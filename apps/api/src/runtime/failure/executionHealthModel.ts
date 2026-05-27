import type { DomainEvent } from "../../domain/events.js";
import type { CognitionGraph, CognitionNode, AgentRole } from "../../domain/cognition.js";
import type { FailureSignal, FailureSignalKind } from "../../domain/failure.js";
import type {
  AnomalyDimension,
  AnomalyDimensionScore,
  ExecutionAnomalyScore,
  ExecutionConfidenceScore,
  ExecutionHealthSnapshot,
  ReasoningConsistencyScore,
  ReplayStabilityScore,
  ToolReliabilityScore
} from "../../domain/executionHealth.js";
import { syncFingerprint } from "../../shared/determinism.js";

/**
 * Execution Health Model — Phase 7 production implementation.
 *
 * WHAT IT COMPUTES:
 *   Five orthogonal sub-scores on real cognition graph + event log + failure
 *   signal data, composed into one healthScore (0..100, higher = healthier).
 *
 *     1. confidence       — would I trust this output? (uncertainty + hallucination signals)
 *     2. stability        — does the same input reliably produce the same output?
 *     3. toolReliability  — are the agent's tools succeeding?
 *     4. consistency      — does the agent contradict itself?
 *     5. anomaly          — is this run abnormal vs the agent's baseline?
 *
 *   Each sub-score returns null when there isn't enough data to measure it
 *   (e.g., stability requires historical executions). The composite formula
 *   re-normalizes weights across only the dimensions that returned a value,
 *   so a brand-new agent isn't penalized for lacking history.
 *
 * OPERATIONAL USEFULNESS:
 *   - Gating: "auto-promote when healthScore ≥ 85 AND confidence ≥ 0.80"
 *   - Pager: "anomaly ≥ 0.7 OR consistency ≤ 0.4 → page on-call"
 *   - Triage list: sort recent executions by healthScore ascending; the worst
 *     are the ones an operator should review first
 *   - Replay anchor: each sub-score points to the frames/nodes that drove it
 *     so scrubbing from a low score lands directly on the cause
 *
 * REPLAY/DEBUGGING VALUE:
 *   - confidence.weakestNodeIds → branch points for "retry with different model"
 *   - stability.outputAgreementRate < 0.5 → flakiness, branch to compare runs
 *   - toolReliability.perTool → which tool failed; tool-specific repair UI
 *   - anomaly.topDimension → which metric (tokens, duration, steps) deviated
 *
 * FALSE-POSITIVE RISKS:
 *   - Genuinely uncertain tasks (open research) will always score low confidence
 *     — surface task type so operators filter
 *   - First N executions of an agent will lack a baseline; anomaly returns null
 *     (we deliberately don't fabricate a "no anomaly" reading from no data)
 *   - replayStability uses input fingerprint equality; two executions of the
 *     "same" question with slightly different prompts won't be compared
 *
 * DETERMINISM:
 *   Given identical (events, graph, signals, baseline) inputs the model
 *   produces identical scores. No clock-dependent or RNG-dependent paths.
 */
export class ExecutionHealthModel {
  /**
   * Weights for composing the healthScore. Must sum to 1.0 across all dims;
   * we renormalize when some dims return null.
   */
  private static readonly WEIGHTS = {
    confidence: 0.30,
    stability: 0.20,
    toolReliability: 0.20,
    consistency: 0.20,
    anomaly: 0.10
  };

  compute(input: HealthComputeInput): ExecutionHealthSnapshot {
    const startedAt = Date.now();
    const { executionId, graph, events, signals, baseline, historicalForAgent } = input;

    const confidence = scoreConfidence(graph, signals);
    const stability = scoreStability(graph, historicalForAgent);
    const toolReliability = scoreToolReliability(events, signals);
    const consistency = scoreConsistency(graph, signals);
    const anomaly = scoreAnomaly(graph, events, signals, baseline);

    const observedSignalKinds = Array.from(new Set(signals.map((s) => s.kind))) as FailureSignalKind[];

    const healthScore = composeHealthScore({
      confidence: confidence.value,
      stability: stability.value,
      toolReliability: toolReliability.value,
      consistency: consistency.value,
      anomaly: anomaly.value
    });

    return {
      executionId,
      cognitionId: graph?.id,
      agentId: graph?.agentId,
      healthScore,
      grade: gradeFor(healthScore),
      confidence,
      stability,
      toolReliability,
      consistency,
      anomaly,
      observedSignalKinds,
      computedAt: new Date(input.now ?? Date.now()).toISOString(),
      computationDurationMs: Date.now() - startedAt
    };
  }
}

