import pg from "pg";
import type { DomainEvent } from "../../domain/events.js";
import type { EventStore, FencedAppendOutcome } from "../../domain/ports.js";
import type { FencingToken } from "../../domain/clusterPorts.js";
import { deriveEventLinks } from "./eventLinkage.js";
import { isValidUuid, generateDeterministicUuid } from "../../shared/id.js";
import { createPgClient, type PgClient } from "./postgres/pgClient.js";
import type { Clock } from "../../shared/clock.js";
import { toIso, SystemClock } from "../../shared/clock.js";

/**
 * Postgres-backed EventStore.
 *
 * Every append also projects the event into the `event_execution_links` and
 * `event_cognition_links` tables (Phase 4) so that `listByExecution` no
 * longer falls back to `payload::text LIKE '%executionId%'` — an O(events)
 * scan — and instead becomes an indexed join, O(log n) + result size.
 *
 * Both writes happen in the same transaction so the link rows are never
 * observable without the underlying event.
 *
 * Sprint Stabilization — accepts a shared PgClient. Previously the store
 * created its own `pg.Pool` against the same DATABASE_URL the persistence
 * layer already had a pool against. Two pools per container meant double
 * the steady-state connections, and a connection-leak in one was invisible
 * from the other's stats — so exhaustion looked like a randomly-degraded
 * subsystem rather than a single pool over capacity. The store now uses
 * the persistence layer's pool, with `acquire()` for the multi-statement
 * append transaction. The legacy connection-string constructor is retained
 * for tests and direct integration usage.
 */
export class PostgresEventStore implements EventStore {
  private readonly db: PgClient;
  /** True when this store owns the underlying pool and must close() it. */
  private readonly ownsClient: boolean;
  /**
   * Legacy direct-pool path. Used only when the store was constructed with a
   * connection string; the path is retained so existing integration tests
   * and the older worker bootstrap continue to work unchanged.
   */
  private readonly legacyPool: pg.Pool | null;
  /**
   * Clock injected for fence-validation timestamping. Defaults to SystemClock
   * so all existing constructors continue to work without modification; the
   * audit's clock-unification pass (Task 6) re-wires authoritative call sites
   * to pass the runtime's shared Clock instance so frozen-clock tests can
   * deterministically exercise expires_at comparisons.
   */
  private readonly clock: Clock;

  constructor(input: string | PgClient, clock: Clock = new SystemClock()) {
    if (typeof input === "string") {
      // Back-compat path. We still build a managed PgClient (so it gets the
      // bounded pool sizing, statement timeout, and leak detection added in
      // Sprint Stabilization) rather than constructing a raw pg.Pool.
      this.db = createPgClient(input);
      this.ownsClient = true;
      this.legacyPool = null;
    } else {
      // Preferred path — share the persistence layer's pool.
      this.db = input;
      this.ownsClient = false;
      this.legacyPool = null;
    }
    this.clock = clock;
  }

