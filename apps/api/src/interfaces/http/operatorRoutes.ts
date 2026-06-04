/**
 * PHASE 4 — Operator HTTP Routes
 *
 * These routes expose the operator platform APIs. They are separate from the
 * main routes.ts to keep operational concerns isolated from product concerns.
 *
 * Route inventory:
 *   GET  /operator/snapshot          → real-time health metrics snapshot
 *   GET  /operator/workers           → detailed per-worker health
 *   GET  /operator/leases            → lease ownership map (who owns what)
 *   GET  /operator/dlq               → dead-letter queue entries
 *   GET  /operator/diagnose/:id      → full execution diagnosis
 *   GET  /operator/trace/:traceId    → distributed trace lineage
 *   GET  /operator/replay/:id        → replay scrubber frame data
 *   GET  /metrics                    → Prometheus text format (if enabled)
 *
 * Operational visibility gained:
 *   Each route is designed to answer a specific operational question an
 *   operator asks during an incident. No decorative endpoints.
 *
 * Debugging improvements:
 *   /operator/diagnose/:id is the "break glass" endpoint: it joins execution
 *   state, lease info, checkpoint phase, DLQ entry, and failure warnings
 *   into a single response — everything needed to triage a stuck execution.
 *
 * Distributed tracing implications:
 *   /operator/trace/:traceId reconstructs the full event causality chain
 *   for any traceId, functioning as a lightweight built-in trace viewer
 *   that works without an external Jaeger/Tempo dependency.
 *
 * Scaling implications:
 *   All operator routes have no write side-effects and are safe to call
 *   under load. The /metrics route is O(1) (Prometheus registry serialise).
 *   /operator/trace/:traceId scans up to 5,000 events — for higher volumes
 *   add a Postgres index on events(metadata->>'traceId').
 */

import type { FastifyInstance } from "fastify";
import type { RuntimeContainer } from "../../application/runtimeContainer.js";
import { ObservabilityQueries } from "../../application/queries/observabilityQueries.js";
import { OperatorQueries } from "../../application/queries/operatorQueries.js";
import { NotFoundError } from "../../shared/errors.js";
import { requirePermission } from "../../infrastructure/security/rbac.js";
import { requireTenant, canAccessAllTenants } from "../../infrastructure/security/tenantContext.js";
import type { TenantGuard } from "../../infrastructure/security/tenantGuard.js";
import { runtimeIdFor } from "./observabilityMetadata.js";

