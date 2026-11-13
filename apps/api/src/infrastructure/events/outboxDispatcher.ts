/**
 * OutboxDispatcher — drains the event outbox to the event bus.
 *
 * It operates in two modes:
 *   1. Database-Backed Mode (Postgres): Polls the `event_outbox` table using
 *      a specialized CTE with `FOR UPDATE SKIP LOCKED`. It enforces strict
 *      per-execution FIFO ordering, visibility timeouts, retry backoff, and
 *      automatic promotion of poison events to the Dead-Letter Queue (DLQ).
 *   2. Memory-Backed Mode (Fallback / Test): Drains the PersistedEventPublisher's
 *      in-memory pendingOutbox. Used in single-process, in-memory, and legacy unit
 *      test environments.
 */

import type { DomainEvent } from "../../domain/events.js";
import type { EventBus } from "../../domain/ports.js";
import type { PersistedEventPublisher } from "./persistedEventPublisher.js";
import type { PgClient } from "../persistence/postgres/pgClient.js";
import { acquireFencingToken, assertCanWrite } from "../reliability/splitBrainGuard.js";
import { assertRuntimeInvariant } from "../../runtime/canonicalSemantics.js";

const MAX_RETRIES = 5;
const DEFAULT_VISIBILITY_TIMEOUT_SEC = 30;

/**
 * Marker stamped into event_outbox.last_error when the dispatcher reclaims
 * a stranded PROCESSING row whose visibility timeout has elapsed. Observability
 * only — operators grep for this to count crash-recovery reclaims.
 */
export const STRANDED_RECOVERY_MARKER = "OUTBOX_RECOVERED_STRANDED_PROCESSING";

export interface OutboxDispatcherOptions {
  /**
   * How long a claimed (PROCESSING) row stays invisible to other workers
   * before it is treated as stranded and eligible for re-claim. Must exceed
   * the slowest expected bus.publish() round-trip plus the post-publish DB
   * write. Default 30s matches the legacy constant.
   */
  visibilityTimeoutSec?: number;
}

export interface OutboxRow {
  id: string;
  event_id: string;
  execution_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sequence: string | number;
  idempotency_key: string;
  /**
   * Producer-side timestamp of the source event, populated by
   * commitTerminal (and by future producers). Audit CRITICAL-3: this is
   * what consumers should see on the bus — NOT the dispatch wall time.
   * NULL only for rows that pre-date migration 0011 and whose source
   * event was already archived; the dispatcher falls back to `now` in
   * that single degenerate case.
   */
  original_timestamp: Date | string | null;
  /**
   * Owning tenant (migration 0025). Pure attribution: it is carried through to
   * the DLQ on poison promotion so a dead-lettered side effect keeps its
   * tenant, but it never participates in the claim CTE, FIFO ordering, or
   * fencing — exactly-once + per-execution ordering are unchanged.
   */
  tenant_id: string;
}

export class OutboxDispatcher {
  private readonly visibilityTimeoutSec: number;

  constructor(
    private readonly publisher: PersistedEventPublisher,
    private readonly bus: EventBus,
    private readonly db?: PgClient,
    private readonly logger?: { info: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void; warn: (msg: string, ...args: unknown[]) => void },
    options?: OutboxDispatcherOptions
  ) {
    const requested = options?.visibilityTimeoutSec ?? DEFAULT_VISIBILITY_TIMEOUT_SEC;
    // Defensive lower bound: a zero/negative timeout would let a worker
    // reclaim a row another worker is *currently* publishing, breaking
    // at-least-once into "many-times" with no upper bound. 1s is the
    // minimum that still leaves room for a healthy publish round-trip.
    this.visibilityTimeoutSec = requested >= 1 ? requested : DEFAULT_VISIBILITY_TIMEOUT_SEC;
  }

  /**
   * Drain pending events to the bus.
   * In DB mode, claims a batch of events, attempts delivery, and updates DB status.
   * In memory mode, drains the publisher's in-process pending outbox.
   * Returns the number of successfully delivered events.
   */
  async tick(batchSize = 20): Promise<number> {
    // TASK D1: Split-brain outbox fencing: only active region dispatches outbox events.
    const held = acquireFencingToken();
    if (!this.db) {
      return this.tickMemory();
    }
    const result = await this.tickDatabase(batchSize);
    assertCanWrite(held);
    return result;
  }

