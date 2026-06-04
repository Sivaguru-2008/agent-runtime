import { describe, expect, it } from "vitest";
import { SystemClock, type Clock } from "../../src/shared/clock.js";
import { EventFactory } from "../../src/infrastructure/events/eventFactory.js";
import { InMemoryEventBus } from "../../src/infrastructure/events/inMemoryEventBus.js";
import { PersistedEventPublisher } from "../../src/infrastructure/events/persistedEventPublisher.js";
import {
  InMemoryAgentRepository,
  InMemoryEventStore,
  InMemoryExecutionRepository,
  InMemoryMemoryRepository
} from "../../src/infrastructure/persistence/inMemoryStores.js";
import {
  InMemoryCheckpointStore,
  InMemoryLeaseStore,
  InMemoryWorkerRegistry
} from "../../src/infrastructure/cluster/inMemoryClusterStores.js";
import { LeaseHeartbeatWorker } from "../../src/infrastructure/cluster/leaseHeartbeatWorker.js";
import { InMemoryDeadLetterStore } from "../../src/infrastructure/reliability/deadLetterStore.js";
import { WorkerLifecycleService } from "../../src/application/cluster/workerLifecycle.js";
import { DistributedScheduler, type SchedulerConfig } from "../../src/application/cluster/distributedScheduler.js";
import { ClusterQueries } from "../../src/application/cluster/clusterQueries.js";
import { ExecutionEngine } from "../../src/runtime/executionEngine.js";
import { DeterministicModelProvider } from "../../src/runtime/mockModelProvider.js";
import { BuiltInToolExecutor } from "../../src/runtime/toolRegistry.js";
import { AgentRuntime } from "../../src/runtime/agentRuntime.js";
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

function buildHarness(clock: Clock = new SystemClock(), schedulerOverrides: Partial<SchedulerConfig> = {}) {
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
    { leaseTtlMs: 1_000, workerId: "worker-1", pollIntervalMs: 1_000, maxPoisonPillAttempts: 3, ...schedulerOverrides },
    deadLetterQueue,
    heartbeatWorker,
    logger
  );
  const runtime = new AgentRuntime(agents, executions, engine, eventFactory, publisher, clock, scheduler);
  const queries = new ClusterQueries(workers, leases, executions, checkpoints);
  return { lifecycle, scheduler, workers, leases, checkpoints, executions, agents, runtime, queries, eventStore, deadLetterQueue };
}