export async function registerOperatorRoutes(
  app: FastifyInstance,
  container: RuntimeContainer
): Promise<void> {
  const observability = new ObservabilityQueries(
    container.agents,
    container.executions,
    container.eventStore
  );

  const operator = new OperatorQueries(
    container.eventStore,
    container.executions,
    container.workers,
    container.leases,
    container.checkpoints,
    container.deadLetterQueue,
    container.scheduler,
    observability
  );

  // /operator diagnostic READS require observability:read (operator/admin/owner
  // plus the read-only auditor). The break-glass WRITE controls (pause, resume,
  // inject, freeze) require recovery:execute. Replay scrubber data requires
  // replay:read. Per-execution routes additionally validate tenant ownership
  // unless the requester is owner/admin.
  const operatorOnly = requirePermission("observability:read");
  const recoveryControl = requirePermission("recovery:execute");
  const replayRead = requirePermission("replay:read");
  const guard: TenantGuard = app.hasDecorator("tenantGuard")
    ? app.tenantGuard
    : container.tenantGuard;

  // ── GET /operator/snapshot ───────────────────────────────────────────────
  // Real-time health metrics: executions, workers, leases, scheduler, DLQ,
  // token totals. Designed for a 5-second polling interval.
  app.get("/operator/snapshot", { preHandler: operatorOnly }, async () => {
    return operator.metricsSnapshot();
  });

  // ── GET /operator/workers ────────────────────────────────────────────────
  // Per-worker health: status, load (cpu/memory/inFlight), heartbeat age,
  // active leases, utilisation percent.
  app.get("/operator/workers", { preHandler: operatorOnly }, async () => {
    return operator.workerHealthDetail();
  });

  // ── GET /operator/leases ─────────────────────────────────────────────────
  // Active lease map: each entry cross-references worker host and execution
  // status so operators can see who is holding what and for how long.
  app.get("/operator/leases", { preHandler: operatorOnly }, async () => {
    return operator.leaseOwnershipMap();
  });

  // ── GET /operator/dlq ────────────────────────────────────────────────────
  // Dead-letter queue entries. Each entry includes the last error message,
  // failure count, and a task snapshot for replay diagnostics.
  app.get("/operator/dlq", { preHandler: operatorOnly }, async () => {
    return operator.dlqEntries();
  });

  // ── GET /operator/diagnose/:executionId ──────────────────────────────────
  // Full execution diagnosis: event timeline + checkpoint + lease + DLQ entry
  // + failure warnings. The "break glass" endpoint for stuck executions.
  app.get("/operator/diagnose/:executionId", { preHandler: operatorOnly }, async (request) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    // An operator is tenant-scoped; only admins may diagnose executions in
    // other tenants. This blocks horizontal privilege escalation between two
    // tenants that both happen to have operator-grade keys.
    if (!canAccessAllTenants(ctx.role)) {
      await guard.assertOwnsExecution(ctx, executionId);
    }
    const diagnosis = await operator.executionDiagnosis(executionId);
    if (!diagnosis.execution && diagnosis.eventCount === 0) {
      throw new NotFoundError("Execution", executionId);
    }
    return { ...diagnosis, runtimeId: runtimeIdFor(request) };
  });

  // ── GET /operator/trace/:traceId ─────────────────────────────────────────
  // Distributed trace lineage: all events sharing a traceId, ordered by
  // sequence. Shows the complete causal chain of an API request.
  // Trace IDs may span tenants in admin tooling — operator role is enough.
  app.get("/operator/trace/:traceId", { preHandler: operatorOnly }, async (request) => {
    const ctx = requireTenant(request);
    const { traceId } = request.params as { traceId: string };
    const events = await operator.traceLineage(traceId);
    // For non-admin operators, strip events that don't belong to the caller's
    // tenant. A trace by definition follows one request's causal chain so we
    // expect the whole chain to share a tenant — but defensively filter.
    if (!canAccessAllTenants(ctx.role)) {
      // TraceLineageEntry doesn't currently carry tenantId; resolve via the
      // event's aggregate. A trace is one causal chain, so we expect a single
      // owning tenant — if any entry resolves to a different tenant, deny.
      const allowed = [] as typeof events;
      for (const e of events) {
        let tid: string | null = null;
        if (e.aggregateType === "EXECUTION") tid = await guard.resolveExecutionTenant(e.aggregateId);
        else if (e.aggregateType === "AGENT") tid = await guard.resolveAgentTenant(e.aggregateId);
        if (tid === null || tid === ctx.tenantId) allowed.push(e);
      }
      return { traceId, eventCount: allowed.length, events: allowed };
    }
    return { traceId, eventCount: events.length, events };
  });

  // ── GET /operator/replay/:executionId ────────────────────────────────────
  // Replay scrubber data: checkpoints, step frames, and branch pointers.
  // The frontend uses this to drive the time-travel scrubber UI.
  app.get("/operator/replay/:executionId", { preHandler: replayRead }, async (request) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    if (!canAccessAllTenants(ctx.role)) {
      await guard.assertOwnsExecution(ctx, executionId);
    }
    return operator.replayScrubberData(executionId);
  });

  // ── POST /operator/executions/:executionId/pause ────────────────────────
  // Operator-initiated execution suspension. Writes a OPERATOR_PAUSE_REQUESTED
  // checkpoint so the execution engine suspends at its next checkpoint boundary.
  // Idempotent: calling twice returns ALREADY_PAUSED.
  app.post("/operator/executions/:executionId/pause", { preHandler: recoveryControl }, async (request, reply) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    if (!canAccessAllTenants(ctx.role)) {
      await guard.assertOwnsExecution(ctx, executionId);
    }
    const existing = await container.checkpoints.latest(executionId);
    if (existing && (existing.phase as any) === "OPERATOR_PAUSED") {
      return reply.status(200).send({ status: "ALREADY_PAUSED", executionId, checkpointId: existing.id, requestedAt: existing.createdAt });
    }
    const now = new Date().toISOString();
    const checkpointId = `op-pause-${executionId}-${Date.now()}`;
    await container.checkpoints.write({
      id: checkpointId,
      executionId,
      workerId: "operator",
      phase: "OPERATOR_PAUSED" as any,
      sequence: (existing?.sequence ?? 0) + 1,
      state: { pausedByOperator: true, pausedAt: now },
      createdAt: now
    });
    return reply.status(200).send({ status: "PAUSE_REQUESTED", executionId, checkpointId, requestedAt: now });
  });

  // ── POST /operator/executions/:executionId/resume ────────────────────────
  // Cancels an operator pause. Writes an OPERATOR_RESUMED checkpoint so the
  // execution engine can continue from the last real checkpoint.
  app.post("/operator/executions/:executionId/resume", { preHandler: recoveryControl }, async (request, reply) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    if (!canAccessAllTenants(ctx.role)) {
      await guard.assertOwnsExecution(ctx, executionId);
    }
    const existing = await container.checkpoints.latest(executionId);
    if (!existing || (existing.phase as any) !== "OPERATOR_PAUSED") {
      return reply.status(200).send({ status: "NOT_PAUSED", executionId, requestedAt: new Date().toISOString() });
    }
    const now = new Date().toISOString();
    await container.checkpoints.write({
      id: `op-resume-${executionId}-${Date.now()}`,
      executionId,
      workerId: "operator",
      phase: "OPERATOR_RESUMED" as any,
      sequence: existing.sequence + 1,
      state: { resumedByOperator: true, resumedAt: now },
      createdAt: now
    });
    return reply.status(200).send({ status: "RESUME_REQUESTED", executionId, requestedAt: now });
  });

  // ── POST /operator/executions/:executionId/inject ────────────────────────
  // Queues a corrected input injection at the specified replay frame.
  // The injection is persisted as a checkpoint so replay can pick it up.
  app.post("/operator/executions/:executionId/inject", { preHandler: recoveryControl }, async (request, reply) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    if (!canAccessAllTenants(ctx.role)) {
      await guard.assertOwnsExecution(ctx, executionId);
    }
    const { frameIndex, input, reason } = request.body as { frameIndex: number; input: Record<string, unknown>; reason: string };
    const now = new Date().toISOString();
    const injectionId = `op-inject-${executionId}-${frameIndex}-${Date.now()}`;
    const existing = await container.checkpoints.latest(executionId);
    await container.checkpoints.write({
      id: injectionId,
      executionId,
      workerId: "operator",
      phase: "OPERATOR_INJECTED" as any,
      sequence: (existing?.sequence ?? 0) + 1,
      state: { injectedInput: input, frameIndex, reason, injectedAt: now },
      createdAt: now
    });
    return reply.status(200).send({ status: "INJECT_QUEUED", executionId, injectionId, frameIndex, requestedAt: now });
  });

  // ── GET /metrics ─────────────────────────────────────────────────────────
  // Prometheus text exposition format. Scraped by Prometheus/Grafana Agent.
  // Only registered when METRICS_ENABLED=true.
  if (container.config.METRICS_ENABLED) {
    // Prometheus metrics expose per-tenant counters; only operators/admins may
    // scrape them. The metrics endpoint is added to AUTH_SKIP_PATHS in
    // production for unauthenticated Prometheus scrapers; when auth IS enabled
    // for /metrics, this guard enforces operator role.
    app.get("/metrics", { preHandler: operatorOnly }, async (_request, reply) => {
      try {
        const metrics = await container.metrics.registry.metrics();
        reply.header("content-type", container.metrics.registry.contentType);
        return reply.send(metrics);
      } catch (err) {
        app.log.error({ err }, "Prometheus metrics serialisation failed");
        return reply.status(500).send({ error: "METRICS_ERROR" });
      }
    });

    app.log.info("Prometheus /metrics endpoint enabled");
  }

  // ── V3: Reliability surface ──────────────────────────────────────────────
  // Every endpoint here is operator-only. None take a tenant scope — the V3
  // reliability state is process-global by design.

  // GET /operator/slo — current SLO snapshot ladder.
  app.get("/operator/slo", { preHandler: operatorOnly }, async () => {
    return {
      definitions: container.reliability.slo.listDefinitions(),
      snapshots: container.reliability.slo.snapshotAll()
    };
  });

  // GET /operator/freeze — deploy-freeze decision contract.
  // Stable shape: { frozen: boolean, reason?, source, sloEvidence: [] }.
  app.get("/operator/freeze", { preHandler: operatorOnly }, async () => {
    return container.reliability.freeze.decision();
  });

  // POST /operator/freeze — operator force-freeze. Optional ttlMs.
  app.post("/operator/freeze", { preHandler: recoveryControl }, async (request) => {
    const body = (request.body ?? {}) as { reason?: string; ttlMs?: number };
    const reason = body.reason ?? "operator-manual";
    return container.reliability.freeze.forceFreeze(reason, body.ttlMs);
  });

  // DELETE /operator/freeze — release operator override.
  app.delete("/operator/freeze", { preHandler: recoveryControl }, async () => {
    return container.reliability.freeze.releaseFreeze();
  });

  // GET /operator/region — current region topology + fencing token.
  app.get("/operator/region", { preHandler: operatorOnly }, async () => {
    const { getRegionAwareness } = await import(
      "../../infrastructure/reliability/regionAwareness.js"
    );
    return getRegionAwareness().topology();
  });

  // GET /operator/readiness — V3 reliability-aware readiness contract.
  //
  // Note: the unauthenticated /ready route lives in routes.ts (pre-V3 health
  // probe surface). This authenticated variant exposes the richer
  // ReadinessReport for operator dashboards while leaving the LB probe
  // contract on /ready unchanged for backward compatibility.
  app.get("/operator/readiness", { preHandler: operatorOnly }, async (_req, reply) => {
    const report = container.reliability.readiness.evaluate();
    reply.status(report.ready ? 200 : 503);
    return report;
  });

  // GET /operator/incident — incident-correlation envelope for log/alert join.
  app.get("/operator/incident", { preHandler: operatorOnly }, async () => {
    return container.reliability.incidents.current();
  });
}
