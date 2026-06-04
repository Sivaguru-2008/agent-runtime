/**
 * OutboxDlqRecoveryService — out-of-band recovery for dead-lettered outbox events.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The OutboxDispatcher guarantees "every committed outbox event is eventually
 * delivered" — but only for rows still in `event_outbox`. When a row exhausts
 * MAX_RETRIES (e.g. a bus outage that outlasts the retry ladder) the dispatcher
 * moves it to `event_outbox_dlq` and deletes it from `event_outbox`. Nothing
 * ever read `event_outbox_dlq` back out, so a transient-but-sustained failure
 * permanently dropped the event off the bus — the delivery guarantee was
 * silently broken for exactly the events that needed recovery most.
 *
 * Phase 2 (migration 0021) closed the *stranded PROCESSING* hole. This service
 * closes the *dead-letter* hole: a background sweep re-attempts delivery of
 * dead-lettered events directly to the bus, bounded by a durable attempt
 * counter and backoff, and quarantines genuinely-poison rows so it never
 * thrashes.
 *
 * GUARANTEES PRESERVED
 * --------------------
 *   • Determinism / replay — UNAFFECTED. The authoritative event was appended to
 *     the `events` table on first publish; `event_outbox_dlq` only ever held a
 *     *delivery* copy. Replay reads `events`, never the outbox or its DLQ, so
 *     redelivery changes nothing the replay engine observes.
 *   • Idempotency — redelivery is at-least-once. Consumers dedupe on
 *     `idempotency_key`; the PersistedEventPublisher's in-process dedup set is
 *     primed via confirmDelivered(). A duplicate is therefore a no-op end to end.
 *   • Ordering — this service NEVER re-inserts into `event_outbox`. Re-queueing a
 *     DLQ'd event at its old sequence behind already-delivered successors would
 *     reorder healthy rows and could trip the O1 FIFO invariant. The causal gap
 *     for a dead-lettered event was already created when it was DLQ'd and its
 *     successors proceeded; this service restores *completeness* (the event is
 *     delivered at all) without weakening FIFO for healthy traffic. Recovery is,
 *     by construction, out-of-band best-effort ordering for poison events only.
 *   • Split-brain protection — the sweep is fenced. It acquires a fencing token
 *     at tick start and re-asserts it before each bus delivery, so a region that
 *     loses primary mid-sweep stops delivering and the new primary takes over.
 *     A passive region simply skips the tick (no double-delivery across regions).
 *   • Lease / recovery guarantees — orthogonal; this service touches only the
 *     outbox DLQ, never leases, checkpoints, or the recovery coordination store.
 *
 * Multi-worker safety: the claim CTE uses `for update skip locked`, so two
 * recovery sweeps on different replicas never contend on the same DLQ row.
 */

import type { DomainEvent } from "../../domain/events.js";
import type { EventBus } from "../../domain/ports.js";
import type { PersistedEventPublisher } from "./persistedEventPublisher.js";
import type { PgClient } from "../persistence/postgres/pgClient.js";
import {
  acquireFencingToken,
  assertCanWrite,
  NonPrimaryWriteError
} from "../reliability/splitBrainGuard.js";

/** Max redelivery attempts before a DLQ row is quarantined (never auto-retried again). */
export const DLQ_RECOVERY_MAX_ATTEMPTS = 5;
/** Base backoff between redelivery attempts of the same row (ms). */
export const DLQ_RECOVERY_BASE_BACKOFF_MS = 30_000;
/** Backoff ceiling (ms). */
export const DLQ_RECOVERY_MAX_BACKOFF_MS = 30 * 60_000;

/**
 * Stamped into event_outbox_dlq.last_recovery_error when a row is quarantined
 * because it exhausted DLQ_RECOVERY_MAX_ATTEMPTS. Observability only — operators
 * grep for this to find events that need manual intervention.
 */
export const DLQ_QUARANTINE_MARKER = "OUTBOX_DLQ_QUARANTINED_ATTEMPTS_EXHAUSTED";

export type DlqRecoveryOutcome = "redelivered" | "retry-scheduled" | "quarantined";

