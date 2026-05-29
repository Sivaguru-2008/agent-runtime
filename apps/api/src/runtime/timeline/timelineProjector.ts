/**
 * Authoritative DomainEvent → TimelineEvent projector.
 *
 * Pure mapping. No I/O, no clock reads, no randomness. Re-running the
 * projector over the durable event log MUST produce the same projection — it
 * is part of the replay-equivalence guarantee surfaced by executionTimeline.
 *
 * Coverage:
 *   The mapper covers every DomainEventType the runtime emits along the
 *   lease/execution/recovery/DLQ axis. Non-execution events (cognition
 *   internals, circuit breakers, planner traces) return null because they
 *   do not project onto the per-execution timeline — they're addressed by
 *   the cognition timeline (separate projection, separate store).
 *
 * Schema discipline:
 *   The projected `payload` is a deliberately small subset of the source
 *   DomainEvent payload. Dashboards key off it; the full forensic payload is
 *   always available via `eventId` and the EventStore. Renaming a projected
 *   field IS a breaking change for the timeline schema, so changes here are
 *   intentionally heavyweight.
 */

import type { DomainEvent } from "../../domain/events.js";
import type {
  TimelineEvent,
  TimelineEventType,
  TimelinePayload
} from "../../domain/executionTimeline.js";
import { createId } from "../../shared/id.js";

const SYSTEM_WORKER_ID = "system";

/**
 * Map a DomainEvent into a TimelineEvent draft (sequence assigned later by
 * the store). Returns `null` for events that have no canonical timeline
 * projection.
 *
 * Worker / tenant / attempt attribution is recovered from the most reliable
 * source available in the event:
 *
 *   - workerId: payload.workerId → payload.lease.workerId → payload.checkpoint.workerId
 *     → fallback "system". (NEVER a guess: only fields the producer set
 *     explicitly.)
 *   - tenantId: metadata.tenantId → payload.execution.tenantId
 *     → undefined. (No best-effort cross-execution lookup; if it isn't on
 *     the event, we surface absence faithfully.)
 *   - attempt: payload.lease.attempt → payload.attempt → payload.attemptCount
 *     → undefined.
 */
export function projectTimelineEvent(event: DomainEvent): Omit<TimelineEvent, "seq"> | null {
  const mapped = mapToType(event);
  if (!mapped) return null;

  const payload = event.payload as Record<string, unknown>;
  const meta = event.metadata as unknown as Record<string, unknown>;
  const workerId = pickWorkerId(payload, meta);
  const tenantId = pickTenantId(payload, meta);
  const attempt = pickAttempt(payload);

  return {
    id: createId(),
    executionId: event.aggregateId,
    type: mapped.type,
    at: event.timestamp,
    workerId,
    tenantId,
    attempt,
    traceId: (meta?.traceId as string | undefined) ?? undefined,
    correlationId: (meta?.correlationId as string | undefined) ?? undefined,
    causationId: (meta?.causationId as string | undefined) ?? undefined,
    eventId: event.id,
    payload: mapped.payload
  };
}

interface MappedShape {
  type: TimelineEventType;
  payload: TimelinePayload;
}