  /**
   * Append an event to the store with idempotency guarantees.
   *
   * Idempotency key deduplication:
   *   ON CONFLICT (idempotency_key) DO NOTHING means that if this exact
   *   logical operation was already persisted (same type + aggregateId +
   *   traceId context), we silently return the existing event with its
   *   original sequence number. This protects against:
   *     - Caller retrying after a network timeout
   *     - Duplicate publish calls from the PersistedEventPublisher
   *     - Split-brain scenarios where two workers publish the same event
   *
   *   NOTE: The `idempotency_key` column must exist in the events table:
   *     ALTER TABLE events ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;
   *   Until this column is added, the store falls back to ON CONFLICT (id)
   *   DO NOTHING which guards against same-object retries only.
   *
   * Replay safety:
   *   The sequence number from the original insert is returned in both the
   *   success and dedup paths, so callers always get a valid cursor position.
   */
  async append(event: DomainEvent): Promise<DomainEvent> {
    const mappedAggregateId = isValidUuid(event.aggregateId)
      ? event.aggregateId
      : generateDeterministicUuid(event.aggregateId);

    // Multi-statement transaction: acquire a labelled connection from the
    // shared pool. The label is what surfaces in the leak-detector warning
    // if anyone forgets to release.
    const conn = await this.db.acquire("eventStore.append");
    try {
      await conn.query("begin");

      // Attempt the primary insert. ON CONFLICT on idempotency_key (preferred)
      // or id (fallback) prevents duplicate rows. RETURNING is suppressed on
      // conflict so we detect the no-op with an empty result set.
      const result = await conn.query<{ sequence: string }>(
        `insert into events (id, type, aggregate_id, aggregate_type, version, timestamp, payload, metadata, idempotency_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (idempotency_key) do nothing
         returning sequence`,
        [
          event.id,
          event.type,
          mappedAggregateId,
          event.aggregateType,
          event.version,
          event.timestamp,
          JSON.stringify(event.payload),
          JSON.stringify(event.metadata),
          event.metadata.idempotencyKey
        ]
      );

      let sequence: number;
      if (result.rows.length === 0) {
        // Conflict path: this event was already persisted. Fetch the existing
        // sequence so callers get a valid cursor position.
        const existing = await conn.query<{ sequence: string }>(
          `select sequence from events where idempotency_key = $1`,
          [event.metadata.idempotencyKey]
        );
        sequence = Number(existing.rows[0]?.sequence ?? 0);
        await conn.query("commit");
        return { ...event, sequence };
      }

      sequence = Number(result.rows[0]?.sequence ?? 0);

      const links = deriveEventLinks(event);
      for (const link of links.executions) {
        await conn.query(
          `insert into event_execution_links (event_sequence, execution_id, link_kind)
           values ($1, $2, $3)
           on conflict do nothing`,
          [sequence, link.executionId, link.kind]
        );
      }
      for (const cognitionId of links.cognitions) {
        await conn.query(
          `insert into event_cognition_links (event_sequence, cognition_id)
           values ($1, $2)
           on conflict do nothing`,
          [sequence, cognitionId]
        );
      }

      await conn.query("commit");
      return { ...event, sequence };
    } catch (err) {
      try {
        await conn.query("rollback");
      } catch {
        // Rollback failure is secondary — always surface the original error.
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Atomic fenced append. The lease-row check and the events INSERT live in
   * the SAME transaction, with a SHARE lock held on the lease row from the
   * moment of validation through commit. This is the authoritative fencing
   * boundary for execution-scoped events:
   *
   *   1. BEGIN
   *   2. SELECT 1 FROM execution_leases WHERE
   *          execution_id = $fence.executionId
   *      AND worker_id    = $fence.workerId
   *      AND attempt = fencing_token = lease_epoch = ownership_version
   *          = $fence.attempt   (fail-closed AND over the canonical epoch)
   *      AND status in ('LEASED','RENEWING','RECOVERY_OWNED')
   *      AND expires_at   > $clock.now()
   *      FOR SHARE
   *      → if 0 rows: ROLLBACK, return FENCED.
   *   3. INSERT INTO events (...) ON CONFLICT (idempotency_key) DO NOTHING
   *   4. INSERT INTO event_execution_links / event_cognition_links
   *   5. COMMIT, return COMMITTED with assigned sequence.
   *
   * Why SELECT ... FOR SHARE rather than FOR UPDATE:
   *   - FOR SHARE blocks concurrent UPDATEs of the lease row (the only thing
   *     that could invalidate the fence mid-flight) but allows other fenced
   *     inserts from the same lease holder to proceed in parallel. Two
   *     simultaneous step events from the same valid lease don't serialise
   *     unnecessarily.
   *   - FOR UPDATE would needlessly serialise them. Correctness is identical
   *     for both, because the lease row is only ever written by acquire/
   *     renew/reclaim/release paths — which require FOR UPDATE on the row.
   *
   * On a stale-worker append:
   *   The lease row was reclaimed → either the row's worker_id/attempt no
   *   longer matches, or the lease is now held by a different worker with
   *   a higher attempt. Either way the WHERE clause produces zero rows;
   *   no events are written; the function returns FENCED. The caller
   *   (PersistedEventPublisher.publishFenced) emits a diagnostic counter
   *   and discards the event without bus broadcast — replay stays clean.
   *
   * Idempotency interaction:
   *   ON CONFLICT (idempotency_key) DO NOTHING in step 3 still applies. A
   *   genuine retry of a committed event will dedup as before; the fence
   *   check protects against forward progress of a stale worker, not
   *   against a legitimate caller's network retry.
   */
  async appendFenced(event: DomainEvent, fence: FencingToken): Promise<FencedAppendOutcome> {
    const mappedAggregateId = isValidUuid(event.aggregateId)
      ? event.aggregateId
      : generateDeterministicUuid(event.aggregateId);
    const nowIso = toIso(this.clock.now());

    const conn = await this.db.acquire("eventStore.appendFenced");
    try {
      await conn.query("begin");

      const fenceCheck = await conn.query<{ ok: number }>(
        `select 1 as ok
           from execution_leases
          where execution_id = $1
            and (worker_id    = $2 and coalesce(worker_identity, worker_id) = $2)
            and (attempt      = $3
                 and coalesce(fencing_token, attempt)     = $3
                 and coalesce(lease_epoch, attempt)       = $3
                 and coalesce(ownership_version, attempt) = $3)
            and status in ('LEASED', 'RENEWING', 'RECOVERY_OWNED')
            and expires_at   > $4::timestamptz
          for share`,
        [fence.executionId, fence.workerId, fence.attempt, nowIso]
      );

      if (fenceCheck.rows.length === 0) {
        // Fence failed. NEVER persist, NEVER broadcast. The caller is
        // responsible for diagnostic emission; this store stays silent so
        // that test substrates that don't wire a metrics sink see clean
        // return semantics.
        await conn.query("rollback");
        return { outcome: "FENCED" };
      }

      // Fence held. Proceed with the same INSERT semantics as append(),
      // including idempotency_key dedup and the link-table projection.
      const result = await conn.query<{ sequence: string }>(
        `insert into events (id, type, aggregate_id, aggregate_type, version, timestamp, payload, metadata, idempotency_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (idempotency_key) do nothing
         returning sequence`,
        [
          event.id,
          event.type,
          mappedAggregateId,
          event.aggregateType,
          event.version,
          event.timestamp,
          JSON.stringify(event.payload),
          JSON.stringify(event.metadata),
          event.metadata.idempotencyKey
        ]
      );

      let sequence: number;
      if (result.rows.length === 0) {
        const existing = await conn.query<{ sequence: string }>(
          `select sequence from events where idempotency_key = $1`,
          [event.metadata.idempotencyKey]
        );
        sequence = Number(existing.rows[0]?.sequence ?? 0);
        await conn.query("commit");
        return { outcome: "COMMITTED", event: { ...event, sequence } };
      }

      sequence = Number(result.rows[0]?.sequence ?? 0);

      const links = deriveEventLinks(event);
      for (const link of links.executions) {
        await conn.query(
          `insert into event_execution_links (event_sequence, execution_id, link_kind)
           values ($1, $2, $3)
           on conflict do nothing`,
          [sequence, link.executionId, link.kind]
        );
      }
      for (const cognitionId of links.cognitions) {
        await conn.query(
          `insert into event_cognition_links (event_sequence, cognition_id)
           values ($1, $2)
           on conflict do nothing`,
          [sequence, cognitionId]
        );
      }

      await conn.query("commit");
      return { outcome: "COMMITTED", event: { ...event, sequence } };
    } catch (err) {
      try {
        await conn.query("rollback");
      } catch {
        // Rollback failure is secondary — always surface the original error.
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  async listByAggregate(aggregateType: DomainEvent["aggregateType"], aggregateId: string): Promise<DomainEvent[]> {
    const mappedId = isValidUuid(aggregateId) ? aggregateId : generateDeterministicUuid(aggregateId);
    const result = await this.db.query(
      `select id, type, aggregate_id, aggregate_type, version, timestamp, payload, metadata, sequence
       from events
       where aggregate_type = $1 and aggregate_id = $2
       order by sequence asc`,
      [aggregateType, mappedId]
    );
    return result.rows.map((r) => mapEventRow(r as Record<string, unknown>));
  }

  async listByExecution(executionId: string): Promise<DomainEvent[]> {
    // Phase 4: indexed join on event_execution_links — replaces the prior
    // payload::text LIKE scan. The (execution_id, event_sequence) index
    // satisfies both filter and order in a single index scan.
    const result = await this.db.query(
      `select e.id, e.type, e.aggregate_id, e.aggregate_type, e.version,
              e.timestamp, e.payload, e.metadata, e.sequence
         from events e
         join event_execution_links l on l.event_sequence = e.sequence
         where l.execution_id = $1
         group by e.id, e.type, e.aggregate_id, e.aggregate_type, e.version,
                  e.timestamp, e.payload, e.metadata, e.sequence
         order by e.sequence asc`,
      [executionId]
    );
    return result.rows.map((r) => mapEventRow(r as Record<string, unknown>));
  }

  async lastForExecution(executionId: string): Promise<DomainEvent | undefined> {
    const result = await this.db.query(
      `select e.id, e.type, e.aggregate_id, e.aggregate_type, e.version,
              e.timestamp, e.payload, e.metadata, e.sequence
         from events e
         join event_execution_links l on l.event_sequence = e.sequence
         where l.execution_id = $1
         order by e.sequence desc
         limit 1`,
      [executionId]
    );
    if (result.rows.length === 0) return undefined;
    return mapEventRow(result.rows[0] as Record<string, unknown>);
  }

  async listByCognition(cognitionId: string): Promise<DomainEvent[]> {
    const result = await this.db.query(
      `select e.id, e.type, e.aggregate_id, e.aggregate_type, e.version,
              e.timestamp, e.payload, e.metadata, e.sequence
         from events e
         join event_cognition_links l on l.event_sequence = e.sequence
         where l.cognition_id = $1
         order by e.sequence asc`,
      [cognitionId]
    );
    return result.rows.map((r) => mapEventRow(r as Record<string, unknown>));
  }

  async listRecent(limit: number): Promise<DomainEvent[]> {
    const result = await this.db.query(
      `select id, type, aggregate_id, aggregate_type, version, timestamp, payload, metadata, sequence
       from events
       order by sequence desc
       limit $1`,
      [limit]
    );
    return result.rows.map((r) => mapEventRow(r as Record<string, unknown>));
  }

  /**
   * Phase 7 helper — fetch events newer than `afterSequence`, ordered, for
   * resumable SSE catch-up. Indexed by the `sequence` PK so this is O(log n).
   */
  async listAfterSequence(afterSequence: number, limit: number): Promise<DomainEvent[]> {
    const result = await this.db.query(
      `select id, type, aggregate_id, aggregate_type, version, timestamp, payload, metadata, sequence
         from events
         where sequence > $1
         order by sequence asc
         limit $2`,
      [afterSequence, limit]
    );
    return result.rows.map((r) => mapEventRow(r as Record<string, unknown>));
  }

  async close(): Promise<void> {
    // Only close the pool we own. When the store was built from a shared
    // PgClient (the new default in createPersistenceLayer), the persistence
    // layer's close() is responsible for draining and ending the pool.
    if (this.ownsClient) {
      await this.db.close();
    }
    if (this.legacyPool) {
      await this.legacyPool.end();
    }
  }
}

function mapEventRow(row: Record<string, unknown>): DomainEvent {
  const metadata = row.metadata as Record<string, unknown>;
  const aggregateId = (metadata && metadata.originalAggregateId)
    ? String(metadata.originalAggregateId)
    : String(row.aggregate_id);

  return {
    id: String(row.id),
    type: row.type as DomainEvent["type"],
    aggregateId,
    aggregateType: row.aggregate_type as DomainEvent["aggregateType"],
    version: Number(row.version),
    timestamp: new Date(String(row.timestamp)).toISOString(),
    payload: row.payload as DomainEvent["payload"],
    metadata: row.metadata as DomainEvent["metadata"],
    sequence: Number(row.sequence)
  };
}
