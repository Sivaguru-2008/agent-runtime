/**
 * Phase 7 — Distributed Execution Ownership & Lease States Chaos Tests.
 *
 * Simulates extreme distributed execution anomalies:
 *   7.1 Explicit ownership state transitions & fencing races
 *   7.2 Concurrent recovery serialization & takeover (takeoverRecovery CAS)
 *   7.3 Split-brain execution & duplicate schedulers (ownership arbitration)
 *   7.4 Replay ownership isolation (isolated replay paths RP3)
 *   7.5 Stale worker permanent invalidation (preventing zombie recovery)
 */

import { afterAll, describe, expect, it } from "vitest";
import { PostgresLeaseStore } from "../../src/infrastructure/cluster/postgres/postgresLeaseStore.js";
import { PostgresCheckpointStore } from "../../src/infrastructure/cluster/postgres/postgresCheckpointStore.js";
import { PostgresExecutionRepository } from "../../src/infrastructure/persistence/postgres/postgresExecutionRepository.js";
import { PostgresWorkerRegistry } from "../../src/infrastructure/cluster/postgres/postgresWorkerRegistry.js";
import { randomUUID } from "node:crypto";
import { tryStartChaosHarness, type ChaosHarness } from "./_setup/chaosHarness.js";
import { recordPhase, evaluateThresholds } from "./_setup/chaosResultBus.js";
import { fanOut } from "../integration/postgres/concurrency.js";
import { seedAgentAndExecution } from "../integration/postgres/factories.js";
import { toIso } from "../../src/shared/clock.js";
import type { Execution } from "../../src/domain/model.js";
import { FencingViolationError } from "../../src/runtime/executionEngine.js";

const harness: ChaosHarness | null = await tryStartChaosHarness();

afterAll(async () => {
  if (harness) await harness.stop();
});

