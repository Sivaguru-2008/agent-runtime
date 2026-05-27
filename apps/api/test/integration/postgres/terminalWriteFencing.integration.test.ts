/**
 * Postgres terminal-write fencing — proves that the durable conditional-write
 * pattern actually rejects stale-worker writes under real row-locking.
 *
 * The in-memory unit tests prove the contract; this suite proves the SQL.
 * Specifically:
 *
 *   1. saveFenced/addFenced with a matching active lease COMMITs the row.
 *   2. saveFenced with a stale token (lease reclaimed) returns "FENCED" and
 *      the row is NOT mutated.
 *   3. Concurrent saveFenced + reclaim do not produce ANY commit-with-stale-
 *      token outcome. Exactly one of the two ends with the database in a
 *      consistent state where:
 *        a) the lease is EXPIRED/ACTIVE-by-new-owner, AND
 *        b) the executions row reflects ONLY a write whose fence was valid at
 *           statement commit time.
 *
 * Why testcontainers: in-memory adapters can simulate the API contract, but
 * only real Postgres MVCC + FOR UPDATE proves the CTE pattern resists
 * interleaved transactions.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PostgresExecutionRepository } from "../../../src/infrastructure/persistence/postgres/postgresExecutionRepository.js";
import { PostgresMemoryRepository } from "../../../src/infrastructure/persistence/postgres/postgresMemoryRepository.js";
import { PostgresLeaseStore } from "../../../src/infrastructure/cluster/postgres/postgresLeaseStore.js";
import { tryStartHarness } from "./harness.js";
import { fanOut } from "./concurrency.js";
import { seedAgentAndExecution } from "./factories.js";
import { toIso } from "../../../src/shared/clock.js";
import type { Execution, MemoryRecord } from "../../../src/domain/model.js";
import type { FencingToken } from "../../../src/domain/clusterPorts.js";

const harness = await tryStartHarness();
const executions = harness ? new PostgresExecutionRepository(harness.pg) : null;
const memory = harness ? new PostgresMemoryRepository(harness.pg) : null;
const leases = harness ? new PostgresLeaseStore(harness.pg) : null;

// Use the always-present 'system' tenant — the schema (0002) enforces a FK
// from executions.tenant_id and memory_records.tenant_id to tenants(id), and
// 'system' is seeded by the migration. Spinning up a bespoke tenant per test
// would require seeding the tenants table first; not worth it for fencing
// validation, which is orthogonal to tenant isolation.
const TENANT = "system";

/**
 * Lease acquisition needs real wall-clock time because both
 * PostgresLeaseStore.validateFencing and the CTE inside saveFenced /
 * addFenced compare `expires_at` against `Date.now()`. A lease acquired with
 * a fixed past Date would always read as expired. `nowFresh()` is called at
 * acquisition time per-test so the TTL is meaningful.
 */
function nowFresh(): Date {
  return new Date();
}

/**
 * Fixed timestamp for fields that don't participate in fence evaluation
 * (executions.startedAt, memory_records.createdAt, lease release/reclaim
 * `renewed_at`). These can be any deterministic value.
 */
const FIXED_NOW = new Date("2026-05-26T00:00:00.000Z");

afterEach(async () => {
  if (harness) await harness.reset();
});
afterAll(async () => {
  if (harness) await harness.stop();
});

async function setup(): Promise<{ agentId: string; executionId: string; workerId: string }> {
  const agentId = randomUUID();
  const executionId = randomUUID();
  const workerId = randomUUID();
  await seedAgentAndExecution(harness!.pg, { agentId, executionId });
  return { agentId, executionId, workerId };
}

function execTemplate(opts: {
  id: string;
  agentId: string;
  status: Execution["status"];
  output?: Record<string, unknown>;
}): Execution {
  return {
    id: opts.id,
    agentId: opts.agentId,
    status: opts.status,
    input: { prompt: "irrelevant" },
    output: opts.output,
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: toIso(FIXED_NOW),
    updatedAt: toIso(FIXED_NOW),
    completedAt: opts.status === "COMPLETED" || opts.status === "FAILED" ? toIso(FIXED_NOW) : undefined,
    tenantId: TENANT
  };
}

