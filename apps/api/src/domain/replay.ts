/**
 * Deterministic Runtime Replay primitives.
 *
 * Replay reconstructs the execution timeline as a stream of *frames* — one per
 * domain event — then lets the operator scrub, step, or fork at any frame.
 *
 * A fork ("replay-from-node") produces a new CognitionGraph whose ancestor
 * frames are identical and whose subsequent frames may diverge.
 */

import type { DomainEvent } from "./events.js";
import type { CognitionGraph, CognitionNode } from "./cognition.js";

export type ReplayFrameKind =
  | "EVENT"
  | "SNAPSHOT"
  | "BRANCH_POINT"
  | "TERMINATION";

export interface ReplayFrame {
  /** Frame index — monotonic, contiguous, 0-based. */
  index: number;
  kind: ReplayFrameKind;
  /** Wall-clock time of the originating event. */
  timestamp: string;
  /** Original event sequence in the append-only log. */
  eventSequence: number;
  eventType: string;
  /** Lightweight payload preview for scrubber rendering. */
  preview: ReplayFramePreview;
  /** Optional snapshot for fast seeks; absent on regular event frames. */
  snapshotId?: string;
}

export interface ReplayFramePreview {
  aggregateType: string;
  aggregateId: string;
  /** Human-friendly label e.g. "Planner step 3: PLAN" */
  label: string;
  /** Color hint for the timeline UI. */
  tone: "info" | "success" | "warning" | "error" | "neutral";
  /** Optional fingerprint to detect divergence vs. the original timeline. */
  fingerprint?: string;
}

export interface ReplaySnapshot {
  id: string;
  cognitionId: string;
  executionId: string;
  /** Frame index this snapshot is bound to. */
  frameIndex: number;
  /** Event sequence at the snapshot boundary. */
  eventSequence: number;
  capturedAt: string;
  /** Full materialized cognition graph at that frame. */
  graph: CognitionGraph;
  /** Source events from frame 0 to frameIndex — kept compact for transport. */
  eventCount: number;
  /**
   * Phase C: integrity hash — sha256 over the deterministic canonicalization
   * of { graph, eventSequence, frameIndex }. Stamped by SnapshotStore.put,
   * verified on get/nearest. A mismatch raises SnapshotCorruptionError and
   * emits SNAPSHOT_INTEGRITY_VIOLATED. Optional on the wire so legacy snapshots
   * persisted before the integrity column landed remain readable (the store
   * stamps a hash on the next put); callers that construct a fresh snapshot
   * should leave this undefined and let the store fill it in.
   */
  integrityHash?: string;
}

export interface ReplaySession {
  id: string;
  /** Cognition being replayed — may be original or a branch. */
  cognitionId: string;
  executionId: string;
  status: "READY" | "PLAYING" | "PAUSED" | "ENDED";
  /** Current playback cursor. */
  cursor: ReplayCursor;
  /** Materialized frames; lazily populated. */
  frames: ReplayFrame[];
  /** If this session forked, the source session + frame. */
  forkedFrom?: { sessionId: string; frameIndex: number };
  createdAt: string;
}

export interface ReplayCursor {
  frameIndex: number;
  eventSequence: number;
  /** Playback speed multiplier (1.0 = realtime, 0 = paused). */
  speed: number;
}

export interface ReplayDiff {
  /** Frames where the branch diverged from the source — first index. */
  divergenceFrameIndex: number | null;
  /** Per-frame delta summary up to the shorter of both timelines. */
  deltas: ReplayDelta[];
  summary: {
    framesCompared: number;
    framesIdentical: number;
    framesDiverged: number;
    branchOnlyFrames: number;
    sourceOnlyFrames: number;
    /** Human-readable one-line summary of the divergence. */
    narrative?: string;
    /** Same as divergenceFrameIndex — the root-cause delta frame. */
    causalDivergenceFrameIndex?: number | null;
    /** How many frames were identical before the first divergence. */
    identicalPrefixLength?: number;
  };
}