export interface HealthComputeInput {
  executionId: string;
  graph: CognitionGraph | undefined;
  events: DomainEvent[];
  signals: FailureSignal[];
  /** Per-agent baseline for anomaly detection. May be undefined → no anomaly score. */
  baseline?: AgentBaseline;
  /**
   * Prior executions of the same agent that we can compare this one to.
   * Empty array means no historical stability data. The model never asks the
   * store to load full graphs — callers pre-project to the minimal fields
   * we need.
   */
  historicalForAgent?: HistoricalExecutionProjection[];
  /** Wallclock for the snapshot timestamp. Injected for deterministic tests. */
  now?: number;
}

export interface AgentBaseline {
  agentId: string;
  executionCount: number;
  dimensions: Record<AnomalyDimension, { median: number; mad: number }>;
}

/**
 * Minimal projection of a historical execution used by stability scoring.
 * Callers (typically a wiring layer) pre-build this so the health model never
 * does deep loads from the store.
 */
export interface HistoricalExecutionProjection {
  executionId: string;
  /** sha-stable fingerprint of the initial input. */
  inputFingerprint: string;
  /** sha-stable fingerprint of the terminal output, or undefined when none. */
  outputFingerprint?: string;
  nodeCount: number;
  toolCallCount: number;
}

// ─── Composition ─────────────────────────────────────────────────────────────

function composeHealthScore(values: {
  confidence: number | null;
  stability: number | null;
  toolReliability: number | null;
  consistency: number | null;
  anomaly: number | null;
}): number {
  const w = ExecutionHealthModel["WEIGHTS"];
  const contribs: Array<[number, number]> = [];
  if (values.confidence !== null) contribs.push([values.confidence, w.confidence]);
  if (values.stability !== null) contribs.push([values.stability, w.stability]);
  if (values.toolReliability !== null) contribs.push([values.toolReliability, w.toolReliability]);
  if (values.consistency !== null) contribs.push([values.consistency, w.consistency]);
  if (values.anomaly !== null) contribs.push([1 - values.anomaly, w.anomaly]);

  if (contribs.length === 0) return 0;
  const totalWeight = contribs.reduce((a, [, weight]) => a + weight, 0);
  const weightedSum = contribs.reduce((a, [v, weight]) => a + v * weight, 0);
  const normalized = weightedSum / totalWeight;
  return Math.round(Math.max(0, Math.min(1, normalized)) * 100);
}

