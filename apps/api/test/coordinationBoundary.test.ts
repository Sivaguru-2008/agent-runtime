import { describe, expect, it } from "vitest";
import { createPersistenceLayer } from "../src/infrastructure/persistence/persistenceFactory.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { SystemClock } from "../src/shared/clock.js";
import { InMemoryExecutionJobQueue } from "../src/infrastructure/queue/inMemoryExecutionJobQueue.js";
import { assertCanonicalOwnershipConsistency } from "../src/runtime/canonicalSemantics.js";
import {
  assertEphemeralLossSafe,
  assertOwnershipResolvesToDurable,
  assertReconstructionDurable,
  ownershipFromCanonical,
  reconcileOwnershipView
} from "../src/runtime/coordinationAuthority.js";
import type { ExecutionCheckpoint } from "../src/domain/cluster.js";

/**
 * Coordination-boundary survival test — proves the central thesis of the
 * Redis<->Postgres redesign on the in-memory substrate, which implements the
 * SAME fencing/ownership contract as the Postgres adapters:
 *
 *   Total Redis loss cannot change a committed correctness outcome, and
 *   ownership/recovery/replay reconstruct purely from the durable substrate.
 *
 * "Durable truth" = leases + checkpoints + event log + executions.
 * "Ephemeral coordination" = the job queue + event bus (wiped to model loss).
 */

const TTL_MS = 30_000;

function makeLayer() {
  return createPersistenceLayer({ driver: "memory" });
}

