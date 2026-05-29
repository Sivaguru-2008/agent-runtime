/**
 * Canonical Execution Timeline.
 *
 * A normalized, append-only, monotonically-sequenced view over every
 * runtime transition that matters for operational reasoning:
 *
 *   - debugging live failures
 *   - inspecting stuck executions
 *   - tracing retries
 *   - reconstructing execution causality
 *   - reasoning about state transitions
 *
 * This layer does NOT replace the durable EventStore. The EventStore remains
 * the source of truth for replay equivalence; it stores DomainEvents with
 * their full payloads, schema versioning, and outbox semantics. The timeline
 * is a *projection* over those events, with a stable normalized schema that
 * never changes when a payload field is added or renamed.
 *
 * Invariants:
 *
 *   I1. Append-only. Records are never mutated after creation. The TimelineStore
 *       contract surfaces only read operations and a single append; there is
 *       no update/delete verb.
 *
 *   I2. Strict chronological + monotonic order. Each (executionId) is assigned
 *       a per-execution `seq` starting at 0 and incremented atomically on each
 *       append. Consumers reading by execution receive records in seq order
 *       which equals causal order — fence-rejected events project to a
 *       different executionId so they never appear interleaved with the
 *       legitimate owner's stream.
 *
 *   I3. Stable schema. The shape of `TimelineEvent` is fixed. New event types
 *       are added by extending the union, never by mutating an existing
 *       variant.
 *
 *   I4. Worker / tenant / attempt attribution. Every record carries the worker
 *       that produced it, the tenant it belongs to, and the attempt that
 *       authored it. Records without authorial worker (e.g., system-level
 *       transitions) use the literal sentinel "system".
 *
 *   I5. Replay-safe ordering. A timeline replay using only the projected
 *       records reconstructs the same operator-visible state transitions as
 *       the canonical event log, even when the underlying DomainEvent
 *       payloads differ between versions.
 */

import type { DomainEvent } from "./events.js";

/**
 * The canonical event names. These map onto DomainEvent types but are spelled
 * in the standard `execution.<aggregate>.<action>` form so operators reading
 * dashboards, runbooks, and post-incident timelines see consistent vocabulary.
 *
 * Adding a new type is non-breaking. Renaming an existing type IS breaking —
 * downstream consumers (dashboards, log queries, alerting rules) key on the
 * literal string and any rename requires coordinated rollout.
 */
export type TimelineEventType =
  | "execution.created"
  | "execution.leased"
  | "execution.lease.renewed"
  | "execution.lease.released"
  | "execution.lease.stolen"
  | "execution.heartbeat"
  | "execution.step.started"
  | "execution.step.completed"
  | "execution.checkpoint.persisted"
  | "execution.retry.scheduled"
  | "execution.retry.started"
  | "execution.recovered"
  | "execution.cancelled"
  | "execution.failed"
  | "execution.completed"
  | "execution.dlq.entered"
  | "execution.dlq.remediated"
  | "execution.replay.detected"
  | "execution.fence.rejected"
  | "execution.poison.pill"
  | "execution.observability.warning";

/**
 * A single canonical timeline record.
 *
 * Field meanings:
 *   - `id`            : opaque unique identifier (random UUID). Useful as a
 *                       primary key for storage and a stable handle for tests.
 *                       Not derived from anything; do NOT rely on it for order.
 *   - `seq`           : per-execution sequence. Monotonic and strictly
 *                       increasing. THE primary order key for replay.
 *   - `executionId`   : the execution this record pertains to.
 *   - `type`          : one of `TimelineEventType` (see invariant I3).
 *   - `at`            : ISO timestamp of the underlying domain transition.
 *   - `workerId`      : authoritative worker attribution. "system" for
 *                       non-worker transitions (cluster recovery sweeps,
 *                       operator-initiated actions).
 *   - `tenantId`      : tenant ownership. Undefined ONLY when the underlying
 *                       record carried no tenant context (legacy data, system
 *                       transitions). New code MUST stamp tenantId.
 *   - `attempt`       : lease attempt at the moment of the transition.
 *                       Undefined for transitions that pre-date the lease
 *                       (e.g., execution.created).
 *   - `traceId`       : OpenTelemetry trace correlation. Threaded from
 *                       DomainEvent.metadata.traceId; never minted here.
 *   - `correlationId` : business-level correlation; same source.
 *   - `causationId`   : prior event in the causal chain.
 *   - `eventId`       : id of the source DomainEvent that authored this
 *                       record. Lets consumers cross-reference to the
 *                       authoritative event log when forensics demand the
 *                       full payload.
 *   - `payload`       : minimal projection of the source payload. KEEP SMALL.
 *                       Goal: every dashboard query can be answered without
 *                       fanning out to the EventStore. Full forensics still
 *                       use `eventId`.
 */
