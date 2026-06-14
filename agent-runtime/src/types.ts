/**
 * Canonical types for the unified runtime intelligence layer.
 *
 * Every one of the eight stages reads and writes these shapes. One `runId`
 * threads through all of them, so any event — a token, a tool result, a fence
 * decision — is traceable end to end (Non-Negotiable #8, #10).
 */

// ─── Fault + intervention taxonomy ──────────────────────────────────────────

export type FaultType =
  | "WRONG_ANSWER"
  | "INCOMPLETE_ANSWER"
  | "HALLUCINATION"
  | "TOOL_FAILURE"
  | "SILENT_FAILURE"
  | "CONTEXT_LOST"
  | "FORMAT_WRONG"
  | "OVERCONFIDENT"
  | "LOOP_WASTE"
  | "INTENT_DRIFT"
  | "FENCE_SUPPRESSED"
  | "COST_EXCEEDED"
  | "CONTEXT_COLLAPSE";

export type InterventionType =
  | "WARN"
  | "REDIRECT"
  | "ABORT"
  | "FENCE"
  | "REPLAY"
  | "HUMAN";

/** Stream-analyzer signal categories (Stage 2). */
export type StreamSignalType =
  | "HALLUCINATION_FORMING"
  | "LOOP_STARTING"
  | "INTENT_DRIFT"
  | "CONTEXT_COLLAPSE"
  | "SILENT_FAILURE"
  | "OVERCONFIDENCE";

export type Severity = "LOW" | "MEDIUM" | "HIGH";

// ─── Stage 0: intent ─────────────────────────────────────────────────────────

export interface ExtractedIntent {
  /** One-line restatement of what the user actually wants. */
  goal: string;
  /** Concrete things the answer must contain to be correct. */
  successCriteria: string;
  /** Keywords the final answer is expected to touch. */
  requiredElements: string[];
  /** Output shape the user expects, when stated (e.g. "JSON", "table"). */
  expectedFormat: string;
}

// ─── Stage 1: pre-flight ─────────────────────────────────────────────────────

export interface PredictedFailure {
  type: FaultType;
  probability: number; // 0..1
  atStep: number;
  reason: string;
  prevention: string;
}

export interface PreFlightAnalysis {
  riskScore: number; // 0..100
  complexity: "SIMPLE" | "MEDIUM" | "COMPLEX" | "DANGEROUS";
  predictedFailures: PredictedFailure[];
  irreversibleActionsDetected: string[];
  loopRiskFactors: string[];
  hallucinationRiskFactors: string[];
  recommendedFenceConfig: Record<string, "IRREVERSIBLE" | "IDEMPOTENT">;
  estimatedSteps: number;
  estimatedCostUSD: number;
  shouldProceed: boolean;
  proceedWithWarnings: string[];
}

// ─── Stage 2: stream signals ─────────────────────────────────────────────────

export interface StreamSignal {
  runId: string;
  type: StreamSignalType;
  /** Index into the run's flat token stream where the signal fired. */
  tokenIndex: number;
  /** Step (agent turn) the token belonged to. */
  detectedAtStep: number;
  severity: Severity;
  /** Concrete, quotable evidence pulled from the real token stream. */
  evidence: string;
  /** For loop signals: the earlier steps whose input hash matched. */
  priorSteps?: number[];
}

/** One token as emitted by the model, with its absolute position + timing. */
export interface TokenEvent {
  index: number;
  step: number;
  text: string;
  atMs: number;
}

// ─── Stage 3: step validation ────────────────────────────────────────────────

export interface StepValidation {
  stepNumber: number;
  toolCalled: string;
  inputHash: string;
  llmClaimedItWouldGet: string;
  actualToolResult: string;
  claimMatchesResult: boolean;
  dataQualityScore: number; // 0..100
  silentFailureDetected: boolean;
  silentFailureEvidence: string;
  duplicateCallDetected: boolean;
  fenceDecision: "COMMIT" | "SUPPRESS";
  continueRecommendation: boolean;
  abortReason: string;
}

// ─── Stage 4: fence ──────────────────────────────────────────────────────────

export interface FenceEvent {
  runId: string;
  step: number;
  tool: string;
  decision: "COMMITTED" | "SUPPRESSED";
  operationId: string;
  /** Present on SUPPRESSED: the recorded response the fence replayed. */
  recordedResponse?: string;
  reason: string;
}

// ─── Stage 5: causal attribution ─────────────────────────────────────────────

export interface CausalNode {
  /** Where this node is anchored in the real evidence. */
  at: { step?: number; tokenIndex?: number };
  label: string;
}

export interface CausalChain {
  failureType: FaultType;
  rootCause: CausalNode;
  chain: CausalNode[];
  /** Earliest point an intervention could have stopped the failure. */
  preventableAt: CausalNode;
  fenceCouldHaveHelped: boolean;
  totalDamageUSD: number;
  damagePreventedUSD: number;
}

// ─── Stage 6: intervention ───────────────────────────────────────────────────

export interface Intervention {
  runId: string;
  step: number;
  tokenIndex?: number;
  type: InterventionType;
  /** Imperative description of what the engine did. */
  action: string;
  reason: string;
  /** Context injected back into the model (REDIRECT) or message to the user. */
  correction?: string;
  returnToUser?: string;
  fenceAction?: string;
  /** Filled in after the run: did the intervention help or overcorrect? */
  outcome: "RESOLVED" | "OVERCORRECTED" | "PENDING";
}

// ─── Stage 8: final evaluation ───────────────────────────────────────────────

export interface DamagePrevented {
  type: string;
  estimatedCostUSD: number;
  description: string;
}

export interface FinalEvaluation {
  userGotWhatTheyAsked: boolean;
  completenessScore: number; // 0..100
  accuracyScore: number; // 0..100
  confidenceScore: number; // 0..100
  missingElements: string[];
  hallucinations: string[];
  preventedFailures: string[];
  damagePrevented: DamagePrevented[];
  overallVerdict: "SUCCESS" | "PARTIAL" | "FAILURE";
  verdictReason: string;
}

// ─── The thing every stage shares ────────────────────────────────────────────

export interface RunContext {
  runId: string;
  prompt: string;
  intent: ExtractedIntent;
  preFlight: PreFlightAnalysis;
  streamSignals: StreamSignal[];
  stepValidations: StepValidation[];
  fenceEvents: FenceEvent[];
  interventions: Intervention[];
  causalChain: CausalChain | null;
  finalEvaluation: FinalEvaluation;
  finalResponse: string;
  totalCostUSD: number;
  damagePreventedUSD: number;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  /** Aborted early by an intervention? */
  aborted: boolean;
  abortReason: string;
}

// ─── Pattern learner (Stage 7) ───────────────────────────────────────────────

export interface FaultPattern {
  faultType: FaultType;
  occurrences: number;
  fenceHelpRate: number;
  avgDamageUSD: number;
  avgInterventionUSD: number;
  predictionAccuracy: number;
  /** Trend arrow vs the previous window. */
  trend: "UP" | "DOWN" | "FLAT";
}

export interface PatternIntelligence {
  patterns: FaultPattern[];
  preFlightAccuracy: number;
  preFlightAccuracyTrend: "UP" | "DOWN" | "FLAT";
  /** Fraction of irreversible-tool fence events that were suppressed. */
  fenceSaveRate: number;
  /** Irreversible effects the fence committed exactly-once. */
  fenceCommitted: number;
  /** Irreversible effects the fence suppressed (duplicate retry or low-data hold). */
  fenceSuppressed: number;
  totalRuns: number;
}