function gradeFor(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

// ─── Sub-score: confidence ────────────────────────────────────────────────────

function scoreConfidence(
  graph: CognitionGraph | undefined,
  signals: FailureSignal[]
): ExecutionConfidenceScore {
  if (!graph) {
    return emptySubScore<ExecutionConfidenceScore>("no cognition graph", {
      weakestNodeIds: []
    });
  }

  const completed = graph.nodes.filter((n) => n.status === "COMPLETED" && n.uncertainty);
  if (completed.length === 0) {
    return emptySubScore<ExecutionConfidenceScore>(
      "no completed nodes carry uncertainty data",
      { weakestNodeIds: [] }
    );
  }

  // Base: average confidence = 1 - average uncertainty.overall, weighted by token count.
  // High-token nodes count more because they carry more information.
  let weightedConfidence = 0;
  let totalWeight = 0;
  for (const node of completed) {
    const u = node.uncertainty!;
    const tokens = node.tokenStream?.length ?? 1;
    weightedConfidence += (1 - u.overall) * tokens;
    totalWeight += tokens;
  }
  const baseConfidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

  // Penalty: detected HALLUCINATION + LOW_CONFIDENCE signals erode confidence.
  // We sum (severityWeight * score) for the two confidence-related kinds,
  // bounded so a single bad signal can't drive the score to 0.
  const confidenceSignals = signals.filter(
    (s) => s.kind === "HALLUCINATION" || s.kind === "LOW_CONFIDENCE" || s.kind === "UNCERTAINTY_SPIKE"
  );
  const signalPenalty = Math.min(
    0.55,
    confidenceSignals.reduce((a, s) => a + s.score * severityFactor(s.severity), 0) * 0.08
  );

  // Self-report agreement: when models declared confidence and it matched the
  // observed uncertainty, we trust the score more (small boost). When it
  // disagreed wildly, we penalise.
  const selfReportAgreement = scoreSelfReportAgreement(completed);

  const value = Math.max(0, Math.min(1, baseConfidence - signalPenalty + selfReportAgreement * 0.05));

  // Weakest nodes: bottom 3 by per-node confidence.
  const weakestNodeIds = [...completed]
    .sort((a, b) => b.uncertainty!.overall - a.uncertainty!.overall)
    .slice(0, 3)
    .map((n) => n.id);

  return {
    value: Number(value.toFixed(4)),
    sampleSize: completed.length,
    rationale: buildConfidenceRationale(baseConfidence, signalPenalty, confidenceSignals.length),
    components: {
      baseConfidence: round(baseConfidence),
      signalPenalty: round(signalPenalty),
      selfReportAgreement: round(selfReportAgreement),
      confidenceSignalCount: confidenceSignals.length
    },
    weakestNodeIds
  };
}

function scoreSelfReportAgreement(nodes: CognitionNode[]): number {
  let agreed = 0;
  let total = 0;
  for (const node of nodes) {
    const u = node.uncertainty!;
    if (u.selfReport === undefined) continue;
    total += 1;
    // Self-report close to (1 - overall) is "model is calibrated".
    const observed = 1 - u.overall;
    if (Math.abs(observed - u.selfReport) < 0.2) agreed += 1;
  }
  return total === 0 ? 0 : agreed / total;
}

function buildConfidenceRationale(base: number, penalty: number, signalCount: number): string {
  const parts: string[] = [`base ${(base * 100).toFixed(0)}%`];
  if (signalCount > 0) parts.push(`-${(penalty * 100).toFixed(0)}% from ${signalCount} confidence signal(s)`);
  return parts.join(", ");
}

// ─── Sub-score: stability ────────────────────────────────────────────────────

function scoreStability(
  graph: CognitionGraph | undefined,
  historical: HistoricalExecutionProjection[] | undefined
): ReplayStabilityScore {
  if (!graph || !historical || historical.length === 0) {
    return {
      value: null,
      sampleSize: 0,
      rationale: "no prior executions of this agent available",
      components: {},
      baselineExecutionCount: 0,
      outputAgreementRate: 0
    };
  }

  // Compare on initial input fingerprint: only count runs that started with
  // the same input as comparable. This avoids declaring "unstable" when the
  // agent was given different tasks.
  const ourInputFp = inputFingerprintOf(graph);
  const ourOutputFp = outputFingerprintOf(graph);
  const ourNodeCount = graph.nodes.length;
  const ourToolCalls = countToolCallNodes(graph);

  const comparable = historical.filter((h) => h.inputFingerprint === ourInputFp);
  if (comparable.length === 0) {
    return {
      value: null,
      sampleSize: 0,
      rationale: `no prior executions matched this input fingerprint (${historical.length} historical execs)`,
      components: { totalHistorical: historical.length },
      baselineExecutionCount: 0,
      outputAgreementRate: 0
    };
  }

  // Output agreement: fraction that produced the same output fingerprint.
  const outputMatches = comparable.filter((h) => h.outputFingerprint && h.outputFingerprint === ourOutputFp).length;
  const outputAgreementRate = comparable.length > 0 ? outputMatches / comparable.length : 0;

  // Structural agreement: node count and tool call count within ±20% counts as agreement.
  const within = (a: number, b: number, tol = 0.2): boolean =>
    a === 0 && b === 0 ? true : Math.abs(a - b) / Math.max(a, b, 1) <= tol;
  const structuralMatches = comparable.filter(
    (h) => within(h.nodeCount, ourNodeCount) && within(h.toolCallCount, ourToolCalls)
  ).length;
  const structuralAgreementRate = comparable.length > 0 ? structuralMatches / comparable.length : 0;

  // Final stability = 60% output agreement + 40% structural agreement.
  // An execution that gives the same output via a wildly different node graph
  // is *less* replay-stable than one with both output AND structure matching.
  const value = outputAgreementRate * 0.6 + structuralAgreementRate * 0.4;

  return {
    value: Number(value.toFixed(4)),
    sampleSize: comparable.length,
    rationale: `${outputMatches}/${comparable.length} prior runs produced the same output; ${structuralMatches}/${comparable.length} matched structure`,
    components: {
      outputAgreement: round(outputAgreementRate),
      structuralAgreement: round(structuralAgreementRate),
      comparableCount: comparable.length,
      totalHistorical: historical.length
    },
    baselineExecutionCount: comparable.length,
    outputAgreementRate: round(outputAgreementRate)
  };
}

// ─── Sub-score: tool reliability ─────────────────────────────────────────────

function scoreToolReliability(
  events: DomainEvent[],
  signals: FailureSignal[]
): ToolReliabilityScore {
  type ToolPayload = {
    toolName?: string;
    success?: boolean;
    error?: string;
    output?: Record<string, unknown>;
  };

  const toolEvents = events.filter((e) => e.type === "TOOL_CALLED");
  if (toolEvents.length === 0) {
    // No tool calls is *not* a failure — return null, not 0.
    return {
      value: null,
      sampleSize: 0,
      rationale: "no tool calls in this execution",
      components: {},
      perTool: []
    };
  }

  const perTool = new Map<string, { calls: number; failures: number; misuse: number }>();
  for (const e of toolEvents) {
    const tc = (e.payload as { toolCall?: ToolPayload }).toolCall;
    if (!tc?.toolName) continue;
    const stats = perTool.get(tc.toolName) ?? { calls: 0, failures: 0, misuse: 0 };
    stats.calls += 1;
    const failed = tc.success === false || (tc.error !== undefined && tc.error.length > 0);
    if (failed) stats.failures += 1;
    perTool.set(tc.toolName, stats);
  }

  // Attribute TOOL_MISUSE signals to the named tool when possible.
  const misuseSignals = signals.filter((s) => s.kind === "TOOL_MISUSE");
  for (const sig of misuseSignals) {
    for (const [name, stats] of perTool) {
      if (sig.summary.includes(`"${name}"`)) {
        stats.misuse += 1;
        break;
      }
    }
  }

  if (perTool.size === 0) {
    return {
      value: null,
      sampleSize: 0,
      rationale: "tool calls present but no tool names attributed",
      components: { toolEventCount: toolEvents.length },
      perTool: []
    };
  }

  // Per-tool reliability = successRate * misusePenalty.
  // Harmonic mean across tools: one consistently bad tool drags the score
  // hard, matching operational reality (one broken tool blocks the agent).
  const reliabilities: number[] = [];
  const perToolReport: ToolReliabilityScore["perTool"] = [];
  for (const [name, stats] of perTool) {
    const successRate = stats.calls > 0 ? (stats.calls - stats.failures) / stats.calls : 1;
    const misusePenalty = Math.min(0.5, stats.misuse * 0.15);
    const rel = Math.max(0, successRate - misusePenalty);
    reliabilities.push(rel);
    perToolReport.push({
      toolName: name,
      callCount: stats.calls,
      successRate: round(successRate),
      misuseSignals: stats.misuse
    });
  }

  // Harmonic mean (penalizes outliers). Add ε to avoid div-by-zero.
  const eps = 1e-6;
  const harmonic = reliabilities.length / reliabilities.reduce((a, r) => a + 1 / (r + eps), 0);

  perToolReport.sort((a, b) => a.successRate - b.successRate);
  return {
    value: Number(harmonic.toFixed(4)),
    sampleSize: toolEvents.length,
    rationale: `${perTool.size} tool(s), ${toolEvents.length} call(s); harmonic-mean reliability ${(harmonic * 100).toFixed(0)}%`,
    components: {
      harmonicReliability: round(harmonic),
      toolCount: perTool.size,
      callCount: toolEvents.length,
      misuseSignalCount: misuseSignals.length
    },
    perTool: perToolReport.slice(0, 8)
  };
}

// ─── Sub-score: reasoning consistency ────────────────────────────────────────

function scoreConsistency(
  graph: CognitionGraph | undefined,
  signals: FailureSignal[]
): ReasoningConsistencyScore {
  if (!graph) {
    return emptySubScore<ReasoningConsistencyScore>("no cognition graph", {
      contradictionSignals: 0,
      trueLoopSignals: 0,
      verifierRejections: 0,
      sameRoleOutputDivergence: 0
    });
  }

  const contradictionSignals = signals.filter((s) => s.kind === "CONTRADICTION").length;
  const trueLoopSignals = signals.filter(
    (s) => s.kind === "RECURSION" &&
      s.evidence.some((ev) => ev.metric?.isProgressCycle === 0)
  ).length;

  // Verifier rejections: structural contradictions from the graph itself.
  const verifierRejections = countVerifierRejections(graph);

  // Same-role output divergence: when EXECUTOR ran 3 times and produced 3
  // different verdict-key values, the model is reasoning inconsistently
  // even if no analyzer flagged it.
  const sameRoleOutputDivergence = computeSameRoleDivergence(graph);

  // Base = 1.0. Each signal class subtracts. The maximum subtraction is bounded
  // so a single contradiction doesn't drive the score to 0.
  const contradictionPenalty = Math.min(0.40, contradictionSignals * 0.12);
  const loopPenalty = Math.min(0.30, trueLoopSignals * 0.18);
  const verifierPenalty = Math.min(0.25, verifierRejections * 0.10);
  const divergencePenalty = sameRoleOutputDivergence * 0.30;

  const value = Math.max(0, 1 - contradictionPenalty - loopPenalty - verifierPenalty - divergencePenalty);

  return {
    value: Number(value.toFixed(4)),
    sampleSize: graph.nodes.length,
    rationale: buildConsistencyRationale(contradictionSignals, trueLoopSignals, verifierRejections, sameRoleOutputDivergence),
    components: {
      contradictionPenalty: round(contradictionPenalty),
      loopPenalty: round(loopPenalty),
      verifierPenalty: round(verifierPenalty),
      divergencePenalty: round(divergencePenalty)
    },
    contradictionSignals,
    trueLoopSignals,
    verifierRejections,
    sameRoleOutputDivergence: round(sameRoleOutputDivergence)
  };
}

function countVerifierRejections(graph: CognitionGraph): number {
  const sorted = [...graph.nodes].sort((a, b) => a.sequence - b.sequence);
  let count = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (
      prev.role === "EXECUTOR" && prev.status === "COMPLETED" &&
      curr.role === "VERIFIER" && curr.status === "FAILED"
    ) {
      count += 1;
    }
  }
  return count;
}

