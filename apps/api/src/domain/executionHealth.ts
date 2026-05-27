/**
 * Execution Health Model — Phase 7 domain types.
 *
 * WHY THIS EXISTS:
 *   Failure analyzers raise *signals*. Signals are local: "this node hallucinated",
 *   "this loop spun". Operators need a *global* read on the entire execution:
 *   should I trust this output? Should I promote it? Is this run abnormal vs the
 *   baseline? Five sub-scores compose into one ExecutionHealthScore that a
 *   dashboard, gating policy, or pager can act on without re-reading the trace.
 *
 * DESIGN PRINCIPLES:
 *   - Every score derives from real cognition graph + event log + signal store
 *     data. No random scoring. Missing inputs produce `null`, never a fabricated
 *     value, so consumers can tell "we don't know" from "we measured and it's low".
 *   - Scores are 0..1 with a uniform direction: HIGHER = HEALTHIER. The composite
 *     healthScore is 0..100 so it composes with the existing FailureReport.
 *   - Each sub-score is independently reportable. The composite is a weighted
 *     summary, not a black box: rationale exposes the components that drove it.
 *
 * OPERATIONAL USEFULNESS:
 *   Gates: "auto-promote when healthScore ≥ 85 AND confidence ≥ 0.8".
 *   Alerts: "page when anomalyScore ≥ 0.7 even if no signals fired".
 *   Triage: "show me the 10 executions with the worst consistency this hour".
 *   Replay: every sub-score links to the frames/nodes that drove it, so
 *   operators scrub directly to the cause.
 */

import type { FailureSignalKind } from "./failure.js";

/**
 * Sub-score with rationale. `value === null` when there is not enough data
 * to compute (e.g., stability score with no historical baseline). Callers
 * must distinguish "null" (unknown) from "0" (measured and bad).
 */
export interface HealthSubScore {
  /** 0..1, higher = healthier. `null` when insufficient data. */
  value: number | null;
  /** Number of inputs used in the calculation (nodes, calls, baselines). */
  sampleSize: number;
  /** Why the score landed where it did — operator-readable. */
  rationale: string;
  /**
   * Machine-readable component contributions so a UI can render a breakdown.
   * Keys are component names (e.g., "uncertaintyAvg"), values are 0..1.
   */
  components: Record<string, number>;
}

export interface ExecutionConfidenceScore extends HealthSubScore {
  /** Cognition node IDs with the lowest confidence — replay anchor points. */
  weakestNodeIds: string[];
}

export interface ReplayStabilityScore extends HealthSubScore {
  /** Number of historical executions of the same agent/input the score was compared against. */
  baselineExecutionCount: number;
  /**
   * 0..1 — fraction of compared executions whose output fingerprint matched.
   * Distinct from `value`: this is the raw agreement rate. `value` also folds
   * in node-count and tool-call agreement so an execution that matches outputs
   * but diverged structurally still loses points.
   */
  outputAgreementRate: number;
}

export interface ToolReliabilityScore extends HealthSubScore {
  /** Per-tool reliability, sorted worst-first. Truncated to the 8 noisiest. */
  perTool: Array<{
    toolName: string;
    callCount: number;
    successRate: number;
    /** Number of TOOL_MISUSE signals raised against this tool in this execution. */
    misuseSignals: number;
  }>;
}

export interface ReasoningConsistencyScore extends HealthSubScore {
  /** Total contradiction signals (any kind). */
  contradictionSignals: number;
  /** Total recursion signals (true loops only — progress retries excluded). */
  trueLoopSignals: number;
  /** Verifier-rejection count: structural contradictions. */
  verifierRejections: number;
  /**
   * 0..1 — fraction of same-role node pairs whose outputs disagree on a shared
   * verdict key. Higher = more inconsistent. Captured separately so operators
   * can see "the model is contradicting itself on PASS/FAIL".
   */
  sameRoleOutputDivergence: number;
}

export interface ExecutionAnomalyScore extends HealthSubScore {
  /**
   * Direction is inverted vs other sub-scores: 0 = normal, 1 = highly anomalous.
   * The composite formula uses `(1 - anomalyScore.value)` so the composite
   * direction stays "higher = healthier".
   */
  value: number | null;
  /** Which dimension was most anomalous — the axis to investigate first. */
  topDimension?: AnomalyDimension;
  /** Per-dimension z-score (robust, MAD-based). */
  dimensions: Record<AnomalyDimension, AnomalyDimensionScore>;
  /** Number of comparable historical executions in the baseline. */
  baselineExecutionCount: number;
}

export type AnomalyDimension =
  | "stepCount"
  | "nodeCount"
  | "tokenTotal"
  | "durationMs"
  | "signalDensity"
  | "toolCallCount";

export interface AnomalyDimensionScore {
  /** Observed value for this execution. */
  observed: number;
  /** Median of comparable historical executions. */
  baselineMedian: number;
  /** Robust z-score (|observed - median| / MAD). */
  robustZScore: number;
}

/**
 * Composite execution health snapshot. Stored per execution; one snapshot per
 * call to ExecutionHealthModel.compute(executionId). New snapshots replace older
 * ones for the same execution so the store always reflects the latest reading.
 */
export interface ExecutionHealthSnapshot {
  executionId: string;
  cognitionId?: string;
  agentId?: string;
  /** 0..100 composite. Higher = healthier. */
  healthScore: number;
  /** Letter grade derived from healthScore. */
  grade: "A" | "B" | "C" | "D" | "F";
  /** Sub-score breakdown. Each may be null if insufficient data. */
  confidence: ExecutionConfidenceScore;
  stability: ReplayStabilityScore;
  toolReliability: ToolReliabilityScore;
  consistency: ReasoningConsistencyScore;
  anomaly: ExecutionAnomalyScore;
  /** Which failure signal kinds were observed during scoring. */
  observedSignalKinds: FailureSignalKind[];
  computedAt: string;
  /** Wall-clock cost of the computation, for ops budgeting. */
  computationDurationMs: number;
}

export interface ExecutionHealthBaseline {
  agentId: string;
  /** Number of executions that contributed to the baseline. */
  executionCount: number;
  /** Per-dimension median + MAD for anomaly detection. */
  dimensions: Record<AnomalyDimension, { median: number; mad: number }>;
  /**
   * Per-input-fingerprint output agreement: for the same input, how often did
   * we see the same output? Used by replay stability scoring.
   */
  inputOutputAgreement: Record<
    string,
    { executionCount: number; uniqueOutputFingerprints: number }
  >;
  builtAt: string;
}

export interface HealthSnapshotStore {
  put(snapshot: ExecutionHealthSnapshot): Promise<void>;
  get(executionId: string): Promise<ExecutionHealthSnapshot | undefined>;
  listRecent(limit: number): Promise<ExecutionHealthSnapshot[]>;
  listByAgent(agentId: string, limit: number): Promise<ExecutionHealthSnapshot[]>;
  /**
   * Streaming-friendly accessor for baseline computation: returns just the
   * dimensional metrics, not the full snapshot. Implementations may optimise.
   */
  listMetricsForAgent(agentId: string, limit: number): Promise<
    Array<Pick<ExecutionHealthSnapshot, "executionId" | "computedAt"> & {
      dimensions: Record<AnomalyDimension, number>;
    }>
  >;
}
