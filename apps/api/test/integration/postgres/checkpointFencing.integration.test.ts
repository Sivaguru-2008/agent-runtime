/**
 * Postgres checkpoint-write fencing — Phase A.
 *
 * The in-memory unit tests prove the contract; this suite proves the SQL —
 * specifically that the CTE-with-FOR-UPDATE pattern on
 * PostgresCheckpointStore.writeFenced actually rejects stale-worker writes
 * under real MVCC + row locking, with the same semantics as the
 * ExecutionRepository.saveFenced path.
 *
 * Why checkpoints matter:
 *   Checkpoints are the authoritative recovery anchor. A stale worker landing
 *   a checkpoint at the same (execution_id, sequence) the legitimate owner
 *   later writes shifts every subsequent crash recovery to a snapshot the
 *   legitimate owner never produced — silent corruption of recovery state.
 *   The fence on writeFenced collapses that race window.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PostgresCheckpointStore } from "../../../src/infrastructure/cluster/postgres/postgresCheckpointStore.js";
import { PostgresLeaseStore } from "../../../src/infrastructure/cluster/postgres/postgresLeaseStore.js";
import { tryStartHarness } from "./harness.js";
import { seedAgentAndExecution } from "./factories.js";
import { toIso } from "../../../src/shared/clock.js";
import type { ExecutionCheckpoint } from "../../../src/domain/cluster.js";
import type { FencingToken } from "../../../src/domain/clusterPorts.js";

const harness = await tryStartHarness();
const checkpoints = harness ? new PostgresCheckpointStore(harness.pg) : null;
const leases = harness ? new PostgresLeaseStore(harness.pg) : null;

function nowFresh(): Date {
  return new Date();
}
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

function checkpointTemplate(opts: {
  executionId: string;
  workerId: string;
  sequence: number;
  phase: ExecutionCheckpoint["phase"];
  state: Record<string, unknown>;
}): ExecutionCheckpoint {
  return {
    id: randomUUID(),
    executionId: opts.executionId,
    workerId: opts.workerId,
    sequence: opts.sequence,
    phase: opts.phase,
    state: opts.state,
    createdAt: toIso(FIXED_NOW)
  };
}

describe.skipIf(!harness)("PostgresCheckpointStore.writeFenced", () => {
  it("commits the checkpoint when the fence matches the live lease", async () => {
    const { executionId, workerId } = await setup();
    const lease = await leases!.acquire({
      executionId,
      workerId,
      ttlMs: 60_000,
      now: nowFresh()
    });
    const fence: FencingToken = { executionId, workerId, attempt: lease!.attempt };

    const outcome = await checkpoints!.writeFenced(
      checkpointTemplate({
        executionId,
        workerId,
        sequence: 1,
        phase: "PLANNING",
        state: { plan: "alpha" }
      }),
      fence
    );
    expect(outcome).toBe("COMMITTED");

    const list = await checkpoints!.listByExecution(executionId);
    expect(list).toHaveLength(1);
    expect(list[0].phase).toBe("PLANNING");
    expect(list[0].state).toEqual({ plan: "alpha" });
  });

  it("rejects when the lease has been reclaimed (stale token after re-acquire)", async () => {
    const { executionId, workerId } = await setup();
    const lease = await leases!.acquire({
      executionId,
      workerId,
      ttlMs: 60_000,
      now: nowFresh()
    });
    const staleFence: FencingToken = { executionId, workerId, attempt: lease!.attempt };

    // Legitimate owner writes their own checkpoint first.
    const newWorker = randomUUID();
    await leases!.reclaimByWorker(workerId, FIXED_NOW);
    const newLease = await leases!.acquire({
      executionId,
      workerId: newWorker,
      ttlMs: 60_000,
      now: nowFresh()
    });
    expect(newLease!.attempt).toBe(lease!.attempt + 1);

    const newFence: FencingToken = {
      executionId,
      workerId: newWorker,
      attempt: newLease!.attempt
    };
    const owned = await checkpoints!.writeFenced(
      checkpointTemplate({
        executionId,
        workerId: newWorker,
        sequence: 1,
        phase: "PLANNING",
        state: { plan: "legitimate-new-owner" }
      }),
      newFence
    );
    expect(owned).toBe("COMMITTED");

    // Stale worker wakes up and tries to land a competing checkpoint at the
    // SAME sequence. The fence must reject; the legitimate row must remain.
    const staleOutcome = await checkpoints!.writeFenced(
      checkpointTemplate({
        executionId,
        workerId,
        sequence: 1,
        phase: "PLANNING",
        state: { plan: "stale-overwrite" }
      }),
      staleFence
    );
    expect(staleOutcome).toBe("FENCED");

    const list = await checkpoints!.listByExecution(executionId);
    expect(list).toHaveLength(1);
    // The legitimate checkpoint is untouched.
    expect(list[0].state).toEqual({ plan: "legitimate-new-owner" });
    expect(list[0].workerId).toBe(newWorker);
  });

  it("rejects when the lease was released by its holder", async () => {
    const { executionId, workerId } = await setup();
    const lease = await leases!.acquire({
      executionId,
      workerId,
      ttlMs: 60_000,
      now: nowFresh()
    });
    const fence: FencingToken = { executionId, workerId, attempt: lease!.attempt };
    await leases!.release(executionId, workerId, FIXED_NOW);

    const outcome = await checkpoints!.writeFenced(
      checkpointTemplate({
        executionId,
        workerId,
        sequence: 1,
        phase: "MEMORY_RETRIEVAL",
        state: { foo: "bar" }
      }),
      fence
    );
    expect(outcome).toBe("FENCED");
    expect(await checkpoints!.listByExecution(executionId)).toHaveLength(0);
  });

  it("rejects when the lease expired by wall-clock", async () => {
    const { executionId, workerId } = await setup();
    const lease = await leases!.acquire({
      executionId,
      workerId,
      ttlMs: 1,
      now: new Date(Date.now() - 60_000)
    });
    const fence: FencingToken = { executionId, workerId, attempt: lease!.attempt };

    const outcome = await checkpoints!.writeFenced(
      checkpointTemplate({
        executionId,
        workerId,
        sequence: 1,
        phase: "TOOL_CALL",
        state: { tool: "noop" }
      }),
      fence
    );
    expect(outcome).toBe("FENCED");
  });
});
