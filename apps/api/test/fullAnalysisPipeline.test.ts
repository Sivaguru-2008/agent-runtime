import { describe, expect, it } from "vitest";
import { FailureIntelligenceEngine } from "../src/runtime/failure/failureIntelligenceEngine.js";
import { FailureTimelineBuilder } from "../src/runtime/replay/failureTimeline.js";
import { CausalityTracer } from "../src/runtime/replay/causalityTracer.js";
import type { FailureSignal, FailureSeverity } from "../src/domain/failure.js";
import type { ReplayFrame } from "../src/domain/replay.js";
import type { CognitionGraph, CognitionNode, AgentRole } from "../src/domain/cognition.js";
import type { DomainEvent } from "../src/domain/events.js";

/**
 * Regression suite for the GET /executions/:id/full-analysis pipeline.
 *
 * Reproduces the exact malformed-data shapes that previously crashed individual
 * stages and turned the operator panel into an opaque INTERNAL_ERROR (500):
 *   - report aggregation over signals with missing/unknown severity (NaN poison)
 *   - timeline build over signals whose `evidence` array is absent (not iterable)
 *   - timeline build over frames with a missing `preview`
 *   - causality trace over a node missing `inputFingerprint` (.slice on undefined)
 *   - causality trace with empty evidence / missing graph
 *
 * Each test asserts the stage now degrades to a well-formed value instead of
 * throwing, which is what lets the route return 200 for every execution.
 */

const NOW_ISO = "2024-01-01T00:00:00.000Z";

