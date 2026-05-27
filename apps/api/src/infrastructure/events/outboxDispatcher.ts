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

const MAX_RETRIES = 5;
const VISIBILITY_TIMEOUT_SEC = 30;

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
}

export class OutboxDispatcher {
  constructor(
    private readonly publisher: PersistedEventPublisher,
    private readonly bus: EventBus,
    private readonly db?: PgClient,
    private readonly logger?: { info: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void; warn: (msg: string, ...args: unknown[]) => void }
  ) {}

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
    const visibleAfter = new Date(now.getTime() + VISIBILITY_TIMEOUT_SEC * 1000);

    // 1. Claim a batch of eligible candidates by setting status to PROCESSING
    const claimResult = await this.db.query<OutboxRow>(
      `with eligible_candidates as (
         select id, execution_id, sequence
           from event_outbox
          where status = 'PENDING'
            and visible_after <= $1
       ),
       ordered_candidates as (
         select ec.id
           from eligible_candidates ec
          where not exists (
            select 1 
              from event_outbox prev
             where prev.execution_id = ec.execution_id
               and prev.sequence < ec.sequence
               and prev.status in ('PENDING', 'PROCESSING')
          )
          order by ec.sequence asc
          limit $2
       ),
       locked_batch as (
         select id 
           from event_outbox
          where id in (select id from ordered_candidates)
            for update skip locked
       )
       update event_outbox
          set status = 'PROCESSING',
              visible_after = $3
        where id in (select id from locked_batch)
        returning id, event_id, execution_id, event_type, payload, metadata, sequence, idempotency_key, original_timestamp`,
      [now.toISOString(), batchSize, visibleAfter.toISOString()]
    );

    const rows = claimResult.rows;
    if (rows.length === 0) {
      return 0;
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
              `insert into event_outbox_dlq (id, event_id, execution_id, event_type, payload, metadata, sequence, idempotency_key, last_error)
               values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
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
                errMsg
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
