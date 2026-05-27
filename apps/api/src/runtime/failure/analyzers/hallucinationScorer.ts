import type { FailureAnalyzer } from "../analyzer.js";
import type { AnalyzerContext, FailureEvidence, FailureSignal } from "../../../domain/failure.js";
import type { DomainEvent } from "../../../domain/events.js";
import type { CognitionGraph, CognitionNode } from "../../../domain/cognition.js";
import { deterministicId } from "../../../shared/determinism.js";

/**
 * Hallucination Scorer — Phase 3 production implementation.
 *
 * WHAT IT DETECTS:
 *   An executor node whose output contains factual claims unsupported by any
 *   retrieved memory, or where the model's own token-level confidence signals
 *   indicate fabrication rather than retrieval. Hallucination is the single
 *   most operationally dangerous failure mode: the agent produces plausible-
 *   looking output that is structurally correct but factually invented.
 *
 * OPERATIONAL USEFULNESS:
 *   Every flagged node links directly to the replay frame so an operator can
 *   branch replay just before that node, inject corrected memory, and compare
 *   the diverged timeline to confirm the fix. Without this signal, hallucinated
 *   outputs silently propagate through VERIFIER and MEMORY_COMMIT into the
 *   episodic store, poisoning future executions.
 *
 * REPLAY/DEBUGGING VALUE:
 *   - `nodeId` maps to the exact replay frame
 *   - `evidence.metric` surfaces the raw signal weights so operators can judge
 *     whether each component drove the score
 *   - `evidence.snippet` shows which output string triggered entity mismatch
 *
 * FALSE-POSITIVE RISKS:
 *   - A legitimately creative EXECUTOR that invents plan steps (not facts) will
 *     score medium without memory grounding; operators should filter by role
 *   - Long outputs with many proper nouns score higher for "entity density"
 *     even when those nouns appear in tool outputs not modeled as memories
 *   - Self-report confidence (selfReport) is only present when the model
 *     explicitly emits it; absence does not mean high confidence
 *
 * SIGNAL COMPONENTS:
 *   1. Token-confidence uncertainty  — from uncertainty.overall + variance
 *   2. Memory-grounding deficit      — entity overlap between output and memories
 *   3. Self-report discount          — model declared its own uncertainty
 *   4. Verifier rejection correlation — VERIFIER failed immediately after this node
 */
export class HallucinationScorer implements FailureAnalyzer {
  readonly name = "hallucination-scorer";

  private static readonly THRESHOLD = 0.32;
  private static readonly MIN_TEXT_FOR_ENTITY_CHECK = 40;

  analyze(events: DomainEvent[], graph: CognitionGraph | undefined, ctx: AnalyzerContext): FailureSignal[] {
    if (!graph) return [];

    // Build a corpus of all text from consulted memories so we can check
    // whether output entities are grounded in real retrieved content.
    const memoryTextCorpus = this.buildMemoryCorpus(graph);

    // Track which EXECUTOR nodes were immediately followed by a VERIFIER failure.
    // This is the strongest available signal that the executor produced bad output.
    const executorIdsFollowedByVerifierFail = this.findVerifierRejections(graph);

    const signals: FailureSignal[] = [];

    for (const node of graph.nodes) {
      if (node.role !== "EXECUTOR" || node.status !== "COMPLETED") continue;

      const u = node.uncertainty;
      const outputText = JSON.stringify(node.output ?? "");
      if (outputText.length < HallucinationScorer.MIN_TEXT_FOR_ENTITY_CHECK && !u) continue;

      // ── Component 1: Token-confidence uncertainty ─────────────────────────
      // overall ∈ [0,1]: 0 = confident, 1 = maximally uncertain
      // variance amplifies uncertainty when the model oscillated: low-average
      // but high-variance means it kept second-guessing itself.
      // selfReport is the model's explicit "I'm not sure" declaration.
      const uncertaintyComponent = computeUncertaintyComponent(u);

      // ── Component 2: Memory-grounding deficit ────────────────────────────
      // Extract string values from output, isolate proper-noun-like tokens
      // (≥4 chars, starts uppercase), measure what fraction appear nowhere
      // in the retrieved memory corpus.
      const { groundingDeficit, unmatchedEntities, totalEntities } = computeGroundingDeficit(
        outputText,
        memoryTextCorpus,
        (node.memoryInfluence?.length ?? 0) === 0
      );

      // ── Component 3: Verifier-rejection correlation ───────────────────────
      // If the VERIFIER node that ran immediately after this EXECUTOR failed,
      // that's strong evidence the executor's output was rejected.
      const verifierRejected = executorIdsFollowedByVerifierFail.has(node.id);
      const verifierComponent = verifierRejected ? 0.28 : 0;

      // ── Composite score ────────────────────────────────────────────────────
      // Weighted combination. Uncertainty is the weakest signal alone (many
      // tasks are genuinely uncertain); grounding deficit is the strongest.
      const raw =
        uncertaintyComponent * 0.35 +
        groundingDeficit * 0.45 +
        verifierComponent;

      const score = Math.min(1, Number(raw.toFixed(3)));
      if (score < HallucinationScorer.THRESHOLD) continue;

      const evidence: FailureEvidence[] = [
        {
          nodeId: node.id,
          metric: {
            uncertaintyOverall: Number((u?.overall ?? 0).toFixed(3)),
            uncertaintyVariance: Number((u?.variance ?? 0).toFixed(3)),
            selfReport: Number((u?.selfReport ?? -1).toFixed(3)),
            lowConfidenceTokens: u?.lowConfidenceTokens ?? 0,
            groundingDeficit: Number(groundingDeficit.toFixed(3)),
            totalEntities,
            unmatchedEntities,
            verifierRejected: verifierRejected ? 1 : 0,
            noMemoryConsulted: (node.memoryInfluence?.length ?? 0) === 0 ? 1 : 0
          }
        }
      ];

      const noMemory = (node.memoryInfluence?.length ?? 0) === 0;
      signals.push({
        id: deterministicId([node.id, "hallucination", ctx.executionId]),
        cognitionId: ctx.cognitionId,
        executionId: ctx.executionId,
        nodeId: node.id,
        kind: "HALLUCINATION",
        severity: score >= 0.75 ? "HIGH" : score >= 0.52 ? "MEDIUM" : "LOW",
        score,
        summary: buildSummary(score, noMemory, verifierRejected, unmatchedEntities, totalEntities, u?.overall ?? 0),
        evidence,
        detectedAt: ctx.detectedAt,
        detectedBy: this.name
      });
    }

    return signals;
  }

