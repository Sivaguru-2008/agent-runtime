import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SystemClock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { InMemoryEventBus } from "../src/infrastructure/events/inMemoryEventBus.js";
import { PersistedEventPublisher } from "../src/infrastructure/events/persistedEventPublisher.js";
import {
  InMemoryEventStore,
  InMemoryExecutionRepository,
  InMemoryMemoryRepository
} from "../src/infrastructure/persistence/inMemoryStores.js";
import {
  InMemoryCheckpointStore,
  InMemoryLeaseStore
} from "../src/infrastructure/cluster/inMemoryClusterStores.js";
import { ExecutionEngine } from "../src/runtime/executionEngine.js";
import { DeterministicModelProvider } from "../src/runtime/mockModelProvider.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import type { DomainEvent } from "../src/domain/events.js";
import type { Agent, Execution } from "../src/domain/model.js";
import type { ExecutionCheckpoint } from "../src/domain/cluster.js";
import type { CheckpointStore, FencingToken, FencedWriteOutcome } from "../src/domain/clusterPorts.js";

/**
 * Phase A (Operational Hardening) — Persistence-level fencing for checkpoint writes.
 *
 * Checkpoints are the authoritative recovery anchor. Without fencing on
 * writeFenced(), a stale worker whose lease was reclaimed can land a
 * checkpoint AT THE SAME execution_id + sequence as the legitimate owner —
 * shifting every subsequent crash recovery to a snapshot the legitimate
 * owner never produced.
 *
 * What we pin here:
 *   (1) InMemoryCheckpointStore.writeFenced rejects a stale fence (FENCED) and
 *       does NOT persist the row. Same contract Postgres enforces in SQL.
 *   (2) ExecutionEngine.writeCheckpoint, called with a fence whose lease was
 *       reclaimed mid-execution, surrenders without persisting the checkpoint
 *       AND publishes EXECUTION_FENCE_REJECTED with the checkpoint phase.
 *   (3) The legitimate owner's earlier checkpoint is intact — the stale write
 *       does not overwrite it via the ON CONFLICT (execution_id, sequence)
 *       conflict target.
 */

class ReclaimOnCheckpointWriteStore implements CheckpointStore {
  public stalePersistCount = 0;
  constructor(
    private readonly inner: CheckpointStore,
    private readonly leases: InMemoryLeaseStore,
    private readonly workerId: string,
    private readonly clock: SystemClock,
    /** Which checkpoint phase triggers the reclaim injection. */
    private readonly trigger: ExecutionCheckpoint["phase"]
  ) {}
  async write(checkpoint: ExecutionCheckpoint): Promise<ExecutionCheckpoint> {
    return this.inner.write(checkpoint);
  }
  async writeFenced(
    checkpoint: ExecutionCheckpoint,
    fence: FencingToken
  ): Promise<FencedWriteOutcome> {
    if (checkpoint.phase === this.trigger) {
      // Simulate the GC-pause-then-reclaim race: between the engine deciding
      // to write a checkpoint and the durable adapter actually persisting it,
      // the lease is reclaimed by the recovery loop. The downstream
      // writeFenced MUST observe the stale fence and reject.
      await this.leases.reclaimByWorker(this.workerId, this.clock.now());
    }
    const outcome = await this.inner.writeFenced(checkpoint, fence);
    if (outcome === "COMMITTED" && checkpoint.phase === this.trigger) {
      // If this ever increments, the substrate broke its fencing contract.
      this.stalePersistCount += 1;
    }
    return outcome;
  }
  async listByExecution(executionId: string): Promise<ExecutionCheckpoint[]> {
    return this.inner.listByExecution(executionId);
  }
  async latest(executionId: string): Promise<ExecutionCheckpoint | undefined> {
    return this.inner.latest(executionId);
  }
}

