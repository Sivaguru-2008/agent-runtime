import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { RuntimeContainer } from "../../application/runtimeContainer.js";
import { ObservabilityQueries } from "../../application/queries/observabilityQueries.js";
import {
  BackpressureError,
  ConflictError,
  NotFoundError,
  PlannerValidationError,
  LowConfidenceExecutionBlocked,
  RuntimeExecutionError,
  ToolContractViolation,
  NodeResolutionFailure
} from "../../shared/errors.js";
import { createId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { registerLiveRoutes } from "../../routes/live-routes.js";
import { registerSprintNextRoutes } from "./sprintNextRoutes.js";
import { RecentSequenceTracker } from "../../events/sse-dedupe.js";
import { requireTenant } from "../../infrastructure/security/tenantContext.js";
import { requireRole } from "../../infrastructure/security/rbac.js";
import {
  CrossTenantAccessError,
  ResourceTenantNotResolvableError,
  type TenantGuard
} from "../../infrastructure/security/tenantGuard.js";
import {
  createAgentSchema,
  createMemorySchema,
  runTaskSchema,
  registerWorkerSchema,
  workerHeartbeatSchema
} from "./schemas.js";

// Cardinality-bounded route label for metrics. Same UUID pattern used in
// app.ts so the queue_saturation series joins cleanly with http_request_duration.
const ROUTE_ID_PATTERN = /\/[0-9a-f-]{8,}(?=\/|$)/gi;
function normaliseRouteForMetrics(url: string): string {
  return url.split("?")[0]!.replace(ROUTE_ID_PATTERN, "/:id");
}

export async function registerRoutes(app: FastifyInstance, container: RuntimeContainer): Promise<void> {
  const queries = new ObservabilityQueries(container.agents, container.executions, container.eventStore);
  // Tenant guard is decorated by app.ts when DATABASE_URL is set. In the
  // in-memory/test mode the decorator is missing — fall through to the
  // container's permissive guard, preserving the legacy behaviour.
  const guard: TenantGuard = app.hasDecorator("tenantGuard")
    ? app.tenantGuard
    : container.tenantGuard;

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "VALIDATION_ERROR", issues: error.issues });
    }

    if (error instanceof NotFoundError) {
      return reply.status(404).send({ error: "NOT_FOUND", message: error.message });
    }

    if (error instanceof ConflictError) {
      return reply.status(409).send({ error: "CONFLICT", message: error.message });
    }

    // Sprint Stabilization — queue overflow MUST surface as 503, not 500.
    //
    // Previously a BackpressureError propagated to the generic catch-all
    // below and was reported to the client as INTERNAL_ERROR (500) with no
    // Retry-After. Downstream API consumers therefore could not distinguish
    // "the runtime is healthy but at capacity, please back off" from "the
    // runtime is broken, escalate". The classifier-based autoscaler at the
    // edge stopped seeing 503s and never scaled the worker pool.
    //
    // Retry-After: chosen by the size of the overshoot. A queue at 1.2x the
    // threshold drains faster than one at 5x; jitter on the client side
    // prevents thundering-herd retries.
    if (error instanceof BackpressureError) {
      const overshoot = error.depth - error.threshold;
      const retryAfterSec = Math.min(60, Math.max(1, Math.ceil(overshoot / 50) + 1));
      // Structured metric emission — single counter increment per rejected
      // request, dimensioned by route so dashboards can localise which entry
      // point is shedding load. We emit via the container so the registry is
      // the same one /metrics scrapes.
      try {
        container.metrics.queueSaturationRejections.inc({
          route: normaliseRouteForMetrics(request.url)
        });
      } catch {
        // metrics registry registration is a best-effort signal; never let
        // a metric emission failure swallow a real 503 response.
      }
      app.log.warn(
        {
          requestId: request.id,
          url: request.url,
          method: request.method,
          depth: error.depth,
          threshold: error.threshold,
          retryAfterSec
        },
        "[BACKPRESSURE] rejecting request — queue over capacity"
      );
      reply.header("Retry-After", String(retryAfterSec));
      return reply.status(503).send({
        error: "QUEUE_SATURATED",
        message: error.message,
        depth: error.depth,
        threshold: error.threshold,
        retryAfterSec
      });
    }

    // Multi-tenant isolation breach — map to 403 without leaking detail.
    // We deliberately do not return 404 here: differential timing/status would
    // let a probing attacker enumerate which resource IDs exist in other tenants.
    if (error instanceof CrossTenantAccessError || error instanceof ResourceTenantNotResolvableError) {
      return reply.status(403).send({ error: "FORBIDDEN", message: "Cross-tenant access denied" });
    }

    if (
      error instanceof PlannerValidationError ||
      error instanceof LowConfidenceExecutionBlocked ||
      error instanceof RuntimeExecutionError ||
      error instanceof ToolContractViolation ||
      error instanceof NodeResolutionFailure
    ) {
      app.log.error(error);
      const status = error instanceof RuntimeExecutionError ? 500 : 400;
      return reply.status(status).send({
        success: false,
        error: {
          type: error.name,
          message: error.message,
          cognitionId: (error as any).cognitionId,
          recoverable: (error as any).recoverable ?? true,
          retryable: (error as any).retryable ?? true
        }
      });
    }

    // Catch-all. Stamp a correlation id so a frontend 500 can be grepped back
    // to the originating server log line. The stack is logged server-side
    // (never returned to clients) so we keep the existing information-disclosure
    // posture while making the failure operable.
    const errorId = createId();
    app.log.error(
      {
        errorId,
        requestId: request.id,
        url: request.url,
        method: request.method,
        errorName: error?.name,
        errorMessage: error?.message,
        errorStack: error?.stack
      },
      "[INTERNAL_ERROR] unhandled exception escaped route handler"
    );
    return reply.status(500).send({
      error: "INTERNAL_ERROR",
      message: "Unexpected runtime error",
      errorId
    });
  });

  app.get("/health", async () => ({
    ok: true,
    service: "agent-runtime-api",
    timestamp: new Date().toISOString()
  }));

  // ── K8s-style probes ───────────────────────────────────────────────────────
  // /live  — process-only liveness. Returns 200 as long as the event loop is
  //          responsive. Used by the kubelet to decide whether to restart the
  //          pod. Must NEVER probe Redis/Postgres: a transient downstream
  //          outage should not kill the API container.
  // /ready — readiness. Probes the dependencies the API actually needs to
  //          serve requests (Postgres pool, Redis if event bus or job queue
  //          is Redis-backed). A failed probe pulls the pod out of the
  //          service endpoint until the dependency recovers.
  // D5 — Liveness now exposes the runtime's STRICT_PROD evaluation so the
  // orchestrator (Kubernetes / Nomad) can distinguish:
  //   200 healthy             — event loop responsive AND no strict-prod
  //                             precondition violated
  //   200 degraded            — process alive but some subsystem flagged
  //                             a non-fatal degradation; pod should NOT
  //                             be restarted (alerts handle user impact)
  //   503 strict-prod-failure — a STRICT_PROD precondition was violated;
  //                             orchestrator MUST back off rather than
  //                             restart-loop into the same broken downstream
  app.get("/live", async (_req, reply) => {
    const { getLivenessState } = await import("../../infrastructure/reliability/livenessState.js");
    const live = getLivenessState();
    const status =
      live.state === "strict-prod-failure"
        ? 503
        : 200;
    return reply.status(status).send({
      status: live.state,
      reason: live.reason,
      strict: live.strict,
      timestamp: new Date().toISOString()
    });
  });

  app.get("/ready", async (_request, reply) => {
    const cfg = container.config;
    const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

    // Postgres readiness — only when a Postgres pool is actually wired in.
    if (container.persistence.pg) {
      const start = Date.now();
      try {
        await container.persistence.pg.query("SELECT 1");
        checks.postgres = { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        checks.postgres = {
          ok: false,
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }

    // Redis readiness — only when the Redis-backed event bus or job queue is
    // active. We don't ping every Redis client; one probe via the queue/bus
    // exercise path is enough to detect a regional outage.
    if (
      cfg.REDIS_URL &&
      (cfg.EVENT_BUS_DRIVER === "redis" ||
        cfg.EVENT_BUS_DRIVER === "redis-streams" ||
        cfg.JOB_QUEUE_DRIVER === "redis")
    ) {
      const start = Date.now();
      try {
        // jobQueue.depth() requires a real Redis call (LLEN/ZCARD) and never
        // mutates state — ideal as a lightweight probe.
        await container.jobQueue.depth();
        checks.redis = { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        checks.redis = {
          ok: false,
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    if (!allOk) {
      return reply.status(503).send({
        status: "not-ready",
        checks,
        timestamp: new Date().toISOString()
      });
    }
    return reply.status(200).send({
      status: "ready",
      checks,
      timestamp: new Date().toISOString()
    });
  });

  // Agent creation requires write privilege (developer+). Quota enforcement
  // on max_agents runs BEFORE the insert so a tenant cannot burst past their
  // plan limit by racing many concurrent creates.
  app.post("/agents", { preHandler: requireRole("developer") }, async (request, reply) => {
    const ctx = requireTenant(request);
    const body = createAgentSchema.parse(request.body);
    if (app.hasDecorator("quotaEnforcer")) {
      const r = await app.quotaEnforcer.checkAgentCreation(ctx.tenantId);
      if (!r.allowed) {
        return reply.status(429).send({ error: "QUOTA_EXCEEDED", reason: r.reason, limit: r.limit, current: r.current });
      }
    }
    const agent = await container.runtime.createAgent(body, requestContext(request.id, ctx.tenantId));
    return reply.status(201).send(agent);
  });

  // Listing agents is tenant-scoped at the route boundary: a non-admin sees
  // only their own agents. Admins see everything (cross-tenant tooling).
  app.get("/agents", async (request) => {
    const ctx = requireTenant(request);
    const all = await container.agents.list();
    if (ctx.role === "admin") return all;
    const owned: typeof all = [];
    for (const a of all) {
      const owner = await guard.resolveAgentTenant(a.id);
      if (owner === null || owner === ctx.tenantId) owned.push(a);
    }
    return owned;
  });

  app.get("/agents/:agentId", async (request) => {
    const ctx = requireTenant(request);
    const { agentId } = request.params as { agentId: string };
    await guard.assertOwnsAgent(ctx, agentId);
    const agent = await container.agents.getById(agentId);
    if (!agent) throw new NotFoundError("Agent", agentId);
    const executions = await container.executions.listByAgent(agentId);
    const memory = await container.memory.listByAgent(agentId);
    return { agent, executions, memory };
  });

  app.post("/agents/:agentId/start", { preHandler: requireRole("developer") }, async (request) => {
    const ctx = requireTenant(request);
    const { agentId } = request.params as { agentId: string };
    await guard.assertOwnsAgent(ctx, agentId);
    return container.runtime.startAgent(agentId, requestContext(request.id, ctx.tenantId));
  });

  app.post("/agents/:agentId/stop", { preHandler: requireRole("developer") }, async (request) => {
    const ctx = requireTenant(request);
    const { agentId } = request.params as { agentId: string };
    await guard.assertOwnsAgent(ctx, agentId);
    return container.runtime.stopAgent(agentId, requestContext(request.id, ctx.tenantId));
  });

  // Task creation is the heaviest write path — gated on developer+, ownership,
  // and per-tenant execution quota (concurrent + hourly).
  app.post("/agents/:agentId/tasks", { preHandler: requireRole("developer") }, async (request, reply) => {
    const ctx = requireTenant(request);
    const { agentId } = request.params as { agentId: string };
    await guard.assertOwnsAgent(ctx, agentId);
    if (app.hasDecorator("quotaEnforcer")) {
      // C-3: checkExecutionStart() now atomically reserves the concurrent
      // slot. The previous explicit trackExecutionStart() call is a no-op
      // shim retained for back-compat and is no longer needed here — calling
      // it would still be safe (it does nothing) but we drop it for clarity.
      const r = await app.quotaEnforcer.checkExecutionStart(ctx.tenantId);
      if (!r.allowed) {
        return reply.status(429).send({ error: "QUOTA_EXCEEDED", reason: r.reason, limit: r.limit, current: r.current });
      }
    }
    const body = runTaskSchema.parse(request.body);
    const execution = await container.runtime.runTask(agentId, body, requestContext(request.id, ctx.tenantId));
    return reply.status(202).send(execution);
  });

  app.post("/agents/:agentId/memory", { preHandler: requireRole("developer") }, async (request, reply) => {
    const ctx = requireTenant(request);
    const { agentId } = request.params as { agentId: string };
    await guard.assertOwnsAgent(ctx, agentId);
    const agent = await container.agents.getById(agentId);
    if (!agent) throw new NotFoundError("Agent", agentId);
    const body = createMemorySchema.parse(request.body);
    const memory = {
      id: createId(),
      agentId,
      type: body.type,
      content: body.content,
      metadata: body.metadata,
      createdAt: toIso(new Date()),
      // C-1: stamp the originating tenant on memory rows written via the
      // HTTP API so they remain reachable only to the owning tenant's
      // search/list paths.
      tenantId: ctx.tenantId
    };
    await container.memory.add(memory);
    return reply.status(201).send(memory);
  });

  app.get("/executions/:executionId", async (request) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    await guard.assertOwnsExecution(ctx, executionId);
    const execution = await container.executions.getById(executionId);
    if (!execution) throw new NotFoundError("Execution", executionId);
    const details = await queries.executionDetails(executionId);
    return { execution, ...details };
  });

  app.get("/executions/:executionId/events", async (request) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    await guard.assertOwnsExecution(ctx, executionId);
    return container.eventStore.listByExecution(executionId);
  });

  app.get("/executions/:executionId/analysis", async (request) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    await guard.assertOwnsExecution(ctx, executionId);
    return queries.failureAnalysis(executionId);
  });

  // Replay is a write-class operation (reconstructs an execution) — requires
  // developer+ and ownership of the source execution to prevent replay leakage.
  app.post("/executions/:executionId/replay", { preHandler: requireRole("developer") }, async (request, reply) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    await guard.assertOwnsExecution(ctx, executionId);
    const replay = await container.runtime.replayExecution(executionId, requestContext(request.id, ctx.tenantId));
    return reply.status(202).send(replay);
  });

  // Cluster topology endpoints expose worker hosts, lease ownership, and
  // execution timelines that span all tenants. Restrict to operator+ — these
  // are platform-level diagnostics, not customer-visible product surfaces.
  app.get("/cluster/overview", { preHandler: requireRole("operator") }, async () => container.clusterQueries.overview());

  app.get("/cluster/snapshot", { preHandler: requireRole("operator") }, async () => container.clusterQueries.snapshot());

  app.get("/cluster/workers", { preHandler: requireRole("operator") }, async () => container.workers.list());

  app.get("/cluster/leases", { preHandler: requireRole("operator") }, async () => container.leases.listActive());

  app.get("/cluster/executions/:executionId", { preHandler: requireRole("operator") }, async (request) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    // Operator can see cross-tenant *cluster* state for their own tenant's
    // executions; only admins can pivot to executions outside their tenant.
    if (ctx.role !== "admin") {
      await guard.assertOwnsExecution(ctx, executionId);
    }
    return container.clusterQueries.executionTimeline(executionId);
  });

  // Worker registration & lifecycle controls are infrastructure-grade actions:
  // a rogue developer key must not be able to register a fake worker (which
  // could then steal leases) or stop a real one. Operator+ required.
  app.post("/cluster/workers", { preHandler: requireRole("operator") }, async (request, reply) => {
    const body = registerWorkerSchema.parse(request.body);
    const worker = await container.workerLifecycle.register(body);
    return reply.status(201).send(worker);
  });

  app.post("/cluster/workers/:workerId/heartbeat", { preHandler: requireRole("operator") }, async (request) => {
    const { workerId } = request.params as { workerId: string };
    const body = workerHeartbeatSchema.parse(request.body);
    const worker = await container.workerLifecycle.heartbeat(workerId, body);
    if (!worker) throw new NotFoundError("Worker", workerId);
    return worker;
  });

  app.post("/cluster/workers/:workerId/drain", { preHandler: requireRole("operator") }, async (request) => {
    const { workerId } = request.params as { workerId: string };
    const worker = await container.workerLifecycle.setStatus(workerId, "DRAINING");
    if (!worker) throw new NotFoundError("Worker", workerId);
    return worker;
  });

  app.post("/cluster/workers/:workerId/stop", { preHandler: requireRole("operator") }, async (request) => {
    const { workerId } = request.params as { workerId: string };
    const worker = await container.workerLifecycle.setStatus(workerId, "STOPPED");
    if (!worker) throw new NotFoundError("Worker", workerId);
    return worker;
  });

  app.post("/cluster/recover", { preHandler: requireRole("operator") }, async () => {
    const recovered = await container.scheduler.recover();
    return { recovered };
  });

  // Observability endpoints aggregate across all tenants — operator+ only.
  app.get("/observability/overview", { preHandler: requireRole("operator") }, async () => queries.overview());

  app.get("/observability/topology", { preHandler: requireRole("operator") }, async () => queries.topology());

  app.get("/observability/failure-clusters", { preHandler: requireRole("operator") }, async () => queries.failureClusters());

  app.get("/executions/:executionId/snapshot", async (request, reply) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    await guard.assertOwnsExecution(ctx, executionId);
    const execution = await container.executions.getById(executionId);
    if (!execution) throw new NotFoundError("Execution", executionId);
    const bundle = await queries.snapshot(executionId);
    reply.header("content-disposition", `attachment; filename="execution-${executionId}.json"`);
    return bundle;
  });

  app.get("/events/stream", async (request, reply) => {
    // Phase 7 + Sprint Hardening 3 — Resumable SSE with bounded dedupe.
    //
    // Multi-tenant isolation (new):
    //   Subscriptions are tenant-scoped. The original implementation broadcast
    //   every event to every authenticated client — a cross-tenant data leak
    //   the moment two tenants connected simultaneously. We now require a
    //   tenant context and pass every event through eventBelongsToTenant()
    //   before write. Admins receive the full firehose for cross-tenant
    //   operator tooling; non-admins see only their tenant's events.
    //
    //   Tenancy is determined per-event in priority order:
    //     1. event.metadata.tenantId (preferred, set by the event factory).
    //     2. Resolve via aggregate type → repository → tenant_id column.
    //     3. If unresolvable AND the resource is the system tenant, allow
    //        only when the requester is admin or the system tenant itself.
    //
    // Resume protocol:
    //   • Browsers reconnecting via EventSource send `Last-Event-ID`.
    //   • Clients can also pin a cursor with `?afterSequence=N`.
    //   • On connect we replay every event with sequence > resumeFrom from
    //     the persistent EventStore *before* subscribing to the live bus.
    //   • Each frame is tagged `id: <sequence>` so the browser keeps the
    //     cursor automatic across drops.
    //
    // Dedupe (changed in Sprint Hardening 3):
    //   See RecentSequenceTracker — bounded ring buffer of emitted sequences.
    //
    // Backpressure: writes that return false pause the bus subscription
    // until `drain` fires, so a slow client can't blow up the bus queue.
    const ctx = requireTenant(request);
    const lastEventIdHeader = request.headers["last-event-id"];
    const afterQuery = (request.query as { afterSequence?: string }).afterSequence;
    const initialCursor =
      Number(lastEventIdHeader) ||
      Number(afterQuery) ||
      0;

    // Cache of aggregateId → tenantId resolutions to avoid hammering Postgres
    // for every event on a busy stream. Bounded by the natural cardinality of
    // active aggregates the client subscribed to.
    const tenantResolutionCache = new Map<string, string | null>();
    const resolveEventTenant = async (event: { aggregateId?: string; aggregateType?: string; metadata?: Record<string, unknown> }): Promise<string | null> => {
      const fromMeta = event?.metadata && typeof event.metadata === "object"
        ? (event.metadata as Record<string, unknown>).tenantId
        : undefined;
      if (typeof fromMeta === "string" && fromMeta.length) return fromMeta;
      const aggId = event?.aggregateId;
      const aggType = event?.aggregateType;
      if (!aggId || !aggType) return null;
      const cacheKey = `${aggType}:${aggId}`;
      if (tenantResolutionCache.has(cacheKey)) return tenantResolutionCache.get(cacheKey)!;
      let tid: string | null = null;
      try {
        if (aggType === "EXECUTION") tid = await guard.resolveExecutionTenant(aggId);
        else if (aggType === "AGENT") tid = await guard.resolveAgentTenant(aggId);
        // MEMORY/SYSTEM events fall through to null — handled by tenant filter.
      } catch {
        tid = null;
      }
      tenantResolutionCache.set(cacheKey, tid);
      return tid;
    };
    const eventBelongsToTenant = async (event: unknown): Promise<boolean> => {
      if (ctx.role === "admin") return true;
      const resolved = await resolveEventTenant(event as { aggregateId?: string; aggregateType?: string; metadata?: Record<string, unknown> });
      // Unresolved events: deny by default to avoid leaking SYSTEM-level data
      // (worker lifecycle, lease state, scheduler events) to product tenants.
      if (resolved === null) return false;
      return resolved === ctx.tenantId;
    };

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const resumeFrom = Number.isFinite(initialCursor) ? Math.max(0, initialCursor) : 0;
    const dedupeWindow = container.config.SSE_DEDUPE_WINDOW;
    const tracker = new RecentSequenceTracker(dedupeWindow);
    let pageHighWaterMark = resumeFrom;
    let paused = false;
    const pendingBatch: Array<{ type: string; payload: string }> = [];

    const flush = (): void => {
      if (paused) return;
      while (pendingBatch.length) {
        const next = pendingBatch.shift()!;
        const ok = reply.raw.write(next.payload);
        if (!ok) {
          paused = true;
          reply.raw.once("drain", () => {
            paused = false;
            flush();
          });
          return;
        }
      }
    };

    const writeEvent = (sequence: number, type: string, body: unknown): void => {
      const thinnedBody = thinEvent(body);
      const payload =
        `id: ${sequence}\n` +
        `event: ${type}\n` +
        `data: ${JSON.stringify(thinnedBody)}\n\n`;
      pendingBatch.push({ type, payload });
      flush();
    };

    // Replay catch-up window in pages so we don't materialize an unbounded
    // backlog into memory on a very stale reconnect.
    const PAGE = 500;
    try {
      // Pagination uses pageHighWaterMark (the largest sequence we've
      // already pulled from the store), NOT the dedupe tracker. The tracker
      // is bounded, so it can't be the source of pagination truth.
      for (;;) {
        const page = await container.eventStore.listAfterSequence(pageHighWaterMark, PAGE);
        if (!page.length) break;
        for (const event of page) {
          const seq = event.sequence ?? 0;
          if (seq <= resumeFrom) continue;
          if (!tracker.observe(seq)) continue;
          // Tenant isolation: do not replay events from another tenant on
          // catch-up. Critical for the resume path because the persisted
          // event log is global by design.
          if (!(await eventBelongsToTenant(event))) {
            if (seq > pageHighWaterMark) pageHighWaterMark = seq;
            continue;
          }
          writeEvent(seq, event.type, event);
          if (seq > pageHighWaterMark) pageHighWaterMark = seq;
        }
        if (page.length < PAGE) break;
      }
    } catch (err) {
      app.log.error({ err }, "SSE replay catch-up failed");
    }

    const unsubscribe = container.eventBus.subscribe((event) => {
      const seq = event.sequence ?? 0;
      if (seq && seq <= resumeFrom) return;
      // tracker.observe() handles three cases:
      //   1. seq already in the recent window (e.g., delivered via catch-up
      //      or a previous duplicate publish) → suppress.
      //   2. seq is out-of-order but novel → emit, count as out-of-order.
      //   3. seq is the new high-water mark → emit.
      if (seq && !tracker.observe(seq)) return;
      // Tenant filter — must run after the dedupe tracker so a denied event
      // still consumes its sequence (prevents replay holes confusing future
      // catch-up). Async dispatch keeps subscriber callback synchronous.
      void (async () => {
        if (!(await eventBelongsToTenant(event))) return;
        if (!seq) {
          writeEvent(seq, event.type, event);
          return;
        }
        writeEvent(seq, event.type, event);
      })();
    });

    // Periodic keepalive comment lines stop intermediaries from closing the
    // connection while there is no traffic.
    const keepalive = setInterval(() => {
      reply.raw.write(`: keepalive ${Date.now()}\n\n`);
    }, 15_000);
    keepalive.unref?.();

    request.raw.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
      const snapshot = tracker.snapshot();
      app.log.info(
        {
          requestId: request.id,
          resumeFrom,
          dedupeWindow,
          ...snapshot
        },
        "SSE connection closed"
      );
    });
  });

  await registerLiveRoutes(app, {
    engine: container.liveEngine,
    broadcaster: container.liveBroadcaster,
    ollama: container.ollama
  });

  // Sprint Next: cognition + replay + time-travel + failure intelligence
  await registerSprintNextRoutes(app, container);
}

