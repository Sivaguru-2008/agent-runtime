import type { FailureAnalyzer } from "../analyzer.js";
import type { AnalyzerContext, FailureSignal } from "../../../domain/failure.js";
import type { DomainEvent } from "../../../domain/events.js";
import type { CognitionGraph, CognitionNode } from "../../../domain/cognition.js";
import { deterministicId } from "../../../shared/determinism.js";

/**
 * Recursion Detector — Phase 3 production implementation.
 *
 * WHAT IT DETECTS:
 *   True cycles in the cognition execution graph: sequences of role→role
 *   transitions that form a loop without the execution reaching a new phase
 *   or producing novel output. Distinguishes "progress retry" (same role,
 *   different output) from "true loop" (same role, identical output — wasted
 *   compute with no hope of resolution).
 *
 * OPERATIONAL USEFULNESS:
 *   A true loop burns tokens indefinitely. Detecting it early lets operators
 *   branch replay at the first cycle entry point, inject a different input or
 *   override the model, and avoid hitting the retry budget exhaustion path
 *   which terminates the execution with a FAILED status and no output.
 *
 * REPLAY/DEBUGGING VALUE:
 *   - `evidence` contains the full cycle path so operators can scrub from
 *     cycle-entry to cycle-repeat and see exactly what changed (or didn't)
 *   - `metric.isProgressCycle` distinguishes retry (output changed) vs
 *     true loop (output fingerprint identical) for triage prioritization
 *
 * FALSE-POSITIVE RISKS:
 *   - Intentional retry loops: a VERIFIER→EXECUTOR→VERIFIER pattern is
 *     expected up to the retry budget; we only flag at/above THRESHOLD
 *   - Cognitions where the PLANNER legitimately re-plans twice (e.g. for
 *     multi-step tasks with checkpoints) — we require *identical input*
 *     fingerprint for the "same role" check
 *
 * DETECTION STRATEGIES:
 *   1. Input-fingerprint deduplication: (role, inputFingerprint) seen ≥ THRESHOLD
 *   2. Handoff graph cycle detection: DFS on the handoff adjacency list to find
 *      back-edges (structural cycles independent of input content)
 *   3. Progress classification: compare output fingerprints to distinguish
 *      a productive retry from a stuck loop
 */
export class RecursionDetector implements FailureAnalyzer {
  readonly name = "recursion-detector";
  private static readonly THRESHOLD = 3;