export interface OutboxDlqRecoveryOptions {
  /** Max redelivery attempts before quarantine. Default 5. */
  maxAttempts?: number;
  /** Base backoff between attempts of the same row (ms). Default 30s. */
  baseBackoffMs?: number;
  /** Backoff ceiling (ms). Default 30m. */
  maxBackoffMs?: number;
}

export interface OutboxDlqRow {
  id: string;
  event_id: string;
  execution_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sequence: string | number;
  idempotency_key: string;
  original_timestamp: Date | string | null;
  recovery_attempts: string | number;
}

/**
 * Pure backoff schedule for a failed redelivery attempt. Exported for direct
 * unit testing (Docker-free) so the bounded-retry contract has regression
 * coverage independent of the integration harness.
 *
 * `attemptsAfterFailure` is the new attempt count *after* incrementing on this
 * failure (1 on the first failure). Capped at `maxBackoffMs`.
 */
export function dlqRecoveryBackoffMs(
  attemptsAfterFailure: number,
  baseBackoffMs: number = DLQ_RECOVERY_BASE_BACKOFF_MS,
  maxBackoffMs: number = DLQ_RECOVERY_MAX_BACKOFF_MS
): number {
  const exp = Math.max(0, attemptsAfterFailure - 1);
  return Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, exp));
}

/**
 * Pure decision: given the attempt count *after* incrementing on a failure,
 * should the row be quarantined? Exported for unit testing the boundary.
 */
export function shouldQuarantineDlqRow(
  attemptsAfterFailure: number,
  maxAttempts: number = DLQ_RECOVERY_MAX_ATTEMPTS
): boolean {
  return attemptsAfterFailure >= maxAttempts;
}

