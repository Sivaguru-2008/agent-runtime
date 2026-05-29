/**
 * Distributed Recovery Orchestration — Chaos Tests.
 *
 * Exercises the canonical recovery orchestrator (src/runtime/recovery/) under
 * the adversarial distributed-recovery scenarios the runtime must survive:
 *
 *   R.1  distributed crash recovery        — a crashed execution recovers cleanly.
 *   R.2  recovery after partition          — a healed partition: the fresh epoch
 *                                            wins, the stale partitioned worker is
 *                                            invalidated (REC4).
 *   R.3  replay recovery divergence        — a diverged replay recovery quarantines
 *                                            to reconciliation and can NEVER complete
 *                                            (REC2/REC5 — no divergence leakage).
 *   R.4  concurrent takeover attempts      — a fan-out of contending recovery
 *                                            workers elects exactly one owner that
 *                                            repels every stale challenger (REC1/REC8).
 *   R.5  recovery retry storms             — a storm of recovery requests is shed
 *                                            (BLOCKED); amplification stays bounded
 *                                            and a hard breach fails closed (REC7).
 *   R.6  ambiguity escalation              — an ambiguous external commit can never
 *                                            be re-driven without reconciliation
 *                                            (REC3); a COMMITTED verdict settles it
 *                                            without a double-fire.
 *
 * Unlike the Postgres-backed phase suites, these run purely in memory (the
 * orchestrator's in-memory coordination store is a faithful model of the
 * Postgres CTE-under-row-lock — same synchronous-critical-section CAS), so they
 * always run and need no Docker harness.
 */

