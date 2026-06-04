import type { CognitionGraph, CognitionNode } from "../../../domain/cognition.js";
import type { CognitionRepository } from "../../../domain/cognitionPorts.js";
import type { PgClient } from "./pgClient.js";

/**
 * Postgres-backed CognitionRepository.
 *
 * Stores the full materialized graph as jsonb on `cognition_graphs.graph` for
 * O(1) read of the whole graph (replay engine path) and additionally projects
 * every node into the normalized `cognition_nodes` table for ad-hoc queries.
 *
 * Writes are transactional: graph + nodes are inserted/updated atomically so
 * partial graph state is never visible to a concurrent reader on another
 * worker.
 */
export class PostgresCognitionRepository implements CognitionRepository {
  constructor(private readonly client: PgClient) {}

  async save(graph: CognitionGraph): Promise<void> {
    // C-1 fail-closed: cognition graphs MUST persist with an explicit tenant.
    // The orchestrator resolves it from the originating execution before
    // calling save(); a missing value here would silently default to the
    // 'system' tenant and break per-tenant cognition retrieval.
    const tenantId = assertTenantId(graph.tenantId, "cognition_graphs", graph.id);
    await this.client.withTransaction(async (tx) => {
      await tx.query(
        `insert into cognition_graphs (
           id, execution_id, agent_id, parent_cognition_id, parent_node_id,
           phase, started_at, completed_at, output, owner_worker_id,
           uncertainty, graph, updated_at, tenant_id, trace_id
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, '{"nodes":[],"handoffs":[]}'::jsonb, now(), $12, $13)
         on conflict (id) do update set
           phase = excluded.phase,
           completed_at = excluded.completed_at,
           output = excluded.output,
           owner_worker_id = excluded.owner_worker_id,
           uncertainty = excluded.uncertainty,
           updated_at = now(),
           tenant_id = excluded.tenant_id,
           trace_id = coalesce(excluded.trace_id, cognition_graphs.trace_id)`,
        [
          graph.id,
          graph.executionId,
          graph.agentId,
          graph.parentCognitionId ?? null,
          graph.parentNodeId ?? null,
          graph.phase,
          graph.startedAt,
          graph.completedAt ?? null,
          graph.output ? JSON.stringify(graph.output) : null,
          graph.ownerWorkerId ?? null,
          graph.uncertainty ? JSON.stringify(graph.uncertainty) : null,
          tenantId,
          graph.traceId ?? null
        ]
      );

      for (const handoff of graph.handoffs) {
        await tx.query(
          `insert into cognition_handoffs (
             cognition_id, from_node_id, to_role, reason, carry_over
           ) values ($1,$2,$3,$4,$5)
           on conflict (cognition_id, from_node_id, to_role) do update set
             reason = excluded.reason,
             carry_over = excluded.carry_over`,
          [
            graph.id,
            handoff.fromNodeId,
            handoff.toRole,
            handoff.reason,
            JSON.stringify(handoff.carryOver)
          ]
        );
      }

      for (const node of graph.nodes) {
        await upsertNodeTx(tx, node);
      }
    });
  }

  async upsertNode(node: CognitionNode): Promise<void> {
    await this.client.withTransaction(async (tx) => {
      await upsertNodeTx(tx, node);
    });
  }

  async getById(id: string): Promise<CognitionGraph | undefined> {
    const { rows } = await this.client.query<GraphRow>(
      `select id, execution_id, agent_id, parent_cognition_id, parent_node_id,
              phase, started_at, completed_at, output, owner_worker_id,
              uncertainty, graph, tenant_id, trace_id
         from cognition_graphs where id = $1`,
      [id]
    );
    const row = rows[0];
    return row ? this.hydrateGraph(row) : undefined;
  }

  async getByExecution(executionId: string): Promise<CognitionGraph | undefined> {
    const { rows } = await this.client.query<GraphRow>(
      `select id, execution_id, agent_id, parent_cognition_id, parent_node_id,
              phase, started_at, completed_at, output, owner_worker_id,
              uncertainty, graph, tenant_id, trace_id
         from cognition_graphs
         where execution_id = $1
         order by started_at desc
         limit 1`,
      [executionId]
    );
    const row = rows[0];
    return row ? this.hydrateGraph(row) : undefined;
  }

