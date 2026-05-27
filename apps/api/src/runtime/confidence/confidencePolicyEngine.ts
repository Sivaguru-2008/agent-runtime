import type {
  CognitionNode,
  ConfidenceLineage,
  ConfidencePropagation,
  DegradationTracking,
  InstabilityAttribution
} from "../../domain/cognition.js";

export type ConfidenceClassification = "HIGH" | "MEDIUM" | "LOW" | "CRITICAL";

export interface ConfidencePolicyDecision {
  classification: ConfidenceClassification;
  confidenceScore: number;
  triggerReplanning: boolean;
  retrievalDepthMultiplier: number;
  enableMultiVerifier: boolean;
  executionAutonomy: "FULL" | "DEGRADED" | "HALTED";
  requireEscalation: boolean;
}

/**
 * Calculates a 0-100 confidence score for a CognitionNode based on its uncertainty score.
 * By default, uncertainty.overall is [0..1] where 0 is high confidence and 1 is maximal uncertainty.
 * If the agent self-reported a confidence score, we respect it (scaling to 0-100 if in [0..1] range).
 */
export function calculateConfidenceScore(node: CognitionNode): number {
  if (node.uncertainty?.selfReport !== undefined) {
    const report = node.uncertainty.selfReport;
    return report <= 1 && report > 0 ? report * 100 : report;
  }
  if (node.uncertainty?.overall !== undefined) {
    return Math.max(0, Math.min(100, (1 - node.uncertainty.overall) * 100));
  }
  if (node.tokenStream && node.tokenStream.length > 0) {
    const sum = node.tokenStream.reduce((acc, t) => acc + (t.confidence ?? 0), 0);
    return Math.max(0, Math.min(100, (sum / node.tokenStream.length) * 100));
  }
  return 100;
}

/**
 * Classifies a 0-100 confidence score based on the policy thresholds:
 *   - HIGH >= 80
 *   - MEDIUM >= 50
 *   - LOW >= 30
 *   - CRITICAL < 30
 */
export function classifyConfidence(score: number): ConfidenceClassification {
  if (score >= 80) return "HIGH";
  if (score >= 50) return "MEDIUM";
  if (score >= 30) return "LOW";
  return "CRITICAL";
}

/**
 * Produces orchestration routing decisions based on the confidence score:
 *
 * If confidence < 30 (CRITICAL):
 *   - trigger replanning
 *   - increase retrieval depth
 *   - enable multi-verifier mode
 *   - lower execution autonomy ("DEGRADED")
 *
 * If confidence < 15:
 *   - halt autonomous execution ("HALTED")
 *   - require escalation state
 */
export function makeOrchestrationDecision(score: number): ConfidencePolicyDecision {
  const classification = classifyConfidence(score);
  const isCritical = score < 30;
  const isHalted = score < 15;

  return {
    classification,
    confidenceScore: Number(score.toFixed(2)),
    triggerReplanning: isCritical,
    retrievalDepthMultiplier: isCritical ? 2 : 1,
    enableMultiVerifier: isCritical,
    executionAutonomy: isHalted ? "HALTED" : (isCritical ? "DEGRADED" : "FULL"),
    requireEscalation: isHalted
  };
}

/**
 * Propagates confidence values, tracks parent-child degradation, and attributes instability source.
 * Updates the given node's confidence properties in-place.
 */
export function propagateConfidence(node: CognitionNode, history: CognitionNode[]): void {
  // Find preceding completed node in history (which acts as the direct parent)
  const completedHistory = history.filter((n) => n.status === "COMPLETED" && n.id !== node.id);
  const parent = completedHistory[completedHistory.length - 1];

  const score = calculateConfidenceScore(node);
  const classification = classifyConfidence(score);

  node.confidenceScore = score;
  node.confidenceClassification = classification;

  // 1. Confidence Lineage Tracking
  const lineagePath: string[] = parent && parent.confidenceLineage
    ? [...parent.confidenceLineage.path, node.id]
    : [node.id];
  const lineageScores: number[] = parent && parent.confidenceLineage
    ? [...parent.confidenceLineage.scores, score]
    : [score];

  node.confidenceLineage = {
    path: lineagePath,
    scores: lineageScores
  };

  // 2. Confidence Propagation Analytics
  const ancestorScores = lineageScores.slice(0, lineageScores.length - 1);
  const ancestorSum = ancestorScores.reduce((acc, s) => acc + s, 0);
  const ancestorAverage = ancestorScores.length > 0 ? ancestorSum / ancestorScores.length : score;
  const lineageMin = Math.min(...lineageScores);
  const propagatingDegradation = parent ? (parent.confidenceClassification === "CRITICAL" || parent.confidenceClassification === "LOW") : false;

  node.confidencePropagation = {
    ancestorAverage: Number(ancestorAverage.toFixed(2)),
    lineageMin,
    propagatingDegradation
  };

  // 3. Parent-Child Degradation Tracking
  const parentConfidence = parent ? parent.confidenceScore ?? 100 : undefined;
  const confidenceDrop = parentConfidence !== undefined ? parentConfidence - score : 0;

  let severity: DegradationTracking["severity"] = "NONE";
  if (confidenceDrop > 30 || score < 30) severity = "CRITICAL";
  else if (confidenceDrop > 15 || score < 50) severity = "HIGH";
  else if (confidenceDrop > 5 || score < 80) severity = "LOW";

  node.degradationTracking = {
    parentId: parent?.id,
    parentConfidence,
    confidenceDrop: Number(confidenceDrop.toFixed(2)),
    severity
  };

  // 4. Instability Source Attribution
  if (score < 50) {
    let sourceId = node.id;
    let sourceType: InstabilityAttribution["sourceType"] = "LLM";
    let uncertaintyScore = node.uncertainty?.overall ?? 0.5;
    let reason = "Model output had high token uncertainty or variance.";

    // Qualitative check of outcomes to attribute the source of the drop
    const toolResults = node.output?.toolResults as Array<{ name: string; output: Record<string, unknown> }> | undefined;
    const hasToolError = toolResults?.some((tr) => tr.output?.error !== undefined || tr.output?.status === "FAILED");

    if (hasToolError) {
      sourceType = "TOOL";
      reason = "Uncertainty attributed to tool call error or unsuccessful tool run.";
    } else if (parent && parent.confidenceScore !== undefined && parent.confidenceScore < 50) {
      sourceType = "PARENT";
      sourceId = parent.id;
      reason = `Uncertainty propagated from preceding degraded parent node ${parent.id}.`;
    } else if (!node.memoryInfluence || node.memoryInfluence.length === 0) {
      sourceType = "CONTEXT";
      reason = "Attributed to sparse or low-relevance memory context retrieved.";
    }

    node.instabilityAttribution = {
      sourceId,
      sourceType,
      uncertaintyScore,
      reason
    };
  }
}
