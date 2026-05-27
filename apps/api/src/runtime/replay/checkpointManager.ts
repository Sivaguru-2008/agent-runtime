import type { CognitionGraph } from "../../domain/cognition.js";
import type { BranchComparison, BranchComparisonEntry, CognitionDiff, ReplayCheckpoint } from "../../domain/replay.js";
import type {
  BranchRegistry,
  CognitionRepository,
  FailureSignalStore,
  SnapshotStore
} from "../../domain/cognitionPorts.js";
import type { EventFactory } from "../../infrastructure/events/eventFactory.js";
import type { PersistedEventPublisher } from "../../infrastructure/events/persistedEventPublisher.js";
import type { Clock } from "../../shared/clock.js";
import { toIso } from "../../shared/clock.js";
import { deterministicId } from "../../shared/determinism.js";
import { ReplayEngine } from "./replayEngine.js";
import { FailureIntelligenceEngine } from "../failure/failureIntelligenceEngine.js";

/**
 * Checkpoint Manager — Phase 3 replay product module.
 *
 * Three complementary capabilities:
 *
 * 1. NAMED CHECKPOINTS — operator-placed markers in a replay session with
 *    a name, note, and full graph snapshot. Unlike auto-snapshots (written
 *    by the engine at fixed intervals for seek performance), checkpoints are
 *    intentional: "before-tool-fix", "post-memory-injection", "baseline".
 *    Operators can branch replay directly from a checkpoint without needing
 *    to know the frame index.
 *
 * 2. COGNITION DIFF — deep structural comparison between two cognitions
 *    (source and branch). Goes beyond frame fingerprints to explain *why*
 *    they diverged: which node first produced different output, which handoffs
 *    changed, and a human-readable interpretation.
 *
 * 3. BRANCH COMPARISON — aggregate comparison across all branches of a source
 *    cognition. Gives operators a ranked list of branches by health score so
 *    they can identify which corrective attempt worked best.
 */
export class CheckpointManager {
  private readonly checkpoints = new Map<string, ReplayCheckpoint[]>();  // cognitionId → checkpoints

  constructor(
    private readonly cognitions: CognitionRepository,
    private readonly snapshots: SnapshotStore,
    private readonly branches: BranchRegistry,
    private readonly failureSignals: FailureSignalStore,
    private readonly replayEngine: ReplayEngine,
    private readonly failureEngine: FailureIntelligenceEngine,
    private readonly publisher: PersistedEventPublisher,
    private readonly eventFactory: EventFactory,
    private readonly clock: Clock
  ) {}

  // ─── Named Checkpoints ──────────────────────────────────────────────────────

  async createCheckpoint(
    cognitionId: string,
    frameIndex: number,
    name: string,
    note?: string,
    sessionId?: string
  ): Promise<ReplayCheckpoint> {
    const graph = await this.cognitions.getById(cognitionId);
    if (!graph) throw new Error(`Cognition ${cognitionId} not found`);

    // Materialize the graph state at the requested frame.
    const graphAtFrame = await this.replayEngine.getGraphAt(cognitionId, frameIndex);
    const frames = await this.replayEngine.materializeFrames(graph);
    const frame = frames[frameIndex];

    const checkpoint: ReplayCheckpoint = {
      id: deterministicId([cognitionId, frameIndex.toString(), name, "checkpoint"]),
      cognitionId,
      sessionId,
      frameIndex,
      eventSequence: frame?.eventSequence ?? frameIndex,
      name,
      note,
      createdAt: toIso(this.clock.now()),
      graphSnapshot: graphAtFrame ?? graph
    };

    // Store in-memory (production: persist to a CheckpointStore).
    const list = this.checkpoints.get(cognitionId) ?? [];
    // Replace existing checkpoint with same name (idempotent).
    const existing = list.findIndex((c) => c.name === name);
    if (existing !== -1) {
      list[existing] = checkpoint;
    } else {
      list.push(checkpoint);
    }
    this.checkpoints.set(cognitionId, list);

    await this.publisher.publish(
      this.eventFactory.create({
        type: "REPLAY_CHECKPOINT_CREATED",
        aggregateId: cognitionId,
        aggregateType: "EXECUTION",
        payload: { checkpoint: { id: checkpoint.id, cognitionId, frameIndex, name, note } },
        context: { traceId: deterministicId(["checkpoint-trace", checkpoint.id]) }
      })
    );

    return checkpoint;
  }

