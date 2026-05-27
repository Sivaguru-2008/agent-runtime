import type { NodeLineage } from "../../../domain/cognition.js";
import type { LineageStore } from "../../../domain/cognitionPorts.js";
import type { PgClient } from "./pgClient.js";

/**
 * Postgres-backed LineageStore. Lineage is stored as a normalized edge list
 * (ANCESTOR / DESCENDANT / SIBLING) so BFS traversal is a single recursive
 * CTE rather than N round-trips.
 */
export class PostgresLineageStore implements LineageStore {
  constructor(private readonly client: PgClient) {}

  async recordParent(child: string, parent: string): Promise<void> {
    const cognitionId = await this.cognitionIdFor(child);
    await this.client.withTransaction(async (tx) => {
      await tx.query(
        `insert into cognition_lineage (node_id, related_node_id, kind, cognition_id)
         values ($1, $2, 'ANCESTOR', $3)
         on conflict do nothing`,
        [child, parent, cognitionId]
      );
      await tx.query(
        `insert into cognition_lineage (node_id, related_node_id, kind, cognition_id)
         values ($1, $2, 'DESCENDANT', $3)
         on conflict do nothing`,
        [parent, child, cognitionId]
      );
    });
  }

  async recordSibling(a: string, b: string): Promise<void> {
    const cognitionId = await this.cognitionIdFor(a);
    await this.client.withTransaction(async (tx) => {
      await tx.query(
        `insert into cognition_lineage (node_id, related_node_id, kind, cognition_id)
         values ($1, $2, 'SIBLING', $3) on conflict do nothing`,
        [a, b, cognitionId]
      );
      await tx.query(
        `insert into cognition_lineage (node_id, related_node_id, kind, cognition_id)
         values ($1, $2, 'SIBLING', $3) on conflict do nothing`,
        [b, a, cognitionId]
      );
    });
  }

  async getLineage(nodeId: string): Promise<NodeLineage | undefined> {
    const { rows } = await this.client.query<{ related_node_id: string; kind: string; cognition_id: string }>(
      `select related_node_id, kind, cognition_id
         from cognition_lineage where node_id = $1`,
      [nodeId]
    );
    if (!rows.length) return undefined;
    const lineage: NodeLineage = {
      nodeId,
      cognitionId: rows[0]!.cognition_id,
      ancestors: [],
      descendants: [],
      siblings: []
    };
    for (const row of rows) {
      if (row.kind === "ANCESTOR") lineage.ancestors.push(row.related_node_id);
      else if (row.kind === "DESCENDANT") lineage.descendants.push(row.related_node_id);
      else if (row.kind === "SIBLING") lineage.siblings.push(row.related_node_id);
    }
    return lineage;
  }

  async listFamily(rootNodeId: string): Promise<NodeLineage[]> {
    // Recursive CTE: gather every node reachable from root via descendants or
    // siblings. Avoids the N+1 round-trip pattern the in-memory version uses.
    const { rows } = await this.client.query<{ node_id: string }>(
      `with recursive family(node_id) as (
          select $1::text
        union
          select l.related_node_id
          from cognition_lineage l
          join family f on l.node_id = f.node_id
          where l.kind in ('DESCENDANT','SIBLING')
       )
       select node_id from family`,
      [rootNodeId]
    );
    const result: NodeLineage[] = [];
    for (const row of rows) {
      const lineage = await this.getLineage(row.node_id);
      if (lineage) result.push(lineage);
    }
    return result;
  }

  private async cognitionIdFor(nodeId: string): Promise<string> {
    const { rows } = await this.client.query<{ cognition_id: string }>(
      `select cognition_id from cognition_nodes where id = $1 limit 1`,
      [nodeId]
    );
    return rows[0]?.cognition_id ?? "";
  }
}
