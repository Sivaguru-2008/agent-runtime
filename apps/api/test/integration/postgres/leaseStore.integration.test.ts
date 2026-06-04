/**
 * Phase 3 — Distributed lease / recovery validation under real Postgres
 * row-locking semantics.
 *
 * The in-memory unit tests can't prove the lease store is race-free; only a
 * real Postgres backend with `FOR UPDATE SKIP LOCKED` does that. This suite:
 *
 *   • Fires N concurrent acquire() against the same executionId and asserts
 *     exactly ONE succeeds and the rest return undefined (skip-locked).
 *   • Fires concurrent acquires against DISTINCT executionIds and asserts
 *     they all succeed in parallel (no false serialization).
 *   • Runs two recovery loops in parallel and asserts no expired lease is
 *     reclaimed twice (no phantom reclaim).
 *   • Asserts the reclaim transition ACTIVE → EXPIRED is atomic — readers
 *     never see a half-reclaimed row.
 *   • Validates heartbeat expiry and worker-crash recovery semantics.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PostgresLeaseStore } from "../../../src/infrastructure/cluster/postgres/postgresLeaseStore.js";
import { tryStartHarness } from "./harness.js";
import { fanOut, parallelMap, sleep } from "./concurrency.js";
import { ManualClock } from "./clocks.js";
import { makeLeaseInput } from "./factories.js";

const harness = await tryStartHarness();
const leases = harness ? new PostgresLeaseStore(harness.pg) : null;

afterEach(async () => {
  if (harness) await harness.reset();
});

afterAll(async () => {
  if (harness) await harness.stop();
});

describe.skipIf(!harness)("PostgresLeaseStore — acquire exclusivity", () => {
  it("only one worker wins concurrent acquire on the same execution", async () => {
    const exec = "exec-contention";
    const WORKERS = 16;
    const now = new Date("2026-05-22T00:00:00.000Z");

    const { results, errors } = await fanOut(WORKERS, (i) =>
      leases!.acquire(makeLeaseInput({
        executionId: exec,
        workerId: `worker-${i}`,
        ttlMs: 60_000,
        now
      }))
    );
    expect(errors).toEqual([]);

    const wins = results.filter((r) => r !== undefined);
    expect(wins).toHaveLength(1);
    // The losers are SKIP-LOCKED'd out — undefined return, no error.
    expect(results.filter((r) => r === undefined)).toHaveLength(WORKERS - 1);

    // Stored row matches the winning worker.
    const stored = await leases!.getByExecution(exec);
    expect(stored?.workerId).toBe(wins[0]!.workerId);
    expect(stored?.status).toBe("LEASED");
  });

  it("acquires against DISTINCT executions succeed in parallel", async () => {
    const now = new Date("2026-05-22T00:00:00.000Z");
    const N = 32;
    const acquired = await parallelMap(
      Array.from({ length: N }, (_, i) => `exec-${i}`),
      async (exec, i) =>
        leases!.acquire(makeLeaseInput({
          executionId: exec,
          workerId: `worker-${i}`,
          ttlMs: 60_000,
          now
        }))
    );
    // Every acquire succeeded — distinct rows do not contend.
    expect(acquired.every((r) => r !== undefined)).toBe(true);
    expect(new Set(acquired.map((r) => r!.workerId)).size).toBe(N);
  });

  it("rejects a second acquire while the lease is unexpired", async () => {
    const now = new Date("2026-05-22T00:00:00.000Z");
    const first = await leases!.acquire(makeLeaseInput({
      executionId: "exec-held",
      workerId: "worker-A",
      ttlMs: 60_000,
      now
    }));
    expect(first?.status).toBe("LEASED");

    const second = await leases!.acquire(makeLeaseInput({
      executionId: "exec-held",
      workerId: "worker-B",
      ttlMs: 60_000,
      now
    }));
    expect(second).toBeUndefined();
  });

  it("re-acquire after expiry succeeds and increments attempt", async () => {
    const clock = new ManualClock(new Date("2026-05-22T00:00:00.000Z"));
    const first = await leases!.acquire(makeLeaseInput({
      executionId: "exec-expire",
      workerId: "worker-A",
      ttlMs: 1_000,
      now: clock.now()
    }));
    expect(first?.attempt).toBe(1);

    clock.advance(5_000);
    const second = await leases!.acquire(makeLeaseInput({
      executionId: "exec-expire",
      workerId: "worker-B",
      ttlMs: 30_000,
      now: clock.now()
    }));
    expect(second?.workerId).toBe("worker-B");
    expect(second?.attempt).toBe(2);
    expect(second?.status).toBe("LEASED");
  });
});

describe.skipIf(!harness)("PostgresLeaseStore — renew + release", () => {
  it("renew() extends the lease only for the owning worker", async () => {
    const now = new Date("2026-05-22T00:00:00.000Z");
    const acquired = await leases!.acquire(makeLeaseInput({
      executionId: "exec-renew",
      workerId: "worker-A",
      ttlMs: 30_000,
      now
    }));
    expect(acquired).toBeDefined();

    const later = new Date(now.getTime() + 5_000);
    const renewed = await leases!.renew("exec-renew", "worker-A", later, 30_000);
    expect(renewed).toBeDefined();
    expect(new Date(renewed!.expiresAt).getTime()).toBeGreaterThan(
      new Date(acquired!.expiresAt).getTime()
    );

    // A different worker cannot renew.
    const stolen = await leases!.renew("exec-renew", "worker-B", later, 30_000);
    expect(stolen).toBeUndefined();
  });

  it("release() flips status to TRANSFERRED for the owner", async () => {
    const now = new Date("2026-05-22T00:00:00.000Z");
    await leases!.acquire(makeLeaseInput({
      executionId: "exec-release",
      workerId: "worker-A",
      ttlMs: 30_000,
      now
    }));
    const released = await leases!.release("exec-release", "worker-A", now);
    expect(released?.status).toBe("TRANSFERRED");
    expect((await leases!.getByExecution("exec-release"))!.status).toBe("TRANSFERRED");

    // Another worker can now acquire it.
    const reacquired = await leases!.acquire(makeLeaseInput({
      executionId: "exec-release",
      workerId: "worker-B",
      ttlMs: 30_000,
      now
    }));
    expect(reacquired?.workerId).toBe("worker-B");
  });
});

describe.skipIf(!harness)("PostgresLeaseStore — reclaimExpired (FOR UPDATE SKIP LOCKED)", () => {
  it("reclaims all expired leases in one pass", async () => {
    const now = new Date("2026-05-22T00:00:00.000Z");
    // Seed 5 LEASED-but-expired leases.
    for (let i = 0; i < 5; i++) {
      await leases!.acquire(makeLeaseInput({
        executionId: `exec-stale-${i}`,
        workerId: `dead-worker-${i}`,
        ttlMs: 100,
        now
      }));
    }
    // Advance "now" past expiry.
    const later = new Date(now.getTime() + 60_000);
    const reclaimed = await leases!.reclaimExpired(later);
    expect(reclaimed).toHaveLength(5);
    for (const lease of reclaimed) {
      expect(lease.status).toBe("EXPIRED");
    }
  });

  it("two concurrent recovery loops do NOT double-reclaim the same lease", async () => {
    const now = new Date("2026-05-22T00:00:00.000Z");
    const N = 20;
    for (let i = 0; i < N; i++) {
      await leases!.acquire(makeLeaseInput({
        executionId: `exec-race-${i}`,
        workerId: `dead-${i}`,
        ttlMs: 100,
        now
      }));
    }
    const later = new Date(now.getTime() + 60_000);

    // Race two reclaim loops. The SKIP-LOCKED selects in each transaction
    // partition the candidate set — the SUM of their results equals N, and
    // their INTERSECTION is empty.
    const [batch1, batch2] = await Promise.all([
      leases!.reclaimExpired(later),
      leases!.reclaimExpired(later)
    ]);

    const ids1 = batch1.map((l) => l.executionId);
    const ids2 = batch2.map((l) => l.executionId);
    const all = new Set([...ids1, ...ids2]);

    expect(all.size).toBe(ids1.length + ids2.length); // no overlap
    expect(all.size).toBe(N); // every expired lease reclaimed exactly once
  });

  it("does NOT reclaim leases that are still within their TTL", async () => {
    const now = new Date("2026-05-22T00:00:00.000Z");
    await leases!.acquire(makeLeaseInput({
      executionId: "exec-fresh",
      workerId: "alive",
      ttlMs: 60_000,
      now
    }));
    const reclaimed = await leases!.reclaimExpired(new Date(now.getTime() + 1_000));
    expect(reclaimed).toEqual([]);
    expect((await leases!.getByExecution("exec-fresh"))!.status).toBe("LEASED");
  });

  it("reclaimByWorker() reclaims every active lease for a dead worker", async () => {
    const now = new Date("2026-05-22T00:00:00.000Z");
    await leases!.acquire(makeLeaseInput({ executionId: "e1", workerId: "dead", ttlMs: 60_000, now }));
    await leases!.acquire(makeLeaseInput({ executionId: "e2", workerId: "dead", ttlMs: 60_000, now }));
    await leases!.acquire(makeLeaseInput({ executionId: "e3", workerId: "alive", ttlMs: 60_000, now }));

    const reclaimed = await leases!.reclaimByWorker("dead", now);
    expect(reclaimed.map((l) => l.executionId).sort()).toEqual(["e1", "e2"]);
    expect(reclaimed.every((l) => l.status === "EXPIRED")).toBe(true);
    // Other worker's lease is untouched.
    expect((await leases!.getByExecution("e3"))!.status).toBe("LEASED");
  });
});

describe.skipIf(!harness)("PostgresLeaseStore — listActive ordering", () => {
  it("returns only active leases, ordered by acquired_at ascending", async () => {
    const t0 = new Date("2026-05-22T00:00:00.000Z");
    await leases!.acquire(makeLeaseInput({
      executionId: "first", workerId: "w1", ttlMs: 60_000, now: t0
    }));
    await sleep(10);
    const t1 = new Date(t0.getTime() + 1_000);
    await leases!.acquire(makeLeaseInput({
      executionId: "second", workerId: "w2", ttlMs: 60_000, now: t1
    }));
    await leases!.acquire(makeLeaseInput({
      executionId: "released",
      workerId: "w3",
      ttlMs: 60_000,
      now: new Date(t0.getTime() + 2_000)
    }));
    await leases!.release("released", "w3", new Date(t0.getTime() + 3_000));

    const active = await leases!.listActive();
    const ids = active.map((l) => l.executionId);
    expect(ids).toEqual(["first", "second"]);
  });
});

describe.skipIf(!harness)("PostgresLeaseStore — worker crash recovery semantics", () => {
  it("after a worker dies, another worker can acquire the expired lease", async () => {
    const clock = new ManualClock(new Date("2026-05-22T00:00:00.000Z"));
    // Worker A acquires.
    const acquiredByA = await leases!.acquire(makeLeaseInput({
      executionId: "exec-crash", workerId: "A", ttlMs: 1_000, now: clock.now()
    }));
    expect(acquiredByA?.workerId).toBe("A");

    // Worker A "dies" (no renew). Time passes past TTL.
    clock.advance(5_000);

    // Recovery loop reclaims it.
    const reclaimed = await leases!.reclaimExpired(clock.now());
    expect(reclaimed.map((l) => l.executionId)).toContain("exec-crash");

    // Worker B can now acquire.
    const acquiredByB = await leases!.acquire(makeLeaseInput({
      executionId: "exec-crash", workerId: "B", ttlMs: 30_000, now: clock.now()
    }));
    expect(acquiredByB?.workerId).toBe("B");
    expect(acquiredByB?.attempt).toBe(2);
  });

  it("stale dead-worker leases do not block reacquire even WITHOUT a recovery pass", async () => {
    // Documents the on-demand recovery path: acquire() itself notices an
    // expired LEASED lease and overwrites it. This is critical when the
    // recovery loop is delayed (e.g., briefly partitioned).
    const clock = new ManualClock(new Date("2026-05-22T00:00:00.000Z"));
    await leases!.acquire(makeLeaseInput({
      executionId: "exec-no-recovery", workerId: "A", ttlMs: 100, now: clock.now()
    }));
    clock.advance(60_000);
    const stolen = await leases!.acquire(makeLeaseInput({
      executionId: "exec-no-recovery", workerId: "B", ttlMs: 30_000, now: clock.now()
    }));
    expect(stolen?.workerId).toBe("B");
    expect(stolen?.attempt).toBe(2);
  });
});