function makeAgentAndExecution(): { agent: Agent; execution: Execution } {
  const now = new Date().toISOString();
  const agentId = randomUUID();
  const executionId = randomUUID();
  const agent: Agent = {
    id: agentId,
    name: "checkpoint-fencing-agent",
    goal: "exercise checkpoint fencing",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    tools: [{ name: "runtime.inspect", enabled: false }],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-checkpoint-fencing"
  };
  const execution: Execution = {
    id: executionId,
    agentId,
    status: "QUEUED",
    input: { prompt: "irrelevant" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-checkpoint-fencing"
  };
  return { agent, execution };
}

async function acquireFence(
  leases: InMemoryLeaseStore,
  executionId: string,
  workerId: string
): Promise<FencingToken> {
  const lease = await leases.acquire({
    executionId,
    workerId,
    ttlMs: 60_000,
    now: new Date()
  });
  if (!lease) throw new Error("could not acquire test lease — harness bug");
  return { executionId, workerId, attempt: lease.attempt };
}

describe("InMemoryCheckpointStore.writeFenced — direct adapter contract", () => {
  it("returns COMMITTED when fence matches a live ACTIVE lease", async () => {
    const leases = new InMemoryLeaseStore();
    const store = new InMemoryCheckpointStore(leases);
    const executionId = randomUUID();
    const workerId = randomUUID();
    const lease = await leases.acquire({
      executionId,
      workerId,
      ttlMs: 60_000,
      now: new Date()
    });
    expect(lease).toBeDefined();

    const checkpoint: ExecutionCheckpoint = {
      id: randomUUID(),
      executionId,
      workerId,
      sequence: 1,
      phase: "PLANNING",
      state: { plan: "test" },
      createdAt: new Date().toISOString()
    };
    const outcome = await store.writeFenced(checkpoint, {
      executionId,
      workerId,
      attempt: lease!.attempt
    });
    expect(outcome).toBe("COMMITTED");
    const list = await store.listByExecution(executionId);
    expect(list).toHaveLength(1);
    expect(list[0].phase).toBe("PLANNING");
  });

  it("returns FENCED and does NOT persist when the lease was reclaimed", async () => {
    const leases = new InMemoryLeaseStore();
    const store = new InMemoryCheckpointStore(leases);
    const executionId = randomUUID();
    const workerId = randomUUID();
    const lease = await leases.acquire({
      executionId,
      workerId,
      ttlMs: 60_000,
      now: new Date()
    });
    expect(lease).toBeDefined();
    const fence: FencingToken = {
      executionId,
      workerId,
      attempt: lease!.attempt
    };

    // Lease reclaimed before the stale worker attempts its checkpoint write.
    await leases.reclaimByWorker(workerId, new Date());

    const outcome = await store.writeFenced(
      {
        id: randomUUID(),
        executionId,
        workerId,
        sequence: 1,
        phase: "PLANNING",
        state: { plan: "stale-write" },
        createdAt: new Date().toISOString()
      },
      fence
    );
    expect(outcome).toBe("FENCED");
    expect(await store.listByExecution(executionId)).toHaveLength(0);
  });

  it("returns FENCED when the fence references a different attempt (stale token after re-acquire)", async () => {
    const leases = new InMemoryLeaseStore();
    const store = new InMemoryCheckpointStore(leases);
    const executionId = randomUUID();
    const workerA = randomUUID();
    const workerB = randomUUID();

    const leaseA = await leases.acquire({
      executionId,
      workerId: workerA,
      ttlMs: 60_000,
      now: new Date()
    });
    expect(leaseA).toBeDefined();
    const staleFence: FencingToken = {
      executionId,
      workerId: workerA,
      attempt: leaseA!.attempt
    };

    // A is reclaimed, B acquires — attempt monotonically increases.
    await leases.reclaimByWorker(workerA, new Date());
    const leaseB = await leases.acquire({
      executionId,
      workerId: workerB,
      ttlMs: 60_000,
      now: new Date()
    });
    expect(leaseB).toBeDefined();
    expect(leaseB!.attempt).toBeGreaterThan(leaseA!.attempt);

    // A wakes up with its stale token and tries to write a checkpoint.
    const outcome = await store.writeFenced(
      {
        id: randomUUID(),
        executionId,
        workerId: workerA,
        sequence: 2,
        phase: "MODEL_GENERATION",
        state: { tokens: 99 },
        createdAt: new Date().toISOString()
      },
      staleFence
    );
    expect(outcome).toBe("FENCED");
    expect(await store.listByExecution(executionId)).toHaveLength(0);
  });
});

describe("ExecutionEngine — stale-worker checkpoint write surrenders without state corruption", () => {
  function build(triggerPhase: ExecutionCheckpoint["phase"]) {
    const clock = new SystemClock();
    const workerId = randomUUID();
    const eventStore = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const publisher = new PersistedEventPublisher(eventStore, bus);
    const eventFactory = new EventFactory(clock, "checkpoint-fencing-test");

    const observedEvents: DomainEvent[] = [];
    bus.subscribe((event) => {
      observedEvents.push(event);
    });

    const leases = new InMemoryLeaseStore();
    const memory = new InMemoryMemoryRepository(leases);
    const inner = new InMemoryCheckpointStore(leases);
    const checkpoints = new ReclaimOnCheckpointWriteStore(
      inner,
      leases,
      workerId,
      clock,
      triggerPhase
    );
    // writeCheckpoint now commits the checkpoint atomically through
    // commitTransition, so the repository — not the engine — owns the durable
    // checkpoint write. Wire the same fence-injecting store into the repository
    // so the stale-fence rejection fires inside the transactional commit.
    const executions = new InMemoryExecutionRepository(leases, memory, undefined, checkpoints);

    const engine = new ExecutionEngine(
      eventFactory,
      publisher,
      executions,
      memory,
      new DeterministicModelProvider(),
      new BuiltInToolExecutor(),
      clock,
      { workerId, checkpoints }
    );
    return { engine, leases, executions, observedEvents, workerId, checkpoints, inner };
  }

  it("PLANNING checkpoint: stale fence → no checkpoint persisted, FENCE_REJECTED emitted, no terminal stomp", async () => {
    const h = build("PLANNING");
    const { agent, execution } = makeAgentAndExecution();
    const fence = await acquireFence(h.leases, execution.id, h.workerId);

    const result = await h.engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: h.workerId,
      validateLease: async () => true,
      fence
    });

    // Execution surrendered — engine returns the input by reference (per the
    // existing surrender contract) and never wrote the terminal COMPLETED row.
    expect(result.status).toBe("QUEUED");

    // The substrate's writeFenced contract held: zero stale-persists.
    expect(h.checkpoints.stalePersistCount).toBe(0);

    // The PLANNING checkpoint is absent from the durable layer. The
    // INITIALIZED checkpoint (written before the reclaim trigger fired) is
    // present — it landed under a still-live lease.
    const allCheckpoints = await h.inner.listByExecution(execution.id);
    expect(allCheckpoints.find((c) => c.phase === "PLANNING")).toBeUndefined();
    expect(allCheckpoints.find((c) => c.phase === "INITIALIZED")).toBeDefined();

    // A diagnostic FENCE_REJECTED was emitted for the rejected checkpoint phase.
    const rejected = h.observedEvents.filter(
      (e) => e.type === "EXECUTION_FENCE_REJECTED"
    );
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    const rejectedPayloads = rejected.map((e) => e.payload as Record<string, unknown>);
    expect(
      rejectedPayloads.some((p) => p.phase === "checkpoint.PLANNING")
    ).toBe(true);

    // No EXECUTION_COMPLETED ever happened from the stale worker.
    expect(
      h.observedEvents.filter((e) => e.type === "EXECUTION_COMPLETED")
    ).toHaveLength(0);
  });

  it("(control) no reclaim — the fence stays valid and the engine writes every checkpoint phase", async () => {
    const clock = new SystemClock();
    const workerId = randomUUID();
    const eventStore = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const publisher = new PersistedEventPublisher(eventStore, bus);
    const eventFactory = new EventFactory(clock, "checkpoint-fencing-control");
    const observed: DomainEvent[] = [];
    bus.subscribe((e) => {
      observed.push(e);
    });
    const leases = new InMemoryLeaseStore();
    const memory = new InMemoryMemoryRepository(leases);
    const checkpoints = new InMemoryCheckpointStore(leases);
    const executions = new InMemoryExecutionRepository(leases, memory, undefined, checkpoints);

    const engine = new ExecutionEngine(
      eventFactory,
      publisher,
      executions,
      memory,
      new DeterministicModelProvider(),
      new BuiltInToolExecutor(),
      clock,
      { workerId, checkpoints }
    );

    const { agent, execution } = makeAgentAndExecution();
    const fence = await acquireFence(leases, execution.id, workerId);
    const result = await engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId,
      validateLease: async () => true,
      fence
    });
    expect(result.status).toBe("COMPLETED");
    const persisted = await checkpoints.listByExecution(execution.id);
    expect(persisted.length).toBeGreaterThan(0);
    // No fence rejections on the happy path.
    expect(observed.filter((e) => e.type === "EXECUTION_FENCE_REJECTED")).toHaveLength(0);
  });
});
