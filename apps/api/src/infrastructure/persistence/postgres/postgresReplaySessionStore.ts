import type { ReplayFrame, ReplaySession } from "../../../domain/replay.js";
import type { ReplaySessionStore } from "../../../domain/cognitionPorts.js";
import type { PgClient } from "./pgClient.js";

/**
 * Postgres-backed ReplaySessionStore.
 *
 * Sessions own their materialized frame list — frames are stored separately in
 * `replay_frames` keyed by (session_id, frame_index), which lets the engine:
 *   • seek to any frame in O(log n)
 *   • stream a windowed range without pulling the whole session
 *   • survive process restart with the exact frame sequence intact
 *
 * The session row carries the cursor + status; frames are populated on
 * `put` and replaced atomically.
 */
export class PostgresReplaySessionStore implements ReplaySessionStore {
  constructor(private readonly client: PgClient) {}

  async put(session: ReplaySession): Promise<void> {
    await this.client.withTransaction(async (tx) => {
      await tx.query(
        // tenant_id (migration 0025) is stamped on first insert and never
        // rewritten on conflict — ownership is immutable. We prefer the
        // caller-supplied tenant, fall back to the owning execution's tenant,
        // and finally 'system'. The subquery is a text-compare so it can never
        // raise (an unresolvable execution simply yields 'system'); it mirrors
        // the best-effort backfill convention from 0005_tenant_propagation.sql.
        `insert into replay_sessions (
           id, cognition_id, execution_id, status,
           cursor_frame_index, cursor_event_sequence, cursor_speed,
           forked_from_session_id, forked_from_frame_index, created_at, updated_at,
           tenant_id
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(),
           coalesce($11::text, (select tenant_id from executions where id::text = $3::text), 'system')
         )
         on conflict (id) do update set
           status = excluded.status,
           cursor_frame_index = excluded.cursor_frame_index,
           cursor_event_sequence = excluded.cursor_event_sequence,
           cursor_speed = excluded.cursor_speed,
           updated_at = now()`,
        [
          session.id,
          session.cognitionId,
          session.executionId,
          session.status,
          session.cursor.frameIndex,
          session.cursor.eventSequence,
          session.cursor.speed,
          session.forkedFrom?.sessionId ?? null,
          session.forkedFrom?.frameIndex ?? null,
          session.createdAt,
          session.tenantId ?? null
        ]
      );

      // Replace the frame set transactionally so a partial write never
      // produces a torn timeline.
      await tx.query(`delete from replay_frames where session_id = $1`, [session.id]);

      for (const frame of session.frames) {
        await tx.query(
          `insert into replay_frames (
             session_id, frame_index, kind, ts, event_sequence, event_type,
             preview, snapshot_id
           ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            session.id,
            frame.index,
            frame.kind,
            frame.timestamp,
            frame.eventSequence,
            frame.eventType,
            JSON.stringify(frame.preview),
            frame.snapshotId ?? null
          ]
        );
      }
    });
  }

  async get(sessionId: string): Promise<ReplaySession | undefined> {
    const { rows } = await this.client.query<SessionRow>(
      `select id, cognition_id, execution_id, status,
              cursor_frame_index, cursor_event_sequence, cursor_speed,
              forked_from_session_id, forked_from_frame_index, created_at, tenant_id
         from replay_sessions where id = $1`,
      [sessionId]
    );
    const row = rows[0];
    if (!row) return undefined;
    const frames = await this.loadFrames(sessionId);
    return rowToSession(row, frames);
  }

  async listByCognition(cognitionId: string): Promise<ReplaySession[]> {
    const { rows } = await this.client.query<SessionRow>(
      `select id, cognition_id, execution_id, status,
              cursor_frame_index, cursor_event_sequence, cursor_speed,
              forked_from_session_id, forked_from_frame_index, created_at, tenant_id
         from replay_sessions
         where cognition_id = $1
         order by created_at desc`,
      [cognitionId]
    );
    const sessions: ReplaySession[] = [];
    for (const row of rows) {
      const frames = await this.loadFrames(row.id);
      sessions.push(rowToSession(row, frames));
    }
    return sessions;
  }

  private async loadFrames(sessionId: string): Promise<ReplayFrame[]> {
    const { rows } = await this.client.query<FrameRow>(
      `select frame_index, kind, ts, event_sequence, event_type, preview, snapshot_id
         from replay_frames
         where session_id = $1
         order by frame_index asc`,
      [sessionId]
    );
    return rows.map((row) => ({
      index: row.frame_index,
      kind: row.kind as ReplayFrame["kind"],
      timestamp: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
      eventSequence: Number(row.event_sequence),
      eventType: row.event_type,
      preview: row.preview as unknown as ReplayFrame["preview"],
      snapshotId: row.snapshot_id ?? undefined
    }));
  }
}

interface SessionRow {
  id: string;
  cognition_id: string;
  execution_id: string;
  status: string;
  cursor_frame_index: number;
  cursor_event_sequence: string | number;
  cursor_speed: number;
  forked_from_session_id: string | null;
  forked_from_frame_index: number | null;
  created_at: Date | string;
  tenant_id?: string | null;
}

interface FrameRow {
  frame_index: number;
  kind: string;
  ts: Date | string;
  event_sequence: string | number;
  event_type: string;
  preview: Record<string, unknown>;
  snapshot_id: string | null;
}

function rowToSession(row: SessionRow, frames: ReplayFrame[]): ReplaySession {
  return {
    id: row.id,
    cognitionId: row.cognition_id,
    executionId: row.execution_id,
    status: row.status as ReplaySession["status"],
    cursor: {
      frameIndex: row.cursor_frame_index,
      eventSequence: Number(row.cursor_event_sequence),
      speed: Number(row.cursor_speed)
    },
    frames,
    forkedFrom:
      row.forked_from_session_id && row.forked_from_frame_index !== null
        ? { sessionId: row.forked_from_session_id, frameIndex: row.forked_from_frame_index }
        : undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    ...(row.tenant_id != null ? { tenantId: row.tenant_id } : {})
  };
}