function computeSameRoleDivergence(graph: CognitionGraph): number {
  // Group completed nodes by role. For each role with ≥2 nodes, compute the
  // ratio of distinct output fingerprints to nodes. 1.0 = every output unique
  // (high divergence), 0 = all identical (no divergence).
  const byRole = new Map<AgentRole, string[]>();
  for (const node of graph.nodes) {
    if (node.status !== "COMPLETED" || !node.output) continue;
    const fps = byRole.get(node.role) ?? [];
    fps.push(syncFingerprint(node.output));
    byRole.set(node.role, fps);
  }
  let totalDivergence = 0;
  let groupsCounted = 0;
  for (const [, fps] of byRole) {
    if (fps.length < 2) continue;
    const distinct = new Set(fps).size;
    // distinct=1 (all identical) → divergence 0; distinct=n (all unique) → 1.
    const divergence = (distinct - 1) / (fps.length - 1);
    totalDivergence += divergence;
    groupsCounted += 1;
  }
  return groupsCounted === 0 ? 0 : totalDivergence / groupsCounted;
}

function buildConsistencyRationale(
  contradictions: number,
  loops: number,
  rejections: number,
  divergence: number
): string {
  const parts: string[] = [];
  if (contradictions > 0) parts.push(`${contradictions} contradiction(s)`);
  if (loops > 0) parts.push(`${loops} true loop(s)`);
  if (rejections > 0) parts.push(`${rejections} verifier rejection(s)`);
  if (divergence > 0.3) parts.push(`same-role outputs diverged ${(divergence * 100).toFixed(0)}%`);
  return parts.length > 0 ? parts.join(", ") : "no contradictions or loops detected";
}

