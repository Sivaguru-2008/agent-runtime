import type { ExecutionCheckpoint } from "../../../domain/cluster.js";
import type { CheckpointStore, FencedWriteOutcome, FencingToken } from "../../../domain/clusterPorts.js";
import type { PgClient } from "../../persistence/postgres/pgClient.js";

export class PostgresCheckpointStore implements CheckpointStore {
  constructor(private readonly client: PgClient) {}

  async write(checkpoint: ExecutionCheckpoint): Promise<ExecutionCheckpoint> {
    const { rows } = await this.client.query<Row>(
      `insert into execution_checkpoints (
         id, execution_id, worker_id, sequence, phase, state, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set
         state = excluded.state,
         phase = excluded.phase
       returning *`,
      [
        checkpoint.id,
        checkpoint.executionId,
        checkpoint.workerId,
        checkpoint.sequence,
        checkpoint.phase,
        JSON.stringify(checkpoint.state),
        checkpoint.createdAt
      ]
    );
    return rowToCheckpoint(rows[0]!);
  }

  /**
   * Fence-guarded checkpoint write. Mirrors PostgresExecutionRepository.saveFenced:
   * a CTE selects the live lease row with FOR UPDATE, and the INSERT pulls its
   * row source from that CTE. When the lease has been reclaimed/expired/
   * transferred the CTE is empty and the INSERT writes zero rows — the
   * `returning id` then produces zero rows and we surface FENCED.
   *
   * Conflict target uses (execution_id, sequence) rather than primary-key id
   * so that a stale worker cannot land a checkpoint at the same logical
   * sequence as the legitimate owner via a new randomly-generated id. The
   * existing terminal-commit path already uses ON CONFLICT (execution_id,
   * sequence), so this is consistent across the two checkpoint write paths.
   */
  async writeFenced(
    checkpoint: ExecutionCheckpoint,
    fence: FencingToken
  ): Promise<FencedWriteOutcome> {
    const nowIso = new Date().toISOString();
    const { rows } = await this.client.query<{ id: string }>(
      `with fence as (
         select 1 as ok
           from execution_leases
          where execution_id = $8
            and worker_id    = $9
            and attempt      = $10
            and coalesce(fencing_token, attempt)     = $10
            and coalesce(lease_epoch, attempt)       = $10
            and coalesce(ownership_version, attempt) = $10
            and status in ('LEASED', 'RENEWING', 'RECOVERY_OWNED')
            and expires_at   > $11
          for update
       )
       insert into execution_checkpoints (
         id, execution_id, worker_id, sequence, phase, state, created_at
       )
       select $1, $2, $3, $4, $5, $6::jsonb, $7
       from fence
       on conflict (execution_id, sequence) do update set
         phase      = excluded.phase,
         state      = excluded.state,
         created_at = excluded.created_at,
         worker_id  = excluded.worker_id
       returning id`,
      [
        checkpoint.id,
        checkpoint.executionId,
        checkpoint.workerId,
        checkpoint.sequence,
        checkpoint.phase,
        JSON.stringify(checkpoint.state),
        checkpoint.createdAt,
        fence.executionId,
        fence.workerId,
        fence.attempt,
        nowIso
      ]
    );
    return rows.length === 1 ? "COMMITTED" : "FENCED";
  }

  async listByExecution(executionId: string): Promise<ExecutionCheckpoint[]> {
    const { rows } = await this.client.query<Row>(
      `select * from execution_checkpoints
         where execution_id = $1
         order by sequence asc`,
      [executionId]
    );
    return rows.map(rowToCheckpoint);
  }

  async latest(executionId: string): Promise<ExecutionCheckpoint | undefined> {
    const { rows } = await this.client.query<Row>(
      `select * from execution_checkpoints
         where execution_id = $1
         order by sequence desc
         limit 1`,
      [executionId]
    );
    return rows[0] ? rowToCheckpoint(rows[0]) : undefined;
  }
}

interface Row {
  id: string;
  execution_id: string;
  worker_id: string;
  sequence: string | number;
  phase: string;
  state: Record<string, unknown>;
  created_at: Date | string;
}

function rowToCheckpoint(row: Row): ExecutionCheckpoint {
  return {
    id: row.id,
    executionId: row.execution_id,
    workerId: row.worker_id,
    sequence: Number(row.sequence),
    phase: row.phase as ExecutionCheckpoint["phase"],
    state: row.state,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  };
}
