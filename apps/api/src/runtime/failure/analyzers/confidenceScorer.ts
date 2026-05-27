import type { FailureAnalyzer } from "../analyzer.js";
import type { AnalyzerContext, FailureSignal } from "../../../domain/failure.js";
import type { DomainEvent } from "../../../domain/events.js";
import type { CognitionGraph, CognitionNode } from "../../../domain/cognition.js";
import { deterministicId } from "../../../shared/determinism.js";

/**
 * Confidence Scorer — Phase 3 new analyzer.
 *
 * WHAT IT DETECTS:
 *   Systematic confidence degradation across the cognition graph: a trend
 *   where each successive node has lower confidence than the previous one
 *   (indicating an agent losing its footing), single-node uncertainty spikes
 *   (indicating a specific moment of maximum confusion), or self-declared
 *   low confidence from the model's own output.
 *
 * OPERATIONAL USEFULNESS:
 *   Confidence decay is a leading indicator, not a lagging one: it shows up
 *   *before* the execution actually fails. An operator watching the confidence
 *   curve can intervene early — branch replay at the first spike, inject a
 *   clarifying memory, or switch models — rather than waiting for EXECUTION_FAILED.
 *
 * REPLAY/DEBUGGING VALUE:
 *   - `metric.slopePerNode` gives the linear trend — steep negative slope
 *     means rapid degradation, shallow means gradual drift
 *   - Spike signals include the exact node before/after the spike so operators
 *     can scrub directly to the inflection point
 *   - Self-report signals include the declared confidence value so triage can
 *     judge how explicitly the model flagged its uncertainty
 *
 * FALSE-POSITIVE RISKS:
 *   - Tasks that are genuinely uncertain by nature (open research, speculation)
 *     will show high uncertainty throughout; this is expected, not a failure
 *   - Uncertainty spikes at VERIFIER nodes are often expected — the verifier
 *     should be less certain than the executor about its own verdict; consider
 *     filtering VERIFIER from spike detection
 *   - Low self-report confidence is only present when the model emits it
 *     (inference-time confidence elicitation); absence is neutral, not positive
 *
 * DETECTION STRATEGIES:
 *   1. Linear confidence decay: trend line over node uncertainty.overall
 *   2. Uncertainty spikes: single-node uncertainty jump > SPIKE_THRESHOLD
 *   3. Self-report below floor: model declares selfReport < LOW_SELF_REPORT
 *   4. High-variance cluster: consecutive nodes with variance > VARIANCE_THRESHOLD
 */
export class ConfidenceScorer implements FailureAnalyzer {
  readonly name = "confidence-scorer";

  private static readonly DECAY_SLOPE_THRESHOLD = -0.08;  // per-node drop
  private static readonly SPIKE_DELTA_THRESHOLD = 0.30;   // single-step jump
  private static readonly LOW_SELF_REPORT = 0.35;
  private static readonly VARIANCE_THRESHOLD = 0.25;
  private static readonly MIN_NODES_FOR_TREND = 3;

