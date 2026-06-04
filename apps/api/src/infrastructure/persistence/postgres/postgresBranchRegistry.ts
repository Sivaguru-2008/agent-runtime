import type { BranchPointer } from "../../../domain/replay.js";
import type { BranchRegistry } from "../../../domain/cognitionPorts.js";
import type { PgClient } from "./pgClient.js";

export class PostgresBranchRegistry implements BranchRegistry {
  constructor(private readonly client: PgClient) {}

  async record(pointer: BranchPointer): Promise<void> {
    await this.client.query(
      // tenant_id (migration 0025) resolves through the source cognition's
      // tenant — a PK lookup on cognition_graphs (already tenant-columned by
      // 0005), so no scan. Unresolvable source falls back to 'system'.
      `insert into replay_branches (
         branch_cognition_id, source_cognition_id, source_node_id,
         branch_point_frame_index, reason, created_at, tenant_id
       ) values (
         $1, $2, $3, $4, $5, $6,
         coalesce((select tenant_id from cognition_graphs where id = $2), 'system')
       )
       on conflict (branch_cognition_id) do nothing`,
      [
        pointer.branchCognitionId,
        pointer.sourceCognitionId,
        pointer.sourceNodeId,
        pointer.branchPointFrameIndex,
        null,
        pointer.createdAt
      ]
    );
  }

  async listForCognition(cognitionId: string): Promise<BranchPointer[]> {
    const { rows } = await this.client.query<Row>(
      `select branch_cognition_id, source_cognition_id, source_node_id,
              branch_point_frame_index, created_at
         from replay_branches
         where source_cognition_id = $1 or branch_cognition_id = $1
         order by created_at asc`,
      [cognitionId]
    );
    return rows.map(rowToPointer);
  }

  async listAll(): Promise<BranchPointer[]> {
    const { rows } = await this.client.query<Row>(
      `select branch_cognition_id, source_cognition_id, source_node_id,
              branch_point_frame_index, created_at
         from replay_branches
         order by created_at desc`
    );
    return rows.map(rowToPointer);
  }
}

interface Row {
  branch_cognition_id: string;
  source_cognition_id: string;
  source_node_id: string;
  branch_point_frame_index: number;
  created_at: Date | string;
}

function rowToPointer(row: Row): BranchPointer {
  return {
    branchCognitionId: row.branch_cognition_id,
    sourceCognitionId: row.source_cognition_id,
    sourceNodeId: row.source_node_id,
    branchPointFrameIndex: row.branch_point_frame_index,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  };
}
