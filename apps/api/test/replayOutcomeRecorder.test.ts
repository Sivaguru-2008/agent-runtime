import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  ReplayOutcomeRecorder,
  buildReplayOutcome
} from "../src/runtime/failure/replayOutcomeRecorder.js";
import { FailureLearning } from "../src/runtime/failure/failureLearning.js";
import {
  InMemoryAnomalyIndex,
  InMemoryFailureSignatureStore,
  InMemoryReplayOutcomeStore
} from "../src/infrastructure/persistence/inMemoryCognitionStores.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { SystemClock } from "../src/shared/clock.js";
import type { CognitionGraph } from "../src/domain/cognition.js";
import type { FailureReport } from "../src/domain/failure.js";
import type { DomainEvent } from "../src/domain/events.js";

/**
 * Phase 7: ReplayOutcomeRecorder activates the dormant adaptive learning loop.
 * These tests verify:
 *   - Deterministic outcome generation from (graph, report)
 *   - SOURCE vs BRANCH classification
 *   - Failure isolation: persistence/event errors don't propagate
 *   - REPLAY_OUTCOME_RECORDED is emitted on every recording
 *   - REPAIR_OUTCOME_EVALUATED fires only when a BRANCH has a known source
 *   - No duplicate writes when called once
 */

function makeGraph(over: Partial<CognitionGraph> = {}): CognitionGraph {
  return {
    id: "cog-1",
    executionId: "exec-1",
    agentId: "agent-1",
    phase: "COMPLETE",
    startedAt: "2024-01-01T00:00:00.000Z",
    completedAt: "2024-01-01T00:00:01.234Z",
    nodes: [],
    handoffs: [],
    ...over
  };
}

function makeReport(over: Partial<FailureReport> = {}): FailureReport {
  return {
    executionId: "exec-1",
    cognitionId: "cog-1",
    totalSignals: 0,
    bySeverity: { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 },
    byKind: {
      HALLUCINATION: 0,
      CONTRADICTION: 0,
      RECURSION: 0,
      EXECUTION_LOOP: 0,
      TOOL_MISUSE: 0,
      CORRUPTED_MEMORY: 0,
      UNCERTAINTY_SPIKE: 0,
      LOW_CONFIDENCE: 0,
      PLAN_DRIFT: 0
    },
    topSignals: [],
    healthScore: 100,
    ...over
  };
}

describe("buildReplayOutcome", () => {
  const nowIso = "2024-02-02T00:00:00.000Z";

  it("classifies a graph with no parentCognitionId as SOURCE", () => {
    const outcome = buildReplayOutcome(makeGraph(), makeReport(), nowIso);
    expect(outcome.kind).toBe("SOURCE");
    expect(outcome.sourceCognitionId).toBeUndefined();
    expect(outcome.branchOverride).toBeUndefined();
  });

  it("classifies a graph with parentCognitionId as BRANCH and forwards branchOverride", () => {
    const outcome = buildReplayOutcome(
      makeGraph({ id: "branch-1", parentCognitionId: "cog-source" }),
      makeReport(),
      nowIso,
      { branchOverride: { type: "MODEL", description: "swap to opus" } }
    );
    expect(outcome.kind).toBe("BRANCH");
    expect(outcome.sourceCognitionId).toBe("cog-source");
    expect(outcome.branchOverride).toEqual({ type: "MODEL", description: "swap to opus" });
  });

  it("derives observedSignalKinds deterministically (sorted, no zeros)", () => {
    const outcome = buildReplayOutcome(
      makeGraph(),
      makeReport({
        totalSignals: 3,
        byKind: {
          HALLUCINATION: 1, CONTRADICTION: 0, RECURSION: 2, EXECUTION_LOOP: 0,
          TOOL_MISUSE: 0, CORRUPTED_MEMORY: 0, UNCERTAINTY_SPIKE: 0,
          LOW_CONFIDENCE: 0, PLAN_DRIFT: 0
        }
      }),
      nowIso
    );
    expect(outcome.observedSignalKinds).toEqual(["HALLUCINATION", "RECURSION"]);
    expect(outcome.failureSignalCount).toBe(3);
  });

  it("succeeded=true iff graph.phase === COMPLETE", () => {
    expect(buildReplayOutcome(makeGraph({ phase: "COMPLETE" }), makeReport(), nowIso).succeeded).toBe(true);
    expect(buildReplayOutcome(makeGraph({ phase: "FAILED" }), makeReport(), nowIso).succeeded).toBe(false);
  });

  it("clamps healthScore to [0, 100] and tolerates NaN", () => {
    expect(buildReplayOutcome(makeGraph(), makeReport({ healthScore: -5 }), nowIso).healthScore).toBe(0);
    expect(buildReplayOutcome(makeGraph(), makeReport({ healthScore: 250 }), nowIso).healthScore).toBe(100);
    expect(buildReplayOutcome(makeGraph(), makeReport({ healthScore: NaN }), nowIso).healthScore).toBe(0);
  });

  it("derives durationMs from graph timestamps when not overridden", () => {
    const outcome = buildReplayOutcome(makeGraph(), makeReport(), nowIso);
    expect(outcome.durationMs).toBe(1234);
  });

  it("returns deterministic outcomes for identical inputs", () => {
    const a = buildReplayOutcome(makeGraph(), makeReport({ healthScore: 78 }), nowIso);
    const b = buildReplayOutcome(makeGraph(), makeReport({ healthScore: 78 }), nowIso);
    expect(a).toEqual(b);
  });
});

