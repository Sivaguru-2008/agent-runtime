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
import { InMemoryLeaseStore } from "../src/infrastructure/cluster/inMemoryClusterStores.js";
import { ExecutionEngine } from "../src/runtime/executionEngine.js";
import { DeterministicModelProvider } from "../src/runtime/mockModelProvider.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import type { DomainEvent } from "../src/domain/events.js";
import type { Agent, Execution, MemoryRecord } from "../src/domain/model.js";
import type { ExecutionRepository, MemoryRepository, CommitTerminalInput, CommitTransitionInput } from "../src/domain/ports.js";
import type { FencingToken, FencedWriteOutcome } from "../src/domain/clusterPorts.js";

/**
 * Terminal-write fencing — closes the TOCTOU between assertFencing() and the
 * unconditional durable writes in ExecutionEngine.execute().
 *
 * The race being tested:
 *   1. Worker A acquires lease attempt=1
 *   2. Engine runs PLAN → MEMORY → MODEL. Model completes successfully.
 *   3. Engine calls assertFencing() — still valid, A holds attempt=1.
 *   4. ⚠ GC pause / network delay — A's lease expires.
 *   5. Recovery loop reclaims; worker B acquires attempt=2.
 *   6. B completes the work and writes COMPLETED with B's output.
 *   7. A wakes, runs executions.save(completed_A) and memory.add(...).
 *      Pre-fix: these were unconditional UPSERTs that overwrote B's terminal
 *      state with A's stale output.
 *      Post-fix: both writes are conditional on the lease still matching A's
 *      original token. Both return "FENCED". Engine emits
 *      EXECUTION_FENCE_REJECTED and surrenders without further mutation.
 *
 * The mechanism we exercise here is a wrapping repository that reclaims the
 * lease immediately before delegating the write — a deterministic stand-in
 * for the GC-pause-then-reclaim sequence. The race window collapses to a
 * single synchronous step, which is what makes this test deterministic.
 */

class ReclaimOnSaveExecutionRepository implements ExecutionRepository {
  constructor(
    private readonly inner: ExecutionRepository,
    private readonly leases: InMemoryLeaseStore,
    private readonly workerId: string,
    private readonly clock: SystemClock,
    private readonly trigger: { status: Execution["status"] }
  ) {}
  async save(execution: Execution): Promise<void> {
    if (execution.status === this.trigger.status) {
      await this.leases.reclaimByWorker(this.workerId, this.clock.now());
    }
    return this.inner.save(execution);
  }
  async saveFenced(execution: Execution, fence: FencingToken): Promise<FencedWriteOutcome> {
    if (execution.status === this.trigger.status) {
      await this.leases.reclaimByWorker(this.workerId, this.clock.now());
    }
    return this.inner.saveFenced(execution, fence);
  }
  async commitTerminal(input: CommitTerminalInput): Promise<FencedWriteOutcome> {
    if (input.execution.status === this.trigger.status) {
      await this.leases.reclaimByWorker(this.workerId, this.clock.now());
    }
    return this.inner.commitTerminal(input);
  }
  async commitTransition(input: CommitTransitionInput): Promise<FencedWriteOutcome> {
    if (input.execution.status === this.trigger.status) {
      await this.leases.reclaimByWorker(this.workerId, this.clock.now());
    }
    return this.inner.commitTransition(input);
  }
  async detectPartialCommit(executionId: string): Promise<{ isConsistent: boolean; actualStatus: Execution["status"]; lastEventSeq?: number; error?: string }> {
    return this.inner.detectPartialCommit(executionId);
  }
  isOutboxEnabled(): boolean {
    return false;
  }
  async getById(id: string): Promise<Execution | undefined> {
    return this.inner.getById(id);
  }
  async listByAgent(agentId: string): Promise<Execution[]> {
    return this.inner.listByAgent(agentId);
  }
}

