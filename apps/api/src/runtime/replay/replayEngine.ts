import type { CognitionGraph, CognitionNode } from "../../domain/cognition.js";
import type {
  BranchRegistry,
  CognitionRepository,
  ReplaySessionStore,
  SnapshotStore
} from "../../domain/cognitionPorts.js";
import type { EventFactory } from "../../infrastructure/events/eventFactory.js";
import type { PersistedEventPublisher } from "../../infrastructure/events/persistedEventPublisher.js";
import type { EventStore } from "../../domain/ports.js";
import type {
  BranchPointer,
  BranchRequest,
  ReplayCursor,
  ReplayDiff,
  ReplayFrame,
  ReplaySession,
  ReplaySnapshot
} from "../../domain/replay.js";
import type { Clock } from "../../shared/clock.js";
import { toIso } from "../../shared/clock.js";
import { deterministicId, fingerprint } from "../../shared/determinism.js";
import { FrameBuilder } from "./frameBuilder.js";
import { ReplayDiffEngine } from "./diffEngine.js";

/**
 * Deterministic Runtime Replay Engine.
 *
 * Loads events for a cognition/execution, materializes a frame timeline,
 * supports scrubber seek (nearest-snapshot + forward replay), and branches
 * a new cognition from any frame ("replay-from-node").
 *
 * The engine is *pure* with respect to the event log: given identical events,
 * frames + diffs are identical. Side effects are limited to writing the
 * branch pointer + REPLAY_BRANCH_CREATED domain event.
 */
export class ReplayEngine {
  private readonly frameBuilder = new FrameBuilder();
  private readonly diffEngine = new ReplayDiffEngine();

  constructor(
    private readonly events: EventStore,
    private readonly cognitions: CognitionRepository,
    private readonly snapshots: SnapshotStore,
    private readonly sessions: ReplaySessionStore,
    private readonly branches: BranchRegistry,
    private readonly publisher: PersistedEventPublisher,
    private readonly eventFactory: EventFactory,
    private readonly clock: Clock
  ) {}

  async createSession(cognitionId: string): Promise<ReplaySession> {
    const graph = await this.cognitions.getById(cognitionId);
    if (!graph) throw new Error(`Cognition ${cognitionId} not found`);
    const frames = await this.materializeFrames(graph);
    // Phase 3: deterministic session IDs. Replaying the same cognition with
    // the same set of frames must always produce the same session id so
    // downstream consumers (snapshots, branch pointers, SSE clients) can be
    // resumed without coordination.
    const sessionId = deterministicId([
      "replay-session",
      cognitionId,
      graph.executionId,
      frames.length,
      frames[frames.length - 1]?.eventSequence ?? 0
    ]);
    const traceId = deterministicId(["replay-trace", sessionId]);
    const session: ReplaySession = {
      id: sessionId,
      cognitionId,
      executionId: graph.executionId,
      status: "READY",
      cursor: { frameIndex: 0, eventSequence: frames[0]?.eventSequence ?? 0, speed: 1 },
      frames,
      createdAt: toIso(this.clock.now())
    };
    await this.sessions.put(session);
    await this.publisher.publish(
      this.eventFactory.create({
        type: "REPLAY_SESSION_CREATED",
        aggregateId: cognitionId,
        aggregateType: "EXECUTION",
        payload: { sessionId: session.id, cognitionId, executionId: graph.executionId },
        context: { traceId }
      })
    );
    return session;
  }