function requestContext(requestId: string, tenantId?: string) {
  const traceId = createId();
  // tenantId is optional for back-compat with callers that don't yet pass it.
  // When present, downstream event emission can stamp metadata.tenantId so
  // the SSE filter can resolve ownership without an aggregate→repository hop.
  return {
    traceId,
    correlationId: requestId,
    ...(tenantId ? { tenantId } : {})
  };
}

function thinEvent(event: any): any {
  if (!event || !event.type) return event;

  if (
    event.type === "COGNITION_STARTED" ||
    event.type === "COGNITION_COMPLETED" ||
    event.type === "COGNITION_FAILED"
  ) {
    if (event.payload && event.payload.graph) {
      const thinnedGraph = {
        ...event.payload.graph,
        nodes: (event.payload.graph.nodes ?? []).map((node: any) => {
          if (!node) return node;
          const { input, output, tokenStream, memoryInfluence, ...rest } = node;
          return rest;
        })
      };
      return {
        ...event,
        payload: {
          ...event.payload,
          graph: thinnedGraph
        }
      };
    }
  } else if (
    event.type === "COGNITION_NODE_STARTED" ||
    event.type === "COGNITION_NODE_COMPLETED" ||
    event.type === "COGNITION_NODE_FAILED"
  ) {
    if (event.payload && event.payload.node) {
      const { input, output, tokenStream, memoryInfluence, ...thinnedNode } = event.payload.node;
      return {
        ...event,
        payload: {
          ...event.payload,
          node: thinnedNode
        }
      };
    }
  }
  return event;
}
