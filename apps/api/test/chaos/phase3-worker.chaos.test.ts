/**
 * Phase 3 — Worker failure survivability.
 *
 * Workers are killed mid-execution by terminating the lease holder without
 * calling release(). Recovery is driven by reclaimExpired() — the same path
 * the BackgroundRecoveryLoop runs in production. The contract under test:
 *
 *   3.1 Kill mid-execution             → expired lease is reclaimable
 *   3.2 Lease fencing correctness      → reclaim does NOT hand the lease back
 *                                         to the dead worker; attempt counter
 *                                         strictly increases.
 *   3.3 Poison-pill handling           → after N attempts, execution lands in
 *                                         the dead-letter store with attempt ≥ N.
 *   3.4 Replay recovery                → after reclaim + re-acquire, the work
 *                                         is performable by a fresh worker.
 *   3.5 No duplicated commits          → two workers that race acquire() never
 *                                         BOTH believe they own the lease.
 *
 * All scenarios exercise the production PostgresLeaseStore + PostgresDead
 * LetterStore against the real test container — no mocks.
 */

import { afterAll, describe, expect, it } from "vitest";
import { PostgresLeaseStore } from "../../src/infrastructure/cluster/postgres/postgresLeaseStore.js";
import { PostgresCheckpointStore } from "../../src/infrastructure/cluster/postgres/postgresCheckpointStore.js";
import { PostgresExecutionRepository } from "../../src/infrastructure/persistence/postgres/postgresExecutionRepository.js";
import { PostgresDeadLetterStore } from "../../src/infrastructure/reliability/postgresDeadLetterStore.js";
import { randomUUID } from "node:crypto";
import { tryStartChaosHarness, type ChaosHarness } from "./_setup/chaosHarness.js";
import { recordPhase, evaluateThresholds } from "./_setup/chaosResultBus.js";
import { fanOut } from "../integration/postgres/concurrency.js";
import { seedAgentAndExecution } from "../integration/postgres/factories.js";
import { toIso } from "../../src/shared/clock.js";
import type { Execution } from "../../src/domain/model.js";
import type { ExecutionCheckpoint } from "../../src/domain/cluster.js";
import type { FencingToken } from "../../src/domain/clusterPorts.js";

// Top-level await: describe.skipIf is evaluated synchronously at collection
// time, so the harness must already be resolved when the predicate runs.
const harness: ChaosHarness | null = await tryStartChaosHarness();

afterAll(async () => {
  if (harness) await harness.stop();
});