  listCheckpoints(cognitionId: string): ReplayCheckpoint[] {
    return (this.checkpoints.get(cognitionId) ?? []).sort(
      (a, b) => a.frameIndex - b.frameIndex
    );
  }

  getCheckpoint(cognitionId: string, name: string): ReplayCheckpoint | undefined {
    return (this.checkpoints.get(cognitionId) ?? []).find((c) => c.name === name);
  }

  // ─── Cognition Diff ─────────────────────────────────────────────────────────

  async diffCognitions(sourceCognitionId: string, branchCognitionId: string): Promise<CognitionDiff> {
    const [source, branch] = await Promise.all([
      this.cognitions.getById(sourceCognitionId),
      this.cognitions.getById(branchCognitionId)
    ]);
    if (!source || !branch) throw new Error("Cognition not found for diff");

    const [sourceFrames, branchFrames] = await Promise.all([
      this.replayEngine.materializeFrames(source),
      this.replayEngine.materializeFrames(branch)
    ]);

    // ── Structural diff ───────────────────────────────────────────────────────
    const sourceSeqs = new Set(source.nodes.map((n) => n.sequence));
    const branchSeqs = new Set(branch.nodes.map((n) => n.sequence));
    const sharedNodeSequences = [...sourceSeqs].filter((s) => branchSeqs.has(s)).sort((a, b) => a - b);
    const sourceOnlyNodeSequences = [...sourceSeqs].filter((s) => !branchSeqs.has(s)).sort((a, b) => a - b);
    const branchOnlyNodeSequences = [...branchSeqs].filter((s) => !sourceSeqs.has(s)).sort((a, b) => a - b);

    // ── Handoff changes ───────────────────────────────────────────────────────
    const handoffChanges: CognitionDiff["structural"]["handoffChanges"] = [];
    const maxHandoffs = Math.max(source.handoffs.length, branch.handoffs.length);
    for (let i = 0; i < maxHandoffs; i++) {
      const sh = source.handoffs[i];
      const bh = branch.handoffs[i];
      if (sh && bh && sh.toRole !== bh.toRole) {
        handoffChanges.push({ sequence: i, source: sh.toRole, branch: bh.toRole });
      }
    }

    // ── Output diffs on shared nodes ──────────────────────────────────────────
    const outputDiffs: CognitionDiff["outputDiffs"] = [];
    let firstDivergentNodeSequence: number | undefined;

    for (const seq of sharedNodeSequences) {
      const sourceNode = source.nodes.find((n) => n.sequence === seq);
      const branchNode = branch.nodes.find((n) => n.sequence === seq);
      if (!sourceNode || !branchNode) continue;
      if (!sourceNode.output && !branchNode.output) continue;

      const changedKeys = findChangedKeys(sourceNode.output ?? {}, branchNode.output ?? {});
      if (changedKeys.length > 0) {
        if (firstDivergentNodeSequence === undefined) {
          firstDivergentNodeSequence = seq;
        }
        outputDiffs.push({
          nodeSequence: seq,
          role: sourceNode.role,
          changedKeys,
          sourceSummary: summarizeOutput(sourceNode.output),
          branchSummary: summarizeOutput(branchNode.output)
        });
      }
    }

    // ── Frame-level divergence ────────────────────────────────────────────────
    const frameDiff = await this.replayEngine.diffCognitions(sourceCognitionId, branchCognitionId);

    // ── Human interpretation ──────────────────────────────────────────────────
    const interpretation = buildInterpretation(
      source,
      branch,
      firstDivergentNodeSequence,
      outputDiffs,
      handoffChanges,
      sourceOnlyNodeSequences,
      branchOnlyNodeSequences
    );

    return {
      sourceCognitionId,
      branchCognitionId,
      divergenceFrameIndex: frameDiff.divergenceFrameIndex,
      firstDivergentNodeSequence,
      structural: {
        sourceNodeCount: source.nodes.length,
        branchNodeCount: branch.nodes.length,
        sharedNodeSequences,
        sourceOnlyNodeSequences,
        branchOnlyNodeSequences,
        handoffChanges
      },
      outputDiffs,
      interpretation,
      diffedAt: toIso(this.clock.now())
    };
  }

  // ─── Branch Comparison ──────────────────────────────────────────────────────

