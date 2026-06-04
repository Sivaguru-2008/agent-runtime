import { describe, it, expect } from "vitest";
import { InMemoryExecutionRepository } from "../../src/infrastructure/persistence/inMemoryStores.js";
import { InMemoryLeaseStore } from "../../src/infrastructure/cluster/inMemoryClusterStores.js";
import { SystemClock } from "../../src/shared/clock.js";
import {
  reconcileOrphanedExecutions,
  ORPHANED_ON_RESTART_CODE
} from "../../src/runtime/recovery/orphanReconciler.js";
import type { Execution } from "../../src/domain/model.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
} as any;

function makeExecution(over: Partial<Execution> & Pick<Execution, "id">): Execution {
  const now = new Date().toISOString();
  return {
    agentId: "agent-1",
    status: "RUNNING",
    input: { prompt: "x" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    ...over
  };
}

describe("reclaimExpired re-surfaces stranded EXPIRED leases (recovery crash-resilience)", () => {
  it("returns an already-EXPIRED lease again so a stranded recovery is re-driven", async () => {
    const leases = new InMemoryLeaseStore();
    const now = new Date("2026-05-31T00:00:00.000Z");
    await leases.acquire({ executionId: "exec-1", workerId: "w1", ttlMs: 100, now });

    const later = new Date(now.getTime() + 60_000);

    // First sweep: LEASED → EXPIRED, returned for recovery.
    const first = await leases.reclaimExpired(later);
    expect(first.map((l) => l.executionId)).toEqual(["exec-1"]);
    expect((await leases.getByExecution("exec-1"))!.status).toBe("EXPIRED");

    // Simulate a crash BEFORE takeoverRecovery ran: the lease is left at EXPIRED.
    // A second sweep MUST re-surface it (pre-fix it was dropped forever).
    const second = await leases.reclaimExpired(later);
    expect(second.map((l) => l.executionId)).toEqual(["exec-1"]);
  });

  it("does NOT re-surface a lease whose recovery moved it forward (future expiry)", async () => {
    const leases = new InMemoryLeaseStore();
    const now = new Date("2026-05-31T00:00:00.000Z");
    await leases.acquire({ executionId: "exec-2", workerId: "w1", ttlMs: 100, now });
    const later = new Date(now.getTime() + 60_000);

    await leases.reclaimExpired(later); // → EXPIRED
    // takeoverRecovery moves EXPIRED → RECOVERY_OWNED with a fresh future TTL.
    await leases.takeoverRecovery("exec-2", "w2", later, 30_000);

    // Now within the new TTL, the lease is no longer expired → not re-surfaced.
    const again = await leases.reclaimExpired(new Date(later.getTime() + 1_000));
    expect(again.map((l) => l.executionId)).not.toContain("exec-2");
  });
});

describe("reconcileOrphanedExecutions — leaseless cognition orphans", () => {
  it("finalizes a leaseless RUNNING execution as FAILED", async () => {
    const executions = new InMemoryExecutionRepository();
    const leases = new InMemoryLeaseStore();
    await executions.save(makeExecution({ id: "orphan-1" }));

    const summary = await reconcileOrphanedExecutions({
      executions,
      leases,
      clock: new SystemClock(),
      logger: silentLogger
    });

    expect(summary.finalized).toBe(1);
    expect(summary.finalizedIds).toEqual(["orphan-1"]);
    const after = await executions.getById("orphan-1");
    expect(after!.status).toBe("FAILED");
    expect(after!.failure?.code).toBe(ORPHANED_ON_RESTART_CODE);
    expect(after!.failure?.recoverable).toBe(false);
    expect(after!.completedAt).toBeDefined();
  });

  it("leaves a RUNNING execution that HOLDS a lease untouched (durable recovery owns it)", async () => {
    const executions = new InMemoryExecutionRepository();
    const leases = new InMemoryLeaseStore();
    await executions.save(makeExecution({ id: "durable-1" }));
    const now = new Date();
    await leases.acquire({ executionId: "durable-1", workerId: "w1", ttlMs: 1, now });
    // Expire + reclaim so the lease sits at EXPIRED — still a lease row, so the
    // reconciler must skip it (lease-based recovery re-drives it instead).
    await leases.reclaimExpired(new Date(now.getTime() + 60_000));
    expect((await leases.getByExecution("durable-1"))!.status).toBe("EXPIRED");

    const summary = await reconcileOrphanedExecutions({
      executions,
      leases,
      clock: new SystemClock(),
      logger: silentLogger
    });

    expect(summary.finalized).toBe(0);
    expect((await executions.getById("durable-1"))!.status).toBe("RUNNING");
  });

  it("ignores terminal executions", async () => {
    const executions = new InMemoryExecutionRepository();
    const leases = new InMemoryLeaseStore();
    await executions.save(makeExecution({ id: "done-1", status: "COMPLETED" }));
    await executions.save(makeExecution({ id: "failed-1", status: "FAILED" }));

    const summary = await reconcileOrphanedExecutions({
      executions,
      leases,
      clock: new SystemClock(),
      logger: silentLogger
    });

    expect(summary.scanned).toBe(0);
    expect(summary.finalized).toBe(0);
  });
});