export interface TimelineEvent {
  readonly id: string;
  readonly seq: number;
  readonly executionId: string;
  readonly type: TimelineEventType;
  readonly at: string;
  readonly workerId: string;
  readonly tenantId?: string;
  readonly attempt?: number;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly eventId: string;
  readonly payload: TimelinePayload;
}

/**
 * Discriminated-by-type payload shape. Every event type lists exactly the
 * fields a dashboard, runbook, or post-incident timeline needs to render the
 * row without consulting the underlying DomainEvent.
 *
 * Adding a field is non-breaking. Renaming or removing a field IS breaking;
 * downstream consumers (dashboards, log queries) key on it.
 */
export type TimelinePayload =
  | { kind: "created"; agentId: string }
  | { kind: "leased"; leaseExpiresAt: string }
  | { kind: "lease.renewed"; leaseExpiresAt: string }
  | { kind: "lease.released"; reason?: string }
  | { kind: "lease.stolen"; newOwnerWorkerId?: string }
  | { kind: "heartbeat"; ageMs: number }
  | { kind: "step.started"; stepType: string; stepId: string }
  | { kind: "step.completed"; stepType: string; stepId: string; durationMs?: number }
  | { kind: "checkpoint.persisted"; phase: string; sequence: number }
  | { kind: "retry.scheduled"; delayMs: number; reason?: string }
  | { kind: "retry.started"; attempt: number }
  | { kind: "recovered"; fromSequence: number }
  | { kind: "cancelled"; reason: "lease-lost" | "shutdown" | "manual" }
  | { kind: "failed"; category: string; message: string; recoverable: boolean }
  | { kind: "completed"; tokenUsage?: { total: number } }
  | {
      kind: "dlq.entered";
      failureCount: number;
      lastError: string;
      classification?: string;
    }
  | { kind: "dlq.remediated"; outcome: "succeeded" | "failed" | "quarantined" }
  | { kind: "replay.detected"; divergenceFrameIndex: number }
  | {
      kind: "fence.rejected";
      attemptedStatus: string;
      phase: string;
      originalError?: string;
    }
  | { kind: "poison.pill"; attemptCount: number; maxAttempts: number }
  | {
      kind: "observability.warning";
      signalKind: string;
      severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      summary: string;
    };

/**
 * Authoritative pure mapper from a DomainEvent into zero or one TimelineEvent
 * records. Returns `null` for events that do not project onto the timeline —
 * e.g., system-wide circuit breaker transitions, cognition-internal events.
 *
 * Why a pure function:
 *   - Replay equivalence: re-projecting the durable event log MUST be
 *     deterministic for the same input. No I/O, no clock reads, no random.
 *   - Test isolation: every projection rule is unit-testable from a single
 *     fixture event.
 *
 * `seq` is intentionally NOT assigned here. The projector is concerned with
 * mapping; the sequence is owned by the TimelineStore at append time (so two
 * concurrent projectors over the same event cannot mint conflicting seqs).
 */
export type TimelineProjector = (event: DomainEvent) => Omit<TimelineEvent, "seq"> | null;

/**
 * Append-only persistence and read contract for the timeline.
 *
 * Implementations MUST:
 *   - Assign seq monotonically per executionId. Concurrent appends for the
 *     same executionId must be serialised; the implementation chooses
 *     whether to do that under a lock, a sequence column with a
 *     RETURNING clause, or an atomic counter — but the contract is the
 *     same.
 *   - Never mutate a record once appended.
 *   - Never observe a partial record. The append is all-or-nothing.
 *
 * Implementations MAY:
 *   - Drop records that fail uniqueness on (executionId, seq) — this can
 *     happen if a callable re-appends the same projection. Idempotency here
 *     keeps the timeline append-once even under retry pressure.
 */
export interface TimelineStore {
  append(record: Omit<TimelineEvent, "seq">): Promise<TimelineEvent>;
  listByExecution(executionId: string): Promise<TimelineEvent[]>;
  /** Latest N records globally; useful for live operator dashboards. */
  listRecent(limit: number): Promise<TimelineEvent[]>;
  /** Records for an execution at or after a given seq — supports SSE catch-up. */
  listAfter(executionId: string, afterSeq: number, limit: number): Promise<TimelineEvent[]>;
}
