import type { ExecutionLease } from "../../../domain/cluster.js";
import type { AcquireLeaseInput, LeaseStore } from "../../../domain/clusterPorts.js";
import { toIso } from "../../../shared/clock.js";
import type { PgClient } from "../../persistence/postgres/pgClient.js";
import { isValidUuid } from "../../../shared/id.js";

/**
 * Postgres-backed LeaseStore with `FOR UPDATE SKIP LOCKED` semantics for
 * distributed lease coordination.
 *
 * Acquire flow (single round-trip, race-safe):
 *   1. SELECT existing lease FOR UPDATE SKIP LOCKED — concurrent workers
 *      contending for the same execution simply *skip* this row instead of
 *      blocking, so worker N+1 immediately returns "could not acquire" and
 *      moves on to the next job.
 *   2. If no active lease (or it's expired/released), INSERT/UPDATE and
 *      return the new lease.
 *   3. Otherwise return undefined — the caller knows another worker owns it.
 *
 * All writes happen inside the same transaction as the SELECT, so the
 * row-level lock holds until COMMIT.
 */
export class PostgresLeaseStore implements LeaseStore {
  constructor(private readonly client: PgClient) {}

  async acquire({ executionId, workerId, ttlMs, now }: AcquireLeaseInput): Promise<ExecutionLease | undefined> {
    if (!isValidUuid(executionId) || !isValidUuid(workerId)) {
      throw new Error(`Lease acquisition validation failed: executionId and workerId must be valid UUIDs, got executionId="${executionId}", workerId="${workerId}"`);
    }
    return this.client.withTransaction(async (tx) => {
      const { rows: existingRows } = await tx.query<LeaseRow>(
        `select execution_id, worker_id, acquired_at, renewed_at, expires_at,
                status, attempt
           from execution_leases
           where execution_id = $1
           for update skip locked`,
        [executionId]
      );

      const existing = existingRows[0];
      const nowMs = now.getTime();

      if (existing && existing.status === "ACTIVE") {
        const expiresAt = new Date(existing.expires_at).getTime();
        if (expiresAt > nowMs) {
          // Active lease held by another worker (or the row was skip-locked).
          return undefined;
        }
      }

      const attempt = existing ? Number(existing.attempt) + 1 : 1;
      const expiresAt = toIso(new Date(nowMs + ttlMs));

      // ON CONFLICT semantics:
      //   The SELECT FOR UPDATE SKIP LOCKED above only skips *existing* rows.
      //   For a brand-new execution with N concurrent acquirers, no row exists
      //   yet, so every contender falls through to the INSERT. The first INSERT
      //   wins; subsequent INSERTs would otherwise overwrite worker_id via
      //   DO UPDATE, and each would see its own workerId in the RETURNING row
      //   — producing N "owners" for the same lease.
      //
      //   The WHERE clause restricts DO UPDATE to the cases where re-acquire
      //   is actually legal: the prior lease was released, reclaimed, expired,
      //   or its expires_at is already in the past. An ACTIVE, unexpired
      //   lease is left untouched, RETURNING produces zero rows for the
      //   loser, and acquire() returns undefined — the correct "another
      //   worker owns it" signal.
      const { rows } = await tx.query<LeaseRow>(
        `insert into execution_leases (
            execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt
          ) values ($1, $2, $3, $3, $4, 'ACTIVE', $5)
          on conflict (execution_id) do update set
            worker_id = excluded.worker_id,
            acquired_at = excluded.acquired_at,
            renewed_at = excluded.renewed_at,
            expires_at = excluded.expires_at,
            status = 'ACTIVE',
            attempt = excluded.attempt
          where execution_leases.status <> 'ACTIVE'
             or execution_leases.expires_at <= $3::timestamptz
          returning execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt`,
        [executionId, workerId, toIso(now), expiresAt, attempt]
      );

      return rows[0] ? rowToLease(rows[0]) : undefined;
    });
  }

  async renew(executionId: string, workerId: string, now: Date, ttlMs: number): Promise<ExecutionLease | undefined> {
    if (!isValidUuid(executionId) || !isValidUuid(workerId)) {
      throw new Error(`Lease renewal validation failed: executionId and workerId must be valid UUIDs, got executionId="${executionId}", workerId="${workerId}"`);
    }
    const { rows } = await this.client.query<LeaseRow>(
      `update execution_leases
          set renewed_at = $3, expires_at = $4
          where execution_id = $1 and worker_id = $2 and status = 'ACTIVE'
          returning execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt`,
      [executionId, workerId, toIso(now), toIso(new Date(now.getTime() + ttlMs))]
    );
    return rows[0] ? rowToLease(rows[0]) : undefined;
  }

