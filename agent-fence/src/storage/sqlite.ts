import type Database from "better-sqlite3";
import {
  CommittedEffect,
  IntentRecord,
  IntentStatus,
  PutResult,
  StorageAdapter,
  toIso,
} from "./base";

type SqliteDb = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fence_committed_effects (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  UNIQUE(operation_id, tool_name, input_hash)
);
CREATE INDEX IF NOT EXISTS idx_fence_committed_op
  ON fence_committed_effects(operation_id);

CREATE TABLE IF NOT EXISTS fence_intent_log (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  intended_at TEXT NOT NULL,
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
  committed_at: string;
}

/** SQLite storage adapter backed by better-sqlite3 (great for local dev). */
export class SqliteStorage implements StorageAdapter {
  private db: SqliteDb | null = null;

  constructor(private readonly path: string = "agent-fence.db") {}

  async init(): Promise<void> {
    if (this.db) return;
    let Ctor: new (path: string) => SqliteDb;
    try {
      const mod = (await import("better-sqlite3")) as unknown as {
        default: new (path: string) => SqliteDb;
      };
      Ctor = mod.default;
    } catch {
      throw new Error(
        'agent-fence: SQLite storage needs the optional dependency "better-sqlite3". Install it with `npm install better-sqlite3`.'
      );
    }
    const db = new Ctor(this.path);
    if (this.path !== ":memory:") {
      try {
        db.pragma("journal_mode = WAL");
      } catch {
        /* WAL is best-effort; fall back to the default journal mode */
      }
    }
    db.exec(SCHEMA);
    this.db = db;
  }

  private get conn(): SqliteDb {
    if (!this.db) throw new Error("agent-fence: SqliteStorage not initialized");
    return this.db;
  }

  async getCommitted(operationId: string): Promise<CommittedEffect | null> {
    const row = this.conn
      .prepare(
        "SELECT * FROM fence_committed_effects WHERE operation_id = ? LIMIT 1"
      )
      .get(operationId) as Row | undefined;
    return row ? mapRow(row) : null;
  }

  async putCommitted(effect: CommittedEffect): Promise<PutResult> {
    const info = this.conn
      .prepare(
        `INSERT INTO fence_committed_effects
           (id, operation_id, tool_name, input_hash, response, committed_at)
         VALUES
           (@id, @operationId, @toolName, @inputHash, @response, @committedAt)
         ON CONFLICT(operation_id, tool_name, input_hash) DO NOTHING`
      )
      .run(effect);
    if (info.changes === 1) return { row: effect, inserted: true };
    const existing = await this.getCommitted(effect.operationId);
    return { row: existing ?? effect, inserted: false };
  }

  async recordIntent(intent: IntentRecord): Promise<void> {
    this.conn
      .prepare(
        `INSERT INTO fence_intent_log
           (id, operation_id, tool_name, input, intended_at, status)
         VALUES
           (@id, @operationId, @toolName, @input, @intendedAt, @status)`
      )
      .run(intent);
  }

  async updateIntentStatus(id: string, status: IntentStatus): Promise<void> {
    this.conn
      .prepare("UPDATE fence_intent_log SET status = ? WHERE id = ?")
      .run(status, id);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
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
