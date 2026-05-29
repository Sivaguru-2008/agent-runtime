import { describe, expect, it } from "vitest";
import { SystemClock, type Clock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { InMemoryEventBus } from "../src/infrastructure/events/inMemoryEventBus.js";
import { PersistedEventPublisher } from "../src/infrastructure/events/persistedEventPublisher.js";
import {
  InMemoryAgentRepository,
  InMemoryEventStore,
  InMemoryExecutionRepository,
  InMemoryMemoryRepository
} from "../src/infrastructure/persistence/inMemoryStores.js";
import {
  InMemoryCheckpointStore,
  InMemoryLeaseStore,
  InMemoryWorkerRegistry
} from "../src/infrastructure/cluster/inMemoryClusterStores.js";
import { LeaseHeartbeatWorker } from "../src/infrastructure/cluster/leaseHeartbeatWorker.js";
import { InMemoryDeadLetterStore } from "../src/infrastructure/reliability/deadLetterStore.js";
import { WorkerLifecycleService } from "../src/application/cluster/workerLifecycle.js";
import { DistributedScheduler } from "../src/application/cluster/distributedScheduler.js";
import { ClusterQueries } from "../src/application/cluster/clusterQueries.js";
import { ExecutionEngine } from "../src/runtime/executionEngine.js";
import { DeterministicModelProvider } from "../src/runtime/mockModelProvider.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import pino from "pino";

class ManualClock implements Clock {
  constructor(public current: Date = new Date(0)) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

function buildHarness(clock: Clock = new SystemClock()) {
  const logger = pino({ level: "silent" });
  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "test");
  const agents = new InMemoryAgentRepository();
  const memoryRepo = new InMemoryMemoryRepository();
  const workers = new InMemoryWorkerRegistry();
  const leases = new InMemoryLeaseStore();
  const checkpoints = new InMemoryCheckpointStore();
  const executions = new InMemoryExecutionRepository(leases, memoryRepo, undefined, checkpoints);
  const deadLetterQueue = new InMemoryDeadLetterStore();
  const engine = new ExecutionEngine(
    eventFactory,
    publisher,
    executions,
    memoryRepo,
    new DeterministicModelProvider(),
    new BuiltInToolExecutor(),
    clock,
    { checkpoints, workerId: "worker-1" }
  );
  const lifecycle = new WorkerLifecycleService(
    workers,
    leases,
    publisher,
    eventFactory,
    clock,
    { heartbeatTtlMs: 5_000, sweepIntervalMs: 60_000 },
    logger
  );
  const heartbeatWorker = new LeaseHeartbeatWorker(leases, publisher, eventFactory, clock, logger, {
    workerId: "worker-1",
    leaseTtlMs: 1_000,
    renewThresholdFactor: 0.4,
    pollIntervalMs: 500
  });
  const scheduler = new DistributedScheduler(
    engine,
    executions,
    agents,
    leases,
    workers,
    publisher,
    eventFactory,
    clock,
    { leaseTtlMs: 1_000, workerId: "worker-1", pollIntervalMs: 1_000, maxPoisonPillAttempts: 3 },
    deadLetterQueue,
    heartbeatWorker,
    logger
  );
  const runtime = new AgentRuntime(agents, executions, engine, eventFactory, publisher, clock, scheduler);
  const queries = new ClusterQueries(workers, leases, executions, checkpoints);
  return { lifecycle, scheduler, workers, leases, checkpoints, executions, agents, runtime, queries, eventStore, deadLetterQueue };
}

describe("worker lifecycle", () => {
  it("registers a worker and marks it lost when heartbeats expire", async () => {
    const clock = new ManualClock(new Date("2026-05-22T00:00:00Z"));
    const { lifecycle, workers } = buildHarness(clock);

    await lifecycle.register({ id: "w1", host: "node-1", version: "0.1.0" });
    expect((await workers.list())[0].status).toBe("READY");

    clock.advance(10_000);
    const result = await lifecycle.sweep();
    expect(result.expired.map((w) => w.id)).toContain("w1");
    expect((await workers.getById("w1"))?.status).toBe("LOST");
  });

  it("reclaims leases owned by a lost worker", async () => {
    const clock = new ManualClock(new Date("2026-05-22T00:00:00Z"));
    const { lifecycle, leases } = buildHarness(clock);

    await lifecycle.register({ id: "w1", host: "node-1", version: "0.1.0" });
    await leases.acquire({ executionId: "exec-1", workerId: "w1", ttlMs: 60_000, now: clock.now() });

    clock.advance(10_000);
    const result = await lifecycle.sweep();
    expect(result.reclaimedLeases).toBe(1);
    const lease = await leases.getByExecution("exec-1");
    expect(lease?.status).toBe("INVALIDATED");
  });
});

describe("distributed scheduler", () => {
  it("dispatches a queued task through the scheduler and settles agent state", async () => {
    const harness = buildHarness();
    await harness.lifecycle.register({ id: "worker-1", host: "embedded", version: "0.1.0", capacity: 4 });

    const agent = await harness.runtime.createAgent({
      name: "test-agent",
      goal: "investigate",
      tools: [{ name: "runtime.inspect", enabled: true }]
    });

    const queued = await harness.runtime.runTask(agent.id, { prompt: "diagnose" });
    expect(queued.status).toBe("QUEUED");
    expect(harness.scheduler.queueDepth()).toBe(1);

    await harness.scheduler.tick();

    const completed = await harness.executions.getById(queued.id);
    expect(completed?.status).toBe("COMPLETED");
    const settled = await harness.agents.getById(agent.id);
    expect(settled?.runtimeStatus).toBe("READY");
  });

  it("recovers executions whose leases expire", async () => {
    const clock = new ManualClock(new Date("2026-05-22T00:00:00Z"));
    const harness = buildHarness(clock);
    await harness.lifecycle.register({ id: "worker-1", host: "embedded", version: "0.1.0", capacity: 4 });

    const agent = await harness.runtime.createAgent({
      name: "stuck-agent",
      goal: "investigate",
      tools: [{ name: "runtime.inspect", enabled: true }]
    });

    const queued = await harness.runtime.runTask(agent.id, { prompt: "diagnose" });
    // Simulate worker death before the scheduler ticks: acquire a lease for a phantom worker.
    await harness.leases.acquire({
      executionId: queued.id,
      workerId: "phantom",
      ttlMs: 50,
      now: clock.now()
    });

    clock.advance(5_000);
    const recovered = await harness.scheduler.recover();
    expect(recovered).toBeGreaterThanOrEqual(1);
  });
});

describe("checkpointing", () => {
  it("writes checkpoints across step boundaries", async () => {
    const harness = buildHarness();
    await harness.lifecycle.register({ id: "worker-1", host: "embedded", version: "0.1.0", capacity: 4 });
    const agent = await harness.runtime.createAgent({
      name: "checkpoint-agent",
      goal: "investigate",
      tools: [{ name: "runtime.inspect", enabled: true }]
    });
    const queued = await harness.runtime.runTask(agent.id, { prompt: "diagnose" });
    await harness.scheduler.tick();

    const checkpoints = await harness.checkpoints.listByExecution(queued.id);
    const phases = checkpoints.map((c) => c.phase);
    expect(phases).toContain("INITIALIZED");
    expect(phases).toContain("PLANNING");
    expect(phases).toContain("COMPLETION");
  });
});

describe("cluster queries", () => {
  it("returns overview totals reflecting registered workers and active leases", async () => {
    const harness = buildHarness();
    await harness.lifecycle.register({ id: "worker-1", host: "embedded", version: "0.1.0", capacity: 4 });
    await harness.leases.acquire({
      executionId: "exec-x",
      workerId: "worker-1",
      ttlMs: 60_000,
      now: new Date()
    });
    const overview = await harness.queries.overview();
    expect(overview.workers.total).toBe(1);
    expect(overview.leases.active).toBe(1);
  });
});