// ─── Sub-score: anomaly ──────────────────────────────────────────────────────

function scoreAnomaly(
  graph: CognitionGraph | undefined,
  events: DomainEvent[],
  signals: FailureSignal[],
  baseline: AgentBaseline | undefined
): ExecutionAnomalyScore {
  const observed: Record<AnomalyDimension, number> = {
    stepCount: countEvents(events, ["EXECUTION_STEP_COMPLETED"]),
    nodeCount: graph?.nodes.length ?? 0,
    tokenTotal: sumTokens(events),
    durationMs: computeDurationMs(events),
    signalDensity: signals.length / Math.max(1, graph?.nodes.length ?? 1),
    toolCallCount: countEvents(events, ["TOOL_CALLED"])
  };

  if (!baseline || baseline.executionCount < 5) {
    // Not enough history to declare anomaly. Return null but still report
    // observed values so operators can see the raw metrics.
    const dimensions = {} as Record<AnomalyDimension, AnomalyDimensionScore>;
    for (const dim of Object.keys(observed) as AnomalyDimension[]) {
      dimensions[dim] = { observed: observed[dim], baselineMedian: 0, robustZScore: 0 };
    }
    return {
      value: null,
      sampleSize: events.length,
      rationale: baseline
        ? `baseline has only ${baseline.executionCount} execution(s); need ≥5`
        : "no baseline for this agent",
      components: {},
      dimensions,
      baselineExecutionCount: baseline?.executionCount ?? 0
    };
  }

  const dimensions = {} as Record<AnomalyDimension, AnomalyDimensionScore>;
  let topZ = 0;
  let topDim: AnomalyDimension = "stepCount";
  for (const dim of Object.keys(observed) as AnomalyDimension[]) {
    const obs = observed[dim];
    const stats = baseline.dimensions[dim] ?? { median: 0, mad: 0 };
    const delta = Math.abs(obs - stats.median);
    // Robust-z calculation:
    //   - Standard case (MAD > 0): delta / MAD
    //   - Degenerate case (MAD = 0, observed == median): z = 0 (perfectly normal)
    //   - Degenerate case (MAD = 0, observed != median): the baseline was
    //     CONSTANT on this dimension. Any deviation is a strong anomaly.
    //     Use delta / max(1, median) so the magnitude of the deviation
    //     still matters: 1 vs 0 yields z=1, but 1000 vs 0 yields z=large.
    //     We cap at 10 so a single outlier dimension can't dominate the
    //     overall score.
    let robustZ: number;
    if (stats.mad > 0) {
      robustZ = delta / stats.mad;
    } else if (delta === 0) {
      robustZ = 0;
    } else {
      robustZ = Math.min(10, delta / Math.max(1, Math.abs(stats.median)));
    }
    dimensions[dim] = {
      observed: round(obs),
      baselineMedian: round(stats.median),
      robustZScore: round(robustZ)
    };
    if (robustZ > topZ) {
      topZ = robustZ;
      topDim = dim;
    }
  }

  // Convert robust-z to a 0..1 anomaly score with a sigmoid-like saturation:
  //   z=0   → 0     (perfectly normal)
  //   z=3   → 0.6   (notable)
  //   z=5   → 0.85  (clear anomaly)
  //   z=10+ → ~1.0  (extreme outlier)
  const value = topZ <= 0 ? 0 : 1 - Math.exp(-topZ / 3.5);

  return {
    value: Number(value.toFixed(4)),
    sampleSize: baseline.executionCount,
    rationale: `top dimension "${topDim}" deviates ${topZ.toFixed(2)} robust-z from baseline median`,
    components: {
      topRobustZScore: round(topZ),
      baselineExecutionCount: baseline.executionCount
    },
    topDimension: topDim,
    dimensions,
    baselineExecutionCount: baseline.executionCount
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function severityFactor(severity: FailureSignal["severity"]): number {
  return { INFO: 0, LOW: 0.5, MEDIUM: 1, HIGH: 1.8, CRITICAL: 3 }[severity] ?? 0;
}

function round(n: number): number {
  return Number(n.toFixed(4));
}

function emptySubScore<T extends {
  value: number | null;
  sampleSize: number;
  rationale: string;
  components: Record<string, number>;
}>(rationale: string, extra: Omit<T, "value" | "sampleSize" | "rationale" | "components">): T {
  return {
    value: null,
    sampleSize: 0,
    rationale,
    components: {},
    ...(extra as object)
  } as T;
}

function countEvents(events: DomainEvent[], types: string[]): number {
  const set = new Set(types);
  return events.filter((e) => set.has(e.type)).length;
}

function sumTokens(events: DomainEvent[]): number {
  let total = 0;
  for (const e of events) {
    if (e.type !== "MODEL_COMPLETED") continue;
    const p = e.payload as { tokenUsage?: { total?: number; promptTokens?: number; completionTokens?: number } };
    const t = p.tokenUsage;
    if (!t) continue;
    total += t.total ?? ((t.promptTokens ?? 0) + (t.completionTokens ?? 0));
  }
  return total;
}

function computeDurationMs(events: DomainEvent[]): number {
  if (events.length < 2) return 0;
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const first = Date.parse(sorted[0].timestamp);
  const last = Date.parse(sorted[sorted.length - 1].timestamp);
  return Math.max(0, last - first);
}

function inputFingerprintOf(graph: CognitionGraph): string {
  const first = [...graph.nodes].sort((a, b) => a.sequence - b.sequence)[0];
  return first?.inputFingerprint ?? syncFingerprint(graph.id);
}

function outputFingerprintOf(graph: CognitionGraph): string | undefined {
  if (graph.output) return syncFingerprint(graph.output);
  const last = [...graph.nodes].sort((a, b) => b.sequence - a.sequence)[0];
  return last?.output ? syncFingerprint(last.output) : undefined;
}

function countToolCallNodes(graph: CognitionGraph): number {
  // Not directly stored on the graph; approximate by counting EXECUTOR nodes
  // whose output references a tool. Falls back to 0 when no signal available.
  return graph.nodes.filter((n) =>
    n.role === "EXECUTOR" && n.output && JSON.stringify(n.output).toLowerCase().includes("tool")
  ).length;
}

/**
 * Pure helper to build an AgentBaseline from a list of per-execution
 * dimensional metrics. Uses median + MAD (robust to outliers), unlike
 * mean + stddev which would be dragged by a single 100x-token run.
 *
 * Callers: wiring layer pre-loads the metrics via HealthSnapshotStore
 *          .listMetricsForAgent() and passes them here.
 */
export function buildBaselineFromMetrics(
  agentId: string,
  history: Array<{ dimensions: Record<AnomalyDimension, number> }>
): AgentBaseline {
  const dims = ["stepCount", "nodeCount", "tokenTotal", "durationMs", "signalDensity", "toolCallCount"] as AnomalyDimension[];
  const out = {} as Record<AnomalyDimension, { median: number; mad: number }>;
  for (const dim of dims) {
    const values = history.map((h) => h.dimensions[dim]).filter((v): v is number => typeof v === "number");
    const median = robustMedian(values);
    const deviations = values.map((v) => Math.abs(v - median));
    const mad = robustMedian(deviations);
    out[dim] = { median, mad };
  }
  return { agentId, executionCount: history.length, dimensions: out };
}

function robustMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