  async listRecent(limit: number): Promise<CognitionGraph[]> {
    const { rows } = await this.client.query<any>(
      `select g.id, g.execution_id, g.agent_id, g.parent_cognition_id, g.parent_node_id,
              g.phase, g.started_at, g.completed_at, g.output, g.owner_worker_id,
              g.uncertainty, g.tenant_id, g.trace_id,
              count(n.id) as node_count
         from cognition_graphs g
         left join cognition_nodes n on n.cognition_id = g.id
         group by g.id, g.execution_id, g.agent_id, g.parent_cognition_id, g.parent_node_id,
                  g.phase, g.started_at, g.completed_at, g.output, g.owner_worker_id,
                  g.uncertainty, g.tenant_id, g.trace_id
         order by g.started_at desc
         limit $1`,
      [limit]
    );
    return rows.map((r) => {
      const nodeCount = Number(r.node_count ?? 0);
      return {
        id: r.id,
        executionId: r.execution_id,
        agentId: r.agent_id,
        parentCognitionId: r.parent_cognition_id ?? undefined,
        parentNodeId: r.parent_node_id ?? undefined,
        tenantId: r.tenant_id ?? undefined,
        traceId: r.trace_id ?? undefined,
        phase: r.phase as CognitionGraph["phase"],
        startedAt: toIso(r.started_at),
        completedAt: r.completed_at ? toIso(r.completed_at) : undefined,
        output: (r.output ?? undefined) as CognitionGraph["output"],
        ownerWorkerId: r.owner_worker_id ?? undefined,
        uncertainty: (r.uncertainty ?? undefined) as CognitionGraph["uncertainty"],
        nodes: new Array(nodeCount).fill(null).map((_, i) => ({ id: `${r.id}-thin-${i}`, sequence: i } as any)),
        handoffs: []
      };
    });
  }

  async listChildren(parentCognitionId: string): Promise<CognitionGraph[]> {
    const { rows } = await this.client.query<GraphRow>(
      `select id, execution_id, agent_id, parent_cognition_id, parent_node_id,
              phase, started_at, completed_at, output, owner_worker_id,
              uncertainty, graph, tenant_id, trace_id
         from cognition_graphs
         where parent_cognition_id = $1
         order by started_at asc`,
      [parentCognitionId]
    );
    const list: CognitionGraph[] = [];
    for (const r of rows) {
      list.push(await this.hydrateGraph(r));
    }
    return list;
  }

  private async hydrateGraph(row: GraphRow): Promise<CognitionGraph> {
    const { rows: nodeRows } = await this.client.query<any>(
      `select id, cognition_id, execution_id, parent_node_id, sequence, role, phase,
              status, input_fingerprint, input, output, token_stream, uncertainty,
              memory_influence, started_at, completed_at, duration_ms, worker_id,
              replayed_from_node_id
         from cognition_nodes
         where cognition_id = $1
         order by sequence asc`,
      [row.id]
    );

    const nodes: CognitionNode[] = nodeRows.map((r) => ({
      id: r.id,
      cognitionId: r.cognition_id,
      executionId: r.execution_id,
      parentNodeId: r.parent_node_id ?? undefined,
      sequence: r.sequence,
      role: r.role as CognitionNode["role"],
      phase: r.phase as CognitionNode["phase"],
      status: r.status as CognitionNode["status"],
      inputFingerprint: r.input_fingerprint,
      input: r.input,
      output: r.output ?? undefined,
      tokenStream: r.token_stream ?? undefined,
      uncertainty: r.uncertainty ?? undefined,
      memoryInfluence: r.memory_influence ?? undefined,
      startedAt: toIso(r.started_at),
      completedAt: r.completed_at ? toIso(r.completed_at) : undefined,
      durationMs: r.duration_ms ?? undefined,
      workerId: r.worker_id ?? undefined,
      replayedFromNodeId: r.replayed_from_node_id ?? undefined
    }));

    const { rows: handoffRows } = await this.client.query<any>(
      `select from_node_id, to_role, reason, carry_over
         from cognition_handoffs
         where cognition_id = $1`,
      [row.id]
    );

    const handoffs = handoffRows.map((h) => ({
      fromNodeId: h.from_node_id,
      toRole: h.to_role as CognitionNode["role"],
      reason: h.reason,
      carryOver: h.carry_over
    }));

    // Fallback to legacy denormalized graph if normalized tables are completely empty
    if (nodes.length === 0 && handoffs.length === 0 && row.graph && row.graph.nodes && row.graph.nodes.length > 0) {
      return {
        id: row.id,
        executionId: row.execution_id,
        agentId: row.agent_id,
        parentCognitionId: row.parent_cognition_id ?? undefined,
        parentNodeId: row.parent_node_id ?? undefined,
        tenantId: row.tenant_id ?? undefined,
        traceId: row.trace_id ?? undefined,
        phase: row.phase as CognitionGraph["phase"],
        startedAt: toIso(row.started_at),
        completedAt: row.completed_at ? toIso(row.completed_at) : undefined,
        output: (row.output ?? undefined) as CognitionGraph["output"],
        ownerWorkerId: row.owner_worker_id ?? undefined,
        uncertainty: (row.uncertainty ?? undefined) as CognitionGraph["uncertainty"],
        nodes: row.graph.nodes ?? [],
        handoffs: row.graph.handoffs ?? []
      };
    }

    return {
      id: row.id,
      executionId: row.execution_id,
      agentId: row.agent_id,
      parentCognitionId: row.parent_cognition_id ?? undefined,
      parentNodeId: row.parent_node_id ?? undefined,
      tenantId: row.tenant_id ?? undefined,
      phase: row.phase as CognitionGraph["phase"],
      startedAt: toIso(row.started_at),
      completedAt: row.completed_at ? toIso(row.completed_at) : undefined,
      output: (row.output ?? undefined) as CognitionGraph["output"],
      ownerWorkerId: row.owner_worker_id ?? undefined,
      uncertainty: (row.uncertainty ?? undefined) as CognitionGraph["uncertainty"],
      nodes,
      handoffs
    };
  }
}

