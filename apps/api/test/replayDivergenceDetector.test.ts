import { describe, expect, it } from "vitest";
import { FrozenClock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { InMemoryEventStore } from "../src/infrastructure/persistence/inMemoryStores.js";
import { InMemoryReplayCertificationStore } from "../src/infrastructure/persistence/inMemoryCognitionStores.js";
import { ReplayDivergenceDetector } from "../src/runtime/replay/divergenceDetector.js";
import {
  chainHashOf,
  computeExecutionFingerprint,
  firstDivergentIndex
} from "../src/runtime/replay/executionFingerprint.js";
import { FrameBuilder } from "../src/runtime/replay/frameBuilder.js";
import type { DomainEvent } from "../src/domain/events.js";

/**
 * Replay Divergence Detector — Phase B operational hardening.
 *
 * The contracts under test (in order of strictness):
 *
 *   (a) Pure executionFingerprint:
 *       - chainHashOf([]) is the empty-stream sentinel — stable across calls.
 *       - chainHashOf is sensitive to ordering: swapping two digests changes
 *         the hash.
 *       - firstDivergentIndex localizes the earliest mismatch.
 *
 *   (b) End-to-end determinism:
 *       - Re-certifying the same event log twice produces identical chainHash.
 *       - Re-certifying after appending an event keeps the prefix digests
 *         identical, changes the chain hash, and EVENT_COUNT divergence is
 *         reported.
 *       - Mutating an in-place payload field (deterministic key, not stripped)
 *         shifts the digest at that frame's index — FRAME_DIGEST divergence
 *         localized to that frame.
 *       - Mutating ONLY non-deterministic keys (stripped by FrameBuilder) does
 *         NOT change the chain hash.
 *
 *   (c) Workflow-version comparability:
 *       - Two certifications across different workflowVersion are reported as
 *         divergent with reason="WORKFLOW_VERSION".
 *
 *   (d) Detector statefulness:
 *       - First compare() on an execution with no prior certification reports
 *         divergent=false and a clear "first capture" narrative.
 *       - certify() persists; subsequent compare() reads back the prior result.
 */

function makeEvent(opts: {
  sequence: number;
  type: string;
  executionId: string;
  payload?: Record<string, unknown>;
}): DomainEvent {
  return {
    id: `evt-${opts.sequence}`,
    type: opts.type as DomainEvent["type"],
    aggregateId: opts.executionId,
    aggregateType: "EXECUTION",
    version: 1,
    timestamp: "2026-05-22T00:00:00.000Z",
    payload: opts.payload ?? {},
    metadata: {
      traceId: "trace-fixed",
      correlationId: "trace-fixed",
      schemaVersion: 1,
      source: "test",
      idempotencyKey: `idem-${opts.sequence}`
    },
    sequence: opts.sequence
  };
}

function buildHarness() {
  const clock = new FrozenClock(new Date("2026-05-27T00:00:00.000Z"));
  const events = new InMemoryEventStore();
  const certifications = new InMemoryReplayCertificationStore();
  const detector = new ReplayDivergenceDetector(events, certifications, clock);
  // Unused but useful for ad-hoc fixtures during debugging.
  const factory = new EventFactory(clock, "divergence-test");
  void factory;
  return { detector, events, certifications };
}

describe("executionFingerprint — pure primitives", () => {
  it("chainHashOf is order-sensitive", () => {
    const a = chainHashOf(["alpha", "beta", "gamma"]);
    const b = chainHashOf(["beta", "alpha", "gamma"]);
    expect(a).not.toBe(b);
  });

  it("chainHashOf returns the empty-stream sentinel for []", () => {
    const empty = chainHashOf([]);
    expect(empty).toBe("0".repeat(32));
  });

  it("firstDivergentIndex returns null on identical arrays", () => {
    expect(firstDivergentIndex(["a", "b", "c"], ["a", "b", "c"])).toBeNull();
  });

  it("firstDivergentIndex returns the earliest mismatch", () => {
    expect(firstDivergentIndex(["a", "b", "c"], ["a", "x", "c"])).toBe(1);
  });

  it("firstDivergentIndex returns the shorter length when arrays differ in size with a matching prefix", () => {
    expect(firstDivergentIndex(["a", "b"], ["a", "b", "c"])).toBe(2);
    expect(firstDivergentIndex(["a", "b", "c"], ["a", "b"])).toBe(2);
  });

  it("computeExecutionFingerprint sorts frames by eventSequence before folding", async () => {
    const builder = new FrameBuilder();
    const e1 = makeEvent({ sequence: 1, type: "EXECUTION_STARTED", executionId: "exec-1" });
    const e2 = makeEvent({ sequence: 2, type: "EXECUTION_COMPLETED", executionId: "exec-1" });
    const e3 = makeEvent({ sequence: 3, type: "EXECUTION_FAILED", executionId: "exec-1" });
    const framesAsc = await builder.build([e1, e2, e3]);
    const framesDesc = await builder.build([e3, e2, e1]);
    const fpAsc = computeExecutionFingerprint(framesAsc);
    const fpDesc = computeExecutionFingerprint(framesDesc);
    expect(fpAsc.chainHash).toBe(fpDesc.chainHash);
    expect(fpAsc.frameDigests).toEqual(fpDesc.frameDigests);
  });
});

describe("ReplayDivergenceDetector — end-to-end", () => {
  it("certify() is stable across calls on the same event log", async () => {
    const h = buildHarness();
    const executionId = "exec-stable";
    await h.events.append(
      makeEvent({ sequence: 1, type: "EXECUTION_STARTED", executionId })
    );
    await h.events.append(
      makeEvent({ sequence: 2, type: "EXECUTION_COMPLETED", executionId, payload: { output: { ok: true } } })
    );

    const first = await h.detector.certify(executionId, "v1");
    const second = await h.detector.certify(executionId, "v1");

    expect(first.chainHash).toBe(second.chainHash);
    expect(first.frameDigests).toEqual(second.frameDigests);
    expect(first.eventCount).toBe(2);
    expect(second.eventCount).toBe(2);
  });

  it("compare() with no prior certification is benign (first-capture)", async () => {
    const h = buildHarness();
    const executionId = "exec-first-capture";
    await h.events.append(
      makeEvent({ sequence: 1, type: "EXECUTION_STARTED", executionId })
    );

    const result = await h.detector.compare(executionId, "v1");
    expect(result.divergent).toBe(false);
    expect(result.reason).toBe("NONE");
    expect(result.narrative).toMatch(/First certification/);
    expect(result.firstDivergentFrame).toBeNull();
  });

  it("compare() reports NONE when the log is unchanged since the prior certification", async () => {
    const h = buildHarness();
    const executionId = "exec-clean";
    await h.events.append(
      makeEvent({ sequence: 1, type: "EXECUTION_STARTED", executionId })
    );
    await h.events.append(
      makeEvent({ sequence: 2, type: "EXECUTION_COMPLETED", executionId })
    );

    await h.detector.certify(executionId, "v1");
    const result = await h.detector.compare(executionId, "v1");
    expect(result.divergent).toBe(false);
    expect(result.reason).toBe("NONE");
    expect(result.firstDivergentFrame).toBeNull();
  });

  it("compare() reports EVENT_COUNT when a new event is appended after baseline", async () => {
    const h = buildHarness();
    const executionId = "exec-grow";
    await h.events.append(
      makeEvent({ sequence: 1, type: "EXECUTION_STARTED", executionId })
    );
    await h.events.append(
      makeEvent({ sequence: 2, type: "EXECUTION_COMPLETED", executionId })
    );
    await h.detector.certify(executionId, "v1");

    await h.events.append(
      makeEvent({ sequence: 3, type: "EXECUTION_FAILED", executionId })
    );

    const result = await h.detector.compare(executionId, "v1");
    expect(result.divergent).toBe(true);
    expect(result.reason).toBe("EVENT_COUNT");
    // First two prefix frames are identical; divergence at index 2 (the new event).
    expect(result.firstDivergentFrame).toBe(2);
    expect(result.narrative).toMatch(/Event log size changed/);
  });

  it("compare() reports WORKFLOW_VERSION when the supplied version drifts", async () => {
    const h = buildHarness();
    const executionId = "exec-version-drift";
    await h.events.append(
      makeEvent({ sequence: 1, type: "EXECUTION_STARTED", executionId })
    );

    await h.detector.certify(executionId, "v1");
    const result = await h.detector.compare(executionId, "v2");
    expect(result.divergent).toBe(true);
    expect(result.reason).toBe("WORKFLOW_VERSION");
    expect(result.firstDivergentFrame).toBeNull();
    expect(result.narrative).toMatch(/v1.*v2/);
  });

  it("non-deterministic field mutation does NOT shift the chain hash", async () => {
    const h = buildHarness();
    const executionId = "exec-nondet";
    // First event uses a wallclock that the FrameBuilder strips when folding.
    await h.events.append(
      makeEvent({
        sequence: 1,
        type: "EXECUTION_STARTED",
        executionId,
        payload: { startedAt: "2024-01-01T00:00:00.000Z", workerId: "worker-A" }
      })
    );

    const baseline = await h.detector.certify(executionId, "v1");

    // Second harness with the same execution id but every wallclock and worker
    // field flipped — the chain hash MUST match (stripping rule honored).
    const h2 = buildHarness();
    await h2.events.append(
      makeEvent({
        sequence: 1,
        type: "EXECUTION_STARTED",
        executionId,
        payload: { startedAt: "2099-12-31T00:00:00.000Z", workerId: "worker-Z" }
      })
    );
    const mutated = await h2.detector.certify(executionId, "v1");

    expect(mutated.chainHash).toBe(baseline.chainHash);
    expect(mutated.frameDigests).toEqual(baseline.frameDigests);
  });

  it("certify() persists, and subsequent compare() reads the persisted baseline", async () => {
    const h = buildHarness();
    const executionId = "exec-persist";
    await h.events.append(
      makeEvent({ sequence: 1, type: "EXECUTION_STARTED", executionId })
    );
    const baseline = await h.detector.certify(executionId, "v1");

    const list = await h.certifications.listForExecution(executionId);
    expect(list).toHaveLength(1);
    expect(list[0].chainHash).toBe(baseline.chainHash);

    const cmp = await h.detector.compare(executionId, "v1");
    expect(cmp.divergent).toBe(false);
    expect(cmp.expected.chainHash).toBe(baseline.chainHash);
    expect(cmp.actual.chainHash).toBe(baseline.chainHash);
  });
});

describe("ReplayDivergenceDetector — payload mutation simulating non-determinism", () => {
  it("flipping a *deterministic* payload field on a re-projection is reported as FRAME_DIGEST with localized index", async () => {
    // Two independent harnesses simulate a non-deterministic agent: same
    // executionId, same event sequences, but one event's deterministic
    // payload differs across the two harnesses. The detector compares
    // certifications across harnesses by querying the persisted baseline.
    const baselineH = buildHarness();
    const driftH = buildHarness();
    const executionId = "exec-drift";

    const events = [
      makeEvent({ sequence: 1, type: "EXECUTION_STARTED", executionId, payload: { stage: "INIT" } }),
      makeEvent({ sequence: 2, type: "COGNITION_NODE_COMPLETED", executionId, payload: { result: "A" } }),
      makeEvent({ sequence: 3, type: "EXECUTION_COMPLETED", executionId, payload: { output: { ok: true } } })
    ];
    for (const e of events) await baselineH.events.append(e);

    const baseline = await baselineH.detector.certify(executionId, "v1");
    // Persist the same baseline into the drift harness so its compare() has
    // something to compare against.
    await driftH.certifications.put(baseline);

    // Drift: middle frame's deterministic field changes — frame 1 (0-indexed).
    const drifted = [
      events[0],
      makeEvent({ sequence: 2, type: "COGNITION_NODE_COMPLETED", executionId, payload: { result: "B" } }),
      events[2]
    ];
    for (const e of drifted) await driftH.events.append(e);

    const result = await driftH.detector.compare(executionId, "v1");
    expect(result.divergent).toBe(true);
    expect(result.reason).toBe("FRAME_DIGEST");
    expect(result.firstDivergentFrame).toBe(1);
    expect(result.narrative).toMatch(/frame 1/);
  });
});
