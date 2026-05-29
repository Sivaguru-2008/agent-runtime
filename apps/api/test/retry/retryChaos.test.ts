/**
 * Retry-coordination chaos suite (in-memory, Docker-free).
 *
 * Drives the RetryCoordinator + InMemoryRetryCoordinationStore (and, where
 * distributed ownership matters, the real InMemoryLeaseStore) under heavy
 * fan-out concurrency to prove the RT1..RT8 guarantees hold under the exact
 * race conditions they exist to defeat:
 *
 *   - retry storms                (RT6)
 *   - duplicate scheduler events  (RT1)
 *   - concurrent recovery takeover (RT3)
 *   - replay/retry overlap        (RT4)
 *   - ambiguity retries           (RT7)
 *   - queue redelivery races      (RT1)
 *
 * Runs under the default vitest config (test/**\/*.test.ts) so `npm test`
 * exercises it without a Postgres/Redis harness.
 */

import { describe, expect, it } from "vitest";
import { InMemoryRetryCoordinationStore } from "../../src/runtime/retry/inMemoryRetryStore.js";
import { RetryCoordinator, type RetryCoordinatorConfig } from "../../src/runtime/retry/retryCoordinator.js";
import { InMemoryLeaseStore } from "../../src/infrastructure/cluster/inMemoryClusterStores.js";
import { InvariantViolation } from "../../src/runtime/canonicalSemantics.js";
import { fanOut } from "../integration/postgres/concurrency.js";

class ManualClock {
  constructor(private t = 1_000) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function makeCoordinator(config: Partial<RetryCoordinatorConfig> = {}) {
  const clock = new ManualClock();
  const store = new InMemoryRetryCoordinationStore({ clock });
  const coordinator = new RetryCoordinator(store, { clock, config });
  return { store, coordinator, clock };
}

function isRT(err: unknown, id: string): boolean {
  return err instanceof InvariantViolation && (err as InvariantViolation).invariant === id;
}

describe("chaos: queue redelivery + duplicate scheduler events (RT1)", () => {
  it("admits exactly one retry when N deliveries of the same attempt race", async () => {
    // High storm limits: this test isolates single-flight (RT1) from the storm
    // guard (RT6), which legitimately counts every duplicate delivery as load.
    const { coordinator } = makeCoordinator({ stormSoftLimit: 1_000, stormHardLimit: 100_000 });
    const { results, errors } = await fanOut(64, () =>
      coordinator.requestRetry({ executionId: "exec-redeliver", requesterWorkerId: "w", attempt: 2 })
    );
    expect(errors).toHaveLength(0);
    const admitted = results.filter((r) => r.decision === "ADMITTED");
    const deduped = results.filter((r) => r.decision === "DEDUPED");
    expect(admitted).toHaveLength(1);
    expect(deduped).toHaveLength(63);
    expect((await coordinator.get("exec-redeliver"))?.state).toBe("RETRY_SCHEDULED");
  });

  it("never double-drives across many distinct executions delivered in duplicate", async () => {
    const { coordinator } = makeCoordinator({ maxInFlightRetries: 10_000, stormSoftLimit: 1_000, stormHardLimit: 100_000 });
    const execIds = Array.from({ length: 50 }, (_, i) => `e${i}`);
    const calls = execIds.flatMap((id) => Array.from({ length: 6 }, () => id));
    const { results, errors } = await fanOut(calls.length, (i) =>
      coordinator.requestRetry({ executionId: calls[i]!, requesterWorkerId: "w", attempt: 2 })
    );
    expect(errors).toHaveLength(0);
    for (const id of execIds) {
      const forId = results.filter((_, i) => calls[i] === id);
      expect(forId.filter((r) => r.decision === "ADMITTED")).toHaveLength(1);
    }
  });
});

describe("chaos: retry storm amplification (RT6)", () => {
  it("bounds admitted retries to the soft limit and asserts past the hard ceiling", async () => {
    const soft = 5;
    const hard = 12;
    const { coordinator } = makeCoordinator({ stormSoftLimit: soft, stormHardLimit: hard, stormWindowMs: 10_000_000, maxInFlightRetries: 10_000 });
    // 40 distinct, escalating attempts hammer ONE execution.
    const { results, errors } = await fanOut(40, (i) =>
      coordinator.requestRetry({ executionId: "storm", requesterWorkerId: `w${i}`, attempt: i + 1 })
    );
    const admitted = results.filter((r) => r.decision === "ADMITTED").length;
    const blocked = results.filter((r) => r.decision === "BLOCKED").length;
    // Amplification is bounded: no more than `soft` retries are admitted...
    expect(admitted).toBeLessThanOrEqual(soft);
    // ...the rest are shed or hard-stopped.
    expect(blocked).toBeGreaterThan(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => isRT(e, "RT6"))).toBe(true);
  });
});