class ReclaimOnAddMemoryRepository implements MemoryRepository {
  constructor(
    private readonly inner: MemoryRepository,
    private readonly leases: InMemoryLeaseStore,
    private readonly workerId: string,
    private readonly clock: SystemClock
  ) {}
  async add(record: MemoryRecord): Promise<void> {
    await this.leases.reclaimByWorker(this.workerId, this.clock.now());
    return this.inner.add(record);
  }
  async addFenced(record: MemoryRecord, fence: FencingToken): Promise<FencedWriteOutcome> {
    await this.leases.reclaimByWorker(this.workerId, this.clock.now());
    return this.inner.addFenced(record, fence);
  }
  async search(agentId: string, query: string, limit: number) {
    return this.inner.search(agentId, query, limit);
  }
  async listByAgent(agentId: string) {
    return this.inner.listByAgent(agentId);
  }
}

interface Harness {
  engine: ExecutionEngine;
  leases: InMemoryLeaseStore;
  executions: InMemoryExecutionRepository;
  memory: InMemoryMemoryRepository;
  observedEvents: DomainEvent[];
  workerId: string;
}

function buildHarness(opts: {
  /** Which save call triggers the race injection. */
  reclaimOn?: "RUNNING" | "COMPLETED" | "FAILED" | "memory";
  /** Model provider — defaults to the deterministic one that completes successfully. */
  modelProvider?: ExecutionEngine extends ExecutionEngine ? ConstructorParameters<typeof ExecutionEngine>[4] : never;
}): Harness {
  const clock = new SystemClock();
  const workerId = randomUUID();
  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "terminal-fencing-test");

  const observedEvents: DomainEvent[] = [];
  bus.subscribe((event) => {
    observedEvents.push(event);
  });

  const leases = new InMemoryLeaseStore();
  const baseMemory = new InMemoryMemoryRepository(leases);

  let memory: MemoryRepository = baseMemory;
  if (opts.reclaimOn === "memory") {
    memory = new ReclaimOnAddMemoryRepository(baseMemory, leases, workerId, clock);
  }

  const baseExecutions = new InMemoryExecutionRepository(leases, memory);

  let executions: ExecutionRepository = baseExecutions;
  if (opts.reclaimOn && opts.reclaimOn !== "memory") {
    executions = new ReclaimOnSaveExecutionRepository(
      baseExecutions,
      leases,
      workerId,
      clock,
      { status: opts.reclaimOn }
    );
  }

  const engine = new ExecutionEngine(
    eventFactory,
    publisher,
    executions,
    memory,
    opts.modelProvider ?? new DeterministicModelProvider(),
    new BuiltInToolExecutor(),
    clock,
    { workerId }
  );

  return { engine, leases, executions: baseExecutions, memory: baseMemory, observedEvents, workerId };
}

