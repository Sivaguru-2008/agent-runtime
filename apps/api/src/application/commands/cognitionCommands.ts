import type { EventContext } from "../../infrastructure/events/eventFactory.js";
import type { CognitionOrchestrator } from "../../runtime/cognition/orchestrator.js";
import type { ReplayEngine } from "../../runtime/replay/replayEngine.js";
import type { FailureIntelligenceEngine } from "../../runtime/failure/failureIntelligenceEngine.js";
import type { ReplayOutcomeRecorder } from "../../runtime/failure/replayOutcomeRecorder.js";
import type { CognitionStartInput, CognitionGraph } from "../../domain/cognition.js";
import type { BranchRequest, BranchPointer, ReplaySession } from "../../domain/replay.js";

export class CognitionCommands {
  constructor(
    private readonly orchestrator: CognitionOrchestrator,
    private readonly replay: ReplayEngine,
    private readonly failures: FailureIntelligenceEngine,
    /**
     * Optional Phase 7 recorder. When present, every terminal cognition
     * (COMPLETED or FAILED) automatically yields a ReplayOutcome, activating
     * the adaptive learning loop. Optional preserves backward compatibility
     * for tests that construct CognitionCommands without the Phase 7 wiring.
     */
    private readonly outcomeRecorder?: ReplayOutcomeRecorder
  ) {}

  async startCognition(input: CognitionStartInput, context: EventContext): Promise<CognitionGraph> {
    const graph = await this.orchestrator.run(input, context);
    // Fire-and-forget failure analysis on the resulting graph, chained with
    // outcome recording so the adaptive learning feedback loop is fed without
    // blocking the HTTP response. All learning-side errors are isolated inside
    // ReplayOutcomeRecorder so they cannot break execution completion.
    void this.failures
      .analyzeExecution(graph.executionId)
      .then((report) => this.outcomeRecorder?.recordTerminalOutcome(graph, report))
      .catch(() => undefined);
    return graph;
  }

  async createReplaySession(cognitionId: string): Promise<ReplaySession> {
    return this.replay.createSession(cognitionId);
  }

  async seekReplay(sessionId: string, frameIndex: number): Promise<ReplaySession> {
    return this.replay.seek(sessionId, frameIndex);
  }

  async playReplay(sessionId: string, speed: number): Promise<ReplaySession> {
    return this.replay.play(sessionId, speed);
  }

  async branchFromNode(request: BranchRequest): Promise<BranchPointer> {
    return this.replay.branch(request);
  }

  async snapshotAtFrame(cognitionId: string, frameIndex: number) {
    return this.replay.writeSnapshot(cognitionId, frameIndex);
  }
}