  analyze(_events: DomainEvent[], graph: CognitionGraph | undefined, ctx: AnalyzerContext): FailureSignal[] {
    if (!graph) return [];

    const signals: FailureSignal[] = [];
    const sorted = [...graph.nodes].sort((a, b) => a.sequence - b.sequence);

    // ── Strategy 1: Input-fingerprint deduplication ───────────────────────────
    // Identical (role, inputFingerprint) means the cognition is re-entering an
    // agent with exactly the same problem it was given before. Track not just
    // count but also the output fingerprints to classify retry vs. true loop.
    const roleInputHistory = new Map<string, Array<{ nodeId: string; outputFingerprint: string }>>();

    for (const node of sorted) {
      const key = `${node.role}:${node.inputFingerprint}`;
      const history = roleInputHistory.get(key) ?? [];

      if (node.status === "COMPLETED" || node.status === "FAILED") {
        const outputFp = node.output ? roughFingerprint(node.output) : "none";
        history.push({ nodeId: node.id, outputFingerprint: outputFp });
        roleInputHistory.set(key, history);
      }

      if (history.length === RecursionDetector.THRESHOLD) {
        const outputFingerprints = new Set(history.map((h) => h.outputFingerprint));
        const isProgressCycle = outputFingerprints.size > 1;  // outputs differ = some progress
        const cycleNodeIds = history.map((h) => h.nodeId);

        signals.push({
          id: deterministicId([graph.id, key, "recursion", ctx.executionId]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          nodeId: node.id,
          kind: "RECURSION",
          severity: isProgressCycle ? "MEDIUM" : "HIGH",
          score: isProgressCycle ? 0.65 : 0.88,
          summary: isProgressCycle
            ? `${node.role} retried ${history.length}× with same inputs (outputs varied — progress retry)`
            : `${node.role} looped ${history.length}× with identical inputs AND outputs (true stuck loop)`,
          evidence: [
            ...cycleNodeIds.map((id) => ({ nodeId: id })),
            {
              metric: {
                repetitions: history.length,
                isProgressCycle: isProgressCycle ? 1 : 0,
                distinctOutputs: outputFingerprints.size
              }
            }
          ],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    // ── Strategy 2: Handoff graph DFS cycle detection ─────────────────────────
    // Build a directed graph from handoff records (fromNodeId → toNodeId).
    // Run DFS and record back-edges which are structural cycles.
    // This catches cycles that don't repeat an identical input fingerprint
    // (e.g., a CRITIC that keeps passing to EXECUTOR with slightly modified input
    // but the overall graph topology cycles endlessly).
    const handoffCycles = detectHandoffCycles(graph, sorted);
    for (const cycle of handoffCycles) {
      const cycleKey = cycle.path.join(":");
      signals.push({
        id: deterministicId([graph.id, cycleKey, "handoff-cycle", ctx.executionId]),
        cognitionId: ctx.cognitionId,
        executionId: ctx.executionId,
        nodeId: cycle.path[cycle.path.length - 1],
        kind: "RECURSION",
        severity: "HIGH",
        score: 0.80,
        summary: `Handoff cycle detected in execution graph: ${cycle.roleSequence.join(" → ")} → (back to ${cycle.roleSequence[0]})`,
        evidence: [
          ...cycle.path.map((nodeId) => ({ nodeId })),
          { metric: { cycleLength: cycle.path.length, handoffCount: graph.handoffs.length } }
        ],
        detectedAt: ctx.detectedAt,
        detectedBy: this.name
      });
    }

    return signals;
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function roughFingerprint(output: Record<string, unknown>): string {
  // Stable key-sorted JSON hash proxy (not cryptographic — just for equality comparison).
  const keys = Object.keys(output).sort();
  const pairs = keys.map((k) => `${k}=${String(output[k]).slice(0, 32)}`);
  return pairs.join("|").slice(0, 128);
}

interface CycleResult {
  path: string[];
  roleSequence: string[];
}

function detectHandoffCycles(
  graph: CognitionGraph,
  sorted: CognitionNode[]
): CycleResult[] {
  if (graph.handoffs.length === 0) return [];

  // Build nodeId → CognitionNode lookup and adjacency list from handoffs.
  const nodeById = new Map<string, CognitionNode>(sorted.map((n) => [n.id, n]));

  // For DFS: adjacency = fromNodeId → [toNodeIds]
  // The handoff record has fromNodeId and toRole. We map toRole to the next
  // node in sequence after the handoff.
  const adj = new Map<string, string[]>();
  for (const h of graph.handoffs) {
    const fromNode = nodeById.get(h.fromNodeId);
    if (!fromNode) continue;
    // Find the node immediately after this handoff with the target role.
    const toNode = sorted.find(
      (n) => n.sequence > fromNode.sequence && n.role === h.toRole
    );
    if (!toNode) continue;
    const list = adj.get(h.fromNodeId) ?? [];
    list.push(toNode.id);
    adj.set(h.fromNodeId, list);
  }

  // Iterative DFS to find back-edges (limit to max 4-node cycles for relevance).
  const cycles: CycleResult[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stackPath: string[] = [];

  function dfs(nodeId: string): void {
    if (cycles.length >= 5) return;  // cap to avoid quadratic reporting
    visited.add(nodeId);
    inStack.add(nodeId);
    stackPath.push(nodeId);

    for (const neighbor of adj.get(nodeId) ?? []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (inStack.has(neighbor)) {
        // Back-edge found — reconstruct the cycle path.
        const cycleStart = stackPath.indexOf(neighbor);
        if (cycleStart !== -1 && stackPath.length - cycleStart >= 2) {
          const cyclePath = stackPath.slice(cycleStart);
          const roleSequence = cyclePath.map((id) => nodeById.get(id)?.role ?? "?");
          cycles.push({ path: [...cyclePath], roleSequence });
        }
      }
    }

    stackPath.pop();
    inStack.delete(nodeId);
  }

  for (const startId of sorted.map((n) => n.id)) {
    if (!visited.has(startId)) dfs(startId);
    if (cycles.length >= 5) break;
  }

  return cycles;
}
