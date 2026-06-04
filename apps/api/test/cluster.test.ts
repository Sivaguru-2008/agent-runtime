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

const ZERO_LOAD = { cpu: 0, memory: 0, inFlight: 0, queueDepth: 0, eventsPerSecond: 0 };

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
    expect(lease?.status).toBe("EXPIRED");
  });

  it("reaps workers terminal beyond the retention window but keeps recently-lost ones", async () => {
    const clock = new ManualClock(new Date("2026-05-22T00:00:00Z"));
    const { lifecycle, workers } = buildHarness(clock);
    const base = clock.now().getTime();

    // LOST 48h ago — past the 24h default retention → must be reaped.
    await workers.register({
      id: "ancient", host: "node", version: "0.1.0", capacity: 4,
      status: "LOST", load: ZERO_LOAD,
      startedAt: new Date(base - 49 * 3_600_000).toISOString(),
      lastHeartbeatAt: new Date(base - 48 * 3_600_000).toISOString()
    });
    // LOST 1 min ago — within retention → must be kept for diagnostics.
    await workers.register({
      id: "recent", host: "node", version: "0.1.0", capacity: 4,
      status: "LOST", load: ZERO_LOAD,
      startedAt: new Date(base - 3_600_000).toISOString(),
      lastHeartbeatAt: new Date(base - 60_000).toISOString()
    });

    const result = await lifecycle.sweep();
    expect(result.reaped.map((w) => w.id)).toEqual(["ancient"]);
    expect(await workers.getById("ancient")).toBeUndefined();
    expect(await workers.getById("recent")).toBeDefined();
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

  it("dead-letters an execution whose recovery attempts are exhausted (poison via recovery path)", async () => {
    const clock = new ManualClock(new Date("2026-05-22T00:00:00Z"));
    const harness = buildHarness(clock);
    await harness.lifecycle.register({ id: "worker-1", host: "embedded", version: "0.1.0", capacity: 4 });

    // A RUNNING execution stranded by a previous incarnation.
    const execId = "exec-poison";
    await harness.executions.save({
      id: execId,
      agentId: "agent-poison",
      status: "RUNNING",
      input: { task: 1 },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      tenantId: "system",
      startedAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString()
    });

    // Drive the lease attempt past maxPoisonPillAttempts (3) via acquire/reclaim
    // cycles, leaving it EXPIRED at attempt 4 — recovery will classify it ABORTED.
    for (let i = 0; i < 4; i++) {
      await harness.leases.acquire({ executionId: execId, workerId: "phantom", ttlMs: 1, now: clock.now() });
      clock.advance(1_000);
      await harness.leases.reclaimExpired(clock.now());
    }
    expect((await harness.leases.getByExecution(execId))!.attempt).toBeGreaterThan(3);

    await harness.scheduler.recover();

    // The execution is finalized (no longer pinned RUNNING) and recorded in the DLQ.
    expect((await harness.executions.getById(execId))!.status).toBe("DEAD_LETTERED");
    expect(await harness.deadLetterQueue.getByExecution(execId)).toBeDefined();

    // The lease is terminalized, so a subsequent recovery sweep does NOT
    // re-surface it (no churn).
    const reSurfaced = await harness.leases.reclaimExpired(clock.now());
    expect(reSurfaced.map((l) => l.executionId)).not.toContain(execId);
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

  it("excludes LOST workers from the mean heartbeat age (mean across live workers)", async () => {
    const harness = buildHarness();
    const now = Date.now();

    // A live worker heartbeating ~3s ago.
    await harness.workers.register({
      id: "live-1", host: "node", version: "0.1.0", capacity: 4,
      status: "READY", load: ZERO_LOAD,
      startedAt: new Date(now - 3_000).toISOString(),
      lastHeartbeatAt: new Date(now - 3_000).toISOString()
    });
    // A worker dead for 8 days — must NOT drag the live mean toward days.
    await harness.workers.register({
      id: "dead-1", host: "node", version: "0.1.0", capacity: 4,
      status: "LOST", load: ZERO_LOAD,
      startedAt: new Date(now - 8 * 86_400_000).toISOString(),
      lastHeartbeatAt: new Date(now - 8 * 86_400_000).toISOString()
    });

    const overview = await harness.queries.overview();
    expect(overview.workers.total).toBe(2);
    expect(overview.workers.lost).toBe(1);
    expect(overview.workers.ready).toBe(1);
    // Were the LOST worker included, the mean would be ~4 days (~345_600_000ms).
    expect(overview.meanHeartbeatAgeMs).toBeLessThan(60_000);
  });
});