function assertTenantId(value: string | undefined | null, table: string, resourceId: string): string {
  if (typeof value !== "string" || value.length === 0) {
    const err = new Error(
      `[tenant-isolation] refused to write ${table} row ${resourceId} without an explicit tenant_id`
    );
    (err as NodeJS.ErrnoException).code = "TENANT_ID_MISSING";
    throw err;
  }
  return value;
}

async function upsertNodeTx(tx: PgClient, node: CognitionNode): Promise<void> {
  await tx.query(
    `insert into cognition_nodes (
       id, cognition_id, execution_id, parent_node_id, sequence, role, phase,
       status, input_fingerprint, input, output, token_stream, uncertainty,
       memory_influence, started_at, completed_at, duration_ms, worker_id,
       replayed_from_node_id
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     on conflict (id) do update set
       phase = excluded.phase,
       status = excluded.status,
       output = excluded.output,
       token_stream = excluded.token_stream,
       uncertainty = excluded.uncertainty,
       memory_influence = excluded.memory_influence,
       completed_at = excluded.completed_at,
       duration_ms = excluded.duration_ms,
       worker_id = excluded.worker_id`,
    [
      node.id,
      node.cognitionId,
      node.executionId,
      node.parentNodeId ?? null,
      node.sequence,
      node.role,
      node.phase,
      node.status,
      node.inputFingerprint,
      JSON.stringify(node.input),
      node.output ? JSON.stringify(node.output) : null,
      node.tokenStream ? JSON.stringify(node.tokenStream) : null,
      node.uncertainty ? JSON.stringify(node.uncertainty) : null,
      node.memoryInfluence ? JSON.stringify(node.memoryInfluence) : null,
      node.startedAt,
      node.completedAt ?? null,
      node.durationMs ?? null,
      node.workerId ?? null,
      node.replayedFromNodeId ?? null
    ]
  );
}

interface GraphRow {
  id: string;
  execution_id: string;
  agent_id: string;
  parent_cognition_id: string | null;
  parent_node_id: string | null;
  phase: string;
  started_at: Date | string;
  completed_at: Date | string | null;
  output: Record<string, unknown> | null;
  owner_worker_id: string | null;
  uncertainty: Record<string, unknown> | null;
  graph: { nodes: CognitionNode[]; handoffs: CognitionGraph["handoffs"] } | null;
  tenant_id?: string | null;
  /** Persisted distributed trace correlation id (migration 0023). */
  trace_id?: string | null;
}

function rowToGraph(row: GraphRow): CognitionGraph {
  const body = row.graph ?? { nodes: [], handoffs: [] };
  return {
    id: row.id,
    executionId: row.execution_id,
    agentId: row.agent_id,
    parentCognitionId: row.parent_cognition_id ?? undefined,
    parentNodeId: row.parent_node_id ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    phase: row.phase as CognitionGraph["phase"],
    startedAt: toIso(row.started_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : undefined,
    output: (row.output ?? undefined) as CognitionGraph["output"],
    ownerWorkerId: row.owner_worker_id ?? undefined,
    uncertainty: (row.uncertainty ?? undefined) as CognitionGraph["uncertainty"],
    nodes: body.nodes ?? [],
    handoffs: body.handoffs ?? []
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
