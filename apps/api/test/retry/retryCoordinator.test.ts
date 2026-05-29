import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryRetryCoordinationStore } from "../../src/runtime/retry/inMemoryRetryStore.js";
import {
  RetryCoordinator,
  type RetryCoordinatorConfig
} from "../../src/runtime/retry/retryCoordinator.js";
import { InvariantViolation } from "../../src/runtime/canonicalSemantics.js";

class ManualClock {
  constructor(private t = 1_000) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function makeCoordinator(config: Partial<RetryCoordinatorConfig> = {}, clock = new ManualClock()) {
  const store = new InMemoryRetryCoordinationStore({ clock });
  const coordinator = new RetryCoordinator(store, { clock, config });
  return { store, coordinator, clock };
}

describe("RetryCoordinator — single-flight admission (RT1/RT5)", () => {
  it("admits a fresh retry and records SCHEDULED", async () => {
    const { coordinator } = makeCoordinator();
    const res = await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w1", attempt: 2 });
    expect(res.decision).toBe("ADMITTED");
    expect(res.record?.state).toBe("RETRY_SCHEDULED");
    expect(res.record?.attempt).toBe(2);
  });

  it("dedupes a duplicate request for the same logical attempt", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w1", attempt: 2 });
    const dup = await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w2", attempt: 2 });
    expect(dup.decision).toBe("DEDUPED");
  });

  it("dedupes a late, lower attempt", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w1", attempt: 5 });
    const late = await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w2", attempt: 3 });
    expect(late.decision).toBe("DEDUPED");
  });

  it("supersedes with a strictly newer attempt (arbitration: newest wins)", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w1", attempt: 2 });
    const newer = await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w2", attempt: 3 });
    expect(newer.decision).toBe("ADMITTED");
    expect(newer.record?.attempt).toBe(3);
  });

  it("rejects a non-positive attempt (RT5)", async () => {
    const { coordinator } = makeCoordinator();
    await expect(
      coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w1", attempt: 0 })
    ).rejects.toBeInstanceOf(InvariantViolation);
  });

  it("re-admits from a concluded coordination after settle", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w1", attempt: 2 });
    await coordinator.settle("e1", "w1", 2);
    const again = await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w1", attempt: 3 });
    expect(again.decision).toBe("ADMITTED");
  });
});

describe("RetryCoordinator — failure legality (RT7 + policy)", () => {
  it("aborts a non-retryable failure", async () => {
    const { coordinator } = makeCoordinator();
    const res = await coordinator.requestRetry({
      executionId: "e1",
      requesterWorkerId: "w1",
      attempt: 2,
      failureType: "STALE_WORKER_MUTATION"
    });
    expect(res.decision).toBe("ABORTED");
    expect((await coordinator.get("e1"))?.state).toBe("RETRY_ABORTED");
  });

  it("routes an ambiguous side effect to reconciliation, not retry (RT7)", async () => {
    const { coordinator } = makeCoordinator();
    const res = await coordinator.requestRetry({
      executionId: "e1",
      requesterWorkerId: "w1",
      attempt: 2,
      failureType: "AMBIGUOUS_EXTERNAL_COMMIT"
    });
    expect(res.decision).toBe("RECONCILE_REQUIRED");
    expect((await coordinator.get("e1"))?.state).toBe("RETRY_RECONCILING");
  });

  it("refuses to supersede a reconciling coordination with a blind retry (RT7)", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w1", attempt: 2, failureType: "TOOL_NON_IDEMPOTENT" });
    const blind = await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w2", attempt: 9 });
    expect(blind.decision).toBe("RECONCILE_REQUIRED");
  });

  it("permits retry after reconciliation verifies NOT_COMMITTED", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w1", attempt: 2, failureType: "AMBIGUOUS_EXTERNAL_COMMIT" });
    await coordinator.resolveReconciliation("e1", "rec", 2, { verdict: "NOT_COMMITTED" });
    expect((await coordinator.get("e1"))?.state).toBe("RETRY_PENDING");
    const retry = await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w1", attempt: 2 });
    expect(retry.decision).toBe("ADMITTED");
  });

  it("settles when reconciliation verifies COMMITTED", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.requestRetry({ executionId: "e1", requesterWorkerId: "w1", attempt: 2, failureType: "AMBIGUOUS_EXTERNAL_COMMIT" });
    await coordinator.resolveReconciliation("e1", "rec", 2, { verdict: "COMMITTED" });
    expect((await coordinator.get("e1"))?.state).toBe("RETRY_SETTLED");
  });
});

