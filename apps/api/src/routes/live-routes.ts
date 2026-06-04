import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LiveExecutionEngine } from "../runtime/execution-engine.js";
import type { LiveEventBroadcaster } from "../events/live-broadcaster.js";
import type { GroqProvider } from "../providers/GroqProvider.js";
import { requirePermission } from "../infrastructure/security/rbac.js";
import { requireTenant, canAccessAllTenants } from "../infrastructure/security/tenantContext.js";

const runBody = z.object({
  prompt: z.string().min(1, "prompt is required").max(8000),
  system: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  executionId: z.string().optional(),
  // Optional Groq model override driven by the UI model selector.
  model: z.string().optional()
});

export interface LiveRouteDeps {
  engine: LiveExecutionEngine;
  broadcaster: LiveEventBroadcaster;
  llm: GroqProvider;
}

export async function registerLiveRoutes(app: FastifyInstance, deps: LiveRouteDeps): Promise<void> {
  const { engine, broadcaster, llm } = deps;

  // ------------------------------------------------------------------------
  // Health: confirms Groq is reachable and reports the active model.
  // ------------------------------------------------------------------------
  app.get("/agent/health", async () => {
    const available = await llm.isAvailable();
    return {
      ok: available,
      model: llm.modelName,
      provider: "groq",
      groq: available ? "online" : "offline"
    };
  });

  // ------------------------------------------------------------------------
  // Submit a prompt. Returns the final execution record once Groq is done.
  // Telemetry (tokens, state changes, errors) is streamed concurrently over
  // the SSE channel below.
  //
  // Multi-tenant note: the live engine emits LiveEvents that are stamped with
  // the caller's tenantId. The broadcaster fan-out filters by tenant so other
  // subscribers can never observe this tenant's token stream.
  // ------------------------------------------------------------------------
  app.post("/agent/run", { preHandler: requirePermission("execution:write") }, async (request, reply) => {
    const ctx = requireTenant(request);
    const parse = runBody.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: "VALIDATION_ERROR", issues: parse.error.issues });
    }
    const controller = new AbortController();
    const abortHandler = () => {
      controller.abort();
    };
    request.raw.on("close", abortHandler);
    try {
      // C-2: tenantId is now a first-class field on RunPromptInput. The engine
      // stamps it on the execution record and every emitted LiveEvent so the
      // broadcaster fan-out filter and the executions REST surface can enforce
      // per-tenant ownership without an extra repository hop.
      const record = await engine.runPrompt({
        ...parse.data,
        tenantId: ctx.tenantId,
        signal: controller.signal,
        executionId: parse.data.executionId
      });
      const status = record.state === "FAILED" ? 502 : 202;
      return reply.status(status).send(record);
    } catch (error) {
      // Stamp an errorId on RUN_FAILED so a client-side 500 can be grepped
      // back to the originating server log entry. Aborts (client disconnect)
      // are not real errors — degrade them to 499 client-closed so they do
      // not pollute the 5xx series.
      const isAbort = (error as Error)?.name === "AbortError";
      if (isAbort) {
        return reply.status(499).send({ error: "CLIENT_CLOSED", message: "Client aborted" });
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      const errorId = `live-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      app.log.error(
        {
          errorId,
          requestId: request.id,
          tenantId: ctx.tenantId,
          executionId: parse.data.executionId,
          errorName: (error as Error)?.name,
          errorMessage: message,
          errorStack: (error as Error)?.stack
        },
        "[live-run] runPrompt failed"
      );
      return reply.status(500).send({ error: "RUN_FAILED", message, errorId });
    } finally {
      request.raw.off("close", abortHandler);
    }
  });

  // ------------------------------------------------------------------------
  // List & detail. The live engine's in-memory list is filtered by the
  // tenant resolved from the request — admins still see everything.
  // ------------------------------------------------------------------------
  app.get("/agent/executions", async (request) => {
    const ctx = requireTenant(request);
    const all = engine.list();
    if (canAccessAllTenants(ctx.role)) return all;
    // C-2: live runPrompt now always stamps tenantId, so a missing tenantId
    // on an in-memory record is a pre-tenancy artifact that non-admins must
    // not see. Fail closed.
    return all.filter((r) => r.tenantId === ctx.tenantId);
  });

  app.get("/agent/executions/:id", async (request, reply) => {
    const ctx = requireTenant(request);
    const { id } = request.params as { id: string };
    const record = engine.get(id);
    if (!record) return reply.status(404).send({ error: "NOT_FOUND" });
    // C-2: untagged records are denied to non-admins — the previous
    // `owner !== undefined` bypass let any tenant read every legacy record.
    if (!canAccessAllTenants(ctx.role) && record.tenantId !== ctx.tenantId) {
      return reply.status(403).send({ error: "FORBIDDEN", message: "Cross-tenant access denied" });
    }
    return record;
  });

  app.get("/agent/executions/:id/events", async (request, reply) => {
    const ctx = requireTenant(request);
    const { id } = request.params as { id: string };
    const record = engine.get(id);
    if (!record) return reply.status(404).send({ error: "NOT_FOUND" });
    // C-2: same fail-closed rule as the executions detail endpoint —
    // ownership must match (or admin) before any history is returned.
    if (!canAccessAllTenants(ctx.role) && record.tenantId !== ctx.tenantId) {
      return reply.status(403).send({ error: "FORBIDDEN", message: "Cross-tenant access denied" });
    }
    return broadcaster.history(id, canAccessAllTenants(ctx.role) ? undefined : ctx.tenantId);
  });

  app.get("/agent/metrics", { preHandler: requirePermission("observability:read") }, async () => engine.metrics());

  // ------------------------------------------------------------------------
  // SSE stream for live telemetry. Tenant-scoped subscription — only events
  // tagged with the caller's tenantId reach the wire. Admins receive the
  // unfiltered firehose for cross-tenant operator tooling.
  // ------------------------------------------------------------------------
  app.get("/agent/events", async (request, reply) => {
    const ctx = requireTenant(request);
    const query = request.query as { executionId?: string; replay?: string };
    const executionId = query.executionId;
    const replay = query.replay !== "false";

    // C-2: cross-tenant block. If the client pinned a specific executionId,
    // the engine record's tenant must match the caller's (or the caller is
    // admin). Untagged records are denied to non-admins — the previous
    // `owner !== undefined` bypass leaked legacy streams across tenants.
    if (executionId) {
      const rec = engine.get(executionId);
      if (rec && !canAccessAllTenants(ctx.role) && rec.tenantId !== ctx.tenantId) {
        return reply.status(403).send({ error: "FORBIDDEN", message: "Cross-tenant access denied" });
      }
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(": connected\n\n");

    const tenantFilter = canAccessAllTenants(ctx.role) ? undefined : ctx.tenantId;
    if (replay) {
      const history = broadcaster.history(executionId, tenantFilter);
      for (const event of history) {
        writeSse(reply.raw, event);
      }
    }

    // Defensive subscription wrapper. `cancelled` blocks any handler that
    // races with cleanup — a slow `writeSse` queued before the socket
    // closes cannot fire EPIPE on a closed socket.
    let cancelled = false;
    const unsubscribe = broadcaster.subscribe((event) => {
      if (cancelled) return;
      if (executionId && event.executionId !== executionId) return;
      writeSse(reply.raw, event);
    }, tenantFilter);

    const keepAlive = setInterval(() => {
      if (cancelled) return;
      try {
        reply.raw.write(": keep-alive\n\n");
      } catch {
        // socket already closed — cleanup will run via the close handler
      }
    }, 15_000);

    const cleanup = () => {
      if (cancelled) return;
      cancelled = true;
      clearInterval(keepAlive);
      try { unsubscribe(); } catch { /* noop */ }
      app.log.info(
        {
          requestId: request.id,
          executionId,
          tenantId: tenantFilter ?? "admin",
          replay
        },
        "[live-sse] subscription closed"
      );
    };

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
  });
}

function writeSse(raw: NodeJS.WritableStream, event: { type: string }): void {
  raw.write(`event: ${event.type}\n`);
  raw.write(`data: ${JSON.stringify(event)}\n\n`);
}
