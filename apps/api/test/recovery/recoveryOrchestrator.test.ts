import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryRecoveryCoordinationStore } from "../../src/runtime/recovery/inMemoryRecoveryStore.js";
import {
  DistributedRecoveryOrchestrator,
  arbitrateRecovery,
  assertReplayRecoverySafe,
  classifyRecovery,
  orderByRecoveryPriority,
  recoveryPriority,
  type RecoveryCoordinationRecord,
  type RecoveryOrchestratorConfig
} from "../../src/runtime/recovery/recoveryOrchestrator.js";
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

function makeOrchestrator(config: Partial<RecoveryOrchestratorConfig> = {}, clock = new ManualClock()) {
  const store = new InMemoryRecoveryCoordinationStore({ clock });
  const orchestrator = new DistributedRecoveryOrchestrator(store, { clock, config });
  return { store, orchestrator, clock };
}

// ─── Pure classification (the recovery legality matrix) ──────────────────────

describe("classifyRecovery — recovery legality matrix", () => {
  it("routes a plain crash to RECOVERING", () => {
    const c = classifyRecovery({ executionStatus: "RUNNING" });
    expect(c.state).toBe("RECOVERING");
    expect(c.strategy).toBe("CRASH");
  });

  it("routes a replay child to REPLAY_RECOVERING", () => {
    const c = classifyRecovery({ executionStatus: "RUNNING", parentExecutionId: "parent-1" });
    expect(c.state).toBe("REPLAY_RECOVERING");
    expect(c.strategy).toBe("REPLAY");
  });

  it("routes an ambiguous external commit to RECONCILING (REC3)", () => {
    const c = classifyRecovery({ executionStatus: "RUNNING", failureCategory: "AMBIGUOUS_EXTERNAL_COMMIT" });
    expect(c.state).toBe("RECONCILING");
    expect(c.strategy).toBe("RECONCILE");
  });

  it("routes a non-idempotent failure to RECONCILING (REC3)", () => {
    const c = classifyRecovery({ executionStatus: "RUNNING", failureCategory: "TOOL_NON_IDEMPOTENT" });
    expect(c.state).toBe("RECONCILING");
  });

  it("routes an AMBIGUOUS execution status to RECONCILING even without a failure code", () => {
    expect(classifyRecovery({ executionStatus: "AMBIGUOUS" }).state).toBe("RECONCILING");
    expect(classifyRecovery({ executionStatus: "RECONCILIATION_REQUIRED" }).state).toBe("RECONCILING");
  });

  it("does NOT re-route to reconciliation once already reconciled", () => {
    const c = classifyRecovery({
      executionStatus: "RECONCILIATION_REQUIRED",
      failureCategory: "AMBIGUOUS_EXTERNAL_COMMIT",
      reconciled: true
    });
    expect(c.state).toBe("RECOVERING");
  });

  it("quarantines a replay divergence to RECONCILING, never re-driving (REC2/REC5)", () => {
    expect(classifyRecovery({ executionStatus: "REPLAYING", failureCategory: "REPLAY_DIVERGENCE" }).state).toBe(
      "RECONCILING"
    );
    expect(classifyRecovery({ executionStatus: "RUNNING", parentExecutionId: "p", replayDiverged: true }).state).toBe(
      "RECONCILING"
    );
  });

  it("escalates exhausted attempts to RECOVERY_ABORTED (dead-letter)", () => {
    const c = classifyRecovery({ executionStatus: "RUNNING", attemptCount: 5, maxAttempts: 3 });
    expect(c.state).toBe("RECOVERY_ABORTED");
    expect(c.escalate).toBe("DEAD_LETTER");
  });

  it("escalates a non-recoverable failure to RECOVERY_ABORTED", () => {
    expect(classifyRecovery({ executionStatus: "RUNNING", failureCategory: "STALE_WORKER_MUTATION" }).state).toBe(
      "RECOVERY_ABORTED"
    );
    expect(classifyRecovery({ executionStatus: "RUNNING", failureCategory: "EXECUTION_CANCELLED" }).state).toBe(
      "RECOVERY_ABORTED"
    );
  });

  it("reconciliation takes precedence over dead-letter escalation (ambiguity is never silently dropped)", () => {
    const c = classifyRecovery({
      executionStatus: "AMBIGUOUS",
      failureCategory: "AMBIGUOUS_EXTERNAL_COMMIT",
      attemptCount: 99,
      maxAttempts: 3
    });
    expect(c.state).toBe("RECONCILING");
  });

  it("treats an already-concluded execution as RECOVERY_COMPLETED", () => {
    expect(classifyRecovery({ executionStatus: "COMPLETED" }).state).toBe("RECOVERY_COMPLETED");
    expect(classifyRecovery({ executionStatus: "DEAD_LETTERED" }).state).toBe("RECOVERY_COMPLETED");
    expect(classifyRecovery({ executionStatus: "CANCELLED" }).state).toBe("RECOVERY_COMPLETED");
  });
});

