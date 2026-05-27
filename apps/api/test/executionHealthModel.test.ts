import { describe, expect, it } from "vitest";
import {
  ExecutionHealthModel,
  buildBaselineFromMetrics,
  type HistoricalExecutionProjection
} from "../src/runtime/failure/executionHealthModel.js";
import { syncFingerprint } from "../src/shared/determinism.js";
import type { CognitionGraph, CognitionNode, AgentRole } from "../src/domain/cognition.js";
import type { DomainEvent } from "../src/domain/events.js";
import type { FailureSignal } from "../src/domain/failure.js";

/**
 * These tests build *realistic-shaped* (but synthetic) cognition graphs and
 * event logs — the exact same shapes produced by the live runtime — to
 * exercise every branch of the health model. No random data; every input is
 * hand-built so we can assert precise score behavior.
 */

const NOW_ISO = "2024-01-01T00:00:00.000Z";

function makeNode(opts: Partial<CognitionNode> & { sequence: number; role: AgentRole }): CognitionNode {
  return {
    id: `node-${opts.sequence}`,
    cognitionId: "cog-1",
    executionId: "exec-1",
    phase: "EXECUTE",
    status: opts.status ?? "COMPLETED",
    inputFingerprint: opts.inputFingerprint ?? `inputFp-${opts.sequence}`,
    input: opts.input ?? { task: `step-${opts.sequence}` },
    output: opts.output ?? { result: `r-${opts.sequence}` },
    uncertainty: opts.uncertainty,
    memoryInfluence: opts.memoryInfluence ?? [],
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
    ...opts
  } as CognitionNode;
}

function makeGraph(nodes: CognitionNode[], agentId = "agent-1"): CognitionGraph {
  return {
    id: "cog-1",
    executionId: "exec-1",
    agentId,
    phase: "COMPLETE",
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
    nodes,
    handoffs: []
  };
}

function makeEvent(type: string, payload: Record<string, unknown>, seq: number): DomainEvent {
  return {
    id: `ev-${seq}`,
    type: type as DomainEvent["type"],
    aggregateId: "exec-1",
    aggregateType: "EXECUTION",
    version: 1,
    timestamp: NOW_ISO,
    sequence: seq,
    payload,
    metadata: {
      traceId: "tr",
      correlationId: "tr",
      schemaVersion: 1,
      source: "test",
      idempotencyKey: `${type}:${seq}`
    }
  };
}

function makeSignal(over: Partial<FailureSignal> & Pick<FailureSignal, "kind" | "severity">): FailureSignal {
  return {
    id: `sig-${Math.random()}`,
    executionId: "exec-1",
    cognitionId: "cog-1",
    score: 0.7,
    summary: "test signal",
    evidence: [],
    detectedAt: NOW_ISO,
    detectedBy: "test",
    ...over
  };
}