describe.skipIf(!harness)("PostgresExecutionRepository.saveFenced", () => {
  it("commits the write when the fence matches the live lease", async () => {
    const { agentId, executionId, workerId } = await setup();
    const lease = await leases!.acquire({
      executionId,
      workerId,
      ttlMs: 60_000,
      now: nowFresh()
    });
    expect(lease).toBeDefined();
    const fence: FencingToken = { executionId, workerId, attempt: lease!.attempt };

    const outcome = await executions!.saveFenced(
      execTemplate({ id: executionId, agentId, status: "COMPLETED", output: { ok: true } }),
      fence
    );
    expect(outcome).toBe("COMMITTED");

    const persisted = await executions!.getById(executionId);
    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.output).toEqual({ ok: true });
  });

  it("rejects when the lease has been reclaimed (stale token)", async () => {
    const { agentId, executionId, workerId } = await setup();
    const lease = await leases!.acquire({
      executionId,
      workerId,
      ttlMs: 60_000,
      now: nowFresh()
    });
    const staleFence: FencingToken = { executionId, workerId, attempt: lease!.attempt };

    // Recovery loop reclaims this worker's leases; a new worker takes over.
    await leases!.reclaimByWorker(workerId, FIXED_NOW);
    const newWorker = randomUUID();
    const newLease = await leases!.acquire({
      executionId,
      workerId: newWorker,
      ttlMs: 60_000,
      now: nowFresh()
    });
    expect(newLease?.attempt).toBe((lease!.attempt) + 1);

    const outcome = await executions!.saveFenced(
      execTemplate({ id: executionId, agentId, status: "COMPLETED", output: { stale: true } }),
      staleFence
    );
    expect(outcome).toBe("FENCED");

    // The executions row must NOT carry the stale output. Either it's still
    // the seeded COMPLETED row from seedAgentAndExecution OR untouched.
    const persisted = await executions!.getById(executionId);
    expect(persisted?.output).not.toEqual({ stale: true });
  });

  it("rejects when attempt matches but the lease was already RELEASED", async () => {
    const { agentId, executionId, workerId } = await setup();
    const lease = await leases!.acquire({
      executionId,
      workerId,
      ttlMs: 60_000,
      now: nowFresh()
    });
    const fence: FencingToken = { executionId, workerId, attempt: lease!.attempt };
    await leases!.release(executionId, workerId, FIXED_NOW);

    const outcome = await executions!.saveFenced(
      execTemplate({ id: executionId, agentId, status: "FAILED" }),
      fence
    );
    expect(outcome).toBe("FENCED");
  });

  it("rejects when the lease has expired by wall-clock", async () => {
    const { agentId, executionId, workerId } = await setup();
    const lease = await leases!.acquire({
      executionId,
      workerId,
      ttlMs: 1, // expires immediately
      now: new Date(Date.now() - 60_000)
    });
    expect(lease).toBeDefined();
    const fence: FencingToken = { executionId, workerId, attempt: lease!.attempt };

    const outcome = await executions!.saveFenced(
      execTemplate({ id: executionId, agentId, status: "COMPLETED" }),
      fence
    );
    expect(outcome).toBe("FENCED");
  });

  it("under concurrent reclaim, ONLY one of (stale-save, reclaim-then-new-acquire) leaves a consistent terminal state", async () => {
    const { agentId, executionId, workerId } = await setup();
    const lease = await leases!.acquire({
      executionId,
      workerId,
      ttlMs: 60_000,
      now: nowFresh()
    });
    const fence: FencingToken = { executionId, workerId, attempt: lease!.attempt };

    // Race: original worker attempts to write COMPLETED while the recovery
    // path reclaims its leases. The CTE-with-FOR-UPDATE pattern means these
    // two transactions serialize on the lease row; either:
    //   • saveFenced wins the lock first → write COMMITs, then reclaim sets
    //     status='EXPIRED' afterwards.
    //   • reclaim wins → saveFenced re-reads the lease as non-ACTIVE → FENCED.
    // Either way, no commit happens with a stale token.
    const { results, errors } = await fanOut(2, async (idx) => {
      if (idx === 0) {
        return executions!.saveFenced(
          execTemplate({ id: executionId, agentId, status: "COMPLETED", output: { writer: "original" } }),
          fence
        );
      }
      await leases!.reclaimByWorker(workerId, FIXED_NOW);
      return "reclaimed" as const;
    });
    expect(errors).toEqual([]);
    expect(results).toHaveLength(2);

    // Whatever interleaving occurred, the post-condition is unambiguous:
    // saveFenced returned either COMMITTED (lock won, write valid) or FENCED
    // (lock lost, write surrendered). It NEVER silently overwrote with a
    // stale token after the reclaim.
    const saveOutcome = results.find((r) => r === "COMMITTED" || r === "FENCED");
    expect(saveOutcome === "COMMITTED" || saveOutcome === "FENCED").toBe(true);

    const persisted = await executions!.getById(executionId);
    const leaseAfter = await leases!.getByExecution(executionId);
    if (saveOutcome === "COMMITTED") {
      // The write went through because the writer held the lock first.
      // Then the reclaim ran and set status away from ACTIVE.
      expect(persisted?.output).toEqual({ writer: "original" });
      expect(leaseAfter?.status).not.toBe("ACTIVE");
    } else {
      // FENCED: write was rejected by the CTE. Whatever the seed row was,
      // it must NOT carry the stale output.
      expect(persisted?.output).not.toEqual({ writer: "original" });
    }
  });
});

describe.skipIf(!harness)("PostgresMemoryRepository.addFenced", () => {
  it("commits when the fence is valid", async () => {
    const { agentId, executionId, workerId } = await setup();
    const lease = await leases!.acquire({
      executionId,
      workerId,
      ttlMs: 60_000,
      now: nowFresh()
    });
    const fence: FencingToken = { executionId, workerId, attempt: lease!.attempt };

    const record: MemoryRecord = {
      id: randomUUID(),
      agentId,
      executionId,
      type: "TASK_HISTORY",
      content: "completed task",
      metadata: { ok: true },
      createdAt: toIso(FIXED_NOW),
      tenantId: TENANT
    };
    const outcome = await memory!.addFenced(record, fence);
    expect(outcome).toBe("COMMITTED");

    const stored = await memory!.listByAgent(agentId);
    expect(stored.some((r) => r.id === record.id)).toBe(true);
  });

  it("rejects when the lease has been reclaimed", async () => {
    const { agentId, executionId, workerId } = await setup();
    const lease = await leases!.acquire({
      executionId,
      workerId,
      ttlMs: 60_000,
      now: nowFresh()
    });
    const staleFence: FencingToken = { executionId, workerId, attempt: lease!.attempt };
    await leases!.reclaimByWorker(workerId, FIXED_NOW);

    const record: MemoryRecord = {
      id: randomUUID(),
      agentId,
      executionId,
      type: "TASK_HISTORY",
      content: "stale write — must be rejected",
      metadata: {},
      createdAt: toIso(FIXED_NOW),
      tenantId: TENANT
    };
    const outcome = await memory!.addFenced(record, staleFence);
    expect(outcome).toBe("FENCED");

    const stored = await memory!.listByAgent(agentId);
    expect(stored.some((r) => r.id === record.id)).toBe(false);
  });
});