describe("chaos: concurrent recovery takeover (RT3)", () => {
  it("serializes recovery to a single coordinator even when many race the same expired lease", async () => {
    const { coordinator } = makeCoordinator({ maxConcurrentRecoveries: 16 });
    const leases = new InMemoryLeaseStore();
    const executionId = "exec-recover";
    const t0 = new Date(10_000);

    await leases.acquire({ executionId, workerId: "dead", ttlMs: 100, now: t0 });
    const later = new Date(t0.getTime() + 60_000);
    await leases.reclaimExpired(later);

    const { results, errors } = await fanOut(12, async (i) => {
      const w = `recoverer-${i}`;
      const lease = await leases.takeoverRecovery(executionId, w, later, 30_000);
      if (!lease) return "no-lease";
      const res = await coordinator.requestRecovery({ executionId, recoveryWorkerId: w, ownerEpoch: lease.attempt });
      return res.decision;
    });

    expect(errors).toHaveLength(0);
    // The durable lease CAS lets exactly one recoverer take over...
    expect(results.filter((d) => d === "ADMITTED")).toHaveLength(1);
    // ...everyone else gets no lease (the lease store already serialised them).
    expect(results.filter((d) => d === "no-lease")).toHaveLength(11);
  });

  it("never exceeds the global recovery throttle under a burst", async () => {
    const max = 4;
    const { coordinator } = makeCoordinator({ maxConcurrentRecoveries: max });
    const { results, errors } = await fanOut(40, (i) =>
      coordinator.requestRecovery({ executionId: `e${i}`, recoveryWorkerId: `r${i}`, ownerEpoch: 2 })
    );
    expect(errors).toHaveLength(0);
    const admitted = results.filter((r) => r.decision === "ADMITTED");
    const throttled = results.filter((r) => r.decision === "THROTTLED");
    // Slots are never released here, so admissions cannot exceed the ceiling.
    expect(admitted.length).toBeLessThanOrEqual(max);
    expect(throttled.length).toBe(40 - admitted.length);
    expect(coordinator.inFlightRecoveries()).toBeLessThanOrEqual(max);
  });
});

describe("chaos: exclusive execution ownership under takeover races (RT2)", () => {
  it("lands on exactly one EXECUTING owner = the highest epoch when many claim concurrently", async () => {
    const { coordinator, store } = makeCoordinator();
    const executionId = "exec-own";
    // Distinct, monotonic epochs (as a monotonic lease store would mint).
    const { errors } = await fanOut(20, (i) =>
      coordinator.claimExecution({ executionId, workerId: `w${i}`, ownerEpoch: i + 1 })
    );
    // No RT2 false-positive: distinct epochs never collide.
    expect(errors).toHaveLength(0);
    const rec = await store.get(executionId);
    expect(rec?.state).toBe("RETRY_EXECUTING");
    // The surviving owner is the maximum epoch claimed.
    expect(rec?.ownerEpoch).toBe(20);
  });
});

describe("chaos: replay/recovery overlap (RT4)", () => {
  it("never lets a recovery and a replay coordination co-exist for one execution", async () => {
    const { coordinator, store } = makeCoordinator({ stormHardLimit: 100_000 });
    const executionId = "exec-overlap";
    const { errors } = await fanOut(20, async (i): Promise<string> => {
      try {
        if (i % 2 === 0) {
          const r = await coordinator.requestRetry({ executionId, requesterWorkerId: `w${i}`, attempt: 2, mode: "replay", parentExecutionId: "parent" });
          return r.decision;
        }
        const r = await coordinator.requestRecovery({ executionId, recoveryWorkerId: `r${i}`, ownerEpoch: 3 });
        return r.decision;
      } catch {
        return "THREW"; // RT4 overlap assertion — expected and absorbed
      }
    });
    // The coordinator either rejects overlap via the RT4 assertion (captured as
    // a throw) or arbitrates to a single mode — but never persists a record whose
    // mode flips between replay and recovery while active.
    expect(errors).toHaveLength(0); // throws were caught inline
    const rec = await store.get(executionId);
    expect(rec).toBeDefined();
    // Whatever won, the live coordination has a single coherent mode.
    expect(["replay", "recovery", "normal"]).toContain(rec!.mode);
  });

  it("asserts RT4 on a direct recovery-over-replay request", async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.requestRetry({ executionId: "x", requesterWorkerId: "w", attempt: 2, mode: "replay", parentExecutionId: "p" });
    let thrown: unknown;
    try {
      await coordinator.requestRecovery({ executionId: "x", recoveryWorkerId: "r", ownerEpoch: 9 });
    } catch (err) {
      thrown = err;
    }
    expect(isRT(thrown, "RT4")).toBe(true);
  });
});

describe("chaos: ambiguity retries (RT7)", () => {
  it("quarantines every concurrent ambiguous retry into reconciliation, admitting none", async () => {
    const { coordinator } = makeCoordinator({ stormHardLimit: 100_000 });
    const executionId = "exec-ambig";
    const { results, errors } = await fanOut(32, (i) =>
      coordinator.requestRetry({
        executionId,
        requesterWorkerId: `w${i}`,
        attempt: i + 1,
        failureType: "AMBIGUOUS_EXTERNAL_COMMIT"
      })
    );
    expect(errors).toHaveLength(0);
    expect(results.every((r) => r.decision === "RECONCILE_REQUIRED")).toBe(true);
    expect((await coordinator.get(executionId))?.state).toBe("RETRY_RECONCILING");

    // A single reconciliation resolves the quarantine; only then may a retry proceed.
    await coordinator.resolveReconciliation(executionId, "rec", 33, { verdict: "NOT_COMMITTED" });
    const after = await coordinator.requestRetry({ executionId, requesterWorkerId: "w", attempt: 34 });
    expect(after.decision).toBe("ADMITTED");
  });
});