  private buildMemoryCorpus(graph: CognitionGraph): string {
    const parts: string[] = [];
    for (const node of graph.nodes) {
      for (const inf of node.memoryInfluence ?? []) {
        // Memory IDs and reasons are the only memory text available in the
        // cognition graph at analysis time (full memory content lives in the
        // memory store, not inlined here). We use what we have: memory IDs
        // and the free-text reason give us anchor tokens.
        if (inf.reason) parts.push(inf.reason.toLowerCase());
        parts.push(inf.memoryId.toLowerCase());
      }
      // Also mine PLANNER and MEMORY_MANAGER output for grounding text.
      if (node.role === "MEMORY_MANAGER" || node.role === "PLANNER") {
        parts.push(JSON.stringify(node.output ?? "").toLowerCase());
      }
    }
    return parts.join(" ");
  }

  private findVerifierRejections(graph: CognitionGraph): Set<string> {
    const rejected = new Set<string>();
    const sorted = [...graph.nodes].sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (
        prev.role === "EXECUTOR" &&
        prev.status === "COMPLETED" &&
        curr.role === "VERIFIER" &&
        curr.status === "FAILED"
      ) {
        rejected.add(prev.id);
      }
    }
    return rejected;
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function computeUncertaintyComponent(u: CognitionNode["uncertainty"]): number {
  if (!u) return 0;
  // Combine average uncertainty with variance (high-variance = oscillating confidence)
  // and self-report if present (lower selfReport = more uncertain by model's own account).
  const baseUncertainty = u.overall;
  const variancePenalty = Math.min(0.3, u.variance * 0.4);
  const selfReportPenalty =
    u.selfReport !== undefined && u.selfReport < 0.5
      ? (0.5 - u.selfReport) * 0.4  // 0 selfReport → 0.20 extra penalty
      : 0;
  return Math.min(1, baseUncertainty + variancePenalty + selfReportPenalty);
}

function computeGroundingDeficit(
  outputText: string,
  memoryCorpus: string,
  noMemoryConsulted: boolean
): { groundingDeficit: number; unmatchedEntities: number; totalEntities: number } {
  // Extract proper-noun-like tokens: 4+ chars, starts uppercase, only letters.
  const entities = Array.from(new Set(
    (outputText.match(/\b[A-Z][a-zA-Z]{3,}\b/g) ?? [])
      .filter((e) => e !== "JSON" && e !== "null" && e !== "true" && e !== "false" && e !== "undefined")
  ));

  if (entities.length === 0) {
    // No named entities: only penalize if there's also zero memory consulted.
    return { groundingDeficit: noMemoryConsulted ? 0.18 : 0, unmatchedEntities: 0, totalEntities: 0 };
  }

  // Count entities that do NOT appear in the memory corpus.
  const unmatched = entities.filter((e) => !memoryCorpus.includes(e.toLowerCase()));
  const unmatchedRatio = unmatched.length / entities.length;

  // Cap at 0.6: even completely ungrounded output doesn't pin the full score
  // to just this signal — uncertainty and verifier rejection must also weigh in.
  const deficit = Math.min(0.6, unmatchedRatio * 0.55 + (noMemoryConsulted ? 0.12 : 0));

  return {
    groundingDeficit: deficit,
    unmatchedEntities: unmatched.length,
    totalEntities: entities.length
  };
}

function buildSummary(
  score: number,
  noMemory: boolean,
  verifierRejected: boolean,
  unmatchedEntities: number,
  totalEntities: number,
  uncertainty: number
): string {
  const parts: string[] = [];
  if (verifierRejected) parts.push("verifier rejected output");
  if (noMemory) parts.push("no memory consulted");
  if (totalEntities > 0 && unmatchedEntities > 0) {
    parts.push(`${unmatchedEntities}/${totalEntities} entities ungrounded`);
  }
  if (uncertainty > 0.5) parts.push(`high uncertainty (${(uncertainty * 100).toFixed(0)}%)`);
  return parts.length > 0
    ? `Hallucination risk ${(score * 100).toFixed(0)}%: ${parts.join(", ")}`
    : `Hallucination risk ${(score * 100).toFixed(0)}%`;
}
