/**
 * PHASE 2 ADVERSARIAL AUDIT — Docker-free guarantee probes.
 *
 * These tests attack guarantees that do NOT need Postgres:
 *   • Circuit breaker CLOSED → OPEN → HALF_OPEN → CLOSED / re-OPEN transitions.
 *   • Circuit breaker HALF_OPEN probe-concurrency (documented "one probe" vs.
 *     actual behavior).
 *   • LeaseHeartbeatWorker self-fences (fires onLeaseLost) once a tracked
 *     lease's expiresAt lapses, even when every renew() call throws (sustained
 *     Postgres partition).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import { CircuitBreaker } from "../../src/infrastructure/reliability/circuitBreaker.js";
import { LeaseHeartbeatWorker } from "../../src/infrastructure/cluster/leaseHeartbeatWorker.js";
import type { LeaseStore } from "../../src/domain/clusterPorts.js";
import type { ExecutionLease } from "../../src/domain/cluster.js";

const silent = pino({ level: "silent" });

afterEach(() => {
  vi.useRealTimers();
});

describe("AUDIT: circuit breaker state machine", () => {
  it("CLOSED→OPEN after failureThreshold, fast-fails while OPEN, then HALF_OPEN→CLOSED on recovery", async () => {
    const transitions: Array<[string, string]> = [];
    const cb = new CircuitBreaker({
      name: "t",
      failureThreshold: 3,
      successThreshold: 2,
      recoveryTimeoutMs: 1000,
      onStateChange: (from, to) => transitions.push([from, to])
    });

    const boom = () => Promise.reject(new Error("dep down"));
    for (let i = 0; i < 3; i++) await cb.call(boom).catch(() => undefined);
    expect(cb.getState()).toBe("OPEN");

    // While OPEN: fast-fail without invoking fn.
    let invoked = false;
    await cb.call(async () => { invoked = true; return 1; }).catch(() => undefined);
    expect(invoked).toBe(false);

    // After recovery window: next call probes (HALF_OPEN), success counts.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1001);
    await cb.call(async () => 1); // probe 1 → HALF_OPEN, success
    expect(cb.getState()).toBe("HALF_OPEN");
    await cb.call(async () => 1); // probe 2 → reaches successThreshold → CLOSED
    expect(cb.getState()).toBe("CLOSED");

    expect(transitions).toContainEqual(["CLOSED", "OPEN"]);
    expect(transitions).toContainEqual(["OPEN", "HALF_OPEN"]);
    expect(transitions).toContainEqual(["HALF_OPEN", "CLOSED"]);
  });

  it("HALF_OPEN→OPEN immediately on a failed probe", async () => {
    const cb = new CircuitBreaker({ name: "t2", failureThreshold: 1, successThreshold: 2, recoveryTimeoutMs: 500 });
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => undefined);
    expect(cb.getState()).toBe("OPEN");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 501);
    await cb.call(() => Promise.reject(new Error("still down"))).catch(() => undefined);
    expect(cb.getState()).toBe("OPEN");
  });

  it("OBSERVATION: HALF_OPEN does not bound probe concurrency (doc says 'one probe per window')", async () => {
    const cb = new CircuitBreaker({ name: "t3", failureThreshold: 1, successThreshold: 5, recoveryTimeoutMs: 100 });
    await cb.call(() => Promise.reject(new Error("x"))).catch(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 101);

    // Fire many concurrent calls the instant the window opens. A strict
    // single-probe breaker would let exactly one through. This one lets all
    // of them hit the dependency. Not a correctness blocker (per-worker,
    // in-memory) but a thundering-herd risk on a recovering dependency.
    let concurrentProbes = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        cb.call(async () => { concurrentProbes += 1; await Promise.resolve(); return 1; }).catch(() => undefined)
      )
    );
    expect(concurrentProbes).toBeGreaterThan(1); // documents the deviation
  });
});

describe("AUDIT: lease heartbeat self-fences under sustained renewal failure", () => {
  it("fires onLeaseLost once expiresAt lapses even if every renew() throws", async () => {
    const base = new Date("2026-05-30T00:00:00.000Z").getTime();
    let currentMs = base; // explicit, manually-advanced clock — no fake timers

    let renewAttempts = 0;
    const leases = {
      renew: async () => { renewAttempts += 1; throw new Error("ECONNREFUSED: postgres partitioned"); }
    } as unknown as LeaseStore;

    const publisher = { publish: async (e: unknown) => e } as any;
    const eventFactory = { create: (x: unknown) => x } as any;
    const clock = { now: () => new Date(currentMs) };

    const worker = new LeaseHeartbeatWorker(leases, publisher, eventFactory, clock as any, silent, {
      workerId: "w1",
      leaseTtlMs: 1000,
      renewThresholdFactor: 0.4,
      pollIntervalMs: 100
    });

    const lost: string[] = [];
    worker.addLeaseLostListener((id) => lost.push(id));

    const lease = { executionId: "exec-1", expiresAt: new Date(base + 1000).toISOString() } as ExecutionLease;
    worker.track("exec-1", lease);

    // Advance past the TTL while every renew throws. Once now >= expiresAt the
    // tick's remainingMs<=0 branch must fire onLeaseLost and stop tracking.
    for (let i = 0; i < 15; i++) {
      currentMs = base + (i + 1) * 100;
      await worker.tick();
    }

    expect(renewAttempts).toBeGreaterThan(0); // it really did try to renew
    expect(lost).toContain("exec-1"); // and self-fenced once the lease lapsed
    expect(worker.trackedCount()).toBe(0);
    worker.stop();
  });
});