describe("RetryCoordinator — backpressure + storm (RT6)", () => {
  it("sheds with BLOCKED + extended backoff when in-flight ceiling is reached", async () => {
    const { coordinator } = makeCoordinator({ maxInFlightRetries: 1, blockedBackoffFloorMs: 5_000 });
    await coordinator.requestRetry({ executionId: "a", requesterWorkerId: "w", attempt: 2 });
    const shed = await coordinator.requestRetry({ executionId: "b", requesterWorkerId: "w", attempt: 2, backoffMs: 100 });
    expect(shed.decision).toBe("BLOCKED");
    expect(shed.effectiveBackoffMs).toBeGreaterThanOrEqual(5_000);
  });

  it("sheds (soft) then asserts (hard) under a per-execution retry storm", async () => {
    const { coordinator } = makeCoordinator({ stormSoftLimit: 2, stormHardLimit: 3, stormWindowMs: 1_000_000 });
    // attempts 1,2 admitted (count 1,2)
    expect((await coordinator.requestRetry({ executionId: "e", requesterWorkerId: "w", attempt: 1 })).decision).toBe("ADMITTED");
    expect((await coordinator.requestRetry({ executionId: "e", requesterWorkerId: "w", attempt: 2 })).decision).toBe("ADMITTED");
    // count 3 > soft 2 → shed
    expect((await coordinator.requestRetry({ executionId: "e", requesterWorkerId: "w", attempt: 3 })).decision).toBe("BLOCKED");
    // count 4 > hard 3 → assert RT6
    await expect(
      coordinator.requestRetry({ executionId: "e", requesterWorkerId: "w", attempt: 4 })
    ).rejects.toBeInstanceOf(InvariantViolation);
  });
});

describe("RetryCoordinator — exclusive execution ownership (RT2/RT8)", () => {
  it("grants ownership to a fresh first-run execution", async () => {
    const { coordinator } = makeCoordinator();
    const claim = await coordinator.claimExecution({ executionId: "e", workerId: "w1", ownerEpoch: 1 });
    expect(claim.outcome).toBe("OWNED");
    expect(claim.record?.state).toBe("RETRY_EXECUTING");
    expect(claim.record?.ownerEpoch).toBe(1);
  });

  it("lets a strictly-higher epoch take over (failover)", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.claimExecution({ executionId: "e", workerId: "w1", ownerEpoch: 1 });
    const takeover = await coordinator.claimExecution({ executionId: "e", workerId: "w2", ownerEpoch: 2 });
    expect(takeover.outcome).toBe("OWNED");
    expect(takeover.record?.ownerEpoch).toBe(2);
    expect(takeover.record?.ownerWorkerId).toBe("w2");
  });

  it("rejects a strictly-lower epoch as a zombie (STALE)", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.claimExecution({ executionId: "e", workerId: "w2", ownerEpoch: 2 });
    const zombie = await coordinator.claimExecution({ executionId: "e", workerId: "w1", ownerEpoch: 1 });
    expect(zombie.outcome).toBe("STALE");
  });

  it("refuses ownership when fence validation fails (RT8)", async () => {
    const { coordinator } = makeCoordinator();
    const claim = await coordinator.claimExecution({
      executionId: "e",
      workerId: "w1",
      ownerEpoch: 1,
      validateFence: async () => false
    });
    expect(claim.outcome).toBe("FENCED");
    expect(await coordinator.get("e")).toBeUndefined();
  });

  it("asserts RT2 on two distinct workers at the identical epoch", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.claimExecution({ executionId: "e", workerId: "w1", ownerEpoch: 5 });
    await expect(
      coordinator.claimExecution({ executionId: "e", workerId: "w2", ownerEpoch: 5 })
    ).rejects.toBeInstanceOf(InvariantViolation);
  });

  it("does not grant ownership while a coordination is reconciling (RT7)", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.requestRetry({ executionId: "e", requesterWorkerId: "w", attempt: 2, failureType: "AMBIGUOUS_EXTERNAL_COMMIT" });
    const claim = await coordinator.claimExecution({ executionId: "e", workerId: "w1", ownerEpoch: 3 });
    expect(claim.outcome).toBe("RECONCILE_REQUIRED");
  });
});