describe("ReplayOutcomeRecorder", () => {
  let signatures: InMemoryFailureSignatureStore;
  let anomalies: InMemoryAnomalyIndex;
  let outcomes: InMemoryReplayOutcomeStore;
  let learning: FailureLearning;
  let clock: SystemClock;
  let eventFactory: EventFactory;
  let publishedEvents: DomainEvent[];
  let publisher: { publish: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    signatures = new InMemoryFailureSignatureStore();
    anomalies = new InMemoryAnomalyIndex();
    outcomes = new InMemoryReplayOutcomeStore();
    learning = new FailureLearning(signatures, anomalies, outcomes);
    clock = new SystemClock();
    eventFactory = new EventFactory(clock, "test");
    publishedEvents = [];
    publisher = {
      publish: vi.fn(async (event: DomainEvent) => {
        publishedEvents.push(event);
        return event;
      })
    };
  });

  it("persists a SOURCE outcome and emits REPLAY_OUTCOME_RECORDED", async () => {
    const recorder = new ReplayOutcomeRecorder(
      learning,
      publisher as any,
      eventFactory,
      clock
    );

    const outcome = await recorder.recordTerminalOutcome(makeGraph(), makeReport({ healthScore: 90 }));
    expect(outcome).toBeDefined();
    expect(outcome!.kind).toBe("SOURCE");

    const stored = await outcomes.getByExecution("exec-1");
    expect(stored).toBeDefined();
    expect(stored!.healthScore).toBe(90);

    const recordedEvents = publishedEvents.filter((e) => e.type === "REPLAY_OUTCOME_RECORDED");
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0].payload.kind).toBe("SOURCE");
    expect(recordedEvents[0].aggregateId).toBe("exec-1");
  });

  it("does NOT emit REPAIR_OUTCOME_EVALUATED for SOURCE outcomes", async () => {
    const recorder = new ReplayOutcomeRecorder(
      learning,
      publisher as any,
      eventFactory,
      clock
    );

    await recorder.recordTerminalOutcome(makeGraph(), makeReport());
    const repairEvents = publishedEvents.filter((e) => e.type === "REPAIR_OUTCOME_EVALUATED");
    expect(repairEvents).toHaveLength(0);
  });

  it("emits REPAIR_OUTCOME_EVALUATED for BRANCH outcomes when source is recorded", async () => {
    const recorder = new ReplayOutcomeRecorder(
      learning,
      publisher as any,
      eventFactory,
      clock
    );

    // Record the source first.
    await recorder.recordTerminalOutcome(
      makeGraph({ id: "src", executionId: "exec-src" }),
      makeReport({ executionId: "exec-src", cognitionId: "src", healthScore: 40 })
    );

    publishedEvents.length = 0; // clear

    // Record a branch with override.
    await recorder.recordTerminalOutcome(
      makeGraph({ id: "br1", executionId: "exec-br1", parentCognitionId: "src" }),
      makeReport({ executionId: "exec-br1", cognitionId: "br1", healthScore: 75 }),
      { branchOverride: { type: "MODEL", description: "x" } }
    );

    const repairEvents = publishedEvents.filter((e) => e.type === "REPAIR_OUTCOME_EVALUATED");
    expect(repairEvents).toHaveLength(1);
    expect(repairEvents[0].payload).toMatchObject({
      sourceCognitionId: "src",
      branchCognitionId: "br1",
      healthScoreDelta: 35
    });
  });

  it("isolates persistence failures: returns undefined and never throws", async () => {
    const failingLearning = {
      recordOutcome: vi.fn().mockRejectedValue(new Error("disk full")),
      compareOutcomes: vi.fn()
    } as unknown as FailureLearning;
    const logger = { warn: vi.fn() };

    const recorder = new ReplayOutcomeRecorder(
      failingLearning,
      publisher as any,
      eventFactory,
      clock,
      logger
    );

    const outcome = await recorder.recordTerminalOutcome(makeGraph(), makeReport());
    expect(outcome).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "record-outcome" }),
      expect.any(String)
    );
    // No REPLAY_OUTCOME_RECORDED should be emitted on persistence failure.
    expect(publishedEvents.filter((e) => e.type === "REPLAY_OUTCOME_RECORDED")).toHaveLength(0);
  });

  it("isolates publisher failures: outcome is still persisted, no throw", async () => {
    publisher.publish.mockRejectedValueOnce(new Error("bus down"));
    const logger = { warn: vi.fn() };

    const recorder = new ReplayOutcomeRecorder(
      learning,
      publisher as any,
      eventFactory,
      clock,
      logger
    );

    const outcome = await recorder.recordTerminalOutcome(makeGraph(), makeReport());
    expect(outcome).toBeDefined();
    expect(await outcomes.getByExecution("exec-1")).toBeDefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("recording the same execution twice does not produce duplicate outcomes in the store", async () => {
    const recorder = new ReplayOutcomeRecorder(
      learning,
      publisher as any,
      eventFactory,
      clock
    );

    await recorder.recordTerminalOutcome(makeGraph(), makeReport({ healthScore: 80 }));
    await recorder.recordTerminalOutcome(makeGraph(), makeReport({ healthScore: 90 }));

    // InMemoryReplayOutcomeStore is keyed by executionId — second write replaces.
    const all = await outcomes.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].healthScore).toBe(90);
  });
});
