import type { Pool } from "pg";
import {
  CommittedEffect,
  IntentRecord,
  IntentStatus,
  PutResult,
  StorageAdapter,
  toIso,
} from "./base";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fence_committed_effects (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  UNIQUE(operation_id, tool_name, input_hash)
);
CREATE INDEX IF NOT EXISTS idx_fence_committed_op
  ON fence_committed_effects(operation_id);

CREATE TABLE IF NOT EXISTS fence_intent_log (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  intended_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
);
CREATE INDEX IF NOT EXISTS idx_fence_intent_op
  ON fence_intent_log(operation_id);
`;

interface Row {
  id: string;
  operation_id: string;
  tool_name: string;
  input_hash: string;
  response: string;
  committed_at: string | Date;
}

/** Postgres storage adapter backed by `pg` (production). */
export class PostgresStorage implements StorageAdapter {
  private pool: Pool | null = null;

  constructor(private readonly connectionString: string) {}

  async init(): Promise<void> {
    if (this.pool) return;
    let PoolCtor: new (config: { connectionString: string }) => Pool;
    try {
      const mod = (await import("pg")) as unknown as {
        default?: { Pool: typeof PoolCtor };
        Pool?: typeof PoolCtor;
      };
      const ctor = mod.default?.Pool ?? mod.Pool;
      if (!ctor) throw new Error("Pool export not found");
      PoolCtor = ctor;
    } catch {
      throw new Error(
        'agent-fence: Postgres storage needs the optional dependency "pg". Install it with `npm install pg`.'
      );
    }
    const pool = new PoolCtor({ connectionString: this.connectionString });
    await pool.query(SCHEMA);
    this.pool = pool;
  }

  private get conn(): Pool {
    if (!this.pool)
      throw new Error("agent-fence: PostgresStorage not initialized");
    return this.pool;
  }

  async getCommitted(operationId: string): Promise<CommittedEffect | null> {
    const res = await this.conn.query<Row>(
      "SELECT * FROM fence_committed_effects WHERE operation_id = $1 LIMIT 1",
      [operationId]
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async putCommitted(effect: CommittedEffect): Promise<PutResult> {
    const res = await this.conn.query<Row>(
      `INSERT INTO fence_committed_effects
         (id, operation_id, tool_name, input_hash, response, committed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (operation_id, tool_name, input_hash) DO NOTHING
       RETURNING *`,
      [
        effect.id,
        effect.operationId,
        effect.toolName,
        effect.inputHash,
        effect.response,
        effect.committedAt,
      ]
    );
    if (res.rows[0]) return { row: mapRow(res.rows[0]), inserted: true };
    const existing = await this.getCommitted(effect.operationId);
    return { row: existing ?? effect, inserted: false };
  }

  async recordIntent(intent: IntentRecord): Promise<void> {
    await this.conn.query(
      `INSERT INTO fence_intent_log
         (id, operation_id, tool_name, input, intended_at, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        intent.id,
        intent.operationId,
        intent.toolName,
        intent.input,
        intent.intendedAt,
        intent.status,
      ]
    );
  }

  async updateIntentStatus(id: string, status: IntentStatus): Promise<void> {
    await this.conn.query(
      "UPDATE fence_intent_log SET status = $1 WHERE id = $2",
      [status, id]
    );
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }
}

function mapRow(row: Row): CommittedEffect {
  return {
    id: row.id,
    operationId: row.operation_id,
    toolName: row.tool_name,
    inputHash: row.input_hash,
    response: row.response,
    committedAt: toIso(row.committed_at),
  };
}