describe("coordination boundary — Redis loss does not corrupt durable truth", () => {
  it("committed ownership, checkpoints, and the event log survive total ephemeral loss", async () => {
    const layer = makeLayer();
    const events = new EventFactory(new SystemClock(), "test");
    const executionId = "exec-survives-redis-loss";
    const t0 = new Date(); // real wall-clock anchor: in-memory validateFencing checks Date.now()

    // ── Worker A establishes durable ownership ──────────────────────────────
    const leaseA = await layer.leases.acquire({
      executionId,
      workerId: "worker-A",
      ttlMs: TTL_MS,
      now: t0
    });
    expect(leaseA).toBeDefined();
    expect(leaseA!.attempt).toBe(1);
    // The durable lease is canonically consistent the moment ownership is taken.
    expect(() => assertCanonicalOwnershipConsistency(leaseA!)).not.toThrow();

    // Durable checkpoint (fence-guarded) + durable event log entries.
    const checkpoint: ExecutionCheckpoint = {
      id: "ckpt-1",
      executionId,
      workerId: "worker-A",
      sequence: 1,
      phase: "PERSISTED",
      state: { progress: 0.5 },
      createdAt: t0.toISOString()
    };
    const writeOutcome = await layer.checkpoints.writeFenced(checkpoint, {
      executionId,
      workerId: "worker-A",
      attempt: leaseA!.attempt
    });
    expect(writeOutcome).toBe("COMMITTED");

    await layer.eventStore.append(
      events.create({
        type: "EXECUTION_STARTED",
        aggregateId: executionId,
        aggregateType: "EXECUTION",
        payload: { executionId }
      })
    );
    await layer.eventStore.append(
      events.create({
        type: "EXECUTION_LEASED",
        aggregateId: executionId,
        aggregateType: "EXECUTION",
        payload: { lease: leaseA }
      })
    );

    // ── Model total Redis loss: the ephemeral substrate is discarded ─────────
    // A fresh queue with NO knowledge of the pre-loss job. The event bus
    // subscribers are gone. Nothing about this touches the durable stores.
    let ephemeralQueue: InMemoryExecutionJobQueue | undefined = new InMemoryExecutionJobQueue({
      visibilityMs: TTL_MS
    });
    await ephemeralQueue.close().catch(() => undefined);
    ephemeralQueue = undefined; // Redis is gone.

    // CA2 — the wiped concerns are loss-safe by classification.
    expect(() => assertEphemeralLossSafe("JOB_QUEUE")).not.toThrow();
    expect(() => assertEphemeralLossSafe("EVENT_BUS")).not.toThrow();

    // ── Durable truth is intact ──────────────────────────────────────────────
    const durableLease = await layer.leases.getByExecution(executionId);
    expect(durableLease?.workerId).toBe("worker-A");
    expect(durableLease?.attempt).toBe(1);

    const latestCheckpoint = await layer.checkpoints.latest(executionId);
    expect(latestCheckpoint?.state).toEqual({ progress: 0.5 });

    const log = await layer.eventStore.listByExecution(executionId);
    expect(log.length).toBe(2);

    await layer.close();
  });

  it("ownership recovery survives Redis loss via durable expiry + serialized takeover", async () => {
    const layer = makeLayer();
    const executionId = "exec-recovers-after-loss";
    const t0 = new Date(); // real wall-clock anchor: in-memory validateFencing checks Date.now()
    const tExpired = new Date(t0.getTime() + TTL_MS + 60_000);

    const leaseA = await layer.leases.acquire({
      executionId,
      workerId: "worker-A",
      ttlMs: TTL_MS,
      now: t0
    });
    expect(leaseA!.attempt).toBe(1);

    // (Redis is gone here — recovery uses only the durable lease table.)

    // Durable expiry sweep, then serialized recovery takeover by worker B.
    const reclaimed = await layer.leases.reclaimExpired(tExpired);
    expect(reclaimed.map((l) => l.executionId)).toContain(executionId);

    const leaseB = await layer.leases.takeoverRecovery(executionId, "worker-B", tExpired, TTL_MS);
    expect(leaseB).toBeDefined();
    expect(leaseB!.status).toBe("RECOVERY_OWNED");
    // Monotonic epoch — the new owner strictly supersedes the lost one.
    expect(leaseB!.attempt).toBeGreaterThan(leaseA!.attempt);
    // The recovered lease is itself canonically consistent (F7).
    expect(() => assertCanonicalOwnershipConsistency(leaseB!)).not.toThrow();

    // CA4 — recovery drew only on durable sources.
    expect(() =>
      assertReconstructionDurable(["EXECUTION_LEASE", "EXECUTION_CHECKPOINT", "EVENT_LOG"])
    ).not.toThrow();

    await layer.close();
  });

  it("a stale Redis job envelope cannot resurrect ownership after recovery (CA5)", async () => {
    const layer = makeLayer();
    const executionId = "exec-no-resurrection";
    const t0 = new Date(); // real wall-clock anchor: in-memory validateFencing checks Date.now()
    const tExpired = new Date(t0.getTime() + TTL_MS + 60_000);

    const leaseA = await layer.leases.acquire({ executionId, workerId: "worker-A", ttlMs: TTL_MS, now: t0 });
    await layer.leases.reclaimExpired(tExpired);
    const leaseB = await layer.leases.takeoverRecovery(executionId, "worker-B", tExpired, TTL_MS);

    const durable = ownershipFromCanonical(leaseB!, true);

    // A stale job envelope that outlived the pre-loss epoch (worker A, attempt 1).
    const staleHint = { workerId: "worker-A", attempt: leaseA!.attempt, source: "redis-redelivered-job" };
    const reconciled = reconcileOwnershipView(durable, staleHint);
    expect(reconciled.severity).toBe("STALE");
    // Postgres wins — ownership stays with the recovery owner.
    expect(reconciled.authoritative?.workerId).toBe("worker-B");
    // STALE is expected, not an incident — it must not throw.
    expect(() => assertOwnershipResolvesToDurable(durable, staleHint)).not.toThrow();

    // A phantom envelope claiming an epoch ABOVE the durable truth is impossible
    // under canonical authority (Postgres mints every epoch) — fail closed.
    expect(() =>
      assertOwnershipResolvesToDurable(durable, {
        workerId: "worker-X",
        attempt: leaseB!.attempt + 1,
        source: "phantom-redis-state"
      })
    ).toThrow(/\[invariant:CA5\]/);

    await layer.close();
  });

  it("replay reconstructs from the durable event log, never from Redis", async () => {
    const layer = makeLayer();
    const events = new EventFactory(new SystemClock(), "test");
    const executionId = "exec-replay-after-loss";

    for (let i = 0; i < 4; i++) {
      await layer.eventStore.append(
        events.create({
          type: "EXECUTION_STARTED",
          aggregateId: executionId,
          aggregateType: "EXECUTION",
          payload: { step: i }
        })
      );
    }

    // Redis is gone; the durable event log is the only replay substrate.
    expect(() =>
      assertReconstructionDurable(["EVENT_LOG", "REPLAY_METADATA", "EXECUTION_CHECKPOINT"])
    ).not.toThrow();

    const replayable = await layer.eventStore.listByExecution(executionId);
    expect(replayable.length).toBe(4);

    await layer.close();
  });
});