function mapToType(event: DomainEvent): MappedShape | null {
  const p = event.payload as Record<string, any>;

  switch (event.type) {
    case "EXECUTION_STARTED": {
      // EXECUTION_STARTED is the canonical "execution.created" projection.
      // The agentId is denormalised onto the execution snapshot in the event
      // payload — read it from there rather than a sibling lookup so the
      // projector remains pure.
      const agentId = String(p.execution?.agentId ?? "unknown");
      return { type: "execution.created", payload: { kind: "created", agentId } };
    }
    case "EXECUTION_LEASED":
      return {
        type: "execution.leased",
        payload: { kind: "leased", leaseExpiresAt: String(p.lease?.expiresAt ?? "") }
      };
    case "EXECUTION_LEASE_RENEWED":
      return {
        type: "execution.lease.renewed",
        payload: {
          kind: "lease.renewed",
          leaseExpiresAt: String(p.lease?.expiresAt ?? "")
        }
      };
    case "EXECUTION_LEASE_RELEASED":
      return {
        type: "execution.lease.released",
        payload: { kind: "lease.released" }
      };
    case "EXECUTION_LEASE_RECLAIMED":
      return {
        type: "execution.lease.stolen",
        payload: { kind: "lease.stolen" }
      };
    case "WORKER_HEARTBEAT": {
      // Worker heartbeats are global, not per-execution. They project to the
      // timeline only when they came tagged with an executionId in metadata
      // (e.g., a lease-renewal-triggered heartbeat). Otherwise null — the
      // cluster heartbeat dashboard handles them.
      if (!event.aggregateId || event.aggregateType !== "EXECUTION") return null;
      return {
        type: "execution.heartbeat",
        payload: { kind: "heartbeat", ageMs: 0 }
      };
    }
    case "EXECUTION_STEP_STARTED": {
      const step = p.step ?? {};
      return {
        type: "execution.step.started",
        payload: {
          kind: "step.started",
          stepType: String(step.type ?? "unknown"),
          stepId: String(step.id ?? "")
        }
      };
    }
    case "EXECUTION_STEP_COMPLETED": {
      const step = p.step ?? {};
      return {
        type: "execution.step.completed",
        payload: {
          kind: "step.completed",
          stepType: String(step.type ?? "unknown"),
          stepId: String(step.id ?? ""),
          durationMs: typeof step.durationMs === "number" ? step.durationMs : undefined
        }
      };
    }
    case "EXECUTION_CHECKPOINT_WRITTEN": {
      const cp = p.checkpoint ?? {};
      return {
        type: "execution.checkpoint.persisted",
        payload: {
          kind: "checkpoint.persisted",
          phase: String(cp.phase ?? "unknown"),
          sequence: Number(cp.sequence ?? 0)
        }
      };
    }
    case "RETRY_TRIGGERED":
      return {
        type: "execution.retry.scheduled",
        payload: {
          kind: "retry.scheduled",
          delayMs: Number(p.delayMs ?? 0),
          reason: typeof p.reason === "string" ? p.reason : undefined
        }
      };
    case "EXECUTION_RESUMED":
      return {
        type: "execution.recovered",
        payload: { kind: "recovered", fromSequence: Number(p.fromSequence ?? 0) }
      };
    case "EXECUTION_ABORTED":
      return {
        type: "execution.cancelled",
        payload: {
          kind: "cancelled",
          reason: (p.reason as "lease-lost" | "shutdown" | "manual") ?? "manual"
        }
      };
    case "EXECUTION_FAILED": {
      const exec = p.execution ?? {};
      const failure = exec.failure ?? {};
      const category = String(p.failureCategory ?? failure.category ?? "UNKNOWN_RUNTIME_FAILURE");
      return {
        type: "execution.failed",
        payload: {
          kind: "failed",
          category,
          message: String(failure.message ?? "execution failed"),
          recoverable: failure.recoverable !== false
        }
      };
    }
    case "EXECUTION_COMPLETED": {
      const tu = p.execution?.tokenUsage;
      return {
        type: "execution.completed",
        payload: {
          kind: "completed",
          tokenUsage: tu ? { total: Number(tu.total ?? 0) } : undefined
        }
      };
    }
    case "EXECUTION_DEAD_LETTERED":
      return {
        type: "execution.dlq.entered",
        payload: {
          kind: "dlq.entered",
          failureCount: Number(p.failureCount ?? 0),
          lastError: String(p.lastError ?? ""),
          classification: typeof p.classification === "string" ? p.classification : undefined
        }
      };
    case "EXECUTION_POISON_PILL_DETECTED":
      return {
        type: "execution.poison.pill",
        payload: {
          kind: "poison.pill",
          attemptCount: Number(p.attemptCount ?? 0),
          maxAttempts: Number(p.maxAttempts ?? 0)
        }
      };
    case "REPLAY_DIVERGENCE_DETECTED":
      return {
        type: "execution.replay.detected",
        payload: {
          kind: "replay.detected",
          divergenceFrameIndex: Number(p.divergenceFrameIndex ?? 0)
        }
      };
    case "EXECUTION_FENCE_REJECTED":
      return {
        type: "execution.fence.rejected",
        payload: {
          kind: "fence.rejected",
          attemptedStatus: String(p.attemptedStatus ?? "unknown"),
          phase: String(p.phase ?? "unknown"),
          originalError:
            typeof p.originalError === "string" ? p.originalError : undefined
        }
      };
    case "OBSERVABILITY_WARNING":
      return {
        type: "execution.observability.warning",
        payload: {
          kind: "observability.warning",
          signalKind: String(p.signalKind ?? "unknown"),
          severity: (p.severity as TimelinePayload extends { severity: infer S } ? S : never) ?? "INFO",
          summary: String(p.summary ?? "")
        }
      };
    default:
      return null;
  }
}

function pickWorkerId(payload: Record<string, any>, meta: Record<string, any>): string {
  return (
    payload?.workerId ??
    payload?.lease?.workerId ??
    payload?.checkpoint?.workerId ??
    payload?.step?.workerId ??
    payload?.toolCall?.workerId ??
    meta?.workerId ??
    SYSTEM_WORKER_ID
  );
}

function pickTenantId(
  payload: Record<string, any>,
  meta: Record<string, any>
): string | undefined {
  return (
    (meta?.tenantId as string | undefined) ??
    (payload?.tenantId as string | undefined) ??
    (payload?.execution?.tenantId as string | undefined) ??
    undefined
  );
}

function pickAttempt(payload: Record<string, any>): number | undefined {
  return (
    (typeof payload?.lease?.attempt === "number" ? payload.lease.attempt : undefined) ??
    (typeof payload?.attempt === "number" ? payload.attempt : undefined) ??
    (typeof payload?.attemptCount === "number" ? payload.attemptCount : undefined) ??
    (typeof payload?.fence?.attempt === "number" ? payload.fence.attempt : undefined) ??
    undefined
  );
}
