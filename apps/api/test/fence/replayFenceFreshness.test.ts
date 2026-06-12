import { describe, expect, it } from "vitest";
import { CentralizedReplayEnforcer } from "../../src/runtime/replay/replayEnforcer.js";
import { InvariantViolation } from "../../src/runtime/canonicalSemantics.js";
import { toIso } from "../../src/shared/clock.js";
import type { Execution } from "../../src/domain/model.js";
import type { FencingToken } from "../../src/domain/clusterPorts.js";

/**
 * Unit coverage for replay-fence freshness (L2): a fence minted under a
 * reclaimed lease carries a lower attempt than the authoritative lease and
 * must be rejected before it can authorize any replay action. This is the
 * non-Docker counterpart of replayChaos Chaos Scenario 2, so the behavior is
 * locked on every platform, not only where Testcontainers runs.
 */
describe("CentralizedReplayEnforcer.validateFence — freshness against the authoritative lease attempt", () => {
  const executionId = "child-exec";

  const execution: Execution = {
    id: executionId,
    agentId: "agent-1",
    status: "RECOVERING",
    parentExecutionId: "parent-exec",
    input: { prompt: "test-prompt" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: toIso(new Date()),
    updatedAt: toIso(new Date()),
    tenantId: "system"
  };

  const fence = (workerId: string, attempt: number): FencingToken => ({
    executionId,
    workerId,
    attempt
  });

  it("rejects a stale fence whose attempt is below the authoritative lease attempt (L2)", () => {
    let thrown: unknown;
    try {
      CentralizedReplayEnforcer.validateFence(execution, fence("stale-worker", 1), "replay.begin", 2);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InvariantViolation);
    expect((thrown as InvariantViolation).invariant).toBe("L2");
  });

  it("accepts a fence whose attempt equals the authoritative lease attempt", () => {
    expect(() =>
      CentralizedReplayEnforcer.validateFence(execution, fence("fresh-worker", 2), "replay.begin", 2)
    ).not.toThrow();
  });

  it("accepts a fence whose attempt is above the authoritative lease attempt (store may lag a freshly minted lease)", () => {
    expect(() =>
      CentralizedReplayEnforcer.validateFence(execution, fence("fresh-worker", 3), "replay.begin", 2)
    ).not.toThrow();
  });

  it("without an authoritative attempt, validates shape and ownership only (freshness needs an authority)", () => {
    expect(() =>
      CentralizedReplayEnforcer.validateFence(execution, fence("any-worker", 1), "replay.begin")
    ).not.toThrow();
  });

  it("still rejects a missing fence outright (RP1)", () => {
    let thrown: unknown;
    try {
      CentralizedReplayEnforcer.validateFence(execution, undefined, "replay.begin", 2);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InvariantViolation);
    expect((thrown as InvariantViolation).invariant).toBe("RP1");
  });

  it("still rejects a fence bound to a different execution (F6)", () => {
    const foreign: FencingToken = { executionId: "other-exec", workerId: "fresh-worker", attempt: 2 };
    let thrown: unknown;
    try {
      CentralizedReplayEnforcer.validateFence(execution, foreign, "replay.begin", 2);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InvariantViolation);
    expect((thrown as InvariantViolation).invariant).toBe("F6");
  });
});
