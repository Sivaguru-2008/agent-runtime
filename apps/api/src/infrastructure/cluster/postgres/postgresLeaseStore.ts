import type { ExecutionLease } from "../../../domain/cluster.js";
import type { AcquireLeaseInput, LeaseStore } from "../../../domain/clusterPorts.js";
import { toIso } from "../../../shared/clock.js";
import type { PgClient } from "../../persistence/postgres/pgClient.js";
import { createId } from "../../../shared/id.js";

/**
 * Postgres-backed LeaseStore with `FOR UPDATE SKIP LOCKED` semantics for
 * distributed lease coordination.
 */
export class PostgresLeaseStore implements LeaseStore {
  constructor(private readonly client: PgClient) {}

  async acquire({ executionId, workerId, ttlMs, now }: AcquireLeaseInput): Promise<ExecutionLease | undefined> {
    return this.client.withTransaction(async (tx) => {
      const { rows: existingRows } = await tx.query<LeaseRow>(
        `select execution_id, worker_id, acquired_at, renewed_at, expires_at,
                status, attempt, lease_id, lease_epoch, fencing_token, ownership_version, worker_identity
           from execution_leases
           where execution_id = $1
           for update skip locked`,
        [executionId]
      );

      const existing = existingRows[0];
      const nowMs = now.getTime();

      if (existing) {
        const isActive = existing.status === "LEASE_PENDING" || existing.status === "LEASED" || existing.status === "RENEWING" || existing.status === "RECOVERY_OWNED";
        const expiresAt = new Date(existing.expires_at).getTime();
        if (isActive && expiresAt > nowMs) {
          // Active lease held by another worker (or the row was skip-locked).
          return undefined;
        }
      }

      const attempt = existing ? Number(existing.attempt) + 1 : 1;
      if (existing && attempt <= Number(existing.attempt)) {
        throw new Error(`Epoch rollback attempt rejected: new attempt ${attempt} <= existing ${existing.attempt}`);
      }
      const expiresAt = toIso(new Date(nowMs + ttlMs));
      const nextLeaseId = createId();

      const { rows } = await tx.query<LeaseRow>(
        `insert into execution_leases (
            execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt, lease_id,
            lease_epoch, fencing_token, ownership_version, worker_identity
          ) values ($1, $2, $3, $3, $4, 'LEASED', $5, $6, $5, $5, $5, $2)
          on conflict (execution_id) do update set
            worker_id = excluded.worker_id,
            acquired_at = excluded.acquired_at,
            renewed_at = excluded.renewed_at,
            expires_at = excluded.expires_at,
            status = 'LEASED',
            attempt = excluded.attempt,
            lease_id = excluded.lease_id,
            lease_epoch = excluded.lease_epoch,
            fencing_token = excluded.fencing_token,
            ownership_version = excluded.ownership_version,
            worker_identity = excluded.worker_identity
          where execution_leases.status not in ('LEASE_PENDING', 'LEASED', 'RENEWING', 'RECOVERY_OWNED')
             or execution_leases.expires_at <= $3::timestamptz
          returning execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt, lease_id,
                    lease_epoch, fencing_token, ownership_version, worker_identity`,
        [executionId, workerId, toIso(now), expiresAt, attempt, nextLeaseId]
      );

      return rows[0] ? rowToLease(rows[0]) : undefined;
    });
  }

  async renew(executionId: string, workerId: string, now: Date, ttlMs: number): Promise<ExecutionLease | undefined> {
    const { rows } = await this.client.query<LeaseRow>(
      `update execution_leases
          set renewed_at = $3, expires_at = $4, status = 'LEASED'
          where execution_id = $1 and worker_id = $2 and status in ('LEASED', 'RENEWING', 'RECOVERY_OWNED')
          returning execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt, lease_id,
                    lease_epoch, fencing_token, ownership_version, worker_identity`,
      [executionId, workerId, toIso(now), toIso(new Date(now.getTime() + ttlMs))]
    );
    return rows[0] ? rowToLease(rows[0]) : undefined;
  }

  async release(executionId: string, workerId: string, now: Date): Promise<ExecutionLease | undefined> {
    const { rows } = await this.client.query<LeaseRow>(
      `update execution_leases
          set status = 'TRANSFERRED', renewed_at = $3
          where execution_id = $1 and worker_id = $2 and status in ('LEASED', 'RENEWING', 'RECOVERY_OWNED')
          returning execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt, lease_id,
                    lease_epoch, fencing_token, ownership_version, worker_identity`,
      [executionId, workerId, toIso(now)]
    );
    return rows[0] ? rowToLease(rows[0]) : undefined;
  }

  async reclaimExpired(now: Date, limit: number = 10): Promise<ExecutionLease[]> {
    return this.client.withTransaction(async (tx) => {
      const { rows: expired } = await tx.query<LeaseRow>(
        `select execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt, lease_id,
                lease_epoch, fencing_token, ownership_version, worker_identity
           from execution_leases
           where status in ('LEASE_PENDING', 'LEASED', 'RENEWING', 'RECOVERY_OWNED') and expires_at < $1
           for update skip locked
           limit $2`,
        [toIso(now), limit]
      );

      if (!expired.length) return [];

      const ids = expired.map((row) => row.execution_id);
      const { rows: updated } = await tx.query<LeaseRow>(
        `update execution_leases
            set status = 'EXPIRED', renewed_at = $2
            where execution_id = any($1::text[])
            returning execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt, lease_id,
                      lease_epoch, fencing_token, ownership_version, worker_identity`,
        [ids, toIso(now)]
      );
      return updated.map(rowToLease);
    });
  }