  async release(executionId: string, workerId: string, now: Date): Promise<ExecutionLease | undefined> {
    if (!isValidUuid(executionId) || !isValidUuid(workerId)) {
      throw new Error(`Lease release validation failed: executionId and workerId must be valid UUIDs, got executionId="${executionId}", workerId="${workerId}"`);
    }
    const { rows } = await this.client.query<LeaseRow>(
      `update execution_leases
          set status = 'RELEASED', renewed_at = $3
          where execution_id = $1 and worker_id = $2
          returning execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt`,
      [executionId, workerId, toIso(now)]
    );
    return rows[0] ? rowToLease(rows[0]) : undefined;
  }

  async reclaimExpired(now: Date): Promise<ExecutionLease[]> {
    // FOR UPDATE SKIP LOCKED on the recovery query so two recovery loops on
    // different workers don't fight over the same expired leases.
    return this.client.withTransaction(async (tx) => {
      const { rows: expired } = await tx.query<LeaseRow>(
        `select execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt
           from execution_leases
           where status = 'ACTIVE' and expires_at < $1
           for update skip locked`,
        [toIso(now)]
      );

      if (!expired.length) return [];

      const ids = expired.map((row) => row.execution_id);
      const { rows: updated } = await tx.query<LeaseRow>(
        `update execution_leases
            set status = 'EXPIRED', renewed_at = $2
            where execution_id = any($1::text[])
            returning execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt`,
        [ids, toIso(now)]
      );
      return updated.map(rowToLease);
    });
  }

  async reclaimByWorker(workerId: string, now: Date): Promise<ExecutionLease[]> {
    const { rows } = await this.client.query<LeaseRow>(
      `update execution_leases
          set status = 'RECLAIMED', renewed_at = $2
          where worker_id = $1 and status = 'ACTIVE'
          returning execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt`,
      [workerId, toIso(now)]
    );
    return rows.map(rowToLease);
  }

  async getByExecution(executionId: string): Promise<ExecutionLease | undefined> {
    const { rows } = await this.client.query<LeaseRow>(
      `select execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt
         from execution_leases where execution_id = $1`,
      [executionId]
    );
    return rows[0] ? rowToLease(rows[0]) : undefined;
  }

  async listActive(): Promise<ExecutionLease[]> {
    const { rows } = await this.client.query<LeaseRow>(
      `select execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt
         from execution_leases where status = 'ACTIVE'
         order by acquired_at asc`
    );
    return rows.map(rowToLease);
  }

  /**
   * Validate that the caller still owns the lease with the expected fencing
   * token (= lease.attempt at acquisition time).
   *
   * Corruption risk prevented:
   *   A stale worker that survived a GC pause or network partition may try to
   *   commit execution results after its lease was reclaimed. Without fencing
   *   validation, the stale write lands and overwrites the legitimate result.
   *   This atomic check ensures the commit only proceeds if the worker still
   *   holds the lease with the SAME attempt count it received at acquisition.
   *
   * Distributed implications:
   *   The check is a single SELECT — it does not hold a lock. It is therefore
   *   a "read-your-writes" consistency check, not a distributed lock. It
   *   prevents the stale-worker case where the old worker is the only one
   *   trying to write. In a true split-brain (both workers simultaneously
   *   writing), the last-writer-wins semantics of the execution repository
   *   apply — use Postgres transactions in ExecutionRepository for stronger
   *   guarantees if needed.
   *
   * Returns `true` if the token is valid and the worker still owns the lease.
   * Returns `false` if the lease was lost, the attempt changed, or the lease
   * does not exist — the caller MUST abort and emit EXECUTION_FENCE_VIOLATED.
   */
  async validateFencing(executionId: string, workerId: string, fencingToken: number): Promise<boolean> {
    if (!isValidUuid(executionId) || !isValidUuid(workerId)) {
      throw new Error(`Fencing validation failed: executionId and workerId must be valid UUIDs, got executionId="${executionId}", workerId="${workerId}"`);
    }
    const { rows } = await this.client.query<LeaseRow>(
      `select execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt
         from execution_leases
         where execution_id = $1`,
      [executionId]
    );
    const lease = rows[0];
    if (!lease) return false;
    if (lease.worker_id !== workerId) return false;
    if (lease.status !== "ACTIVE") return false;
    if (Number(lease.attempt) !== fencingToken) return false;
    // Also reject if the lease has expired — the heartbeat worker should have
    // renewed it, but if it didn't (e.g., CB open on Postgres), we must fence.
    if (new Date(lease.expires_at).getTime() < Date.now()) return false;
    return true;
  }
}

interface LeaseRow {
  execution_id: string;
  worker_id: string;
  acquired_at: Date | string;
  renewed_at: Date | string;
  expires_at: Date | string;
  status: string;
  attempt: number | string;
}

function rowToLease(row: LeaseRow): ExecutionLease {
  return {
    executionId: row.execution_id,
    workerId: row.worker_id,
    acquiredAt: toIsoValue(row.acquired_at),
    renewedAt: toIsoValue(row.renewed_at),
    expiresAt: toIsoValue(row.expires_at),
    status: row.status as ExecutionLease["status"],
    attempt: Number(row.attempt)
  };
}

function toIsoValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