function makeAgentAndExecution(workerId: string): { agent: Agent; execution: Execution } {
  const now = new Date().toISOString();
  const agentId = randomUUID();
  const executionId = randomUUID();
  void workerId;
  const agent: Agent = {
    id: agentId,
    name: "terminal-fencing-agent",
    goal: "exercise terminal-write fencing",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    tools: [{ name: "runtime.inspect", enabled: false }],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-terminal-fencing"
  };
  const execution: Execution = {
    id: executionId,
    agentId,
    status: "QUEUED",
    input: { prompt: "irrelevant" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-terminal-fencing"
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

describe("ExecutionEngine — terminal-write fencing closes TOCTOU between assert and save", () => {
  it("(control) succeeds end-to-end when the fence stays valid throughout", async () => {
    const h = buildHarness({});
    const { agent, execution } = makeAgentAndExecution(h.workerId);
    const fence = await acquireFence(h.leases, execution.id, h.workerId);

    const result = await h.engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: h.workerId,
      validateLease: async () => true,
      fence
    });

    expect(result.status).toBe("COMPLETED");
    const persisted = await h.executions.getById(execution.id);
    expect(persisted?.status).toBe("COMPLETED");

    const completed = h.observedEvents.filter((e) => e.type === "EXECUTION_COMPLETED");
    expect(completed).toHaveLength(1);
    const rejected = h.observedEvents.filter((e) => e.type === "EXECUTION_FENCE_REJECTED");
    expect(rejected).toHaveLength(0);
  });

  it("(A) reclaim between assertFencing() and executions.save(COMPLETED) → durable write is rejected, no terminal stomp", async () => {
    const h = buildHarness({ reclaimOn: "COMPLETED" });
    const { agent, execution } = makeAgentAndExecution(h.workerId);
    const fence = await acquireFence(h.leases, execution.id, h.workerId);

    const result = await h.engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: h.workerId,
      validateLease: async () => true,
      fence
    });

    expect(result.status).not.toBe("COMPLETED");

    const persisted = await h.executions.getById(execution.id);
    expect(persisted?.status).not.toBe("COMPLETED");

    const completed = h.observedEvents.filter((e) => e.type === "EXECUTION_COMPLETED");
    expect(completed).toHaveLength(0);

    const rejected = h.observedEvents.filter((e) => e.type === "EXECUTION_FENCE_REJECTED");
    expect(rejected).toHaveLength(1);
    const payload = rejected[0]!.payload as {
      executionId: string;
      workerId: string;
      attemptedStatus: string;
    };
    expect(payload.executionId).toBe(execution.id);
    expect(payload.workerId).toBe(h.workerId);
    expect(payload.attemptedStatus).toBe("COMPLETED");
  });

  it("(B) reclaim between assertFencing() and memory.add → tenant-tagged memory is NOT orphaned with a stale terminal row", async () => {
    const h = buildHarness({ reclaimOn: "memory" });
    const { agent, execution } = makeAgentAndExecution(h.workerId);
    const fence = await acquireFence(h.leases, execution.id, h.workerId);

    const result = await h.engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: h.workerId,
      validateLease: async () => true,
      fence
    });

    expect(result.status).not.toBe("COMPLETED");

    // The fenced memory write must surrender — no stale TASK_HISTORY for the
    // lost lease. Otherwise downstream RAG sees a memory record pointing at a
    // non-COMPLETED execution.
    const stored = await h.memory.listByAgent(agent.id);
    const taskHistory = stored.filter((r) => r.type === "TASK_HISTORY" && r.executionId === execution.id);
    expect(taskHistory).toHaveLength(0);

    const rejected = h.observedEvents.filter((e) => e.type === "EXECUTION_FENCE_REJECTED");
    expect(rejected).toHaveLength(1);
  });

  it("(C) stale RUNNING save after legitimate COMPLETED does not regress terminal state", async () => {
    // Independent of any single race: prove that saveFenced rejects when the
    // lease has been reclaimed and a new worker has already written COMPLETED.
    const h = buildHarness({});
    const { agent, execution } = makeAgentAndExecution(h.workerId);

    const fenceA = await acquireFence(h.leases, execution.id, h.workerId);

    // Simulate the new owner (worker B) winning the lease and writing COMPLETED.
    await h.leases.reclaimByWorker(h.workerId, new Date());
    const newWorker = randomUUID();
    const leaseB = await h.leases.acquire({
      executionId: execution.id,
      workerId: newWorker,
      ttlMs: 60_000,
      now: new Date()
    });
    expect(leaseB).toBeDefined();

    const completedByB: Execution = {
      ...execution,
      status: "COMPLETED",
      output: { winner: "B" },
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
    const outcomeB = await h.executions.saveFenced(completedByB, {
      executionId: execution.id,
      workerId: newWorker,
      attempt: leaseB!.attempt
    });
    expect(outcomeB).toBe("COMMITTED");

    // Stale worker A now attempts the legacy first-save with its stale fence.
    const staleRunning: Execution = {
      ...execution,
      status: "RUNNING",
      updatedAt: new Date().toISOString()
    };
    const outcomeA = await h.executions.saveFenced(staleRunning, fenceA);
    expect(outcomeA).toBe("FENCED");

    // Row remains COMPLETED — B's terminal state was not stomped to RUNNING.
    const persisted = await h.executions.getById(execution.id);
    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.output).toEqual({ winner: "B" });
  });
});
