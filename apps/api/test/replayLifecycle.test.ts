import { describe, expect, it } from "vitest";
import {
  assertReplayLifecycleTransition,
  IllegalReplayLifecycleTransitionError,
  REPLAY_LIFECYCLE_STATES
} from "../src/runtime/replay/replayLifecycle.js";
import {
  matchStepForReplay,
  parentLogStale,
  stepsObservablyEquivalent
} from "../src/runtime/replay/replayEquivalentSemantics.js";
import {
  assertReplayIsolation,
  assertReplayLegality
} from "../src/runtime/replay/replayAssertions.js";
import { InvariantViolation } from "../src/runtime/canonicalSemantics.js";
import type { ExecutionStep } from "../src/domain/model.js";

describe("Replay lifecycle states", () => {
  it("defines all required lifecycle states", () => {
    for (const state of [
      "REPLAY_PENDING",
      "REPLAYING",
      "REPLAY_EQUIVALENT",
      "REPLAY_DIVERGED",
      "REPLAY_UNSAFE",
      "REPLAY_ABORTED",
      "REPLAY_VERIFIED"
    ]) {
      expect(REPLAY_LIFECYCLE_STATES).toContain(state);
    }
  });

  it("allows PENDING -> REPLAYING -> VERIFIED path", () => {
    expect(() => {
      assertReplayLifecycleTransition("e1", "REPLAY_PENDING", "REPLAYING");
      assertReplayLifecycleTransition("e1", "REPLAYING", "REPLAY_EQUIVALENT");
      assertReplayLifecycleTransition("e1", "REPLAY_EQUIVALENT", "REPLAY_VERIFIED");
    }).not.toThrow();
  });

  it("rejects illegal transitions", () => {
    expect(() =>
      assertReplayLifecycleTransition("e1", "REPLAY_VERIFIED", "REPLAYING")
    ).toThrow(IllegalReplayLifecycleTransitionError);
  });
});

describe("Replay-equivalent semantics helpers", () => {
  const baseStep: ExecutionStep = {
    id: "s1",
    executionId: "exec-1",
    agentId: "a1",
    type: "PLANNING",
    status: "COMPLETED",
    input: { task: { prompt: "x" } },
    output: { objective: "y" },
    startedAt: "2020-01-01T00:00:00.000Z",
    completedAt: "2020-01-01T00:00:01.000Z",
    durationMs: 1000
  };

  it("detects observable equivalence", () => {
    expect(stepsObservablyEquivalent(baseStep, baseStep)).toBe(true);
    expect(
      stepsObservablyEquivalent(baseStep, {
        ...baseStep,
        output: { objective: "different" }
      })
    ).toBe(false);
  });

  it("matches step inputs for replay", () => {
    expect(
      matchStepForReplay(baseStep, "PLANNING", { task: { prompt: "x" } }).match
    ).toBe(true);
    expect(
      matchStepForReplay(baseStep, "PLANNING", { task: { prompt: "drift" } }).reason
    ).toBe("INPUT_MISMATCH");
  });

  it("detects stale parent logs", () => {
    const events = [
      { type: "EXECUTION_STEP_COMPLETED", sequence: 5, payload: {} }
    ] as any[];
    expect(parentLogStale(events, 5)).toBe(false);
    expect(parentLogStale(events, 4)).toBe(true);
  });
});

describe("Replay assertions", () => {
  it("requires parentExecutionId for replay legality", () => {
    expect(() =>
      assertReplayLegality({
        id: "child",
        agentId: "a",
        status: "REPLAYING",
        input: {},
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        startedAt: "",
        updatedAt: ""
      })
    ).toThrow(InvariantViolation);
  });

  it("blocks parent aggregate mutation during replay", () => {
    expect(() =>
      assertReplayIsolation({
        replayExecutionId: "child",
        parentExecutionId: "parent",
        aggregateId: "parent"
      })
    ).toThrow(InvariantViolation);
  });
});