describe.skipIf(!harness)("Phase 3.1 — kill mid-execution → lease becomes reclaimable", () => {
  it("a worker that exits without calling release leaves an ACTIVE lease that expires; reclaim finds it", async () => {
    const t0 = Date.now();
    const leases = new PostgresLeaseStore(harness!.pg);
    const exec = randomUUID();
    const worker = randomUUID();
    const t = new Date("2026-05-22T00:00:00.000Z");

    const acquired = await leases.acquire({ executionId: exec, workerId: worker, ttlMs: 200, now: t });
    expect(acquired?.workerId).toBe(worker);

    // Worker dies — no release. Wait past expiry.
    const later = new Date(t.getTime() + 60_000);
    const reclaimed = await leases.reclaimExpired(later);
    const ids = reclaimed.map((l) => l.executionId);

    const { ok, thresholds } = evaluateThresholds({
      reclaimed: { observed: ids.includes(exec) ? 1 : 0, required: "== 1", predicate: (v) => v === 1 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase3.1.killMidExecution", {
      ok,
      metrics: { reclaimedCount: ids.length, includesTargeted: ids.includes(exec) ? 1 : 0 },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 30_000);
});

describe.skipIf(!harness)("Phase 3.2 — lease fencing correctness", () => {
  it("after reclaim, the dead worker cannot renew; a fresh worker acquires with attempt > 1", async () => {
    const t0 = Date.now();
    const leases = new PostgresLeaseStore(harness!.pg);
    const exec = randomUUID();
    const dead = randomUUID();
    const fresh = randomUUID();
    const t = new Date("2026-05-22T00:00:00.000Z");

    const first = await leases.acquire({ executionId: exec, workerId: dead, ttlMs: 200, now: t });
    expect(first?.attempt).toBe(1);

    const later = new Date(t.getTime() + 60_000);
    await leases.reclaimExpired(later);

    // Dead worker tries to renew. With FOR UPDATE SKIP LOCKED + status guard,
    // this must NOT succeed; renew updates only rows with status = 'ACTIVE'
    // owned by the renewing worker.
    const renewAttempt = await leases.renew(exec, dead, later, 30_000);

    const second = await leases.acquire({ executionId: exec, workerId: fresh, ttlMs: 30_000, now: later });

    const { ok, thresholds } = evaluateThresholds({
      deadCannotRenew: {
        observed: renewAttempt ? 1 : 0,
        required: "== 0 (dead worker must not renew after reclaim)",
        predicate: (v) => v === 0
      },
      freshAcquired: {
        observed: second?.workerId === fresh ? 1 : 0,
        required: "== 1 (fresh worker acquires)",
        predicate: (v) => v === 1
      },
      attemptIncreased: {
        observed: Number(second?.attempt ?? 0),
        required: "> 1 (fencing increments attempt)",
        predicate: (v) => Number(v) > 1
      }
    });
    expect(ok).toBe(true);
    await recordPhase("phase3.2.leaseFencing", {
      ok,
      metrics: { freshAttempt: Number(second?.attempt ?? 0), deadCouldRenew: renewAttempt ? 1 : 0 },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 30_000);
});

describe.skipIf(!harness)("Phase 3.3 — poison-pill handling", () => {
  it("after POISON_PILL_MAX_ATTEMPTS attempts, the execution can be pushed to the dead-letter store", async () => {
    const t0 = Date.now();
    const leases = new PostgresLeaseStore(harness!.pg);
    const dlq = new PostgresDeadLetterStore(harness!.pg);
    const exec = randomUUID();
    const t = new Date("2026-05-22T00:00:00.000Z");

    // Simulate 4 failed attempts (default POISON_PILL_MAX_ATTEMPTS=3).
    const ATTEMPTS = 4;
    let lastAttempt = 0;
    for (let i = 0; i < ATTEMPTS; i++) {
      const w = randomUUID();
      const now = new Date(t.getTime() + i * 60_000);
      const a = await leases.acquire({ executionId: exec, workerId: w, ttlMs: 200, now });
      lastAttempt = a?.attempt ?? lastAttempt;
      const later = new Date(now.getTime() + 30_000);
      await leases.reclaimExpired(later);
    }

    // Push to DLQ exactly as the WorkerExecutionLoop would after exhausting
    // retries. Field names must match DeadLetterEntry (failureCount, lastError,
    // movedAt, workerId) — the store reads exactly those keys into the SQL
    // params, so any rename surfaces as a NOT NULL violation in `attempt`.
    await dlq.push({
      id: exec,
      executionId: exec,
      agentId: randomUUID(),
      workerId: randomUUID(),
      failureCount: lastAttempt,
      lastError: "deliberate fault",
      firstFailedAt: t.toISOString(),
      movedAt: new Date().toISOString(),
      taskSnapshot: { test: true } as Record<string, unknown>
    });

    const entry = await dlq.getByExecution(exec);

    const { ok, thresholds } = evaluateThresholds({
      attemptsExhausted: {
        observed: lastAttempt,
        required: ">= 4",
        predicate: (v) => v >= 4
      },
      dlqEntryPresent: {
        observed: entry ? 1 : 0,
        required: "== 1",
        predicate: (v) => v === 1
      },
      dlqAttemptCount: {
        observed: Number(entry?.failureCount ?? 0),
        required: ">= 4",
        predicate: (v) => Number(v) >= 4
      }
    });
    expect(ok).toBe(true);
    await recordPhase("phase3.3.poisonPill", {
      ok,
      metrics: { lastAttempt, dlqPresent: entry ? 1 : 0 },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 30_000);
});

describe.skipIf(!harness)("Phase 3.4 — replay recovery", () => {
  it("after reclaim, a fresh worker can acquire and (in production) replay from checkpoint", async () => {
    const t0 = Date.now();
    const leases = new PostgresLeaseStore(harness!.pg);
    const exec = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    const t = new Date("2026-05-22T00:00:00.000Z");

    await leases.acquire({ executionId: exec, workerId: a, ttlMs: 200, now: t });
    const later = new Date(t.getTime() + 60_000);
    await leases.reclaimExpired(later);
    const acquired = await leases.acquire({ executionId: exec, workerId: b, ttlMs: 30_000, now: later });

    const { ok, thresholds } = evaluateThresholds({
      freshHolds: {
        observed: acquired?.workerId === b ? 1 : 0,
        required: "== 1",
        predicate: (v) => v === 1
      },
      attemptCounterCarried: {
        observed: Number(acquired?.attempt ?? 0),
        required: ">= 2 (carries from prior worker)",
        predicate: (v) => Number(v) >= 2
      }
    });
    expect(ok).toBe(true);
    await recordPhase("phase3.4.replayRecovery", {
      ok,
      metrics: { attempt: Number(acquired?.attempt ?? 0) },
      thresholds,
      notes:
        "Replay-from-checkpoint requires a Checkpoint row written by the prior attempt; tested in integration/replayDeterminism. This phase asserts the lease handoff is sound.",
      durationMs: Date.now() - t0
    });
  }, 30_000);
});

describe.skipIf(!harness)("Phase 3.5 — no duplicated execution commits", () => {
  it("32 concurrent acquire() calls for the same exec result in EXACTLY ONE owner", async () => {
    const t0 = Date.now();
    const leases = new PostgresLeaseStore(harness!.pg);
    const exec = randomUUID();
    const t = new Date("2026-05-22T00:00:00.000Z");

    const { results, errors } = await fanOut(32, async () => {
      const w = randomUUID();
      return leases.acquire({ executionId: exec, workerId: w, ttlMs: 60_000, now: t });
    });
    const owners = results.filter((r) => r != null);
    const uniqueOwners = new Set(owners.map((o) => o!.workerId));

    const { ok, thresholds } = evaluateThresholds({
      exactlyOneOwner: {
        observed: uniqueOwners.size,
        required: "== 1 (exactly one worker holds the lease)",
        predicate: (v) => v === 1
      },
      noErrors: { observed: errors.length, required: "== 0", predicate: (v) => v === 0 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase3.5.noDuplicateCommit", {
      ok,
      metrics: { contenders: 32, ownersReturned: owners.length, uniqueOwners: uniqueOwners.size },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 30_000);
});

describe.skipIf(!harness)("Phase 3.6 — persistence-level fencing rejects stale writes across all durable boundaries", () => {
  it("a stale worker cannot mutate executions OR execution_checkpoints after its lease was reclaimed", async () => {
    const t0 = Date.now();
    const leases = new PostgresLeaseStore(harness!.pg);
    const executions = new PostgresExecutionRepository(harness!.pg);
    const checkpoints = new PostgresCheckpointStore(harness!.pg);
    const agentId = randomUUID();
    const executionId = randomUUID();
    const dead = randomUUID();
    const fresh = randomUUID();
    const t = new Date();
    const TENANT = "system";

    await seedAgentAndExecution(harness!.pg, { agentId, executionId });

    // Dead worker acquires, captures its fencing token, then dies (lease
    // reclaimed by the recovery loop; fresh worker takes over).
    const lease = await leases.acquire({ executionId, workerId: dead, ttlMs: 60_000, now: t });
    const staleFence: FencingToken = {
      executionId,
      workerId: dead,
      attempt: lease!.attempt
    };
    await leases.reclaimByWorker(dead, t);
    const newLease = await leases.acquire({ executionId, workerId: fresh, ttlMs: 60_000, now: t });
    expect(newLease!.attempt).toBe(lease!.attempt + 1);

    // Fresh worker writes the legitimate checkpoint + execution row.
    const freshFence: FencingToken = {
      executionId,
      workerId: fresh,
      attempt: newLease!.attempt
    };
    const freshCp: ExecutionCheckpoint = {
      id: randomUUID(),
      executionId,
      workerId: fresh,
      sequence: 1,
      phase: "PLANNING",
      state: { owner: "fresh" },
      createdAt: toIso(t)
    };
    const freshCpOutcome = await checkpoints.writeFenced(freshCp, freshFence);
    expect(freshCpOutcome).toBe("COMMITTED");

    const freshExec: Execution = {
      id: executionId,
      agentId,
      status: "COMPLETED",
      input: { prompt: "irrelevant" },
      output: { owner: "fresh" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(t),
      updatedAt: toIso(t),
      completedAt: toIso(t),
      tenantId: TENANT
    };
    const freshExecOutcome = await executions.saveFenced(freshExec, freshFence);
    expect(freshExecOutcome).toBe("COMMITTED");

    // Dead worker wakes up holding its stale token. EVERY durable mutation
    // path must reject it — checkpoints AND executions. If either commits,
    // the legitimate fresh worker's terminal state has been corrupted.
    const staleCp: ExecutionCheckpoint = {
      id: randomUUID(),
      executionId,
      workerId: dead,
      sequence: 1,
      phase: "PLANNING",
      state: { owner: "dead-stale" },
      createdAt: toIso(t)
    };
    const staleCpOutcome = await checkpoints.writeFenced(staleCp, staleFence);

    const staleExec: Execution = {
      ...freshExec,
      status: "FAILED",
      output: { owner: "dead-stale" },
      failure: { message: "stale-overwrite", recoverable: false }
    };
    const staleExecOutcome = await executions.saveFenced(staleExec, staleFence);

    // Read-back the durable state — the legitimate row + checkpoint must be
    // untouched.
    const persistedExec = await executions.getById(executionId);
    const persistedCps = await checkpoints.listByExecution(executionId);

    const { ok, thresholds } = evaluateThresholds({
      staleCheckpointRejected: {
        observed: staleCpOutcome === "FENCED" ? 1 : 0,
        required: "== 1 (stale checkpoint write must return FENCED)",
        predicate: (v) => v === 1
      },
      staleExecutionRejected: {
        observed: staleExecOutcome === "FENCED" ? 1 : 0,
        required: "== 1 (stale execution write must return FENCED)",
        predicate: (v) => v === 1
      },
      legitimateExecPreserved: {
        observed:
          persistedExec?.status === "COMPLETED" &&
          (persistedExec.output as Record<string, unknown> | undefined)?.owner === "fresh"
            ? 1
            : 0,
        required: "== 1 (legitimate COMPLETED row untouched)",
        predicate: (v) => v === 1
      },
      legitimateCheckpointPreserved: {
        observed:
          persistedCps.length === 1 &&
          (persistedCps[0].state as Record<string, unknown>).owner === "fresh"
            ? 1
            : 0,
        required: "== 1 (legitimate checkpoint row untouched)",
        predicate: (v) => v === 1
      }
    });
    expect(ok).toBe(true);
    await recordPhase("phase3.6.persistenceLevelFencing", {
      ok,
      metrics: {
        staleCheckpointOutcomeFenced: staleCpOutcome === "FENCED" ? 1 : 0,
        staleExecutionOutcomeFenced: staleExecOutcome === "FENCED" ? 1 : 0,
        legitimateCheckpoints: persistedCps.length,
        legitimateExecOwnerFresh:
          (persistedExec?.output as Record<string, unknown> | undefined)?.owner === "fresh" ? 1 : 0
      },
      thresholds,
      notes:
        "Closes the cross-aggregate stale-write window: checkpoints AND executions both reject at the SQL CTE level, so a stale worker cannot mutate either after lease reclaim.",
      durationMs: Date.now() - t0
    });
  }, 30_000);
});