export interface ReplayDelta {
  frameIndex: number;
  /** "IDENTICAL" when fingerprints match. */
  kind: "IDENTICAL" | "DIVERGED" | "BRANCH_ONLY" | "SOURCE_ONLY";
  sourceFingerprint?: string;
  branchFingerprint?: string;
  field?: string;
  note?: string;
}

export interface BranchRequest {
  sourceCognitionId: string;
  sourceNodeId: string;
  /** Optional overrides applied at the branch point. */
  overrides?: {
    input?: Record<string, unknown>;
    /** Force a re-roll: use this seed instead of the original. */
    seed?: string;
    /** Switch the model at the branch point. */
    model?: string;
  };
  /** Human reason — surfaces in the divergence visualization. */
  reason?: string;
}

export interface BranchPointer {
  /** New cognition produced by the branch. */
  branchCognitionId: string;
  sourceCognitionId: string;
  sourceNodeId: string;
  branchPointFrameIndex: number;
  createdAt: string;
}

export interface FrameBuilderInput {
  events: DomainEvent[];
  /** Optional graph for fingerprinting node frames. */
  graph?: CognitionGraph;
}

export interface NodeReplayState {
  node: CognitionNode;
  /** Events that produced this node, in order. */
  contributingEvents: DomainEvent[];
}

/**
 * A named, operator-created checkpoint in a replay session.
 * Unlike auto-snapshots (written by the engine), checkpoints are deliberately
 * placed so operators can bookmark "before fix" / "after fix" boundaries.
 */
export interface ReplayCheckpoint {
  id: string;
  cognitionId: string;
  sessionId?: string;
  frameIndex: number;
  eventSequence: number;
  /** Operator-supplied label, e.g. "before-verifier-1", "post-tool-fix". */
  name: string;
  note?: string;
  createdAt: string;
  /** Full graph state at this checkpoint for instant branch-from-here. */
  graphSnapshot: CognitionGraph;
}

/**
 * Deep structural diff between two cognition graphs (not just frame fingerprints).
 * Produced by the CognitionDiffEngine to explain WHY divergence happened.
 */
export interface CognitionDiff {
  sourceCognitionId: string;
  branchCognitionId: string;
  divergenceFrameIndex: number | null;
  /** Which node first produced different output between source and branch. */
  firstDivergentNodeSequence?: number;
  /** Summary of structural changes. */
  structural: {
    sourceNodeCount: number;
    branchNodeCount: number;
    sharedNodeSequences: number[];
    sourceOnlyNodeSequences: number[];
    branchOnlyNodeSequences: number[];
    handoffChanges: Array<{
      sequence: number;
      source: string;
      branch: string;
    }>;
  };
  /** Output-level diffs on nodes that exist in both but produced different results. */
  outputDiffs: Array<{
    nodeSequence: number;
    role: string;
    changedKeys: string[];
    sourceSummary?: string;
    branchSummary?: string;
  }>;
  /** Human interpretation of what caused the divergence. */
  interpretation: string;
  diffedAt: string;
}

/**
 * Comparison of multiple branches off the same source cognition.
 * Enables operators to pick the best corrective branch.
 */
export interface BranchComparisonEntry {
  branchCognitionId: string;
  /** Where in the source timeline this branch forked. */
  divergenceFrameIndex: number | null;
  frameCount: number;
  nodeCount: number;
  healthScore: number;
  phase: string;
  outcome: "COMPLETED" | "FAILED" | "PENDING";
  failureSignalCount: number;
  /** Top signal kinds detected in this branch. */
  topSignalKinds: string[];
}

export interface BranchComparison {
  sourceCognitionId: string;
  sourcePhase: string;
  sourceHealthScore: number;
  branches: BranchComparisonEntry[];
  /** Branch with the highest health score, if any. */
  recommendedBranchId?: string;
  comparedAt: string;
}