describe("ExecutionHealthModel", () => {
  describe("confidence sub-score", () => {
    it("returns null when no graph is provided", () => {
      const model = new ExecutionHealthModel();
      const snapshot = model.compute({
        executionId: "exec-1",
        graph: undefined,
        events: [],
        signals: []
      });
      expect(snapshot.confidence.value).toBeNull();
      expect(snapshot.confidence.sampleSize).toBe(0);
    });

    it("scores high when all nodes have low uncertainty and no signals", () => {
      const model = new ExecutionHealthModel();
      const graph = makeGraph([
        makeNode({
          sequence: 0, role: "PLANNER",
          uncertainty: { overall: 0.05, variance: 0.02, lowConfidenceTokens: 0 }
        }),
        makeNode({
          sequence: 1, role: "EXECUTOR",
          uncertainty: { overall: 0.08, variance: 0.03, lowConfidenceTokens: 1 }
        })
      ]);
      const snapshot = model.compute({ executionId: "exec-1", graph, events: [], signals: [] });
      expect(snapshot.confidence.value).not.toBeNull();
      expect(snapshot.confidence.value!).toBeGreaterThan(0.85);
    });

    it("penalises confidence when HALLUCINATION signals are present", () => {
      const model = new ExecutionHealthModel();
      const graph = makeGraph([
        makeNode({
          sequence: 0, role: "EXECUTOR",
          uncertainty: { overall: 0.2, variance: 0.1, lowConfidenceTokens: 5 }
        })
      ]);
      const signals = [
        makeSignal({ kind: "HALLUCINATION", severity: "HIGH", score: 0.85 }),
        makeSignal({ kind: "LOW_CONFIDENCE", severity: "MEDIUM", score: 0.6 })
      ];
      const snapshot = model.compute({ executionId: "exec-1", graph, events: [], signals });
      const cleanSnapshot = model.compute({ executionId: "exec-1", graph, events: [], signals: [] });
      expect(snapshot.confidence.value!).toBeLessThan(cleanSnapshot.confidence.value!);
      expect(snapshot.confidence.components.confidenceSignalCount).toBe(2);
    });

    it("identifies the weakest 3 nodes by per-node uncertainty", () => {
      const model = new ExecutionHealthModel();
      const graph = makeGraph([
        makeNode({ sequence: 0, role: "PLANNER", uncertainty: { overall: 0.1, variance: 0, lowConfidenceTokens: 0 } }),
        makeNode({ sequence: 1, role: "EXECUTOR", uncertainty: { overall: 0.9, variance: 0.4, lowConfidenceTokens: 30 } }),
        makeNode({ sequence: 2, role: "VERIFIER", uncertainty: { overall: 0.8, variance: 0.3, lowConfidenceTokens: 20 } }),
        makeNode({ sequence: 3, role: "CRITIC", uncertainty: { overall: 0.7, variance: 0.2, lowConfidenceTokens: 10 } })
      ]);
      const snapshot = model.compute({ executionId: "exec-1", graph, events: [], signals: [] });
      expect(snapshot.confidence.weakestNodeIds).toEqual(["node-1", "node-2", "node-3"]);
    });
  });

  describe("stability sub-score", () => {
    it("returns null when no historical executions exist", () => {
      const model = new ExecutionHealthModel();
      const graph = makeGraph([makeNode({ sequence: 0, role: "EXECUTOR" })]);
      const snapshot = model.compute({ executionId: "exec-1", graph, events: [], signals: [] });
      expect(snapshot.stability.value).toBeNull();
      expect(snapshot.stability.baselineExecutionCount).toBe(0);
    });

    it("returns null when no historical execution shares the input fingerprint", () => {
      const model = new ExecutionHealthModel();
      const graph = makeGraph([makeNode({ sequence: 0, role: "EXECUTOR", inputFingerprint: "fp-A" })]);
      const historical: HistoricalExecutionProjection[] = [
        { executionId: "h1", inputFingerprint: "fp-B", nodeCount: 1, toolCallCount: 0 },
        { executionId: "h2", inputFingerprint: "fp-C", nodeCount: 1, toolCallCount: 0 }
      ];
      const snapshot = model.compute({ executionId: "exec-1", graph, events: [], signals: [], historicalForAgent: historical });
      expect(snapshot.stability.value).toBeNull();
      expect(snapshot.stability.components.totalHistorical).toBe(2);
    });

    it("scores 1.0 when all comparable runs produced the same output and structure", () => {
      const model = new ExecutionHealthModel();
      const output = { result: "stable" };
      const graph = makeGraph([
        makeNode({ sequence: 0, role: "EXECUTOR", inputFingerprint: "fp-X", output })
      ]);
      const outputFp = syncFingerprint(output);
      const historical: HistoricalExecutionProjection[] = [
        { executionId: "h1", inputFingerprint: "fp-X", outputFingerprint: outputFp, nodeCount: 1, toolCallCount: 0 },
        { executionId: "h2", inputFingerprint: "fp-X", outputFingerprint: outputFp, nodeCount: 1, toolCallCount: 0 }
      ];
      const snapshot = model.compute({ executionId: "exec-1", graph, events: [], signals: [], historicalForAgent: historical });
      expect(snapshot.stability.value).toBeCloseTo(1.0, 2);
      expect(snapshot.stability.outputAgreementRate).toBeCloseTo(1.0, 2);
    });

    it("drops to ~0.4 when outputs disagree but structure matches", () => {
      const model = new ExecutionHealthModel();
      const graph = makeGraph([
        makeNode({ sequence: 0, role: "EXECUTOR", inputFingerprint: "fp-Y", output: { r: "mine" } })
      ]);
      const historical: HistoricalExecutionProjection[] = [
        { executionId: "h1", inputFingerprint: "fp-Y", outputFingerprint: "someOtherFp", nodeCount: 1, toolCallCount: 0 },
        { executionId: "h2", inputFingerprint: "fp-Y", outputFingerprint: "yetAnotherFp", nodeCount: 1, toolCallCount: 0 }
      ];
      const snapshot = model.compute({ executionId: "exec-1", graph, events: [], signals: [], historicalForAgent: historical });
      expect(snapshot.stability.outputAgreementRate).toBe(0);
      // Structural matches (both have 1 node, 0 tool calls) → 0.4 from structural component.
      expect(snapshot.stability.value!).toBeGreaterThan(0.3);
      expect(snapshot.stability.value!).toBeLessThan(0.5);
    });
  });

  describe("toolReliability sub-score", () => {
    it("returns null when no tool calls occurred", () => {
      const model = new ExecutionHealthModel();
      const snapshot = model.compute({ executionId: "exec-1", graph: undefined, events: [], signals: [] });
      expect(snapshot.toolReliability.value).toBeNull();
    });

    it("scores 1.0 when every tool call succeeded", () => {
      const model = new ExecutionHealthModel();
      const events: DomainEvent[] = [
        makeEvent("TOOL_CALLED", { toolCall: { toolName: "search", success: true } }, 1),
        makeEvent("TOOL_CALLED", { toolCall: { toolName: "search", success: true } }, 2),
        makeEvent("TOOL_CALLED", { toolCall: { toolName: "fetch", success: true } }, 3)
      ];
      const snapshot = model.compute({ executionId: "exec-1", graph: undefined, events, signals: [] });
      expect(snapshot.toolReliability.value).toBeCloseTo(1.0, 2);
    });

    it("uses harmonic mean so one failing tool drags the score down", () => {
      const model = new ExecutionHealthModel();
      const events: DomainEvent[] = [
        // 3 successful calls of "good"
        makeEvent("TOOL_CALLED", { toolCall: { toolName: "good", success: true } }, 1),
        makeEvent("TOOL_CALLED", { toolCall: { toolName: "good", success: true } }, 2),
        makeEvent("TOOL_CALLED", { toolCall: { toolName: "good", success: true } }, 3),
        // 3 failed calls of "broken"
        makeEvent("TOOL_CALLED", { toolCall: { toolName: "broken", success: false, error: "401" } }, 4),
        makeEvent("TOOL_CALLED", { toolCall: { toolName: "broken", success: false, error: "401" } }, 5),
        makeEvent("TOOL_CALLED", { toolCall: { toolName: "broken", success: false, error: "401" } }, 6)
      ];
      const snapshot = model.compute({ executionId: "exec-1", graph: undefined, events, signals: [] });
      // Harmonic mean of (1.0, 0.0) → very low (approaches 0).
      expect(snapshot.toolReliability.value!).toBeLessThan(0.05);
      expect(snapshot.toolReliability.perTool[0].toolName).toBe("broken");
      expect(snapshot.toolReliability.perTool[0].successRate).toBe(0);
    });

    it("attributes TOOL_MISUSE signals to the named tool and penalises", () => {
      const model = new ExecutionHealthModel();
      const events: DomainEvent[] = [
        makeEvent("TOOL_CALLED", { toolCall: { toolName: "shell_exec", success: true } }, 1)
      ];
      const signals = [
        makeSignal({ kind: "TOOL_MISUSE", severity: "MEDIUM", score: 0.7, summary: 'Tool "shell_exec" called with empty input' })
      ];
      const snapshot = model.compute({ executionId: "exec-1", graph: undefined, events, signals });
      const tool = snapshot.toolReliability.perTool.find((t) => t.toolName === "shell_exec");
      expect(tool?.misuseSignals).toBe(1);
      expect(snapshot.toolReliability.value!).toBeLessThan(1.0);
    });
  });

  describe("consistency sub-score", () => {
    it("scores 1.0 when there are no contradictions, loops, or rejections", () => {
      const model = new ExecutionHealthModel();
      const graph = makeGraph([makeNode({ sequence: 0, role: "EXECUTOR" })]);
      const snapshot = model.compute({ executionId: "exec-1", graph, events: [], signals: [] });
      expect(snapshot.consistency.value).toBe(1);
    });

    it("counts CONTRADICTION signals and verifier rejections separately", () => {
      const model = new ExecutionHealthModel();
      const graph = makeGraph([
        makeNode({ sequence: 0, role: "EXECUTOR", status: "COMPLETED" }),
        makeNode({ sequence: 1, role: "VERIFIER", status: "FAILED" })
      ]);
      const signals = [
        makeSignal({ kind: "CONTRADICTION", severity: "HIGH", score: 0.8 }),
        makeSignal({ kind: "CONTRADICTION", severity: "MEDIUM", score: 0.6 })
      ];
      const snapshot = model.compute({ executionId: "exec-1", graph, events: [], signals });
      expect(snapshot.consistency.contradictionSignals).toBe(2);
      expect(snapshot.consistency.verifierRejections).toBe(1);
      expect(snapshot.consistency.value!).toBeLessThan(0.8);
    });

    it("only counts RECURSION signals with metric.isProgressCycle=0 as true loops", () => {
      const model = new ExecutionHealthModel();
      const graph = makeGraph([makeNode({ sequence: 0, role: "EXECUTOR" })]);
      const signals = [
        makeSignal({
          kind: "RECURSION", severity: "HIGH", score: 0.88,
          evidence: [{ metric: { isProgressCycle: 0 } }]
        }),
        makeSignal({
          kind: "RECURSION", severity: "MEDIUM", score: 0.65,
          evidence: [{ metric: { isProgressCycle: 1 } }]  // progress retry, NOT a true loop
        })
      ];
      const snapshot = model.compute({ executionId: "exec-1", graph, events: [], signals });
      expect(snapshot.consistency.trueLoopSignals).toBe(1);
    });

    it("computes sameRoleOutputDivergence across multiple same-role nodes", () => {
      const model = new ExecutionHealthModel();
      const graph = makeGraph([
        makeNode({ sequence: 0, role: "EXECUTOR", output: { verdict: "PASS" } }),
        makeNode({ sequence: 1, role: "EXECUTOR", output: { verdict: "FAIL" } }),
        makeNode({ sequence: 2, role: "EXECUTOR", output: { verdict: "MAYBE" } })
      ]);
      const snapshot = model.compute({ executionId: "exec-1", graph, events: [], signals: [] });
      // 3 distinct fingerprints across 3 nodes → divergence (3-1)/(3-1) = 1.0
      expect(snapshot.consistency.sameRoleOutputDivergence).toBe(1);
    });
  });

  describe("anomaly sub-score", () => {
    it("returns null when fewer than 5 baseline executions exist", () => {
      const model = new ExecutionHealthModel();
      const baseline = buildBaselineFromMetrics("agent-1", [
        { dimensions: { stepCount: 5, nodeCount: 5, tokenTotal: 1000, durationMs: 1000, signalDensity: 0, toolCallCount: 0 } },
        { dimensions: { stepCount: 5, nodeCount: 5, tokenTotal: 1000, durationMs: 1000, signalDensity: 0, toolCallCount: 0 } }
      ]);
      const snapshot = model.compute({
        executionId: "exec-1",
        graph: makeGraph([makeNode({ sequence: 0, role: "EXECUTOR" })]),
        events: [],
        signals: [],
        baseline
      });
      expect(snapshot.anomaly.value).toBeNull();
    });

    it("detects token-total anomaly when this run uses 10x baseline tokens", () => {
      const model = new ExecutionHealthModel();
      const baselineHistory = Array(8).fill({
        dimensions: { stepCount: 5, nodeCount: 5, tokenTotal: 1000, durationMs: 1000, signalDensity: 0, toolCallCount: 1 }
      });
      // Add a small spread so MAD > 0
      baselineHistory[0] = { dimensions: { stepCount: 5, nodeCount: 5, tokenTotal: 1050, durationMs: 1000, signalDensity: 0, toolCallCount: 1 } };
      baselineHistory[1] = { dimensions: { stepCount: 5, nodeCount: 5, tokenTotal: 950, durationMs: 1000, signalDensity: 0, toolCallCount: 1 } };
      const baseline = buildBaselineFromMetrics("agent-1", baselineHistory);

      // This execution: 10,000 tokens via 5 events of 2000 each.
      const tokenEvents: DomainEvent[] = Array.from({ length: 5 }, (_, i) =>
        makeEvent("MODEL_COMPLETED", { tokenUsage: { total: 2000 } }, i + 1)
      );
      const snapshot = model.compute({
        executionId: "exec-1",
        graph: makeGraph([makeNode({ sequence: 0, role: "EXECUTOR" })]),
        events: tokenEvents,
        signals: [],
        baseline
      });
      expect(snapshot.anomaly.value).not.toBeNull();
      expect(snapshot.anomaly.topDimension).toBe("tokenTotal");
      expect(snapshot.anomaly.value!).toBeGreaterThan(0.85);
    });
  });

  describe("composite healthScore", () => {
    it("renormalises weights across only the dimensions that returned a value", () => {
      const model = new ExecutionHealthModel();
      // Confidence available, stability/anomaly null (no history).
      const graph = makeGraph([
        makeNode({ sequence: 0, role: "EXECUTOR", uncertainty: { overall: 0, variance: 0, lowConfidenceTokens: 0 } })
      ]);
      const snapshot = model.compute({ executionId: "exec-1", graph, events: [], signals: [] });
      // No stability, no anomaly, no tool reliability — but confidence + consistency are present.
      // Both at 1.0 → composite renormalises to 100.
      expect(snapshot.healthScore).toBe(100);
      expect(snapshot.grade).toBe("A");
    });

    it("returns 0 health when no dimensions could be computed", () => {
      const model = new ExecutionHealthModel();
      const snapshot = model.compute({ executionId: "exec-1", graph: undefined, events: [], signals: [] });
      expect(snapshot.healthScore).toBe(0);
      expect(snapshot.grade).toBe("F");
    });

    it("assigns grades by threshold band", () => {
      const model = new ExecutionHealthModel();
      // Force a graph with poor confidence + many contradictions for a low score.
      const graph = makeGraph([
        makeNode({ sequence: 0, role: "EXECUTOR", uncertainty: { overall: 0.85, variance: 0.4, lowConfidenceTokens: 50 } })
      ]);
      const lowScoreSnapshot = model.compute({
        executionId: "exec-1",
        graph,
        events: [],
        signals: [
          makeSignal({ kind: "CONTRADICTION", severity: "CRITICAL", score: 0.95 }),
          makeSignal({ kind: "CONTRADICTION", severity: "HIGH", score: 0.85 }),
          makeSignal({ kind: "HALLUCINATION", severity: "HIGH", score: 0.9 })
        ]
      });
      expect(lowScoreSnapshot.grade).not.toBe("A");
      expect(["D", "F", "C"]).toContain(lowScoreSnapshot.grade);
    });
  });

  describe("baseline builder", () => {
    it("uses median + MAD so a single outlier doesn't poison the baseline", () => {
      const history = [
        { dimensions: { stepCount: 5, nodeCount: 5, tokenTotal: 1000, durationMs: 1000, signalDensity: 0, toolCallCount: 0 } },
        { dimensions: { stepCount: 5, nodeCount: 5, tokenTotal: 1000, durationMs: 1000, signalDensity: 0, toolCallCount: 0 } },
        { dimensions: { stepCount: 5, nodeCount: 5, tokenTotal: 1000, durationMs: 1000, signalDensity: 0, toolCallCount: 0 } },
        { dimensions: { stepCount: 5, nodeCount: 5, tokenTotal: 1000, durationMs: 1000, signalDensity: 0, toolCallCount: 0 } },
        { dimensions: { stepCount: 5, nodeCount: 5, tokenTotal: 1000, durationMs: 1000, signalDensity: 0, toolCallCount: 0 } },
        // Outlier: 100x tokens.
        { dimensions: { stepCount: 5, nodeCount: 5, tokenTotal: 100_000, durationMs: 1000, signalDensity: 0, toolCallCount: 0 } }
      ];
      const baseline = buildBaselineFromMetrics("agent-1", history);
      // Median is robust: must be 1000, not 17,500 (mean would be).
      expect(baseline.dimensions.tokenTotal.median).toBe(1000);
    });
  });
});
