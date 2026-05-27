/**
 * Postgres-backed AgentRepository.
 *
 * Replaces InMemoryAgentRepository in production deployments so agent state
 * (name, goal, runtime status, model config, tool list, memory policy) is
 * durable across process restarts.
 *
 * Schema mapping (apps/api/db/schema.sql `agents`):
 *   id                 ←→ Agent.id                  (uuid)
 *   name               ←→ Agent.name
 *   goal               ←→ Agent.goal
 *   state              ←→ Agent.state               (AgentState enum, text)
 *   runtime_status     ←→ Agent.runtimeStatus       (RuntimeStatus enum, text)
 *   model_provider     ←→ Agent.model.provider
 *   model_name         ←→ Agent.model.model
 *   model_temperature  ←→ Agent.model.temperature   (added in 0004)
 *   tools              ←→ Agent.tools               (jsonb array)
 *   memory_policy      ←→ Agent.memoryPolicy        (jsonb)
 *   created_at         ←→ Agent.createdAt
 *   updated_at         ←→ Agent.updatedAt
 *
 * Idempotency:
 *   AgentRuntime.save() is called repeatedly across the lifecycle (CREATED →
 *   IDLE → RUNNING → IDLE/DEGRADED). The INSERT uses ON CONFLICT (id) DO
 *   UPDATE so the second-and-subsequent saves write the updated row instead
 *   of failing on the primary-key constraint.
 */

import type { Agent } from "../../../domain/model.js";
import type { AgentRepository } from "../../../domain/ports.js";
import type { PgClient } from "./pgClient.js";

interface AgentRow {
  id: string;
  name: string;
  goal: string;
  state: string;
  runtime_status: string;
  model_provider: string;
  model_name: string;
  model_temperature: number | string | null;
  tools: Agent["tools"];
  memory_policy: Agent["memoryPolicy"];
  created_at: Date | string;
  updated_at: Date | string;
  tenant_id?: string | null;
}

export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly db: PgClient) {}

  async save(agent: Agent): Promise<void> {
    // C-1 fail-closed: persistence path MUST carry an explicit tenant. Without
    // this assertion the row would default to 'system' and the tenant guard
    // would later resolve cross-tenant ownership against an attacker-supplied
    // tenant. The runtime sets tenantId from the authenticated request context
    // — a missing value here is a programming bug, not a user error.
    const tenantId = assertTenantId(agent.tenantId, "agents", agent.id);
    await this.db.query(
      `insert into agents (
         id, name, goal, state, runtime_status, model_provider, model_name,
         model_temperature, tools, memory_policy, created_at, updated_at, tenant_id
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)
       on conflict (id) do update set
         name              = excluded.name,
         goal              = excluded.goal,
         state             = excluded.state,
         runtime_status    = excluded.runtime_status,
         model_provider    = excluded.model_provider,
         model_name        = excluded.model_name,
         model_temperature = excluded.model_temperature,
         tools             = excluded.tools,
         memory_policy     = excluded.memory_policy,
         updated_at        = excluded.updated_at,
         tenant_id         = excluded.tenant_id`,
      [
        agent.id,
        agent.name,
        agent.goal,
        agent.state,
        agent.runtimeStatus,
        agent.model.provider,
        agent.model.model,
        agent.model.temperature ?? null,
        JSON.stringify(agent.tools),
        JSON.stringify(agent.memoryPolicy),
        agent.createdAt,
        agent.updatedAt,
        tenantId
      ]
    );
  }

  async getById(id: string): Promise<Agent | undefined> {
    const { rows } = await this.db.query<AgentRow>(
      `select id, name, goal, state, runtime_status, model_provider, model_name,
              model_temperature, tools, memory_policy, created_at, updated_at, tenant_id
         from agents where id = $1`,
      [id]
    );
    return rows[0] ? rowToAgent(rows[0]) : undefined;
  }

  async list(): Promise<Agent[]> {
    const { rows } = await this.db.query<AgentRow>(
      `select id, name, goal, state, runtime_status, model_provider, model_name,
              model_temperature, tools, memory_policy, created_at, updated_at, tenant_id
         from agents
         order by updated_at desc`
    );
    return rows.map(rowToAgent);
  }
}

/**
 * Defensive assertion that an authenticated persistence path carries a
 * resolved tenantId. Throws TenantPersistenceError to fail closed — the
 * caller's transaction is rolled back rather than silently mis-attributing
 * the row to the system tenant.
 */
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

function rowToAgent(row: AgentRow): Agent {
  const tools = Array.isArray(row.tools) ? row.tools : [];
  const memoryPolicy = (row.memory_policy ?? {}) as Agent["memoryPolicy"];
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    state: row.state as Agent["state"],
    runtimeStatus: row.runtime_status as Agent["runtimeStatus"],
    model: {
      provider: row.model_provider,
      model: row.model_name,
      temperature: row.model_temperature == null ? undefined : Number(row.model_temperature)
    },
    tools,
    memoryPolicy: {
      episodicEnabled: memoryPolicy.episodicEnabled ?? true,
      semanticEnabled: memoryPolicy.semanticEnabled ?? false,
      maxRetrievedItems: memoryPolicy.maxRetrievedItems ?? 5
    },
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    tenantId: row.tenant_id ?? undefined
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
