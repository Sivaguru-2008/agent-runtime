import type { FastifyRequest } from "fastify";
import type { EventStore } from "../../domain/ports.js";
import { createId } from "../../shared/id.js";

/**
 * Stable identity of THIS running backend process. Generated once at module
 * load (i.e. server boot) and never again, so every response from the same
 * process carries the same `runtimeId`. This is what the operator console's
 * "Runtime ID" field means — "which runtime instance answered me" — so it must
 * NOT change per request. It only rolls over when the process restarts, which
 * is exactly the signal an operator wants ("the runtime came back up").
 *
 * Per-request correlation is a different concern: that is `request.id`, logged
 * as `reqId` and emitted as the `x-request-id` response header.
 */
export const RUNTIME_INSTANCE_ID: string = createId();

/**
 * Observability metadata helpers shared by every execution-related route so the
 * frontend's ExecutionMetadataPanel receives a consistent identity envelope
 * (Run / Execution / Trace / Cognition / Runtime id) regardless of which
 * endpoint produced the view.
 *
 * - runtimeId  : the stable runtime-instance id (RUNTIME_INSTANCE_ID). Identical
 *                to the `x-runtime-id` response header (set in app.ts) so the
 *                value surfaced in the body matches the header on both success
 *                and failure paths, and is identical across every request to the
 *                same running process. Use `x-request-id` / `reqId` to correlate
 *                a single request to its log line.
 * - traceId    : the distributed trace id. Prefers a value already persisted on
 *                the domain object; otherwise resolves it from the execution's
 *                event log (every event carries metadata.traceId), which works
 *                identically across the in-memory and Postgres event stores.
 */

export function runtimeIdFor(_request: FastifyRequest): string {
  return RUNTIME_INSTANCE_ID;
}

export async function resolveTraceId(
  eventStore: EventStore,
  executionId: string,
  preferred?: string
): Promise<string | undefined> {
  if (preferred && preferred.length > 0) return preferred;
  try {
    const events = await eventStore.listByExecution(executionId);
    for (const event of events) {
      const tid = event?.metadata?.traceId;
      if (typeof tid === "string" && tid.length > 0) return tid;
    }
  } catch {
    // Trace resolution is a best-effort enrichment; never fail the request.
  }
  return undefined;
}