// ─── Arbitration + prioritization (pure) ─────────────────────────────────────

describe("arbitrateRecovery — single-winner by monotonic epoch (REC8)", () => {
  const mk = (epoch: number): RecoveryCoordinationRecord => ({
    executionId: "e1",
    state: "RECOVERING",
    ownerEpoch: epoch,
    ownerWorkerId: "w",
    strategy: "CRASH",
    priority: 0,
    createdAt: "t",
    updatedAt: "t"
  });

  it("WINs when there is no active owner", () => {
    expect(arbitrateRecovery(undefined, 5)).toBe("WIN");
    expect(arbitrateRecovery({ ...mk(2), state: "RECOVERY_COMPLETED" }, 5)).toBe("WIN");
  });

  it("TAKEOVERs a strictly-lower epoch (failover)", () => {
    expect(arbitrateRecovery(mk(3), 4)).toBe("TAKEOVER");
  });

  it("LOSEs to an equal or higher epoch (zombie/duplicate surrenders)", () => {
    expect(arbitrateRecovery(mk(5), 5)).toBe("LOSE");
    expect(arbitrateRecovery(mk(7), 4)).toBe("LOSE");
  });
});

describe("recoveryPriority — deterministic ordering policy", () => {
  it("ranks ambiguous / human-gated failures above plain crashes", () => {
    const ambiguous = recoveryPriority({ failureCategory: "AMBIGUOUS_EXTERNAL_COMMIT", ambiguous: true });
    const crash = recoveryPriority({ failureCategory: "PROCESS_CRASH" });
    expect(ambiguous).toBeGreaterThan(crash);
  });

  it("ranks older waits higher (anti-starvation)", () => {
    expect(recoveryPriority({ ageMs: 120_000 })).toBeGreaterThan(recoveryPriority({ ageMs: 0 }));
  });

  it("penalizes executions near the poison-pill ceiling", () => {
    const near = recoveryPriority({ attemptCount: 9, maxAttempts: 10 });
    const fresh = recoveryPriority({ attemptCount: 1, maxAttempts: 10 });
    expect(near).toBeLessThan(fresh);
  });

  it("orders a batch highest-priority-first, stable on ties", () => {
    const items = [
      { id: "crash", p: recoveryPriority({ failureCategory: "PROCESS_CRASH" }) },
      { id: "ambiguous", p: recoveryPriority({ ambiguous: true }) },
      { id: "old", p: recoveryPriority({ ageMs: 60_000 }) }
    ];
    const ordered = orderByRecoveryPriority(items, (x) => x.p).map((x) => x.id);
    expect(ordered[0]).toBe("ambiguous");
  });
});

// ─── Orchestration ───────────────────────────────────────────────────────────

