import { describe, expect, it } from "vitest";
import pino from "pino";
import { SystemClock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { InMemoryEventBus } from "../src/infrastructure/events/inMemoryEventBus.js";
import { PersistedEventPublisher } from "../src/infrastructure/events/persistedEventPublisher.js";
import { InMemoryEventStore } from "../src/infrastructure/persistence/inMemoryStores.js";
import { LeaseHeartbeatWorker } from "../src/infrastructure/cluster/leaseHeartbeatWorker.js";
import type { ExecutionLease } from "../src/domain/cluster.js";
import type { AcquireLeaseInput, LeaseStore } from "../src/domain/clusterPorts.js";

/**
 * Heartbeat-driven lease-loss notification.
 *
 * Today renewOne() handles renewal failure by deleting the tracked entry
 * and logging a warning — nothing downstream learns about it. That's why
 * the worker loop can't proactively abort a long-running model call when
 * its lease was revoked.
 *
 * These tests pin the new addLeaseLostListener API:
 *   (a) Renewal returned undefined (true loss) → listeners fire once.
 *   (b) Renewal threw (transient db error) → listeners do NOT fire; the
 *       existing log-and-retry behavior must be preserved.
 *   (c) Multiple listeners → all receive the notification.
 *   (d) Deregister → removed listener no longer receives notifications.
 */

/**
 * LeaseStore stub controllable per call. Exposes hooks so the test can
 * decide renew() outcomes (return value or thrown error) and observe
 * whatever was passed in.
 */
class StubLeaseStore implements LeaseStore {
  renewBehavior: "ok" | "rejected" | "throw" = "ok";

  async acquire(input: AcquireLeaseInput): Promise<ExecutionLease | undefined> {
    return {
      executionId: input.executionId,
      workerId: input.workerId,
      acquiredAt: input.now.toISOString(),
      renewedAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString(),
      status: "ACTIVE",
      attempt: 1
    };
  }

  async renew(executionId: string, workerId: string, now: Date, ttlMs: number): Promise<ExecutionLease | undefined> {
    switch (this.renewBehavior) {
      case "ok":
        return {
          executionId,
          workerId,
          acquiredAt: now.toISOString(),
          renewedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
          status: "ACTIVE",
          attempt: 1
        };
      case "rejected":
        return undefined;
      case "throw":
        throw new Error("simulated db outage during renewal");
    }
  }

  async release(): Promise<ExecutionLease | undefined> { return undefined; }
  async reclaimExpired(): Promise<ExecutionLease[]> { return []; }
  async reclaimByWorker(): Promise<ExecutionLease[]> { return []; }
  async getByExecution(): Promise<ExecutionLease | undefined> { return undefined; }
  async listActive(): Promise<ExecutionLease[]> { return []; }
  async validateFencing(): Promise<boolean> { return true; }
}

function buildHeartbeat(leases: StubLeaseStore): LeaseHeartbeatWorker {
  const clock = new SystemClock();
  const logger = pino({ level: "silent" });
  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "heartbeat-test");

  // Tight renewal window so any tracked lease is "due for renewal" immediately.
  // leaseTtlMs=100ms with renewThresholdFactor=0.9 means we renew when
  // remainingMs <= 90ms, i.e., almost always.
  return new LeaseHeartbeatWorker(leases, publisher, eventFactory, clock, logger, {
    workerId: "worker-heartbeat-test",
    leaseTtlMs: 100,
    renewThresholdFactor: 0.9,
    pollIntervalMs: 60_000
  });
}

/**
 * leaseFor creates a tracked lease with remainingMs well inside the
 * heartbeat's renewal window (leaseTtlMs=100 × renewThresholdFactor=0.9
 * → renewWindow=90ms). Default remainingMs=50 guarantees the next tick()
 * will attempt renewal, exercising the rejected-renewal branch we care
 * about. The lease.expiresAt is also still in the future so the
 * already-expired branch is not accidentally triggered.
 */
function leaseFor(executionId: string, remainingMs = 50): ExecutionLease {
  const now = new Date();
  return {
    executionId,
    workerId: "worker-heartbeat-test",
    acquiredAt: now.toISOString(),
    renewedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + remainingMs).toISOString(),
    status: "ACTIVE",
    attempt: 1
  };
}

describe("LeaseHeartbeatWorker.addLeaseLostListener", () => {
  it("(a) renewal rejected → registered listener fires exactly once with the lost executionId", async () => {
    const leases = new StubLeaseStore();
    const heartbeat = buildHeartbeat(leases);
    const lost: string[] = [];
    heartbeat.addLeaseLostListener((executionId) => lost.push(executionId));

    heartbeat.track("exec-A", leaseFor("exec-A"));
    leases.renewBehavior = "rejected";
    await heartbeat.tick();

    expect(lost).toEqual(["exec-A"]);
  });

  it("(b) renewal throws → listeners do NOT fire (log-and-retry preserved)", async () => {
    const leases = new StubLeaseStore();
    const heartbeat = buildHeartbeat(leases);
    const lost: string[] = [];
    heartbeat.addLeaseLostListener((executionId) => lost.push(executionId));

    heartbeat.track("exec-B", leaseFor("exec-B"));
    leases.renewBehavior = "throw";
    await heartbeat.tick();

    // Listener must NOT have fired — transient db errors are recoverable.
    expect(lost).toEqual([]);
    // The lease must remain tracked so the next tick can retry.
    expect(heartbeat.trackedCount()).toBe(1);
  });

  it("(c) multiple listeners → all receive the notification, one listener throwing does not block others", async () => {
    const leases = new StubLeaseStore();
    const heartbeat = buildHeartbeat(leases);
    const calls: string[] = [];

    heartbeat.addLeaseLostListener((id) => calls.push(`A:${id}`));
    heartbeat.addLeaseLostListener(() => {
      throw new Error("listener B blew up");
    });
    heartbeat.addLeaseLostListener((id) => calls.push(`C:${id}`));

    heartbeat.track("exec-C", leaseFor("exec-C"));
    leases.renewBehavior = "rejected";
    await heartbeat.tick();

    // Both well-behaved listeners must have fired even though B threw.
    expect(calls).toContain("A:exec-C");
    expect(calls).toContain("C:exec-C");
  });

  it("(d) deregister via returned dispose function → listener no longer fires", async () => {
    const leases = new StubLeaseStore();
    const heartbeat = buildHeartbeat(leases);
    const lost: string[] = [];

    const dispose = heartbeat.addLeaseLostListener((id) => lost.push(id));

    heartbeat.track("exec-D1", leaseFor("exec-D1"));
    leases.renewBehavior = "rejected";
    await heartbeat.tick();
    expect(lost).toEqual(["exec-D1"]);

    // Deregister. A subsequent loss must NOT fire the disposed listener.
    dispose();
    heartbeat.track("exec-D2", leaseFor("exec-D2"));
    leases.renewBehavior = "rejected";
    await heartbeat.tick();

    expect(lost).toEqual(["exec-D1"]); // unchanged
  });
});