  async reclaimByWorker(workerId: string, now: Date): Promise<ExecutionLease[]> {
    const { rows } = await this.client.query<LeaseRow>(
      `update execution_leases
          set status = 'INVALIDATED', renewed_at = $2
          where worker_id = $1 and status in ('LEASE_PENDING', 'LEASED', 'RENEWING', 'RECOVERY_OWNED')
          returning execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt, lease_id,
                    lease_epoch, fencing_token, ownership_version, worker_identity`,
      [workerId, toIso(now)]
    );
    return rows.map(rowToLease);
  }

  async takeoverRecovery(executionId: string, workerId: string, now: Date, ttlMs: number): Promise<ExecutionLease | undefined> {
    return this.client.withTransaction(async (tx) => {
      const { rows: existingRows } = await tx.query<LeaseRow>(
        `select execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt, lease_id,
                lease_epoch, fencing_token, ownership_version, worker_identity
           from execution_leases
           where execution_id = $1
           for update`,
        [executionId]
      );
      const existing = existingRows[0];
      if (!existing) return undefined;
      // Only allow recovery takeover if lease is EXPIRED
      if (existing.status !== "EXPIRED") return undefined;

      const attempt = Number(existing.attempt) + 1;
      if (attempt <= Number(existing.attempt)) {
        throw new Error(`Epoch rollback attempt rejected: new attempt ${attempt} <= existing ${existing.attempt}`);
      }
      const expiresAt = toIso(new Date(now.getTime() + ttlMs));
      const nextLeaseId = createId();

      const { rows } = await tx.query<LeaseRow>(
        `update execution_leases
            set worker_id = $2,
                acquired_at = $3,
                renewed_at = $3,
                expires_at = $4,
                status = 'RECOVERY_OWNED',
                attempt = $5,
                lease_id = $6,
                lease_epoch = $5,
                fencing_token = $5,
                ownership_version = $5,
                worker_identity = $2
            where execution_id = $1 and status = 'EXPIRED'
            returning execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt, lease_id,
                      lease_epoch, fencing_token, ownership_version, worker_identity`,
        [executionId, workerId, toIso(now), expiresAt, attempt, nextLeaseId]
      );
      return rows[0] ? rowToLease(rows[0]) : undefined;
    });
  }

  async getByExecution(executionId: string): Promise<ExecutionLease | undefined> {
    const { rows } = await this.client.query<LeaseRow>(
      `select execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt, lease_id,
              lease_epoch, fencing_token, ownership_version, worker_identity
         from execution_leases where execution_id = $1`,
      [executionId]
    );
    return rows[0] ? rowToLease(rows[0]) : undefined;
  }

  async listActive(): Promise<ExecutionLease[]> {
    const { rows } = await this.client.query<LeaseRow>(
      `select execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt, lease_id,
              lease_epoch, fencing_token, ownership_version, worker_identity
         from execution_leases where status in ('LEASED', 'RENEWING', 'RECOVERY_OWNED')
         order by acquired_at asc`
    );
    return rows.map(rowToLease);
  }

  async validateFencing(executionId: string, workerId: string, fencingToken: number, leaseId?: string, expiration?: string): Promise<boolean> {
    const { rows } = await this.client.query<LeaseRow>(
      `select execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt, lease_id,
              lease_epoch, fencing_token, ownership_version, worker_identity
         from execution_leases
         where execution_id = $1`,
      [executionId]
    );
    const lease = rows[0];
    if (!lease) return false;
    if (lease.worker_id !== workerId) return false;
    if (lease.status !== "LEASED" && lease.status !== "RENEWING" && lease.status !== "RECOVERY_OWNED") return false;
    if (Number(lease.attempt) !== fencingToken) return false;
    if (lease.lease_epoch !== undefined && Number(lease.lease_epoch) !== fencingToken) return false;
    if (leaseId !== undefined && lease.lease_id !== leaseId) return false;
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
  lease_id?: string | null;
  lease_epoch?: number | string | null;
  fencing_token?: number | string | null;
  ownership_version?: number | string | null;
  worker_identity?: string | null;
}

function rowToLease(row: LeaseRow): ExecutionLease {
  return {
    executionId: row.execution_id,
    leaseId: row.lease_id ?? "",
    workerId: row.worker_id,
    acquiredAt: toIsoValue(row.acquired_at),
    renewedAt: toIsoValue(row.renewed_at),
    expiresAt: toIsoValue(row.expires_at),
    status: row.status as ExecutionLease["status"],
    attempt: Number(row.attempt),
    leaseEpoch: row.lease_epoch !== undefined && row.lease_epoch !== null ? Number(row.lease_epoch) : Number(row.attempt),
    lease_epoch: row.lease_epoch !== undefined && row.lease_epoch !== null ? Number(row.lease_epoch) : Number(row.attempt),
    fencingToken: row.fencing_token !== undefined && row.fencing_token !== null ? Number(row.fencing_token) : Number(row.attempt),
    fencing_token: row.fencing_token !== undefined && row.fencing_token !== null ? Number(row.fencing_token) : Number(row.attempt),
    ownershipVersion: row.ownership_version !== undefined && row.ownership_version !== null ? Number(row.ownership_version) : Number(row.attempt),
    ownership_version: row.ownership_version !== undefined && row.ownership_version !== null ? Number(row.ownership_version) : Number(row.attempt),
    workerIdentity: row.worker_identity ?? row.worker_id,
    worker_identity: row.worker_identity ?? row.worker_id
  };
}

function toIsoValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