describe("DistributedRecoveryOrchestrator — strategy dispatch", () => {
  it("admits a fresh crash recovery → RECOVER / RECOVERING", async () => {
    const { orchestrator } = makeOrchestrator();
    const r = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 2,
      executionStatus: "RUNNING"
    });
    expect(r.decision).toBe("RECOVER");
    expect(r.state).toBe("RECOVERING");
    expect(r.record?.ownerEpoch).toBe(2);
    expect(orchestrator.inFlightRecoveries()).toBe(1);
    r.release();
    expect(orchestrator.inFlightRecoveries()).toBe(0);
  });

  it("admits a replay child as REPLAY_RECOVER / REPLAY_RECOVERING", async () => {
    const { orchestrator } = makeOrchestrator();
    const r = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 2,
      executionStatus: "RUNNING",
      parentExecutionId: "parent-1"
    });
    expect(r.decision).toBe("REPLAY_RECOVER");
    expect(r.state).toBe("REPLAY_RECOVERING");
    r.release();
  });

  it("routes ambiguity to RECONCILE / RECONCILING (REC3)", async () => {
    const { orchestrator } = makeOrchestrator();
    const r = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 2,
      executionStatus: "AMBIGUOUS",
      failureCategory: "AMBIGUOUS_EXTERNAL_COMMIT"
    });
    expect(r.decision).toBe("RECONCILE");
    expect(r.state).toBe("RECONCILING");
    r.release();
  });

  it("escalates a non-recoverable failure to ABORTED and frees the slot", async () => {
    const { orchestrator } = makeOrchestrator();
    const r = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 2,
      executionStatus: "RUNNING",
      failureCategory: "STALE_WORKER_MUTATION"
    });
    expect(r.decision).toBe("ABORTED");
    expect(r.state).toBe("RECOVERY_ABORTED");
    expect(orchestrator.inFlightRecoveries()).toBe(0); // terminal classification releases
  });

  it("concludes an already-finished execution as COMPLETED", async () => {
    const { orchestrator } = makeOrchestrator();
    const r = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 2,
      executionStatus: "COMPLETED"
    });
    expect(r.decision).toBe("COMPLETED");
    expect(r.state).toBe("RECOVERY_COMPLETED");
  });

  it("rejects a non-positive recovery epoch (REC8)", async () => {
    const { orchestrator } = makeOrchestrator();
    await expect(
      orchestrator.orchestrateRecovery({ executionId: "e1", recoveryWorkerId: "w1", ownerEpoch: 0, executionStatus: "RUNNING" })
    ).rejects.toBeInstanceOf(InvariantViolation);
  });
});

describe("DistributedRecoveryOrchestrator — ownership arbitration (REC1/REC4/REC8)", () => {
  it("invalidates a stale (lower-epoch) recovery owner", async () => {
    const { orchestrator } = makeOrchestrator();
    const first = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 5,
      executionStatus: "RUNNING"
    });
    expect(first.decision).toBe("RECOVER");

    const stale = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w2",
      ownerEpoch: 3,
      executionStatus: "RUNNING"
    });
    expect(stale.decision).toBe("ALREADY_OWNED");
    expect(stale.record?.ownerEpoch).toBe(5); // live owner unchanged
    first.release();
  });

  it("lets a strictly-higher epoch take over ownership (failover)", async () => {
    const { orchestrator } = makeOrchestrator();
    const first = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 5,
      executionStatus: "RUNNING"
    });
    const takeover = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w2",
      ownerEpoch: 7,
      executionStatus: "RUNNING"
    });
    expect(takeover.decision).toBe("RECOVER");
    expect(takeover.record?.ownerEpoch).toBe(7);
    expect(takeover.record?.ownerWorkerId).toBe("w2");
    first.release();
    takeover.release();
  });

  it("is idempotent for the same worker at the same epoch", async () => {
    const { orchestrator } = makeOrchestrator();
    const a = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 4,
      executionStatus: "RUNNING"
    });
    const b = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 4,
      executionStatus: "RUNNING"
    });
    expect(b.decision).toBe("RECOVER");
    expect(b.record?.ownerEpoch).toBe(4);
    expect(orchestrator.inFlightRecoveries()).toBe(1); // second call did not reserve a new slot
    a.release();
  });

  it("flags two distinct workers claiming the identical epoch as corruption (REC8)", async () => {
    const { orchestrator } = makeOrchestrator();
    const a = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 4,
      executionStatus: "RUNNING"
    });
    await expect(
      orchestrator.orchestrateRecovery({ executionId: "e1", recoveryWorkerId: "w2", ownerEpoch: 4, executionStatus: "RUNNING" })
    ).rejects.toBeInstanceOf(InvariantViolation);
    a.release();
  });
});