/**
 * Replay certification — a single hash that summarizes the *entire* outcome of
 * a replayed execution. Two replays of the same workflow version + event
 * stream MUST produce the same `chainHash`; any drift between them is a
 * determinism regression.
 *
 * The `frameDigests` array is retained so a divergence detector can localize
 * the first divergent frame (binary search across the sequences). Operators
 * can store this alongside an execution and later prove that re-running it
 * still yields the same state — the chain hash is the production-grade
 * "Merkle root" for an execution.
 *
 * Captured fields:
 *   • executionId — the source execution this certification belongs to.
 *   • workflowVersion — the agent/version pair the replay ran under. Two
 *     certifications are only comparable when their workflowVersion matches.
 *   • eventCount — number of events folded into the hash. A different count
 *     before the chain hash even differs is itself a divergence signal.
 *   • lastEventSequence — durable cursor at certification time; lets the
 *     detector tell "the log grew since" from "the log changed underneath us".
 *   • frameDigests — per-frame deterministic digests (= preview.fingerprint).
 *   • chainHash — H_n where H_0 = "" and H_i = sha256(H_{i-1} || digest_i).
 *   • capturedAt — wall time of certification capture (NOT folded into hashes).
 */
export interface ReplayCertification {
  executionId: string;
  workflowVersion: string;
  eventCount: number;
  lastEventSequence: number;
  frameDigests: string[];
  chainHash: string;
  capturedAt: string;
}

export type ReplayDivergenceClassification =
  | "EQUIVALENT"
  | "ACCEPTABLE_VARIANCE"
  | "DIVERGED"
  | "UNSAFE_DIVERGENCE"
  | "NON_RECONSTRUCTABLE";

/**
 * Diagnostic produced when the divergence detector finds a mismatch between
 * two certifications of the same execution. `firstDivergentFrame` is the
 * index of the earliest frame whose digest changed — that frame is the
 * root cause and downstream divergence is consequential.
 */
export interface ReplayDivergence {
  executionId: string;
  expected: ReplayCertification;
  actual: ReplayCertification;
  divergent: boolean;
  /** Index of the first frame whose digest changed; null when not divergent. */
  firstDivergentFrame: number | null;
  /**
   * Why the certifications diverge — concrete classification:
   *   • "NONE"            — no divergence; chain hashes match.
   *   • "EVENT_COUNT"     — event count differs; the log grew/shrank.
   *   • "FRAME_DIGEST"    — same count, but at least one digest changed.
   *   • "WORKFLOW_VERSION"— versions differ; certifications not comparable.
   */
  reason:
    | "NONE"
    | "EVENT_COUNT"
    | "FRAME_DIGEST"
    | "WORKFLOW_VERSION"
    | "BRANCH_DRIFT"
    | "TOOL_MISMATCH"
    | "ORDER_MISMATCH"
    | "LLM_INCONSISTENCY"
    | "MISSING_EXTERNALITY"
    | "TIMING_INCONSISTENCY";
  classification: ReplayDivergenceClassification;
  narrative: string;
  detectedAt: string;
}


export type ReplaySafetyClassification =
  | "replay-safe"        // Read-only/idempotent tool or pure step (safe to run live in replay)
  | "replay-equivalent"  // Replay is fully byte-equivalent to original events
  | "replay-diverged"    // Replay has branched/drifted from original events
  | "replay-unsafe";     // Replay tried to call state-mutating/non-idempotent tool live (blocked)

export {
  REPLAY_LIFECYCLE_STATES,
  REPLAY_LIFECYCLE_TRANSITIONS,
  type ReplayLifecycleStatus,
  type ReplayDivergenceReason,
  IllegalReplayLifecycleTransitionError,
  assertReplayLifecycleTransition,
  mapLifecycleToSafetyClassification,
  isReplayTerminalLifecycle
} from "../runtime/replay/replayLifecycle.js";

export {
  REPLAY_GUARANTEES,
  REPLAY_NON_GUARANTEES,
  DETERMINISTIC_BOUNDARIES,
  PROBABILISTIC_BOUNDARIES,
  stepsObservablyEquivalent
} from "../runtime/replay/replayEquivalentSemantics.js";

export { ReplaySandboxViolationError } from "../runtime/canonicalSemantics.js";
export type { ReplaySessionState } from "../runtime/replay/replayExecutionCoordinator.js";
