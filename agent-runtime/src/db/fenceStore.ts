/**
 * A StorageAdapter (agent-fence's persistence seam) backed by our unified
 * node:sqlite database. This is how Stage 4 keeps the committed-effects log in
 * the SAME file as the other eight stages — one schema, one database.
 *
 * agent-fence ships a SqliteStorage that uses better-sqlite3; we deliberately
 * do NOT use it, because (a) it would be a second database and (b) it needs a
 * native build. Implementing the adapter ourselves over node:sqlite keeps the
 * whole runtime native-dependency-free while reusing the real Fence engine.
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  CommittedEffect,
  IntentRecord,
  IntentStatus,
  PutResult,
  StorageAdapter,
} from "../../../agent-fence/dist/storage/base.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fence_committed_effects (
  id            TEXT PRIMARY KEY,
  operation_id  TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  input_hash    TEXT NOT NULL,
  response      TEXT NOT NULL,
  committed_at  TEXT NOT NULL,
  UNIQUE(operation_id, tool_name, input_hash)
);
CREATE INDEX IF NOT EXISTS idx_fce_op ON fence_committed_effects(operation_id);

CREATE TABLE IF NOT EXISTS fence_intents (
  id           TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  input        TEXT NOT NULL,
  intended_at  TEXT NOT NULL,
  status       TEXT NOT NULL
);
`;

export class SharedSqliteFenceStorage implements StorageAdapter {
  constructor(private readonly db: DatabaseSync) {}

  async init(): Promise<void> {
    this.db.exec(SCHEMA);
  }

  async getCommitted(operationId: string): Promise<CommittedEffect | null> {
    const row = this.db
      .prepare(
        `SELECT id, operation_id, tool_name, input_hash, response, committed_at
         FROM fence_committed_effects WHERE operation_id = ?`
      )
      .get(operationId) as Record<string, string> | undefined;
    if (!row) return null;
    return {
      id: row.id!,
      operationId: row.operation_id!,
      toolName: row.tool_name!,
      inputHash: row.input_hash!,
      response: row.response!,
      committedAt: row.committed_at!,
    };
  }

  async putCommitted(effect: CommittedEffect): Promise<PutResult> {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO fence_committed_effects
         (id, operation_id, tool_name, input_hash, response, committed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        effect.id,
        effect.operationId,
        effect.toolName,
        effect.inputHash,
        effect.response,
        effect.committedAt
      );
    const inserted = Number(res.changes) > 0;
    if (inserted) return { row: effect, inserted: true };
    // A conflicting effect already existed: return the winner.
    const existing = await this.getCommitted(effect.operationId);
    return { row: existing ?? effect, inserted: false };
  }

  async recordIntent(intent: IntentRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO fence_intents
         (id, operation_id, tool_name, input, intended_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(intent.id, intent.operationId, intent.toolName, intent.input, intent.intendedAt, intent.status);
  }

  async updateIntentStatus(id: string, status: IntentStatus): Promise<void> {
    this.db.prepare(`UPDATE fence_intents SET status = ? WHERE id = ?`).run(status, id);
  }

  async close(): Promise<void> {
    // The DatabaseSync handle is owned by RuntimeDB; nothing to release here.
  }
}