describe("DistributedRecoveryOrchestrator — backpressure + storm (REC7)", () => {
  it("sheds recoveries to BLOCKED once the throttle ceiling is reached", async () => {
    const { orchestrator } = makeOrchestrator({ maxConcurrentRecoveries: 2 });
    const a = await orchestrator.orchestrateRecovery({ executionId: "e1", recoveryWorkerId: "w", ownerEpoch: 2, executionStatus: "RUNNING" });
    const b = await orchestrator.orchestrateRecovery({ executionId: "e2", recoveryWorkerId: "w", ownerEpoch: 2, executionStatus: "RUNNING" });
    const c = await orchestrator.orchestrateRecovery({ executionId: "e3", recoveryWorkerId: "w", ownerEpoch: 2, executionStatus: "RUNNING" });
    expect(a.decision).toBe("RECOVER");
    expect(b.decision).toBe("RECOVER");
    expect(c.decision).toBe("BLOCKED");
    expect(c.state).toBe("RECOVERY_BLOCKED");
    expect(orchestrator.inFlightRecoveries()).toBe(2);

    a.release();
    const cRetry = await orchestrator.orchestrateRecovery({ executionId: "e3", recoveryWorkerId: "w", ownerEpoch: 2, executionStatus: "RUNNING" });
    expect(cRetry.decision).toBe("RECOVER");
    b.release();
    cRetry.release();
  });

  it("hard storm breach asserts REC7 (amplification bug, fail-closed)", async () => {
    const clock = new ManualClock();
    const { orchestrator } = makeOrchestrator(
      { stormSoftLimit: 2, stormHardLimit: 3, stormWindowMs: 60_000, maxConcurrentRecoveries: 100 },
      clock
    );
    // count 1, 2 OK; count 3 SOFT → BLOCKED; count 4 HARD → throws.
    (await orchestrator.orchestrateRecovery({ executionId: "e1", recoveryWorkerId: "w", ownerEpoch: 2, executionStatus: "RUNNING" })).release();
    (await orchestrator.orchestrateRecovery({ executionId: "e1", recoveryWorkerId: "w", ownerEpoch: 3, executionStatus: "RUNNING" })).release();
    const soft = await orchestrator.orchestrateRecovery({ executionId: "e1", recoveryWorkerId: "w", ownerEpoch: 4, executionStatus: "RUNNING" });
    expect(soft.decision).toBe("BLOCKED");
    await expect(
      orchestrator.orchestrateRecovery({ executionId: "e1", recoveryWorkerId: "w", ownerEpoch: 5, executionStatus: "RUNNING" })
    ).rejects.toBeInstanceOf(InvariantViolation);
  });
});

describe("DistributedRecoveryOrchestrator — fence + replay-overlap gates (REC6/REC1)", () => {
  it("withholds recovery ownership behind an invalid fence (REC6)", async () => {
    const { orchestrator } = makeOrchestrator();
    const r = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 2,
      executionStatus: "RUNNING",
      validateFence: async () => false
    });
    expect(r.decision).toBe("BLOCKED");
    expect(r.state).toBe("RECOVERY_BLOCKED");
    expect(orchestrator.inFlightRecoveries()).toBe(0); // slot released
  });

  it("admits recovery when the fence validates", async () => {
    const { orchestrator } = makeOrchestrator();
    const r = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 2,
      executionStatus: "RUNNING",
      validateFence: async () => true
    });
    expect(r.decision).toBe("RECOVER");
    r.release();
  });

  it("blocks recovery while a replay child is active (REC1 — no overlap)", async () => {
    const { orchestrator } = makeOrchestrator();
    const r = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 2,
      executionStatus: "RUNNING",
      replayActive: true
    });
    expect(r.decision).toBe("BLOCKED");
    expect(r.state).toBe("RECOVERY_BLOCKED");
    expect(orchestrator.inFlightRecoveries()).toBe(0);
  });
});