  /**
   * Database-backed tick. Uses a specialized CTE to claim a batch of events with
   * FOR UPDATE SKIP LOCKED while guaranteeing strict FIFO per execution_id.
   */
  private async tickDatabase(batchSize: number): Promise<number> {
    if (!this.db) return 0;

    const now = new Date();
    const visibleAfter = new Date(now.getTime() + this.visibilityTimeoutSec * 1000);

    // Claim a batch of eligible candidates. A row is eligible if:
    //   • status = PENDING and its backoff window has elapsed (the normal
    //     dispatch path), OR
    //   • status = PROCESSING and its visibility timeout has elapsed (the
    //     crash-recovery path — a previous worker claimed it and never
    //     finished, so we treat it as abandoned and reclaim it).
    //
    // The per-execution FIFO blocker check still rejects later sequence
    // numbers if any earlier row is *actively* in flight, but it does NOT
    // count a stranded PROCESSING row (visible_after past) as a blocker —
    // that row is itself eligible in the same tick, and the row-level
    // `for update skip locked` keeps two workers from racing on it.
    //
    // The update reclaims rows by re-stamping status='PROCESSING' and a
    // fresh visible_after. For reclaimed (already-PROCESSING) rows we also
    // bump retry_count and stamp last_error with STRANDED_RECOVERY_MARKER
    // so MAX_RETRIES still bounds runaway recovery and operators can see
    // the reclaim count via the existing retry telemetry.
    const claimResult = await this.db.query<OutboxRow>(
      `with eligible_candidates as (
         select id, execution_id, sequence
           from event_outbox
          where visible_after <= $1
            and (status = 'PENDING' or status = 'PROCESSING')
       ),
       ordered_candidates as (
         select ec.id
           from eligible_candidates ec
          where not exists (
            select 1
              from event_outbox prev
             where prev.execution_id = ec.execution_id
               and prev.sequence < ec.sequence
               and (
                 prev.status = 'PENDING'
                 or (prev.status = 'PROCESSING' and prev.visible_after > $1)
               )
          )
          order by ec.sequence asc
          limit $2
       ),
       locked_batch as (
         select id
           from event_outbox
          where id in (select id from ordered_candidates)
            -- Re-assert eligibility *inside* the FOR UPDATE select. In READ
            -- COMMITTED, when SKIP LOCKED reaches a row a competing worker has
            -- already claimed-and-committed (so it is no longer locked, just
            -- re-stamped PROCESSING with a future visible_after), Postgres
            -- runs EvalPlanQual against the latest row version using THIS
            -- select's qualifiers. Without the predicate here the only
            -- qualifier is the id membership test, which still matches, so
            -- the loser of the race re-claims and re-delivers the row --
            -- breaking exactly-once into double delivery. Repeating the
            -- eligibility predicate makes EvalPlanQual exclude the row whose
            -- visible_after was just bumped into the future by the winner.
            and visible_after <= $1
            and (status = 'PENDING' or status = 'PROCESSING')
            for update skip locked
       )
       update event_outbox
          set status = 'PROCESSING',
              visible_after = $3,
              retry_count = case
                when event_outbox.status = 'PROCESSING' then event_outbox.retry_count + 1
                else event_outbox.retry_count
              end,
              last_error = case
                when event_outbox.status = 'PROCESSING' then $4
                else event_outbox.last_error
              end
        where id in (select id from locked_batch)
        returning id, event_id, execution_id, event_type, payload, metadata, sequence, idempotency_key, original_timestamp, tenant_id`,
      [now.toISOString(), batchSize, visibleAfter.toISOString(), STRANDED_RECOVERY_MARKER]
    );

    const rows = claimResult.rows;
    if (rows.length === 0) {
      return 0;
    }

    // FIFO enforcement (O1): the claim CTE selects candidates `order by sequence`,
    // but `UPDATE … RETURNING` does NOT preserve that order — Postgres returns
    // updated rows in physical/arbitrary order. Delivering or asserting in that
    // order intermittently trips the O1 invariant (e.g. a reclaimed stranded
    // seq=1 returned after a PENDING seq=2). Sort the claimed batch by
    // (execution_id, sequence) so delivery is genuinely FIFO per execution and
    // the invariant below validates an already-ordered batch rather than
    // depending on RETURNING order.
    rows.sort((a, b) => {
      if (a.execution_id !== b.execution_id) {
        return a.execution_id < b.execution_id ? -1 : 1;
      }
      return Number(a.sequence) - Number(b.sequence);
    });

    // O1 Invariant: outbox publication FIFO order preservation
    const lastSequencePerExecution = new Map<string, number>();
    for (const r of rows) {
      const prevSeq = lastSequencePerExecution.get(r.execution_id);
      if (prevSeq !== undefined) {
        assertRuntimeInvariant(
          "O1",
          Number(r.sequence) > prevSeq,
          `FIFO Ordering violation: outbox batch processed event seq ${r.sequence} after seq ${prevSeq} for execution ${r.execution_id}`,
          { executionId: r.execution_id, currentSeq: r.sequence, previousSeq: prevSeq }
        );
      }
      lastSequencePerExecution.set(r.execution_id, Number(r.sequence));
    }

    let successfullyDelivered = 0;

    for (const row of rows) {
      // Reconstruct the DomainEvent structure.
      // Audit CRITICAL-3: use the row's original producer-side timestamp
      // when present. Falling back to `now` only for legacy rows written
      // before migration 0011 keeps bus consumers and the events table in
      // agreement on `timestamp` — without this, every redelivery rewrote
      // history.
      const originalTimestamp =
        row.original_timestamp === null || row.original_timestamp === undefined
          ? now.toISOString()
          : row.original_timestamp instanceof Date
            ? row.original_timestamp.toISOString()
            : new Date(row.original_timestamp).toISOString();
      const event: DomainEvent = {
        id: row.event_id,
        type: row.event_type as DomainEvent["type"],
        aggregateId: row.execution_id,
        aggregateType: "EXECUTION",
        version: 1,
        timestamp: originalTimestamp,
        payload: row.payload as unknown as DomainEvent["payload"],
        metadata: row.metadata as unknown as DomainEvent["metadata"],
        sequence: Number(row.sequence)
      };

      try {
        // Publish to the event bus
        await this.bus.publish(event);

        // Delete from the outbox on success (keeps table lean)
        await this.db.query(`delete from event_outbox where id = $1`, [row.id]);

        // Register in publisher memory dedup
        this.publisher.confirmDelivered(row.event_id);
        successfullyDelivered += 1;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger?.error(`OutboxDispatcher failed to publish event ${row.event_id}: ${errMsg}`);

        // Handle failure/poison metrics
        const retryCountResult = await this.db.query<{ retry_count: number }>(
          `select retry_count from event_outbox where id = $1`,
          [row.id]
        );
        const currentRetry = retryCountResult.rows[0] ? Number(retryCountResult.rows[0].retry_count) : 0;

        if (currentRetry >= MAX_RETRIES) {
          // Promote to DLQ as a poison event to prevent execution sequence starvation
          this.logger?.warn(`Outbox event ${row.event_id} reached max retries (${MAX_RETRIES}). Moving to DLQ.`);
          
          await this.db.withTransaction(async (tx) => {
            // Write to DLQ
            await tx.query(
              `insert into event_outbox_dlq (id, event_id, execution_id, event_type, payload, metadata, sequence, idempotency_key, last_error, original_timestamp, tenant_id)
               values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11)
               on conflict (event_id) do nothing`,
              [
                row.id,
                row.event_id,
                row.execution_id,
                row.event_type,
                JSON.stringify(row.payload),
                JSON.stringify(row.metadata),
                row.sequence,
                row.idempotency_key,
                errMsg,
                row.original_timestamp instanceof Date
                  ? row.original_timestamp.toISOString()
                  : row.original_timestamp ?? null,
                // Carry the tenant from the originating outbox row so a
                // dead-lettered side effect stays attributed to its tenant.
                row.tenant_id ?? "system"
              ]
            );
            // Delete from active outbox queue
            await tx.query(`delete from event_outbox where id = $1`, [row.id]);
          });
        } else {
          // Put back to PENDING with exponential backoff
          const nextAttemptDelaySec = Math.pow(2, currentRetry + 1);
          const nextAttemptAt = new Date(Date.now() + nextAttemptDelaySec * 1000);

          await this.db.query(
            `update event_outbox
                set status = 'PENDING',
                    retry_count = retry_count + 1,
                    visible_after = $2,
                    last_error = $3
              where id = $1`,
            [row.id, nextAttemptAt.toISOString(), errMsg]
          );
        }
      }
    }

    return successfullyDelivered;
  }