describe.skipIf(!harness)("Phase 7.1 — Explicit ownership state transitions & fencing races", () => {
  it("an expired worker attempting to write to a reclaimed lease must be strictly rejected at Postgres level", async () => {
    const t0 = Date.now();
    const leases = new PostgresLeaseStore(harness!.pg);
    const executions = new PostgresExecutionRepository(harness!.pg);
    const agentId = randomUUID();
    const executionId = randomUUID();
    const deadWorker = randomUUID();
    const freshWorker = randomUUID();
    const t = new Date();

    await seedAgentAndExecution(harness!.pg, { agentId, executionId });

    // 1. Dead worker acquires lease (attempt 1) - status transitions to LEASED
    const deadLease = await leases.acquire({ executionId, workerId: deadWorker, ttlMs: 100, now: t });
    expect(deadLease?.attempt).toBe(1);
    expect(deadLease?.status).toBe("LEASED");

    // 2. Lease expires and is reclaimed - status transitions to EXPIRED
    const later = new Date(t.getTime() + 60_000);
    await leases.reclaimExpired(later);

    // 3. Fresh worker acquires lease (attempt 2) - status transitions to LEASED
    const freshLease = await leases.acquire({ executionId, workerId: freshWorker, ttlMs: 30_000, now: later });
    expect(freshLease?.attempt).toBe(2);
    expect(freshLease?.status).toBe("LEASED");

    // 4. Stale dead worker wakes up and attempts a fenced save with stale leaseId
    const staleExec: Execution = {
      id: executionId,
      agentId,
      status: "FAILED",
      input: { prompt: "stale" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(t),
      updatedAt: toIso(t),
      tenantId: "system"
    };

    let deadWriteOutcome: string = "";
    try {
      await executions.save(staleExec, {
        executionId,
        leaseId: deadLease!.leaseId,
        leaseEpoch: deadLease!.attempt,
        workerId: deadWorker,
        expiration: deadLease!.expiresAt,
        attempt: deadLease!.attempt
      });
      deadWriteOutcome = "COMMITTED";
    } catch (err) {
      if (err instanceof FencingViolationError) {
        deadWriteOutcome = "FENCED";
      } else {
        deadWriteOutcome = "ERROR";
      }
    }

    const { ok, thresholds } = evaluateThresholds({
      staleWorkerFenced: {
        observed: deadWriteOutcome === "FENCED" ? 1 : 0,
        required: "== 1 (stale worker write throws FencingViolationError)",
        predicate: (v) => v === 1
      }
    });

    expect(ok).toBe(true);
    await recordPhase("phase7.1.delayedWorkerExpiryRace", {
      ok,
      metrics: { deadWriteOutcome },
      thresholds,
      durationMs: Date.now() - t0
    });
  });
});

describe.skipIf(!harness)("Phase 7.2 — Concurrent recovery serialization & takeover", () => {
  it("only a single recovery execution can transition an expired lease to RECOVERY_OWNED state", async () => {
    const t0 = Date.now();
    const leases = new PostgresLeaseStore(harness!.pg);
    const execId = randomUUID();
    const worker = randomUUID();
    const t = new Date();

    // 1. Acquire lease - status transitions to LEASED
    await leases.acquire({ executionId: execId, workerId: worker, ttlMs: 100, now: t });

    // 2. Expiry race
    const later = new Date(t.getTime() + 60_000);

    // 3. Concurrently reclaim the lease to EXPIRED status
    const { results, errors } = await fanOut(8, async () => {
      return leases.reclaimExpired(later, 10);
    });

    const activeReclaims = results.filter((arr) => arr && arr.length > 0);

    // 4. Concurrently takeover recovery to RECOVERY_OWNED status
    const { results: takeoverResults, errors: takeoverErrors } = await fanOut(8, async () => {
      const w = randomUUID();
      return leases.takeoverRecovery(execId, w, later, 30_000);
    });

    const successfulTakeovers = takeoverResults.filter((r) => r !== undefined);
    expect(successfulTakeovers.length).toBe(1);
    expect(successfulTakeovers[0]!.status).toBe("RECOVERY_OWNED");

    const { ok, thresholds } = evaluateThresholds({
      serializedRecovery: {
        observed: activeReclaims.length,
        required: "== 1 (exactly one concurrent reclaim sweeps the lease)",
        predicate: (v) => v === 1
      },
      serializedTakeover: {
        observed: successfulTakeovers.length,
        required: "== 1 (exactly one recovery worker takes over the lease)",
        predicate: (v) => v === 1
      },
      noRecoveryErrors: {
        observed: errors.length + takeoverErrors.length,
        required: "== 0",
        predicate: (v) => v === 0
      }
    });

    expect(ok).toBe(true);
    await recordPhase("phase7.2.concurrentRecoverySerialization", {
      ok,
      metrics: { reclaims: activeReclaims.length, takeovers: successfulTakeovers.length, errors: errors.length },
      thresholds,
      durationMs: Date.now() - t0
    });
  });
});

describe.skipIf(!harness)("Phase 7.3 — Split-brain execution & duplicate schedulers", () => {
  it("duplicate schedulers concurrently acquiring leases results in strictly one winner", async () => {
    const t0 = Date.now();
    const leases = new PostgresLeaseStore(harness!.pg);
    const executionId = randomUUID();
    const t = new Date();

    const { results } = await fanOut(16, async () => {
      const w = randomUUID();
      return leases.acquire({ executionId, workerId: w, ttlMs: 30_000, now: t });
    });

    const successfulAcquires = results.filter((r) => r !== undefined);
    const uniqueLeaseIds = new Set(successfulAcquires.map((l) => l!.leaseId));

    const { ok, thresholds } = evaluateThresholds({
      singleLeaseAcquired: {
        observed: uniqueLeaseIds.size,
        required: "== 1 (only one unique lease is created)",
        predicate: (v) => v === 1
      }
    });

    expect(ok).toBe(true);
    await recordPhase("phase7.3.splitBrainDuplicateSchedulers", {
      ok,
      metrics: { uniqueLeaseCount: uniqueLeaseIds.size },
      thresholds,
      durationMs: Date.now() - t0
    });
  });
});

describe.skipIf(!harness)("Phase 7.4 — Replay ownership isolation", async () => {
  it("isolated replay routes prevent cross-execution lease collision", async () => {
    const t0 = Date.now();
    const leases = new PostgresLeaseStore(harness!.pg);
    const executionId = randomUUID();
    const replayId = randomUUID();
    const worker1 = randomUUID();
    const worker2 = randomUUID();
    const t = new Date();

    // Acquire execution lease
    const execLease = await leases.acquire({ executionId, workerId: worker1, ttlMs: 30_000, now: t });
    // Acquire replay lease concurrently
    const replayLease = await leases.acquire({ executionId: replayId, workerId: worker2, ttlMs: 30_000, now: t });

    const { ok, thresholds } = evaluateThresholds({
      executionLeaseAcquired: {
        observed: execLease ? 1 : 0,
        required: "== 1",
        predicate: (v) => v === 1
      },
      replayLeaseIsolated: {
        observed: replayLease ? 1 : 0,
        required: "== 1",
        predicate: (v) => v === 1
      }
    });

    expect(ok).toBe(true);
    await recordPhase("phase7.4.replayOwnershipIsolation", {
      ok,
      metrics: { executionLeaseId: execLease?.leaseId ?? null, replayLeaseId: replayLease?.leaseId ?? null },
      thresholds,
      durationMs: Date.now() - t0
    });
  });
});

describe.skipIf(!harness)("Phase 7.5 — Stale worker permanent invalidation", () => {
  it("once a worker registry record status becomes LOST, subsequent heartbeats are rejected", async () => {
    const t0 = Date.now();
    const registry = new PostgresWorkerRegistry(harness!.pg);
    const workerId = randomUUID();
    const now = new Date();

    // Register
    await registry.register({
      id: workerId,
      host: "test-host",
      version: "1.0",
      capacity: 10,
      status: "READY",
      load: { cpu: 0, memory: 0, inFlight: 0, queueDepth: 0, eventsPerSecond: 0 },
      startedAt: toIso(now),
      lastHeartbeatAt: toIso(now)
    });

    // Worker status moves to LOST due to expiration sweep
    await registry.expireStale(new Date(now.getTime() + 60_000), 500);

    // Zombie worker wakes up and heartbeats
    const heartbeatResult = await registry.heartbeat(workerId, { cpu: 1, memory: 1, inFlight: 1, queueDepth: 0, eventsPerSecond: 0 });

    const { ok, thresholds } = evaluateThresholds({
      zombieHeartbeatRejected: {
        observed: heartbeatResult ? 1 : 0,
        required: "== 0 (LOST worker heartbeat returns undefined)",
        predicate: (v) => v === 0
      }
    });

    expect(ok).toBe(true);
    await recordPhase("phase7.5.permanentInvalidation", {
      ok,
      metrics: { heartbeatSuccess: heartbeatResult ? 1 : 0 },
      thresholds,
      durationMs: Date.now() - t0
    });
  });
});