describe("RetryCoordinator — recovery serialization + throttle (RT3)", () => {
  it("admits one recovery and reports an in-flight slot", async () => {
    const { coordinator } = makeCoordinator();
    const rec = await coordinator.requestRecovery({ executionId: "e", recoveryWorkerId: "r1", ownerEpoch: 2 });
    expect(rec.decision).toBe("ADMITTED");
    expect(coordinator.inFlightRecoveries()).toBe(1);
    rec.release();
    expect(coordinator.inFlightRecoveries()).toBe(0);
  });

  it("serializes: a second recovery at an equal/lower epoch is ALREADY_OWNED", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.requestRecovery({ executionId: "e", recoveryWorkerId: "r1", ownerEpoch: 2 });
    const second = await coordinator.requestRecovery({ executionId: "e", recoveryWorkerId: "r2", ownerEpoch: 2 });
    expect(second.decision).toBe("ALREADY_OWNED");
  });

  it("throttles concurrent recoveries to the global ceiling", async () => {
    const { coordinator } = makeCoordinator({ maxConcurrentRecoveries: 1 });
    const a = await coordinator.requestRecovery({ executionId: "a", recoveryWorkerId: "r1", ownerEpoch: 2 });
    expect(a.decision).toBe("ADMITTED");
    const b = await coordinator.requestRecovery({ executionId: "b", recoveryWorkerId: "r2", ownerEpoch: 2 });
    expect(b.decision).toBe("THROTTLED");
    a.release();
    const c = await coordinator.requestRecovery({ executionId: "b", recoveryWorkerId: "r2", ownerEpoch: 2 });
    expect(c.decision).toBe("ADMITTED");
  });

  it("blocks recovery while a replay child is active (RT4)", async () => {
    const { coordinator } = makeCoordinator();
    const rec = await coordinator.requestRecovery({ executionId: "e", recoveryWorkerId: "r1", ownerEpoch: 2, replayActive: true });
    expect(rec.decision).toBe("BLOCKED");
  });
});

describe("RetryCoordinator — replay/recovery overlap (RT4)", () => {
  it("asserts when recovery is requested over an active replay coordination", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.requestRetry({ executionId: "e", requesterWorkerId: "w", attempt: 2, mode: "replay", parentExecutionId: "parent" });
    await expect(
      coordinator.requestRecovery({ executionId: "e", recoveryWorkerId: "r", ownerEpoch: 3 })
    ).rejects.toBeInstanceOf(InvariantViolation);
  });

  it("asserts when a replay retry is requested over an active recovery coordination", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.requestRecovery({ executionId: "e", recoveryWorkerId: "r", ownerEpoch: 2 });
    await expect(
      coordinator.requestRetry({ executionId: "e", requesterWorkerId: "w", attempt: 3, mode: "replay" })
    ).rejects.toBeInstanceOf(InvariantViolation);
  });
});

describe("RetryCoordinator — terminal settle/abort", () => {
  let ctx: ReturnType<typeof makeCoordinator>;
  beforeEach(() => {
    ctx = makeCoordinator();
  });

  it("settles from EXECUTING", async () => {
    await ctx.coordinator.claimExecution({ executionId: "e", workerId: "w1", ownerEpoch: 1 });
    await ctx.coordinator.settle("e", "w1", 1);
    expect((await ctx.coordinator.get("e"))?.state).toBe("RETRY_SETTLED");
  });

  it("aborts from any active state and is idempotent", async () => {
    await ctx.coordinator.requestRetry({ executionId: "e", requesterWorkerId: "w", attempt: 2 });
    await ctx.coordinator.abort("e", "exhausted");
    expect((await ctx.coordinator.get("e"))?.state).toBe("RETRY_ABORTED");
    await ctx.coordinator.abort("e", "again"); // no-op on a terminal
    expect((await ctx.coordinator.get("e"))?.state).toBe("RETRY_ABORTED");
  });
});
