import type { FailureAnalyzer } from "../analyzer.js";
import type { AnalyzerContext, FailureSignal } from "../../../domain/failure.js";
import type { DomainEvent } from "../../../domain/events.js";
import type { CognitionGraph } from "../../../domain/cognition.js";
import { deterministicId } from "../../../shared/determinism.js";

/**
 * Corrupted memory propagation detector.
 *
 * When the same memoryId is consulted across multiple cognition nodes AND the
 * source events show MEMORY_INFLUENCE_RECORDED → COGNITION_NODE_FAILED chains,
 * we flag possible memory corruption.
 */
export class CorruptedMemoryDetector implements FailureAnalyzer {
  readonly name = "corrupted-memory-detector";

  analyze(_events: DomainEvent[], graph: CognitionGraph | undefined, ctx: AnalyzerContext): FailureSignal[] {
    if (!graph) return [];
    const failureCountByMemory = new Map<string, number>();
    const evidenceByMemory = new Map<string, string[]>();
    for (const node of graph.nodes) {
      if (node.status !== "FAILED") continue;
      for (const inf of node.memoryInfluence ?? []) {
        failureCountByMemory.set(inf.memoryId, (failureCountByMemory.get(inf.memoryId) ?? 0) + 1);
        const list = evidenceByMemory.get(inf.memoryId) ?? [];
        list.push(node.id);
        evidenceByMemory.set(inf.memoryId, list);
      }
    }

    const signals: FailureSignal[] = [];
    for (const [memoryId, count] of failureCountByMemory) {
      if (count < 2) continue;
      signals.push({
        id: deterministicId([ctx.executionId, memoryId, "corrupted-memory"]),
        cognitionId: ctx.cognitionId,
        executionId: ctx.executionId,
        kind: "CORRUPTED_MEMORY",
        severity: count >= 3 ? "CRITICAL" : "HIGH",
        score: Math.min(1, 0.4 + count * 0.2),
        summary: `Memory ${memoryId.slice(0, 8)} implicated in ${count} failed nodes`,
        evidence: (evidenceByMemory.get(memoryId) ?? []).map((nodeId) => ({ nodeId })),
        detectedAt: ctx.detectedAt,
        detectedBy: this.name
      });
    }
    return signals;
  }
}