  /**
   * Legacy in-memory tick. Drains PersistedEventPublisher's in-process queue.
   */
  private async tickMemory(): Promise<number> {
    const pending = this.publisher.peekPending();
    let delivered = 0;

    // O1 Invariant: outbox publication FIFO order preservation (in-memory)
    const lastSequencePerExecution = new Map<string, number>();
    for (const event of pending) {
      if (event.aggregateType === "EXECUTION") {
        const prevSeq = lastSequencePerExecution.get(event.aggregateId);
        if (prevSeq !== undefined && event.sequence !== undefined) {
          assertRuntimeInvariant(
            "O1",
            event.sequence > prevSeq,
            `FIFO Ordering violation in-memory: outbox batch processed event seq ${event.sequence} after seq ${prevSeq} for execution ${event.aggregateId}`,
            { executionId: event.aggregateId, currentSeq: event.sequence, previousSeq: prevSeq }
          );
        }
        if (event.sequence !== undefined) {
          lastSequencePerExecution.set(event.aggregateId, event.sequence);
        }
      }
    }

    for (const event of pending) {
      try {
        await this.bus.publish(event);
        this.publisher.confirmDelivered(event.id);
        delivered += 1;
      } catch {
        break;
      }
    }
    return delivered;
  }

  /** Drain until empty or the bus fails. */
  async drainAll(): Promise<number> {
    let total = 0;
    let last = -1;
    while (last !== 0) {
      last = await this.tick();
      total += last;
    }
    return total;
  }
}