  async compareBranches(sourceCognitionId: string): Promise<BranchComparison> {
    const [source, branchPointers] = await Promise.all([
      this.cognitions.getById(sourceCognitionId),
      this.branches.listForCognition(sourceCognitionId)
    ]);
    if (!source) throw new Error(`Cognition ${sourceCognitionId} not found`);

    const sourceSignals = await this.failureSignals.listByCognition(sourceCognitionId);
    const sourceReport = this.failureEngine.buildReport(
      source.executionId,
      source.id,
      sourceSignals
    );

    const branchEntries: BranchComparisonEntry[] = await Promise.all(
      branchPointers.map(async (ptr) => {
        const branchGraph = await this.cognitions.getById(ptr.branchCognitionId);
        const branchSignals = await this.failureSignals.listByCognition(ptr.branchCognitionId);
        const branchReport = this.failureEngine.buildReport(
          branchGraph?.executionId ?? "",
          ptr.branchCognitionId,
          branchSignals
        );

        const topSignalKinds = [...new Set(
          branchSignals
            .sort((a, b) => b.score - a.score)
            .slice(0, 4)
            .map((s) => s.kind)
        )];

        return {
          branchCognitionId: ptr.branchCognitionId,
          divergenceFrameIndex: ptr.branchPointFrameIndex,
          frameCount: branchGraph
            ? (await this.replayEngine.materializeFrames(branchGraph)).length
            : 0,
          nodeCount: branchGraph?.nodes.length ?? 0,
          healthScore: branchReport.healthScore,
          phase: branchGraph?.phase ?? "UNKNOWN",
          outcome: mapPhaseToOutcome(branchGraph?.phase),
          failureSignalCount: branchSignals.length,
          topSignalKinds
        };
      })
    );

    // Recommended branch: highest health score among COMPLETED branches.
    const completedBranches = branchEntries.filter((b) => b.outcome === "COMPLETED");
    const recommendedBranchId = completedBranches.length > 0
      ? completedBranches.sort((a, b) => b.healthScore - a.healthScore)[0].branchCognitionId
      : undefined;

    return {
      sourceCognitionId,
      sourcePhase: source.phase,
      sourceHealthScore: sourceReport.healthScore,
      branches: branchEntries.sort((a, b) => b.healthScore - a.healthScore),
      recommendedBranchId,
      comparedAt: toIso(this.clock.now())
    };
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function findChangedKeys(
  sourceOutput: Record<string, unknown>,
  branchOutput: Record<string, unknown>
): string[] {
  const allKeys = new Set([...Object.keys(sourceOutput), ...Object.keys(branchOutput)]);
  return [...allKeys].filter((k) => {
    const sv = JSON.stringify(sourceOutput[k]);
    const bv = JSON.stringify(branchOutput[k]);
    return sv !== bv;
  });
}

function summarizeOutput(output?: Record<string, unknown>): string {
  if (!output) return "(no output)";
  const keys = Object.keys(output).slice(0, 5);
  return `{${keys.map((k) => `${k}: ${String(output[k]).slice(0, 24)}`).join(", ")}}`;
}

function buildInterpretation(
  source: CognitionGraph,
  branch: CognitionGraph,
  firstDivergentSeq: number | undefined,
  outputDiffs: CognitionDiff["outputDiffs"],
  handoffChanges: CognitionDiff["structural"]["handoffChanges"],
  sourceOnly: number[],
  branchOnly: number[]
): string {
  const parts: string[] = [];

  if (firstDivergentSeq !== undefined) {
    const divergentNode = source.nodes.find((n) => n.sequence === firstDivergentSeq);
    parts.push(`First output divergence at node seq ${firstDivergentSeq} (${divergentNode?.role ?? "?"})`);
  } else {
    parts.push("No output divergence — branches produced identical outputs for all shared nodes");
  }

  if (handoffChanges.length > 0) {
    parts.push(`${handoffChanges.length} handoff path change(s)`);
  }

  const sizeChange = branch.nodes.length - source.nodes.length;
  if (sizeChange !== 0) {
    parts.push(`Branch has ${Math.abs(sizeChange)} ${sizeChange > 0 ? "more" : "fewer"} nodes`);
  }

  if (outputDiffs.length > 0) {
    const changedRoles = [...new Set(outputDiffs.map((d) => d.role))];
    parts.push(`Output changed in: ${changedRoles.join(", ")}`);
  }

  if (branch.phase !== source.phase) {
    parts.push(`Source ended in ${source.phase}, branch ended in ${branch.phase}`);
  }

  return parts.join("; ");
}

function mapPhaseToOutcome(phase?: string): "COMPLETED" | "FAILED" | "PENDING" {
  if (!phase) return "PENDING";
  if (phase === "COMPLETE") return "COMPLETED";
  if (phase === "FAILED") return "FAILED";
  return "PENDING";
}
