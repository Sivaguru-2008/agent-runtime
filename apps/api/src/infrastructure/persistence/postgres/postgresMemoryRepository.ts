/**
 * Postgres-backed MemoryRepository.
 *
 * Replaces InMemoryMemoryRepository so retrieved/episodic memory persists
 * across restarts. The MemoryManagerAgent and the ExecutionEngine both
 * write here on every cognition, so losing memory on restart silently
 * regressed the agent's behavior over time.
 *
 * Schema mapping (apps/api/db/schema.sql `memory_records`):
 *   id            ←→ MemoryRecord.id              (uuid)
 *   agent_id      ←→ MemoryRecord.agentId
 *   execution_id  ←→ MemoryRecord.executionId     (nullable)
 *   type          ←→ MemoryRecord.type            (MemoryType enum, text)
 *   content       ←→ MemoryRecord.content
 *   metadata      ←→ MemoryRecord.metadata        (jsonb)
 *   created_at    ←→ MemoryRecord.createdAt
 *   updated_at    ←→ (not exposed; tracked for projection bookkeeping)
 *
 * Search semantics:
 *   The in-memory implementation scores by lowercased substring hits of
 *   each whitespace-delimited query term, with createdAt desc as the
 *   tiebreaker. We reproduce that ranking in SQL so callers observe the
 *   same behavior across drivers — important for replay determinism in
 *   the cognition layer (which feeds MEMORY_RETRIEVED events into the
 *   replay engine and expects deterministic ordering across runs).
 *
 *   For agent_id with no matches we still return up to `limit` recent
 *   records, matching the in-memory behavior where unrelated records
 *   bubble up with score 0.
 */

import type { MemoryRecord } from "../../../domain/model.js";
import type { MemoryRepository } from "../../../domain/ports.js";
import type { FencingToken, FencedWriteOutcome } from "../../../domain/clusterPorts.js";
import type { PgClient } from "./pgClient.js";

interface MemoryRow {
  id: string;
  agent_id: string;
  execution_id: string | null;
  type: string;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
  tenant_id?: string | null;
}

export class PostgresMemoryRepository implements MemoryRepository {
  constructor(private readonly db: PgClient) {}

  async add(record: MemoryRecord): Promise<void> {
    // C-1 fail-closed: memory rows persist tenant_id resolved from the
    // originating execution / agent. Without an explicit tenant the row
    // would silently default to 'system' and become invisible to the owning
    // tenant's RAG search path while leaking to operator queries.
    const tenantId = assertTenantId(record.tenantId, "memory_records", record.id);
    await this.db.query(
      `insert into memory_records (
         id, agent_id, execution_id, type, content, metadata, created_at, updated_at, tenant_id
       ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$7,$8)
       on conflict (id) do update set
         content    = excluded.content,
         metadata   = excluded.metadata,
         updated_at = excluded.created_at,
         tenant_id  = excluded.tenant_id`,
      [
        record.id,
        record.agentId,
        record.executionId ?? null,
        record.type,
        record.content,
        JSON.stringify(record.metadata ?? {}),
        record.createdAt,
        tenantId
      ]
    );
  }

  /**
   * Fence-guarded INSERT. Same pattern as PostgresExecutionRepository.saveFenced
   * — see that docstring for the CTE-with-FOR-UPDATE rationale.
   *
   * Memory records are tenant-tagged and flow into downstream RAG search;
   * a stale-worker write would attach the legitimate owner's tenant_id to
   * the stale worker's content. addFenced refuses to commit when the
   * supplied fencing token does not match a live lease.
   */
  async addFenced(record: MemoryRecord, fence: FencingToken): Promise<FencedWriteOutcome> {
    const tenantId = assertTenantId(record.tenantId, "memory_records", record.id);
    const nowIso = new Date().toISOString();
    const { rows } = await this.db.query<{ id: string }>(
      `with fence as (
         select 1 as ok
           from execution_leases
          where execution_id = $9
            and worker_id    = $10
            and attempt      = $11
            and status in ('LEASED', 'RENEWING', 'RECOVERY_OWNED')
            and expires_at   > $12
          for update
       )
       insert into memory_records (
         id, agent_id, execution_id, type, content, metadata, created_at, updated_at, tenant_id
       )
       select $1, $2, $3, $4, $5, $6::jsonb, $7, $7, $8
       from fence
       on conflict (id) do update set
         content    = excluded.content,
         metadata   = excluded.metadata,
         updated_at = excluded.created_at,
         tenant_id  = excluded.tenant_id
       returning id`,
      [
        record.id,
        record.agentId,
        record.executionId ?? null,
        record.type,
        record.content,
        JSON.stringify(record.metadata ?? {}),
        record.createdAt,
        tenantId,
        fence.executionId,
        fence.workerId,
        fence.attempt,
        nowIso
      ]
    );
    return rows.length === 1 ? "COMMITTED" : "FENCED";
  }

  async search(agentId: string, query: string, limit: number): Promise<MemoryRecord[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    // Empty-query path keeps parity with the in-memory implementation:
    // score is 0 for every record and the result is ordered by recency.
    if (terms.length === 0) {
      return this.listByAgent(agentId).then((records) => records.slice(0, limit));
    }

    const { rows } = await this.db.query<MemoryRow & { score: number | string }>(
      `with terms as (
         select unnest($2::text[]) as term
       ),
       scored as (
         select m.id, m.agent_id, m.execution_id, m.type, m.content, m.metadata, m.created_at, m.tenant_id,
                (select count(*)::int from terms
                  where position(terms.term in lower(m.content)) > 0) as score
           from memory_records m
          where m.agent_id = $1
       )
       select id, agent_id, execution_id, type, content, metadata, created_at, tenant_id, score
         from scored
        order by score desc, created_at desc
        limit $3`,
      [agentId, terms, limit]
    );
    return rows.map(rowToMemory);
  }

  async listByAgent(agentId: string): Promise<MemoryRecord[]> {
    const { rows } = await this.db.query<MemoryRow>(
      `select id, agent_id, execution_id, type, content, metadata, created_at, tenant_id
         from memory_records
         where agent_id = $1
         order by created_at desc`,
      [agentId]
    );
    return rows.map(rowToMemory);
  }
}

function rowToMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    executionId: row.execution_id ?? undefined,
    type: row.type as MemoryRecord["type"],
    content: row.content,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toIso(row.created_at),
    tenantId: row.tenant_id ?? undefined
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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