export class OutboxDlqRecoveryService {
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly publisher: PersistedEventPublisher,
    private readonly bus: EventBus,
    private readonly db: PgClient,
    private readonly logger?: {
      info: (obj: unknown, msg?: string) => void;
      warn: (obj: unknown, msg?: string) => void;
      error: (obj: unknown, msg?: string) => void;
    },
    options?: OutboxDlqRecoveryOptions
  ) {
    this.maxAttempts = options?.maxAttempts ?? DLQ_RECOVERY_MAX_ATTEMPTS;
    this.baseBackoffMs = options?.baseBackoffMs ?? DLQ_RECOVERY_BASE_BACKOFF_MS;
    this.maxBackoffMs = options?.maxBackoffMs ?? DLQ_RECOVERY_MAX_BACKOFF_MS;
  }

  /** Start the periodic recovery sweep. */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        this.logger?.error({ err }, "[outbox-dlq-recovery] tick failed")
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Claim a batch of eligible DLQ rows and re-attempt delivery. Returns the
   * number of events successfully redelivered this tick. Re-entrancy guarded so
   * a slow tick (large batch / slow bus) cannot overlap itself.
   */
  async tick(batchSize = 20): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    // Split-brain guard: only the active primary region drains the DLQ. A
    // passive region skips entirely — it must not double-deliver an event the
    // primary is already recovering.
    let held: { token: number; regionId: string };
    try {
      held = acquireFencingToken();
    } catch (err) {
      this.running = false;
      if (err instanceof NonPrimaryWriteError) {
        this.logger?.info({ err }, "[outbox-dlq-recovery] skipped: non-primary region");
        return 0;
      }
      throw err;
    }

    try {
      return await this.drainBatch(batchSize, held);
    } finally {
      this.running = false;
    }
  }

  /** Drain until a tick delivers nothing (or the batch was empty). */
  async drainAll(batchSize = 20): Promise<number> {
    let total = 0;
    let last = -1;
    while (last !== 0) {
      last = await this.tick(batchSize);
      total += last;
    }
    return total;
  }

  private async drainBatch(
    batchSize: number,
    held: { token: number; regionId: string }
  ): Promise<number> {
    const now = new Date();
    // Claim window: while we work a row, push its visibility out so a sibling
    // sweep does not also pick it up. A failed attempt overwrites this with the
    // real backoff; a success deletes the row.
    const claimVisibleAfter = new Date(now.getTime() + this.baseBackoffMs);

    const claim = await this.db.query<OutboxDlqRow>(
      `with eligible as (
         select id
           from event_outbox_dlq
          where quarantined = false
            and recovery_visible_after <= $1
          order by failed_at asc
          limit $2
          for update skip locked
       )
       update event_outbox_dlq
          set recovery_visible_after = $3
        where id in (select id from eligible)
        returning id, event_id, execution_id, event_type, payload, metadata,
                  sequence, idempotency_key, original_timestamp, recovery_attempts`,
      [now.toISOString(), batchSize, claimVisibleAfter.toISOString()]
    );

    if (claim.rows.length === 0) return 0;

    let redelivered = 0;

    for (const row of claim.rows) {
      // Re-assert the fence before each delivery: if a failover happened mid
      // sweep, stop here and let the new primary recover the remaining rows.
      try {
        assertCanWrite(held);
      } catch (err) {
        this.logger?.warn({ err }, "[outbox-dlq-recovery] topology shifted mid-sweep; aborting tick");
        break;
      }

      const event = this.rowToEvent(row, now);
      try {
        await this.bus.publish(event);
        await this.db.query(`delete from event_outbox_dlq where id = $1`, [row.id]);
        // Prime the publisher's in-process dedup so a concurrent in-process
        // path cannot re-broadcast the same id.
        this.publisher.confirmDelivered(row.event_id);
        redelivered += 1;
        this.logger?.info(
          { eventId: row.event_id, executionId: row.execution_id, attempts: Number(row.recovery_attempts) + 0 },
          "[outbox-dlq-recovery] redelivered dead-lettered event"
        );
      } catch (err) {
        await this.handleFailure(row, err);
      }
    }

    return redelivered;
  }

  private async handleFailure(row: OutboxDlqRow, err: unknown): Promise<void> {
    const errMsg = err instanceof Error ? err.message : String(err);
    const attemptsAfter = Number(row.recovery_attempts) + 1;

    if (shouldQuarantineDlqRow(attemptsAfter, this.maxAttempts)) {
      await this.db.query(
        `update event_outbox_dlq
            set recovery_attempts = $2,
                quarantined = true,
                last_recovery_error = $3
          where id = $1`,
        [row.id, attemptsAfter, `${DLQ_QUARANTINE_MARKER}:${errMsg}`]
      );
      this.logger?.error(
        { eventId: row.event_id, executionId: row.execution_id, attempts: attemptsAfter, lastError: errMsg },
        "[outbox-dlq-recovery] quarantined event after exhausting recovery attempts"
      );
      return;
    }

    const backoff = dlqRecoveryBackoffMs(attemptsAfter, this.baseBackoffMs, this.maxBackoffMs);
    const nextVisibleAfter = new Date(Date.now() + backoff);
    await this.db.query(
      `update event_outbox_dlq
          set recovery_attempts = $2,
              recovery_visible_after = $3,
              last_recovery_error = $4
        where id = $1`,
      [row.id, attemptsAfter, nextVisibleAfter.toISOString(), errMsg]
    );
    this.logger?.warn(
      { eventId: row.event_id, executionId: row.execution_id, attempts: attemptsAfter, nextEligibleInMs: backoff, lastError: errMsg },
      "[outbox-dlq-recovery] redelivery failed; backing off"
    );
  }

  private rowToEvent(row: OutboxDlqRow, now: Date): DomainEvent {
    // Preserve the producer-side timestamp; fall back to `now` only for legacy
    // rows whose original_timestamp predates migration 0011/0022.
    const timestamp =
      row.original_timestamp === null || row.original_timestamp === undefined
        ? now.toISOString()
        : row.original_timestamp instanceof Date
          ? row.original_timestamp.toISOString()
          : new Date(row.original_timestamp).toISOString();

    return {
      id: row.event_id,
      type: row.event_type as DomainEvent["type"],
      aggregateId: row.execution_id,
      aggregateType: "EXECUTION",
      version: 1,
      timestamp,
      payload: row.payload as unknown as DomainEvent["payload"],
      metadata: row.metadata as unknown as DomainEvent["metadata"],
      sequence: Number(row.sequence)
    };
  }
}
