import type { RuntimeWorker, WorkerStatus } from "../../../domain/cluster.js";
import type { WorkerRegistry } from "../../../domain/clusterPorts.js";
import { toIso } from "../../../shared/clock.js";
import type { PgClient } from "../../persistence/postgres/pgClient.js";
import { isValidUuid } from "../../../shared/id.js";

export class PostgresWorkerRegistry implements WorkerRegistry {
  constructor(private readonly client: PgClient) {}

  async register(worker: RuntimeWorker): Promise<RuntimeWorker> {
    if (!isValidUuid(worker.id)) {
      throw new Error(`PostgreSQL UUID validation failed: worker.id must be a valid UUID, got "${worker.id}"`);
    }
    const { rows } = await this.client.query<WorkerRow>(
      `insert into runtime_workers (
         id, host, region, version, capacity, status, load,
         started_at, last_heartbeat_at, metadata
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (id) do update set
         host = excluded.host,
         region = excluded.region,
         version = excluded.version,
         capacity = excluded.capacity,
         status = excluded.status,
         load = excluded.load,
         last_heartbeat_at = excluded.last_heartbeat_at,
         metadata = excluded.metadata
       returning *`,
      [
        worker.id,
        worker.host,
        worker.region ?? null,
        worker.version,
        worker.capacity,
        worker.status,
        JSON.stringify(worker.load),
        worker.startedAt,
        worker.lastHeartbeatAt,
        worker.metadata ? JSON.stringify(worker.metadata) : null
      ]
    );
    return rowToWorker(rows[0]!);
  }

  async heartbeat(workerId: string, load: RuntimeWorker["load"]): Promise<RuntimeWorker | undefined> {
    const { rows } = await this.client.query<WorkerRow>(
      `update runtime_workers
          set load = $2,
              last_heartbeat_at = $3
          where id = $1 and status not in ('LOST', 'STOPPED')
          returning *`,
      [workerId, JSON.stringify(load), toIso(new Date())]
    );
    return rows[0] ? rowToWorker(rows[0]) : undefined;
  }

  async markStatus(workerId: string, status: WorkerStatus): Promise<RuntimeWorker | undefined> {
    const { rows } = await this.client.query<WorkerRow>(
      `update runtime_workers set status = $2 where id = $1 returning *`,
      [workerId, status]
    );
    return rows[0] ? rowToWorker(rows[0]) : undefined;
  }

  async getById(workerId: string): Promise<RuntimeWorker | undefined> {
    const { rows } = await this.client.query<WorkerRow>(
      `select * from runtime_workers where id = $1`,
      [workerId]
    );
    return rows[0] ? rowToWorker(rows[0]) : undefined;
  }

  async list(): Promise<RuntimeWorker[]> {
    const { rows } = await this.client.query<WorkerRow>(
      `select * from runtime_workers order by last_heartbeat_at desc`
    );
    return rows.map(rowToWorker);
  }

  async expireStale(now: Date, ttlMs: number): Promise<RuntimeWorker[]> {
    const cutoff = toIso(new Date(now.getTime() - ttlMs));
    const { rows } = await this.client.query<WorkerRow>(
      `update runtime_workers
          set status = 'LOST'
          where last_heartbeat_at < $1
            and status not in ('LOST', 'STOPPED')
          returning *`,
      [cutoff]
    );
    return rows.map(rowToWorker);
  }
}

interface WorkerRow {
  id: string;
  host: string;
  region: string | null;
  version: string;
  capacity: number;
  status: string;
  load: RuntimeWorker["load"];
  started_at: Date | string;
  last_heartbeat_at: Date | string;
  metadata: Record<string, unknown> | null;
}

function rowToWorker(row: WorkerRow): RuntimeWorker {
  return {
    id: row.id,
    host: row.host,
    region: row.region ?? undefined,
    version: row.version,
    capacity: row.capacity,
    status: row.status as WorkerStatus,
    load: row.load,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    lastHeartbeatAt: row.last_heartbeat_at instanceof Date ? row.last_heartbeat_at.toISOString() : String(row.last_heartbeat_at),
    metadata: row.metadata ?? undefined
  };
}