// buildReport only uses its arguments — the constructor deps are never touched,
// so stub them. (Constructor merely stores them + instantiates pure analyzers.)
function makeEngine(): FailureIntelligenceEngine {
  return new FailureIntelligenceEngine(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

function makeSignal(overrides: Partial<FailureSignal> = {}): FailureSignal {
  return {
    id: overrides.id ?? "sig-1",
    cognitionId: overrides.cognitionId ?? "cog-1",
    executionId: overrides.executionId ?? "exec-1",
    nodeId: overrides.nodeId,
    kind: overrides.kind ?? "HALLUCINATION",
    severity: overrides.severity ?? "HIGH",
    score: overrides.score ?? 0.9,
    summary: overrides.summary ?? "synthetic signal",
    evidence: overrides.evidence ?? [{ eventSequence: 0 }],
    detectedAt: overrides.detectedAt ?? NOW_ISO,
    detectedBy: overrides.detectedBy ?? "test"
  };
}

function makeFrame(index: number, overrides: Partial<ReplayFrame> = {}): ReplayFrame {
  return {
    index,
    kind: "EVENT",
    timestamp: NOW_ISO,
    eventSequence: overrides.eventSequence ?? index,
    eventType: overrides.eventType ?? "COGNITION_NODE_COMPLETED",
    preview: overrides.preview ?? {
      aggregateType: "EXECUTION",
      aggregateId: "exec-1",
      label: `frame ${index}`,
      tone: "neutral"
    },
    ...overrides
  };
}

function makeNode(opts: Partial<CognitionNode> & { sequence: number; role: AgentRole }): CognitionNode {
  return {
    id: opts.id ?? `node-${opts.sequence}`,
    cognitionId: "cog-1",
    executionId: "exec-1",
    phase: "EXECUTE",
    status: opts.status ?? "COMPLETED",
    inputFingerprint: opts.inputFingerprint ?? `fp-${opts.sequence}`,
    input: opts.input ?? {},
    output: opts.output ?? {},
    memoryInfluence: opts.memoryInfluence ?? [],
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
    ...opts
  } as CognitionNode;
}

function makeGraph(nodes: CognitionNode[]): CognitionGraph {
  return {
    id: "cog-1",
    executionId: "exec-1",
    agentId: "agent-1",
    phase: "COMPLETE",
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
    nodes,
    handoffs: []
  };
}

// Minimal fakes for the tracer's collaborators.
function makeTracer(graph: CognitionGraph | undefined, events: DomainEvent[] = []): CausalityTracer {
  const cognitions = {
    getById: async () => graph,
    getByExecution: async () => graph
  } as never;
  const eventStore = {
    listByExecution: async () => events
  } as never;
  const clock = { now: () => new Date(NOW_ISO) } as never;
  return new CausalityTracer(cognitions, eventStore, clock);
}

describe("full-analysis pipeline — report aggregation (buildReport)", () => {
  it("successful execution: aggregates a clean, finite report", () => {
    const engine = makeEngine();
    const signals = [
      makeSignal({ id: "s1", severity: "HIGH", score: 0.5 }),
      makeSignal({ id: "s2", severity: "LOW", score: 0.2 })
    ];
    const report = engine.buildReport("exec-1", "cog-1", signals);
    expect(report.totalSignals).toBe(2);
    expect(report.bySeverity.HIGH).toBe(1);
    expect(report.bySeverity.LOW).toBe(1);
    expect(Number.isFinite(report.healthScore)).toBe(true);
    expect(report.healthScore).toBeGreaterThanOrEqual(0);
    expect(report.healthScore).toBeLessThanOrEqual(100);
  });

  it("no signals: returns healthScore 100 with zeroed maps", () => {
    const engine = makeEngine();
    const report = engine.buildReport("exec-1", "cog-1", []);
    expect(report.totalSignals).toBe(0);
    expect(report.healthScore).toBe(100);
    expect(report.bySeverity.CRITICAL).toBe(0);
  });

  it("missing severity values: never produces NaN healthScore", () => {
    const engine = makeEngine();
    const malformed = [
      makeSignal({ id: "bad-sev", severity: undefined as unknown as FailureSeverity }),
      makeSignal({ id: "bad-score", severity: "HIGH", score: NaN }),
      makeSignal({ id: "bad-kind", kind: "NOT_A_KIND" as never })
    ];
    const report = engine.buildReport("exec-1", "cog-1", malformed);
    expect(Number.isFinite(report.healthScore)).toBe(true);
    expect(report.healthScore).toBeGreaterThanOrEqual(0);
    // Unknown severity is bucketed as INFO; unknown kind as PLAN_DRIFT — no NaN keys.
    const severityTotal = Object.values(report.bySeverity).reduce((a, b) => a + b, 0);
    expect(severityTotal).toBe(3);
  });

  it("non-array signals input does not throw", () => {
    const engine = makeEngine();
    const report = engine.buildReport("exec-1", "cog-1", undefined as unknown as FailureSignal[]);
    expect(report.totalSignals).toBe(0);
    expect(report.healthScore).toBe(100);
  });
});

describe("full-analysis pipeline — timeline build", () => {
  const builder = new FailureTimelineBuilder();

  it("successful execution: annotates frames with signals", () => {
    const frames = [makeFrame(0), makeFrame(1)];
    const signals = [makeSignal({ evidence: [{ eventSequence: 0 }] })];
    const timeline = builder.build(frames, signals, makeGraph([makeNode({ sequence: 0, role: "EXECUTOR" })]));
    expect(timeline.frames).toHaveLength(2);
    expect(timeline.totalSignals).toBe(1);
  });

  it("no timeline frames: returns an empty timeline, not a throw", () => {
    const timeline = builder.build([], [makeSignal()], undefined);
    expect(timeline.frames).toEqual([]);
    expect(timeline.firstFailureFrameIndex).toBeNull();
  });

  it("no signals: returns frames with no annotations", () => {
    const timeline = builder.build([makeFrame(0)], [], undefined);
    expect(timeline.totalSignals).toBe(0);
    expect(timeline.frames[0].causalRole).toBe("CLEAN");
  });

  it("malformed signal with missing evidence array does not throw", () => {
    const bad = makeSignal({ evidence: undefined as unknown as FailureSignal["evidence"] });
    expect(() => builder.build([makeFrame(0)], [bad], undefined)).not.toThrow();
  });

  it("malformed frame with missing preview does not throw", () => {
    const badFrame = makeFrame(0, { preview: undefined as unknown as ReplayFrame["preview"] });
    const timeline = builder.build([badFrame], [makeSignal()], undefined);
    expect(timeline.frames).toHaveLength(1);
    expect(timeline.frames[0].tone).toBeDefined();
  });

  it("non-array inputs degrade to an empty timeline", () => {
    const timeline = builder.build(
      undefined as unknown as ReplayFrame[],
      undefined as unknown as FailureSignal[],
      undefined
    );
    expect(timeline.frames).toEqual([]);
  });
});

describe("full-analysis pipeline — causality trace", () => {
  it("successful execution: builds a causal chain from node ancestry", async () => {
    const root = makeNode({ sequence: 0, role: "PLANNER", id: "root" });
    const child = makeNode({ sequence: 1, role: "EXECUTOR", id: "child", parentNodeId: "root" });
    const tracer = makeTracer(makeGraph([root, child]));
    const signal = makeSignal({ nodeId: "child", evidence: [{ eventSequence: 1 }] });
    const chain = await tracer.trace(signal, [makeFrame(0), makeFrame(1)]);
    expect(chain.links.length).toBeGreaterThan(0);
  });

  it("empty causality (no evidence, no graph): returns a fallback chain, not a throw", async () => {
    const tracer = makeTracer(undefined);
    const signal = makeSignal({ nodeId: undefined, evidence: [] });
    const chain = await tracer.trace(signal, []);
    expect(chain.links.length).toBeGreaterThanOrEqual(1);
    expect(chain.rootCauseDescription).toBeDefined();
  });

  it("missing evidence array does not throw in the event-fallback path", async () => {
    const tracer = makeTracer(undefined);
    const signal = makeSignal({
      nodeId: undefined,
      evidence: undefined as unknown as FailureSignal["evidence"]
    });
    await expect(tracer.trace(signal, [])).resolves.toBeDefined();
  });

  it("RECURSION signal on a node missing inputFingerprint does not throw", async () => {
    const node = makeNode({
      sequence: 0,
      role: "EXECUTOR",
      id: "n0",
      inputFingerprint: undefined as unknown as string
    });
    const tracer = makeTracer(makeGraph([node]));
    const signal = makeSignal({ kind: "RECURSION", nodeId: "n0", evidence: [{ nodeId: "n0" }] });
    await expect(tracer.trace(signal, [makeFrame(0)])).resolves.toBeDefined();
  });

  it("graph with non-array nodes does not throw", async () => {
    const brokenGraph = { ...makeGraph([]), nodes: undefined as unknown as CognitionNode[] };
    const tracer = makeTracer(brokenGraph);
    const signal = makeSignal({ nodeId: "x", evidence: [{ eventSequence: 0 }] });
    await expect(tracer.trace(signal, [makeFrame(0)])).resolves.toBeDefined();
  });
});
