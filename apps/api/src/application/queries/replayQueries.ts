import type { CognitionGraph } from "../../domain/cognition.js";
import type {
  CognitionRepository,
  ReplaySessionStore,
  SnapshotStore
} from "../../domain/cognitionPorts.js";
import type { ReplayFrame, ReplaySession, ReplaySnapshot } from "../../domain/replay.js";
import type { ReplayEngine } from "../../runtime/replay/replayEngine.js";

export interface ReplayTimelineView {
  session: ReplaySession;
  graphAtCursor: CognitionGraph | undefined;
  snapshots: ReplaySnapshot[];
}

export class ReplayQueries {
  constructor(
    private readonly engine: ReplayEngine,
    private readonly sessions: ReplaySessionStore,
    private readonly snapshots: SnapshotStore,
    private readonly cognitions: CognitionRepository
  ) {}

  async getSession(sessionId: string): Promise<ReplayTimelineView | undefined> {
    const session = await this.sessions.get(sessionId);
    if (!session) return undefined;
    const graphAtCursor = await this.engine.getGraphAt(session.cognitionId, session.cursor.frameIndex);
    const snapshots = await this.snapshots.listByCognition(session.cognitionId);
    return { session, graphAtCursor, snapshots };
  }

  async listFrames(cognitionId: string): Promise<ReplayFrame[]> {
    const graph = await this.cognitions.getById(cognitionId);
    if (!graph) return [];
    return this.engine.materializeFrames(graph);
  }
}