import { describe, expect, it } from "vitest";
import { recordPhase, evaluateThresholds } from "./_setup/chaosResultBus.js";
import { InMemoryRecoveryCoordinationStore } from "../../src/runtime/recovery/inMemoryRecoveryStore.js";
import {
  DistributedRecoveryOrchestrator,
  type OrchestrateRecoveryResult,
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

async function fanOut<T>(n: number, fn: (i: number) => Promise<T>): Promise<{ results: T[]; errors: unknown[] }> {
  const settled = await Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
  const results: T[] = [];
  const errors: unknown[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") results.push(s.value);
    else errors.push(s.reason);
  }
  return { results, errors };
}

describe("Recovery R.1 — distributed crash recovery", () => {
  it("recovers a crashed execution and drives it to RECOVERY_COMPLETED", async () => {
    const t0 = Date.now();
    const { orchestrator } = makeOrchestrator();

    const decision = await orchestrator.orchestrateRecovery({
      executionId: "exec-crash",
      recoveryWorkerId: "worker-recovery",
      ownerEpoch: 2,
      executionStatus: "RUNNING"
    });
    const completed = await orchestrator.completeRecovery({
      executionId: "exec-crash",
      workerId: "worker-recovery",
      ownerEpoch: 2
    });
    decision.release();

    const { ok, thresholds } = evaluateThresholds({
      recovered: { observed: decision.decision === "RECOVER" ? 1 : 0, required: "== 1 (RECOVER)", predicate: (v) => v === 1 },
      completed: { observed: completed?.state === "RECOVERY_COMPLETED" ? 1 : 0, required: "== 1 (RECOVERY_COMPLETED)", predicate: (v) => v === 1 },
      slotsFreed: { observed: orchestrator.inFlightRecoveries(), required: "== 0", predicate: (v) => v === 0 }
    });
    expect(ok).toBe(true);
    await recordPhase("recovery.R1.distributedCrashRecovery", { ok, metrics: { decision: decision.decision, finalState: completed?.state ?? "none" }, thresholds, durationMs: Date.now() - t0 });
  });
});

describe("Recovery R.2 — recovery after partition", () => {
  it("elects the fresh epoch and invalidates the stale partitioned worker (REC4)", async () => {
    const t0 = Date.now();
    const { orchestrator } = makeOrchestrator();

    // Before the partition: worker-A owns recovery at epoch 5.
    const a = await orchestrator.orchestrateRecovery({ executionId: "exec-part", recoveryWorkerId: "worker-A", ownerEpoch: 5, executionStatus: "RUNNING" });
    // Partition heals: worker-B reclaims under a fresh, higher epoch and takes over.
    const b = await orchestrator.orchestrateRecovery({ executionId: "exec-part", recoveryWorkerId: "worker-B", ownerEpoch: 7, executionStatus: "RUNNING" });
    // The stale partitioned worker-A wakes up at its old epoch and must surrender.
    const staleWake = await orchestrator.orchestrateRecovery({ executionId: "exec-part", recoveryWorkerId: "worker-A", ownerEpoch: 5, executionStatus: "RUNNING" });
    a.release();
    b.release();

    const { ok, thresholds } = evaluateThresholds({
      freshWins: { observed: b.record?.ownerEpoch ?? -1, required: "== 7", predicate: (v) => v === 7 },
      freshOwner: { observed: b.record?.ownerWorkerId === "worker-B" ? 1 : 0, required: "== 1 (worker-B owns)", predicate: (v) => v === 1 },
      staleInvalidated: { observed: staleWake.decision === "ALREADY_OWNED" ? 1 : 0, required: "== 1 (ALREADY_OWNED)", predicate: (v) => v === 1 },
      staleSeesFreshOwner: { observed: staleWake.record?.ownerEpoch ?? -1, required: "== 7", predicate: (v) => v === 7 }
    });
    expect(ok).toBe(true);
    await recordPhase("recovery.R2.recoveryAfterPartition", { ok, metrics: { winner: b.record?.ownerWorkerId ?? "none", staleDecision: staleWake.decision }, thresholds, durationMs: Date.now() - t0 });
  });
});

describe("Recovery R.3 — replay recovery divergence", () => {
  it("quarantines a diverged replay recovery and forbids completion (REC2/REC5)", async () => {
    const t0 = Date.now();
    const { orchestrator } = makeOrchestrator();

    // A replay-based recovery starts (replay child).
    const replay = await orchestrator.orchestrateRecovery({
      executionId: "exec-replay",
      recoveryWorkerId: "worker-recovery",
      ownerEpoch: 2,
      executionStatus: "RUNNING",
      parentExecutionId: "parent-exec"
    });
    replay.release();

    // It diverges — completing it would leak a non-deterministic side effect.
    // REC5 makes that completion unrepresentable.
    let leakBlocked = false;
    try {
      await orchestrator.completeRecovery({ executionId: "exec-replay", workerId: "worker-recovery", ownerEpoch: 2, replayDiverged: true });
    } catch (err) {
      leakBlocked = err instanceof InvariantViolation;
    }

    // A divergence detected on a fresh recovery routes straight to reconciliation,
    // never to a live re-drive.
    const divergedRecovery = await orchestrator.orchestrateRecovery({
      executionId: "exec-replay-2",
      recoveryWorkerId: "worker-recovery",
      ownerEpoch: 2,
      executionStatus: "REPLAYING",
      failureCategory: "REPLAY_DIVERGENCE"
    });
    divergedRecovery.release();

    const { ok, thresholds } = evaluateThresholds({
      replayRecoverAdmitted: { observed: replay.decision === "REPLAY_RECOVER" ? 1 : 0, required: "== 1 (REPLAY_RECOVER)", predicate: (v) => v === 1 },
      divergenceLeakPrevented: { observed: leakBlocked ? 1 : 0, required: "== 1 (REC5 blocks completing a diverged replay)", predicate: (v) => v === 1 },
      divergedRoutesToReconcile: { observed: divergedRecovery.decision === "RECONCILE" ? 1 : 0, required: "== 1 (RECONCILE)", predicate: (v) => v === 1 }
    });
    expect(ok).toBe(true);
    await recordPhase("recovery.R3.replayRecoveryDivergence", { ok, metrics: { leakBlocked, divergedDecision: divergedRecovery.decision }, thresholds, durationMs: Date.now() - t0 });
  });
});

describe("Recovery R.4 — concurrent takeover attempts", () => {
  it("elects a single recovery owner that repels all stale challengers (REC1/REC4/REC8)", async () => {
    const t0 = Date.now();
    // High throttle ceiling so arbitration — not backpressure — decides the winner.
    const { orchestrator, store } = makeOrchestrator({ maxConcurrentRecoveries: 100, stormSoftLimit: 1_000, stormHardLimit: 10_000 });

    // 16 contending recovery workers, each at a distinct durable lease epoch,
    // race to recover the SAME execution. Monotonic-epoch arbitration must leave
    // exactly one owner; no lower epoch may ever overwrite a higher one.
    const epochs = Array.from({ length: 16 }, (_, i) => i + 1);
    const { results, errors } = await fanOut(epochs.length, (i) =>
      orchestrator.orchestrateRecovery({
        executionId: "exec-takeover",
        recoveryWorkerId: `worker-${epochs[i]}`,
        ownerEpoch: epochs[i]!,
        executionStatus: "RUNNING"
      })
    );
    for (const r of results) (r as OrchestrateRecoveryResult).release();

    const finalRecord = await store.get("exec-takeover");
    const finalEpoch = finalRecord?.ownerEpoch ?? -1;

    // Every epoch strictly below the elected owner must now be rejected — proof
    // the single elected owner is stable and serialized (REC1/REC4).
    let staleRejected = 0;
    let staleProbed = 0;
    for (const epoch of epochs.filter((e) => e < finalEpoch)) {
      staleProbed++;
      const probe = await orchestrator.orchestrateRecovery({
        executionId: "exec-takeover",
        recoveryWorkerId: `zombie-${epoch}`,
        ownerEpoch: epoch,
        executionStatus: "RUNNING"
      });
      probe.release();
      if (probe.decision === "ALREADY_OWNED" && probe.record?.ownerEpoch === finalEpoch) staleRejected++;
    }

    // A strictly-higher epoch (a legitimate later failover) can still take over —
    // arbitration keeps electing exactly one winner as epochs advance.
    const higher = await orchestrator.orchestrateRecovery({
      executionId: "exec-takeover",
      recoveryWorkerId: "worker-failover",
      ownerEpoch: finalEpoch + 1,
      executionStatus: "RUNNING"
    });
    higher.release();

    const { ok, thresholds } = evaluateThresholds({
      ownerIsContender: { observed: epochs.includes(finalEpoch) ? 1 : 0, required: "== 1 (winner is one of the contenders)", predicate: (v) => v === 1 },
      noArbitrationCorruption: { observed: errors.length, required: "== 0 (no impossible same-epoch conflict)", predicate: (v) => v === 0 },
      allStaleChallengersRejected: { observed: staleProbed - staleRejected, required: "== 0 (every lower epoch surrenders)", predicate: (v) => v === 0 },
      higherEpochTakesOver: { observed: (higher.record?.ownerEpoch ?? -1) - finalEpoch, required: "== 1 (failover advances ownership)", predicate: (v) => v === 1 }
    });
    expect(ok).toBe(true);
    await recordPhase("recovery.R4.concurrentTakeover", { ok, metrics: { electedEpoch: finalEpoch, staleRejected, staleProbed, contenders: epochs.length }, thresholds, durationMs: Date.now() - t0 });
  });
});

describe("Recovery R.5 — recovery retry storms", () => {
  it("sheds a recovery storm and bounds amplification (REC7)", async () => {
    const t0 = Date.now();
    const { orchestrator } = makeOrchestrator({ stormSoftLimit: 5, stormHardLimit: 50, stormWindowMs: 600_000, maxConcurrentRecoveries: 1_000 });

    let admitted = 0;
    let blocked = 0;
    // 20 strictly-increasing-epoch recovery requests for ONE execution inside a
    // single storm window. The soft ceiling sheds the surplus to BLOCKED.
    for (let epoch = 2; epoch <= 21; epoch++) {
      const r = await orchestrator.orchestrateRecovery({ executionId: "exec-storm", recoveryWorkerId: "w", ownerEpoch: epoch, executionStatus: "RUNNING" });
      if (r.decision === "RECOVER") admitted++;
      else if (r.decision === "BLOCKED") blocked++;
      r.release();
    }

    const { ok, thresholds } = evaluateThresholds({
      amplificationBounded: { observed: admitted, required: "<= 5 (soft ceiling)", predicate: (v) => v <= 5 },
      surplusShed: { observed: blocked, required: ">= 1 (storm shedding engaged)", predicate: (v) => v >= 1 },
      accountedFor: { observed: admitted + blocked, required: "== 20", predicate: (v) => v === 20 }
    });
    expect(ok).toBe(true);
    await recordPhase("recovery.R5.recoveryRetryStorm", { ok, metrics: { admitted, blocked }, thresholds, durationMs: Date.now() - t0 });
  });

  it("fails closed on a hard storm breach (amplification bug) — REC7 asserts", async () => {
    const t0 = Date.now();
    const { orchestrator } = makeOrchestrator({ stormSoftLimit: 2, stormHardLimit: 4, stormWindowMs: 600_000, maxConcurrentRecoveries: 1_000 });

    let threw = false;
    try {
      for (let epoch = 2; epoch <= 12; epoch++) {
        const r = await orchestrator.orchestrateRecovery({ executionId: "exec-hardstorm", recoveryWorkerId: "w", ownerEpoch: epoch, executionStatus: "RUNNING" });
        r.release();
      }
    } catch (err) {
      threw = err instanceof InvariantViolation;
    }

    const { ok, thresholds } = evaluateThresholds({
      hardBreachFailsClosed: { observed: threw ? 1 : 0, required: "== 1 (REC7 InvariantViolation on hard breach)", predicate: (v) => v === 1 }
    });
    expect(ok).toBe(true);
    await recordPhase("recovery.R5.hardStormFailClosed", { ok, metrics: { threw }, thresholds, durationMs: Date.now() - t0 });
  });
});

describe("Recovery R.6 — ambiguity escalation", () => {
  it("never re-drives an ambiguous commit without reconciliation, then settles a COMMITTED verdict (REC3)", async () => {
    const t0 = Date.now();
    const { orchestrator } = makeOrchestrator();

    // Ambiguous external commit reclaimed for recovery — quarantined.
    const first = await orchestrator.orchestrateRecovery({
      executionId: "exec-ambiguous",
      recoveryWorkerId: "worker-recovery",
      ownerEpoch: 2,
      executionStatus: "AMBIGUOUS",
      failureCategory: "AMBIGUOUS_EXTERNAL_COMMIT"
    });
    first.release();

    // A higher-epoch takeover STILL cannot re-drive it — reconciliation is the
    // only legal exit, so the takeover re-classifies to RECONCILE, not RECOVER.
    const takeover = await orchestrator.orchestrateRecovery({
      executionId: "exec-ambiguous",
      recoveryWorkerId: "worker-other",
      ownerEpoch: 3,
      executionStatus: "AMBIGUOUS",
      failureCategory: "AMBIGUOUS_EXTERNAL_COMMIT"
    });
    takeover.release();

    // Reconciliation verifies the effect DID commit — outcome stands, no double-fire.
    const settled = await orchestrator.resolveReconciliation({
      executionId: "exec-ambiguous",
      workerId: "worker-other",
      ownerEpoch: 3,
      resolution: { verdict: "COMMITTED" }
    });

    const { ok, thresholds } = evaluateThresholds({
      quarantinedFirst: { observed: first.decision === "RECONCILE" ? 1 : 0, required: "== 1 (RECONCILE)", predicate: (v) => v === 1 },
      takeoverCannotBypass: { observed: takeover.decision === "RECONCILE" ? 1 : 0, required: "== 1 (never RECOVER)", predicate: (v) => v === 1 },
      committedSettles: { observed: settled?.state === "RECOVERY_COMPLETED" ? 1 : 0, required: "== 1 (RECOVERY_COMPLETED)", predicate: (v) => v === 1 }
    });
    expect(ok).toBe(true);
    await recordPhase("recovery.R6.ambiguityEscalation", { ok, metrics: { first: first.decision, takeover: takeover.decision, settled: settled?.state ?? "none" }, thresholds, durationMs: Date.now() - t0 });
  });
});