  async seek(sessionId: string, frameIndex: number): Promise<ReplaySession> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error(`Replay session ${sessionId} not found`);
    const clamped = Math.max(0, Math.min(frameIndex, session.frames.length - 1));
    const frame = session.frames[clamped];
    const cursor: ReplayCursor = {
      frameIndex: clamped,
      eventSequence: frame?.eventSequence ?? 0,
      speed: session.cursor.speed
    };
    const updated: ReplaySession = { ...session, cursor, status: "PAUSED" };
    await this.sessions.put(updated);
    return updated;
  }

  async play(sessionId: string, speed: number): Promise<ReplaySession> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error(`Replay session ${sessionId} not found`);
    const updated: ReplaySession = {
      ...session,
      cursor: { ...session.cursor, speed },
      status: speed === 0 ? "PAUSED" : "PLAYING"
    };
    await this.sessions.put(updated);
    return updated;
  }

  async getGraphAt(cognitionId: string, frameIndex: number): Promise<CognitionGraph | undefined> {
    const snapshot = await this.snapshots.nearest(cognitionId, frameIndex);
    if (snapshot && snapshot.frameIndex === frameIndex) return snapshot.graph;
    // Walk forward from the nearest snapshot replaying events.
    const graph = await this.cognitions.getById(cognitionId);
    if (!graph) return undefined;
    if (!snapshot) {
      // Replay up to frameIndex from scratch — for small graphs only.
      const truncated = await this.projectGraph(graph, frameIndex);
      return truncated;
    }
    return this.projectGraph(snapshot.graph, frameIndex);
  }

  /**
   * Phase C — partial graph hydration for recovery.
   *
   * Recovery needs to answer: "what was the latest known good graph state
   * for this execution, and where should we resume the event cursor?"
   * `getGraphAt` requires a specific frame index; recovery doesn't have one
   * — it wants whatever durable state the snapshot store has, falling back
   * to a full event-log replay only when no snapshot exists OR when the
   * caller forces a full replay (e.g. to compare against a snapshot under
   * suspicion).
   *
   * Returns:
   *   - graph: the hydrated CognitionGraph at the recovery boundary.
   *   - eventSequenceCursor: the next event sequence the worker should
   *     consume. Equal to the snapshot's `eventSequence` when hydrating
   *     from a snapshot, or the highest event sequence in the log when
   *     full-replaying (i.e. the worker resumes "after the last event").
   *   - recoveredVia: "SNAPSHOT" when a snapshot path was taken,
   *     "FULL_REPLAY" otherwise. Operators read this to confirm snapshots
   *     are actually being used in production recovery.
   *   - elapsedMs: wall-time the call took. Surfaced on the return value so
   *     callers (and benchmarks) can record per-recovery latency without
   *     wrapping every call in performance.now() themselves.
   *
   * `forceFullReplay: true` short-circuits the snapshot path even when one
   * exists — used by the recovery-perf benchmark to compare costs side-by-
   * side and by operators auditing a snapshot under suspicion.
   *
   * Returns undefined when the cognition is unknown (no rows in the
   * cognition repository); never throws on missing snapshots.
   */
  async hydrateForRecovery(
    executionId: string,
    options: { forceFullReplay?: boolean } = {}
  ): Promise<
    | {
        graph: CognitionGraph;
        eventSequenceCursor: number;
        recoveredVia: "SNAPSHOT" | "FULL_REPLAY";
        elapsedMs: number;
      }
    | undefined
  > {
    const started = performance.now();
    const graph = await this.cognitions.getByExecution(executionId);
    if (!graph) return undefined;

    if (!options.forceFullReplay) {
      // Phase C: prefer the latest snapshot when one exists. We ask `nearest`
      // for the maximum frame index (Number.MAX_SAFE_INTEGER) so we get the
      // freshest snapshot regardless of how many were captured. SnapshotStore
      // validates the integrity hash before returning — a corrupt snapshot
      // would throw SnapshotCorruptionError and surface to the recovery
      // caller, which is the desired behavior (refuse to hydrate corrupt
      // state). The fallthrough to full replay is intentionally NOT used
      // for corruption — that signal must reach the operator.
      const snapshot = await this.snapshots.nearest(graph.id, Number.MAX_SAFE_INTEGER);
      if (snapshot) {
        return {
          graph: snapshot.graph,
          eventSequenceCursor: snapshot.eventSequence,
          recoveredVia: "SNAPSHOT",
          elapsedMs: performance.now() - started
        };
      }
    }

    // Full replay: rebuild the graph view from the event log. The cursor
    // becomes "one past the last event" so the resuming worker picks up
    // from the next event onward.
    const events = await this.events.listByExecution(executionId);
    const lastSeq = events.length > 0 ? Number(events[events.length - 1].sequence ?? events.length) : 0;
    return {
      graph,
      eventSequenceCursor: lastSeq,
      recoveredVia: "FULL_REPLAY",
      elapsedMs: performance.now() - started
    };
  }

  async writeSnapshot(cognitionId: string, frameIndex: number): Promise<ReplaySnapshot> {
    const graph = await this.getGraphAt(cognitionId, frameIndex);
    if (!graph) throw new Error(`Cannot snapshot unknown cognition ${cognitionId}`);
    const sessionsForC = await this.sessions.listByCognition(cognitionId);
    const session = sessionsForC[0];
    const frame = session?.frames[frameIndex];
    const snapshot: ReplaySnapshot = {
      id: deterministicId([cognitionId, frameIndex, "snapshot"]),
      cognitionId,
      executionId: graph.executionId,
      frameIndex,
      eventSequence: frame?.eventSequence ?? frameIndex,
      capturedAt: toIso(this.clock.now()),
      graph,
      eventCount: frameIndex + 1
    };
    await this.snapshots.put(snapshot);
    await this.publisher.publish(
      this.eventFactory.create({
        type: "REPLAY_SNAPSHOT_WRITTEN",
        aggregateId: cognitionId,
        aggregateType: "EXECUTION",
        payload: { snapshot },
        context: { traceId: deterministicId(["replay-snapshot-trace", snapshot.id]) }
      })
    );
    return snapshot;
  }

  async branch(request: BranchRequest): Promise<BranchPointer> {
    const source = await this.cognitions.getById(request.sourceCognitionId);
    if (!source) throw new Error(`Source cognition ${request.sourceCognitionId} not found`);
    const sourceNode = source.nodes.find((node) => node.id === request.sourceNodeId);
    if (!sourceNode) throw new Error(`Source node ${request.sourceNodeId} not found`);

    const frames = await this.materializeFrames(source);
    const branchFrameIndex = frames.findIndex(
      (frame) =>
        frame.preview.aggregateType === "EXECUTION" &&
        frame.preview.aggregateId === source.executionId &&
        frame.eventType === "COGNITION_NODE_COMPLETED"
    );

    const branchCognitionId = deterministicId([
      request.sourceCognitionId,
      request.sourceNodeId,
      await fingerprint(request.overrides ?? {})
    ]);

    const branchGraph: CognitionGraph = {
      id: branchCognitionId,
      executionId: deterministicId([branchCognitionId, "execution"]),
      agentId: source.agentId,
      parentCognitionId: source.id,
      parentNodeId: sourceNode.id,
      phase: "INIT",
      startedAt: toIso(this.clock.now()),
      ownerWorkerId: undefined,
      nodes: this.copyAncestry(source.nodes, sourceNode.sequence).map((node) => ({
        ...node,
        cognitionId: branchCognitionId,
        replayedFromNodeId: node.id,
        status: "REPLAYED"
      })),
      handoffs: source.handoffs.filter((h) =>
        source.nodes.find((n) => n.id === h.fromNodeId && n.sequence < sourceNode.sequence)
      )
    };

    await this.cognitions.save(branchGraph);

    const pointer: BranchPointer = {
      branchCognitionId,
      sourceCognitionId: source.id,
      sourceNodeId: sourceNode.id,
      branchPointFrameIndex: Math.max(0, branchFrameIndex),
      createdAt: toIso(this.clock.now())
    };
    await this.branches.record(pointer);
    await this.publisher.publish(
      this.eventFactory.create({
        type: "REPLAY_BRANCH_CREATED",
        aggregateId: source.id,
        aggregateType: "EXECUTION",
        payload: { pointer, reason: request.reason },
        context: { traceId: deterministicId(["replay-branch-trace", pointer.branchCognitionId]) }
      })
    );
    return pointer;
  }

  async diffCognitions(sourceId: string, branchId: string): Promise<ReplayDiff> {
    const [source, branch] = await Promise.all([
      this.cognitions.getById(sourceId),
      this.cognitions.getById(branchId)
    ]);
    if (!source || !branch) throw new Error(`Cognition not found for diff`);
    const [sourceFrames, branchFrames] = await Promise.all([
      this.materializeFrames(source),
      this.materializeFrames(branch)
    ]);
    return this.diffEngine.diff(sourceFrames, branchFrames);
  }

  async materializeFrames(graph: CognitionGraph): Promise<ReplayFrame[]> {
    const events = await this.events.listByExecution(graph.executionId);
    return this.frameBuilder.build(events);
  }

  private copyAncestry(nodes: CognitionNode[], throughSequence: number): CognitionNode[] {
    return nodes
      .filter((node) => node.sequence < throughSequence)
      .sort((a, b) => a.sequence - b.sequence);
  }

  /** Truncate graph view to frames up to and including `frameIndex`. */
  private async projectGraph(graph: CognitionGraph, frameIndex: number): Promise<CognitionGraph> {
    const frames = await this.materializeFrames(graph);
    const sliced = frames.slice(0, frameIndex + 1);
    const visibleNodes = new Set<string>();
    for (const frame of sliced) {
      if (frame.preview.aggregateType === "EXECUTION") visibleNodes.add(frame.preview.aggregateId);
    }
    return {
      ...graph,
      nodes: graph.nodes.filter((node) => visibleNodes.has(node.executionId) || node.sequence <= sliced.length),
      handoffs: graph.handoffs.slice(0, sliced.length)
    };
  }
}