  analyze(_events: DomainEvent[], graph: CognitionGraph | undefined, ctx: AnalyzerContext): FailureSignal[] {
    if (!graph) return [];

    const signals: FailureSignal[] = [];
    const nodesWithUncertainty = [...graph.nodes]
      .filter((n): n is CognitionNode & { uncertainty: NonNullable<CognitionNode["uncertainty"]> } =>
        n.status === "COMPLETED" && n.uncertainty !== undefined
      )
      .sort((a, b) => a.sequence - b.sequence);

    if (nodesWithUncertainty.length === 0) return signals;

    // ── Strategy 1: Linear confidence decay trend ────────────────────────────
    // Fit a line to (sequence, uncertainty.overall) data. Negative slope means
    // the agent is becoming more uncertain over time. We only trigger on
    // slopes beyond DECAY_SLOPE_THRESHOLD to avoid noise from short sequences.
    if (nodesWithUncertainty.length >= ConfidenceScorer.MIN_NODES_FOR_TREND) {
      const slope = linearSlope(nodesWithUncertainty.map((n, i) => [i, n.uncertainty.overall]));
      if (slope < ConfidenceScorer.DECAY_SLOPE_THRESHOLD) {
        const firstU = nodesWithUncertainty[0].uncertainty.overall;
        const lastU = nodesWithUncertainty[nodesWithUncertainty.length - 1].uncertainty.overall;
        const declineAmount = Number((lastU - firstU).toFixed(3));
        signals.push({
          id: deterministicId([graph.id, "confidence-decay", ctx.executionId]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          nodeId: nodesWithUncertainty[nodesWithUncertainty.length - 1].id,
          kind: "LOW_CONFIDENCE",
          severity: slope < -0.20 ? "HIGH" : "MEDIUM",
          score: Math.min(1, Math.abs(slope) * 4),
          summary: `Confidence decayed across ${nodesWithUncertainty.length} nodes (slope ${slope.toFixed(3)}/node, ${firstU.toFixed(2)} → ${lastU.toFixed(2)})`,
          evidence: [
            ...nodesWithUncertainty.map((n) => ({
              nodeId: n.id,
              metric: { uncertaintyOverall: n.uncertainty.overall, sequence: n.sequence }
            })),
            { metric: { slopePerNode: Number(slope.toFixed(4)), declineAmount, nodeCount: nodesWithUncertainty.length } }
          ],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    // ── Strategy 2: Single-node uncertainty spikes ───────────────────────────
    // A sudden jump in uncertainty.overall between consecutive nodes is more
    // operationally useful than the trend: it pinpoints exactly where the agent
    // lost confidence, which is usually the branch point for replay.
    for (let i = 1; i < nodesWithUncertainty.length; i++) {
      const prev = nodesWithUncertainty[i - 1];
      const curr = nodesWithUncertainty[i];
      const delta = curr.uncertainty.overall - prev.uncertainty.overall;
      if (delta >= ConfidenceScorer.SPIKE_DELTA_THRESHOLD) {
        signals.push({
          id: deterministicId([curr.id, "uncertainty-spike", ctx.executionId]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          nodeId: curr.id,
          kind: "UNCERTAINTY_SPIKE",
          severity: delta >= 0.50 ? "HIGH" : "MEDIUM",
          score: Math.min(1, delta * 1.6),
          summary: `Uncertainty spiked +${(delta * 100).toFixed(0)}% at ${curr.role} (seq ${curr.sequence}): ${prev.uncertainty.overall.toFixed(2)} → ${curr.uncertainty.overall.toFixed(2)}`,
          evidence: [
            { nodeId: prev.id, metric: { uncertaintyBefore: prev.uncertainty.overall } },
            { nodeId: curr.id, metric: { uncertaintyAfter: curr.uncertainty.overall, spike: delta } }
          ],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    // ── Strategy 3: Low self-report confidence ───────────────────────────────
    // When the model explicitly declares its own confidence (selfReport), and
    // that value is below the floor, it's the model's own signal of doubt.
    // This is the highest-quality signal in this analyzer because it's not
    // inferred — it's the model directly telling us it's not confident.
    for (const node of nodesWithUncertainty) {
      const sr = node.uncertainty.selfReport;
      if (sr !== undefined && sr < ConfidenceScorer.LOW_SELF_REPORT) {
        signals.push({
          id: deterministicId([node.id, "low-self-report", ctx.executionId]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          nodeId: node.id,
          kind: "LOW_CONFIDENCE",
          severity: sr < 0.20 ? "HIGH" : "MEDIUM",
          score: Math.min(1, (ConfidenceScorer.LOW_SELF_REPORT - sr) * 2.5 + 0.3),
          summary: `${node.role} (seq ${node.sequence}) self-reported confidence ${(sr * 100).toFixed(0)}% — model declared uncertainty`,
          evidence: [{
            nodeId: node.id,
            metric: {
              selfReport: sr,
              uncertaintyOverall: node.uncertainty.overall,
              lowConfidenceTokens: node.uncertainty.lowConfidenceTokens
            }
          }],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    // ── Strategy 4: High-variance cluster ────────────────────────────────────
    // Consecutive nodes with high variance means the model oscillated token-by-
    // token throughout the execution. Even if average uncertainty is moderate,
    // high variance indicates the model was never firmly committed to anything.
    const highVarNodes = nodesWithUncertainty.filter(
      (n) => n.uncertainty.variance > ConfidenceScorer.VARIANCE_THRESHOLD
    );
    if (highVarNodes.length >= 3) {
      const avgVariance = highVarNodes.reduce((a, n) => a + n.uncertainty.variance, 0) / highVarNodes.length;
      signals.push({
        id: deterministicId([graph.id, "high-variance-cluster", ctx.executionId]),
        cognitionId: ctx.cognitionId,
        executionId: ctx.executionId,
        kind: "LOW_CONFIDENCE",
        severity: highVarNodes.length >= 5 ? "HIGH" : "MEDIUM",
        score: Math.min(1, avgVariance * 1.8),
        summary: `${highVarNodes.length} nodes with high token-confidence variance (avg ${avgVariance.toFixed(2)}) — agent oscillating`,
        evidence: [
          ...highVarNodes.map((n) => ({ nodeId: n.id, metric: { variance: n.uncertainty.variance } })),
          { metric: { highVarianceNodeCount: highVarNodes.length, averageVariance: Number(avgVariance.toFixed(3)) } }
        ],
        detectedAt: ctx.detectedAt,
        detectedBy: this.name
      });
    }

    return signals;
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Least-squares linear slope of (x, y) pairs. Returns 0 for empty/single-point input. */
function linearSlope(points: Array<[number, number]>): number {
  const n = points.length;
  if (n < 2) return 0;
  const sumX = points.reduce((a, [x]) => a + x, 0);
  const sumY = points.reduce((a, [, y]) => a + y, 0);
  const sumXY = points.reduce((a, [x, y]) => a + x * y, 0);
  const sumX2 = points.reduce((a, [x]) => a + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}
