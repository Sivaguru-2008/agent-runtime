/**
 * Failure Intelligence Layer types.
 *
 * Each analyzer emits FailureSignal records. Signals are aggregated per
 * cognition/execution into FailureReport for dashboards and gating logic.
 */

export type FailureSignalKind =
  | "HALLUCINATION"
  | "CONTRADICTION"
  | "RECURSION"
  | "EXECUTION_LOOP"
  | "TOOL_MISUSE"
  | "CORRUPTED_MEMORY"
  | "UNCERTAINTY_SPIKE"
  | "LOW_CONFIDENCE"
  | "PLAN_DRIFT";

export type FailureSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface FailureSignal {
  id: string;
  cognitionId?: string;
  executionId: string;
  nodeId?: string;
  kind: FailureSignalKind;
  severity: FailureSeverity;
  /** 0..1 — analyzer's calibrated confidence the signal is real. */
  score: number;
  /** Short human description. */
  summary: string;
  /** Evidence frames / event sequences that support the signal. */
  evidence: FailureEvidence[];
  detectedAt: string;
  detectedBy: string;
}

export interface FailureEvidence {
  eventSequence?: number;
  nodeId?: string;
  snippet?: string;
  metric?: Record<string, number>;
}

export interface FailureReport {
  cognitionId?: string;
  executionId: string;
  totalSignals: number;
  bySeverity: Record<FailureSeverity, number>;
  byKind: Record<FailureSignalKind, number>;
  topSignals: FailureSignal[];
  /** Aggregate "healthiness" 0..100 — 100 = clean. */
  healthScore: number;
}

export interface AnalyzerContext {
  executionId: string;
  cognitionId?: string;
  detectedAt: string;
}

/**
 * One link in a root-cause chain: a single event/node that contributed to a failure.
 */
export interface CausalLink {
  nodeId?: string;
  eventSequence?: number;
  role?: string;
  description: string;
  /** Whether this link is the identified root cause vs a propagation step. */
  causalRole: "ROOT_CAUSE" | "PROPAGATION" | "TERMINAL";
}

/**
 * Full causal chain from root cause to the detected failure signal.
 */
export interface CausalChain {
  signalId: string;
  cognitionId?: string;
  executionId: string;
  links: CausalLink[];
  rootCauseDescription: string;
  /** Frame index where the root cause first appeared. */
  rootCauseFrameIndex?: number;
  tracedAt: string;
}

/**
 * A replay frame annotated with failure signals that fired in its vicinity.
 */
export interface AnnotatedFrame {
  frameIndex: number;
  eventSequence: number;
  eventType: string;
  label: string;
  tone: "info" | "success" | "warning" | "error" | "neutral";
  signals: FailureSignal[];
  /** Role of this frame in the failure timeline. */
  causalRole: "ROOT_CAUSE" | "PROPAGATION" | "TERMINAL" | "CLEAN";
}

/**
 * Complete failure timeline for an execution: frames annotated with signals
 * and causal roles so operators can scrub to the exact moment of failure.
 */
export interface FailureTimeline {
  cognitionId?: string;
  executionId: string;
  frames: AnnotatedFrame[];
  totalSignals: number;
  /** Frame index where the first failure signal appeared. */
  firstFailureFrameIndex: number | null;
  /** Frame index with the highest signal density. */
  hotspotFrameIndex: number | null;
  /** Health degradation curve: healthScore per frame bucket (10-frame windows). */
  healthCurve: Array<{ bucketStart: number; healthScore: number }>;
}