describe("DistributedRecoveryOrchestrator — reconciliation gate (REC3) + divergence leak (REC5)", () => {
  it("resolves a reconciling recovery: NOT_COMMITTED → RECOVERING", async () => {
    const { orchestrator } = makeOrchestrator();
    const r = await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 2,
      executionStatus: "AMBIGUOUS",
      failureCategory: "AMBIGUOUS_EXTERNAL_COMMIT"
    });
    r.release();
    const resolved = await orchestrator.resolveReconciliation({
      executionId: "e1",
      workerId: "w1",
      ownerEpoch: 2,
      resolution: { verdict: "NOT_COMMITTED" }
    });
    expect(resolved?.state).toBe("RECOVERING");
  });

  it("resolves a reconciling recovery: COMMITTED → RECOVERY_COMPLETED", async () => {
    const { orchestrator } = makeOrchestrator();
    (await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 2,
      executionStatus: "AMBIGUOUS",
      failureCategory: "AMBIGUOUS_EXTERNAL_COMMIT"
    })).release();
    const resolved = await orchestrator.resolveReconciliation({
      executionId: "e1",
      workerId: "w1",
      ownerEpoch: 2,
      resolution: { verdict: "COMMITTED" }
    });
    expect(resolved?.state).toBe("RECOVERY_COMPLETED");
  });

  it("rejects resolveReconciliation when the coordination is not RECONCILING (REC3)", async () => {
    const { orchestrator } = makeOrchestrator();
    (await orchestrator.orchestrateRecovery({ executionId: "e1", recoveryWorkerId: "w1", ownerEpoch: 2, executionStatus: "RUNNING" })).release();
    await expect(
      orchestrator.resolveReconciliation({ executionId: "e1", workerId: "w1", ownerEpoch: 2, resolution: { verdict: "NOT_COMMITTED" } })
    ).rejects.toBeInstanceOf(InvariantViolation);
  });

  it("refuses to complete a diverged replay recovery — it must reconcile (REC5)", async () => {
    const { orchestrator } = makeOrchestrator();
    (await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 2,
      executionStatus: "RUNNING",
      parentExecutionId: "parent-1"
    })).release();
    await expect(
      orchestrator.completeRecovery({ executionId: "e1", workerId: "w1", ownerEpoch: 2, replayDiverged: true })
    ).rejects.toBeInstanceOf(InvariantViolation);
  });

  it("completes a verified-equivalent replay recovery", async () => {
    const { orchestrator } = makeOrchestrator();
    (await orchestrator.orchestrateRecovery({
      executionId: "e1",
      recoveryWorkerId: "w1",
      ownerEpoch: 2,
      executionStatus: "RUNNING",
      parentExecutionId: "parent-1"
    })).release();
    const done = await orchestrator.completeRecovery({ executionId: "e1", workerId: "w1", ownerEpoch: 2, replayDiverged: false });
    expect(done?.state).toBe("RECOVERY_COMPLETED");
  });
});

describe("assertReplayRecoverySafe — unsafe recovery replay (REC2)", () => {
  it("blocks a non-replay-safe side effect after divergence", () => {
    expect(() => assertReplayRecoverySafe("e1", { diverged: true, toolName: "stripe.payment" })).toThrowError(
      InvariantViolation
    );
  });

  it("permits a replay-safe side effect after divergence", () => {
    expect(() => assertReplayRecoverySafe("e1", { diverged: true, toolName: "web.search" })).not.toThrow();
  });

  it("permits any side effect before divergence", () => {
    expect(() => assertReplayRecoverySafe("e1", { diverged: false, toolName: "stripe.payment" })).not.toThrow();
  });
});