describe("Recovery Regression & State-Machine Hardening", () => {
  it("successfully recovers an execution that has timed out/expired while in RUNNING state", async () => {
    const clock = new ManualClock(new Date("2026-05-31T00:00:00Z"));
    const harness = buildHarness(clock);
    await harness.lifecycle.register({ id: "worker-1", host: "embedded", version: "0.1.0", capacity: 4 });

    const agent = await harness.runtime.createAgent({
      name: "stuck-agent",
      goal: "investigate",
      tools: [{ name: "runtime.inspect", enabled: true }]
    });

    const executionId = "exec-running-expired";
    await harness.executions.save({
      id: executionId,
      agentId: agent.id,
      status: "RUNNING",
      input: { task: "inspect" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      tenantId: "system",
      startedAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString()
    });

    // Worker 1 holds the lease but it is now expired
    await harness.leases.acquire({
      executionId,
      workerId: "worker-1",
      ttlMs: 50,
      now: clock.now()
    });

    clock.advance(5_000); // Exceed lease TTL

    // Perform recovery sweep
    const recovered = await harness.scheduler.recover();
    expect(recovered).toBe(1);

    // Verify status was transitioned to RECOVERING (before re-enqueue/re-execution completes)
    const after = await harness.executions.getById(executionId);
    expect(after!.status).toBe("RECOVERING");
  });

  it("successfully recovers an execution that has expired while in SIDE_EFFECT_PENDING state", async () => {
    const clock = new ManualClock(new Date("2026-05-31T00:00:00Z"));
    const harness = buildHarness(clock);
    await harness.lifecycle.register({ id: "worker-1", host: "embedded", version: "0.1.0", capacity: 4 });

    const agent = await harness.runtime.createAgent({
      name: "stuck-agent",
      goal: "investigate",
      tools: [{ name: "runtime.inspect", enabled: true }]
    });

    const executionId = "exec-sep-expired";
    await harness.executions.save({
      id: executionId,
      agentId: agent.id,
      status: "SIDE_EFFECT_PENDING",
      input: { task: "inspect" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      tenantId: "system",
      startedAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString()
    });

    // Acquire lease and expire it
    await harness.leases.acquire({
      executionId,
      workerId: "worker-1",
      ttlMs: 50,
      now: clock.now()
    });

    clock.advance(5_000);

    const recovered = await harness.scheduler.recover();
    expect(recovered).toBe(1);

    const after = await harness.executions.getById(executionId);
    expect(after!.status).toBe("RECOVERING");
  });

  it("successfully recovers an execution that has expired while in REPLAYING state", async () => {
    const clock = new ManualClock(new Date("2026-05-31T00:00:00Z"));
    const harness = buildHarness(clock);
    await harness.lifecycle.register({ id: "worker-1", host: "embedded", version: "0.1.0", capacity: 4 });

    const agent = await harness.runtime.createAgent({
      name: "stuck-agent",
      goal: "investigate",
      tools: [{ name: "runtime.inspect", enabled: true }]
    });

    const executionId = "exec-replay-expired";
    await harness.executions.save({
      id: executionId,
      agentId: agent.id,
      status: "REPLAYING",
      input: { task: "inspect" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      tenantId: "system",
      startedAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString()
    });

    // Acquire lease and expire it
    await harness.leases.acquire({
      executionId,
      workerId: "worker-1",
      ttlMs: 50,
      now: clock.now()
    });

    clock.advance(5_000);

    const recovered = await harness.scheduler.recover();
    expect(recovered).toBe(1);

    const after = await harness.executions.getById(executionId);
    expect(after!.status).toBe("RECOVERING");
  });

  it("handles worker lost sweep and transitions its RUNNING execution to RECOVERING", async () => {
    const clock = new ManualClock(new Date("2026-05-31T00:00:00Z"));
    const harness = buildHarness(clock);

    const agent = await harness.runtime.createAgent({
      name: "lost-agent",
      goal: "investigate",
      tools: [{ name: "runtime.inspect", enabled: true }]
    });
    
    // Register worker and acquire lease
    await harness.lifecycle.register({ id: "worker-lost", host: "lost", version: "0.1.0" });
    
    const executionId = "exec-worker-lost";
    await harness.executions.save({
      id: executionId,
      agentId: agent.id,
      status: "RUNNING",
      input: { task: "inspect" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      tenantId: "system",
      startedAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString()
    });

    await harness.leases.acquire({
      executionId,
      workerId: "worker-lost",
      ttlMs: 60_000,
      now: clock.now()
    });

    clock.advance(10_000); // Exceed worker heartbeat TTL (5,000)

    // Sweep worker lifecycle (detect lost worker and reclaim its leases)
    const sweep = await harness.lifecycle.sweep();
    expect(sweep.expired.map(w => w.id)).toContain("worker-lost");
    expect(sweep.reclaimedLeases).toBeGreaterThanOrEqual(1);

    // Perform scheduler recovery
    const recovered = await harness.scheduler.recover();
    expect(recovered).toBe(1);

    const after = await harness.executions.getById(executionId);
    expect(after!.status).toBe("RECOVERING");
  });

  it("deduplicates recovery attempts and enforces serialized recovery takeover", async () => {
    const clock = new ManualClock(new Date("2026-05-31T00:00:00Z"));
    const harness = buildHarness(clock);
    await harness.lifecycle.register({ id: "worker-1", host: "embedded", version: "0.1.0", capacity: 4 });

    const executionId = "exec-contended";
    await harness.executions.save({
      id: executionId,
      agentId: "agent-contended",
      status: "RUNNING",
      input: { task: "inspect" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      tenantId: "system",
      startedAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString()
    });

    await harness.leases.acquire({
      executionId,
      workerId: "worker-1",
      ttlMs: 50,
      now: clock.now()
    });

    clock.advance(5_000);

    // If two recover loops run concurrently, takeoverRecovery CAS prevents double recovery
    const reclaimed = await harness.leases.reclaimExpired(clock.now());
    expect(reclaimed.length).toBe(1);

    // Run first recovery - should succeed
    const recovered = await harness.scheduler.recover();
    expect(recovered).toBe(1);

    // Run recovery again on same reclaimed lease context - should do nothing
    const recoveredAgain = await harness.scheduler.recover();
    expect(recoveredAgain).toBe(0);
  });

  it("dead-letters a never-progressing execution after the recovery-resume cap instead of recovering it indefinitely", async () => {
    const clock = new ManualClock(new Date("2026-06-01T00:00:00Z"));
    // Poison-pill (lease-epoch) cap set high so it CANNOT be what stops the loop.
    // This isolates the recovery-resume cap: only the EXECUTION_RESUMED count can
    // terminate this scenario, proving the new bound (and not the pre-existing
    // lease.attempt cap) is what dead-letters the stuck execution.
    const harness = buildHarness(clock, { maxPoisonPillAttempts: 100, maxRecoveryAttempts: 3 });
    await harness.lifecycle.register({ id: "worker-1", host: "embedded", version: "0.1.0", capacity: 4 });

    // The agent must exist — recoverOneAdmitted re-drives through it, so a
    // missing agent would short-circuit recovery before it ever resumes.
    const agent = await harness.runtime.createAgent({
      name: "stuck-agent",
      goal: "investigate",
      tools: [{ name: "runtime.inspect", enabled: true }]
    });

    const executionId = "exec-never-progresses";
    await harness.executions.save({
      id: executionId,
      agentId: agent.id,
      status: "RUNNING",
      input: { task: "inspect" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      tenantId: "system",
      startedAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString()
    });

    // Acquire a lease and let it expire — the execution is reclaimable but never
    // makes forward progress (nothing consumes the re-enqueued job; mimics the
    // stuck-in-PLANNING loop where no provider/tool calls follow RESUMED).
    await harness.leases.acquire({ executionId, workerId: "worker-1", ttlMs: 50, now: clock.now() });

    // Drive many recovery cycles. Each cycle advances the clock past the lease TTL
    // so the RECOVERY_OWNED lease minted by the prior takeover re-expires and is
    // reclaimed again — the exact perpetual-recovery condition. Without the cap
    // this re-drives forever; with it the execution is finalized after the cap.
    let deadLetteredAtCycle = -1;
    for (let cycle = 0; cycle < 10; cycle++) {
      clock.advance(5_000); // exceed leaseTtlMs (1_000) so the lease re-expires
      await harness.scheduler.recover();
      const exec = await harness.executions.getById(executionId);
      if (exec!.status === "DEAD_LETTERED") {
        deadLetteredAtCycle = cycle;
        break;
      }
      // Until the cap is hit, every cycle re-drives it back to RECOVERING.
      expect(exec!.status).toBe("RECOVERING");
    }

    // It terminated (did NOT loop for all 10 cycles).
    expect(deadLetteredAtCycle).toBeGreaterThanOrEqual(0);

    const after = await harness.executions.getById(executionId);
    expect(after!.status).toBe("DEAD_LETTERED");
    expect(after!.failure?.recoverable).toBe(false);

    // Recorded in the DLQ for operator visibility (mirrors the poison-pill path).
    expect(await harness.deadLetterQueue.getByExecution(executionId)).toBeDefined();

    // It was resumed exactly the cap number of times — bounded, not indefinite.
    const resumes = (await harness.eventStore.listByExecution(executionId)).filter(
      (e) => e.type === "EXECUTION_RESUMED"
    ).length;
    expect(resumes).toBe(3);

    // The lease was terminalized, so a subsequent reclaim sweep does NOT
    // re-surface it and a further recovery is a no-op — the loop is truly over.
    clock.advance(5_000);
    const reSurfaced = await harness.leases.reclaimExpired(clock.now());
    expect(reSurfaced.map((l) => l.executionId)).not.toContain(executionId);
    const recoveredAgain = await harness.scheduler.recover();
    expect(recoveredAgain).toBe(0);
  });
});
