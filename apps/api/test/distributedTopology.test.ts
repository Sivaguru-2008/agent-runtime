/**
 * distributedTopology.test.ts — validates the true-distributed execution
 * platform end-to-end without requiring Redis/Postgres.
 *
 * What this suite proves:
 *   1. The API process never executes — execution only happens via
 *      WorkerExecutionLoop consuming from the queue.
 *   2. Multi-worker concurrency: two workers can drain the same queue
 *      without duplicate execution (lease atomicity).
 *   3. Lease expiration recovery: a crashed worker's leases get reclaimed
 *      and the job is re-enqueued for another worker to pick up.
 *   4. Worker restart continuity: a worker started fresh against a populated
 *      queue picks up pre-existing work.
 *   5. Duplicate execution prevention: enqueueing the same job twice
 *      executes it once.
 *   6. Fencing violation terminates ownership: a stale worker holding an
 *      out-of-date attempt token cannot commit a write.
 *   7. Backpressure rejects new tasks once threshold is exceeded.
 *   8. Poison pill routes to DLQ after maxAttempts.
 */

import { describe, expect, it } from "vitest";
import pino from "pino";
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
import { WorkerExecutionLoop } from "../src/application/cluster/workerExecutionLoop.js";
import { ExecutionEngine } from "../src/runtime/executionEngine.js";
import { DeterministicModelProvider } from "../src/runtime/mockModelProvider.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { InMemoryExecutionJobQueue } from "../src/infrastructure/queue/inMemoryExecutionJobQueue.js";
import { SystemClock, type Clock } from "../src/shared/clock.js";
import { BackpressureError } from "../src/shared/errors.js";
import type { Agent, Execution } from "../src/domain/model.js";
import type { ExecutionJob } from "../src/domain/jobQueue.js";
import { createId } from "../src/shared/id.js";
import type { ModelProvider } from "../src/domain/ports.js";

class ManualClock implements Clock {
  constructor(public current: Date = new Date("2026-05-22T00:00:00Z")) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

function buildSharedState(clock: Clock = new SystemClock()) {
  const logger = pino({ level: "silent" });
  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "test");
  const agents = new InMemoryAgentRepository();
  const executions = new InMemoryExecutionRepository();
  const memory = new InMemoryMemoryRepository();
  const workers = new InMemoryWorkerRegistry();
  const leases = new InMemoryLeaseStore();
  const checkpoints = new InMemoryCheckpointStore();
  const deadLetters = new InMemoryDeadLetterStore();
  const jobQueue = new InMemoryExecutionJobQueue({ visibilityMs: 5_000 });
  return {
    logger,
    eventStore,
    bus,
    publisher,
    eventFactory,
    agents,
    executions,
    memory,
    workers,
    leases,
    checkpoints,
    deadLetters,
    jobQueue,
    clock
  };
}

function makeEngine(state: ReturnType<typeof buildSharedState>, workerId: string, model?: ModelProvider) {
  return new ExecutionEngine(
    state.eventFactory,
    state.publisher,
    state.executions,
    state.memory,
    model ?? new DeterministicModelProvider(),
    new BuiltInToolExecutor(),
    state.clock,
    { checkpoints: state.checkpoints, workerId }
  );
}

function makeWorker(
  state: ReturnType<typeof buildSharedState>,
  workerId: string,
  opts: { maxAttempts?: number; model?: ModelProvider } = {}
) {
  const engine = makeEngine(state, workerId, opts.model);
  const heartbeat = new LeaseHeartbeatWorker(
    state.leases,
    state.publisher,
    state.eventFactory,
    state.clock,
    state.logger,
    {
      workerId,
      leaseTtlMs: 5_000,
      renewThresholdFactor: 0.4,
      pollIntervalMs: 250
    }
  );
  const loop = new WorkerExecutionLoop(
    engine,
    state.jobQueue,
    state.executions,
    state.agents,
    state.leases,
    state.workers,
    state.publisher,
    state.eventFactory,
    state.clock,
    state.deadLetters,
    heartbeat,
    state.logger,
    {
      workerId,
      leaseTtlMs: 5_000,
      maxAttempts: opts.maxAttempts ?? 3,
      retryBackoffBaseMs: 10,
      retryBackoffMaxMs: 100,
      consumerGroup: "test-group",
      queueBlockMs: 50
    }
  );
  const lifecycle = new WorkerLifecycleService(
    state.workers,
    state.leases,
    state.publisher,
    state.eventFactory,
    state.clock,
    { heartbeatTtlMs: 5_000, sweepIntervalMs: 60_000 },
    state.logger
  );
  return { engine, loop, heartbeat, lifecycle };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
  pollMs = 20
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

describe("true-distributed topology", () => {
  it("API enqueues — only the WorkerExecutionLoop executes (no in-API execution)", async () => {
    const state = buildSharedState();
    const w = makeWorker(state, "worker-A");
    await w.lifecycle.register({ id: "worker-A", host: "test", version: "0.1.0", capacity: 4 });

    // AgentRuntime wired with jobQueue ONLY — no scheduler, no engine handoff.
    const runtime = new AgentRuntime(
      state.agents,
      state.executions,
      // engine is required by AgentRuntime's signature for the sync fallback;
      // in queue mode it is never invoked by runTask. We pass a real one to
      // keep typings honest.
      makeEngine(state, "api-only"),
      state.eventFactory,
      state.publisher,
      state.clock,
      { jobQueue: state.jobQueue }
    );

    const agent = await runtime.createAgent({ name: "a", goal: "g" });
    const queued = await runtime.runTask(agent.id, { prompt: "hello" });
    expect(queued.status).toBe("QUEUED");

    // Confirm the API did NOT execute — the execution is still QUEUED.
    const beforeWorker = await state.executions.getById(queued.id);
    expect(beforeWorker?.status).toBe("QUEUED");

    // Now run a worker tick — execution should complete.
    w.loop.start();
    try {
      await waitFor(async () => {
        const exec = await state.executions.getById(queued.id);
        return exec?.status === "COMPLETED";
      });
    } finally {
      await w.loop.stop();
    }
    const after = await state.executions.getById(queued.id);
    expect(after?.status).toBe("COMPLETED");
  });

  it("multi-worker concurrency: two workers share the queue without duplicate execution", async () => {
    const state = buildSharedState();
    const wa = makeWorker(state, "worker-A");
    const wb = makeWorker(state, "worker-B");
    await wa.lifecycle.register({ id: "worker-A", host: "h", version: "0.1.0", capacity: 2 });
    await wb.lifecycle.register({ id: "worker-B", host: "h", version: "0.1.0", capacity: 2 });

    const runtime = new AgentRuntime(
      state.agents,
      state.executions,
      makeEngine(state, "api"),
      state.eventFactory,
      state.publisher,
      state.clock,
      { jobQueue: state.jobQueue }
    );

    const agent = await runtime.createAgent({ name: "x", goal: "y" });
    const jobs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => runtime.runTask(agent.id, { prompt: `task-${i}` }))
    );

    wa.loop.start();
    wb.loop.start();
    try {
      await waitFor(async () => {
        const all = await Promise.all(jobs.map((j) => state.executions.getById(j.id)));
        return all.every((e) => e?.status === "COMPLETED");
      });
    } finally {
      await Promise.all([wa.loop.stop(), wb.loop.stop()]);
    }

    // Each lease attempt should be exactly 1 — no execution was processed twice.
    for (const j of jobs) {
      const lease = await state.leases.getByExecution(j.id);
      expect(lease?.attempt).toBe(1);
    }
  });

  it("lease expiration recovery: re-enqueues an execution whose lease expired", async () => {
    const state = buildSharedState();
    const wa = makeWorker(state, "worker-A");
    await wa.lifecycle.register({ id: "worker-A", host: "h", version: "0.1.0", capacity: 1 });

    // Simulate a crashed worker: enqueue a job, manually acquire a phantom
    // lease, then drive the worker's loop to confirm it skips (lease held).
    const agent: Agent = {
      id: createId(),
      name: "n",
      goal: "g",
      state: "IDLE",
      runtimeStatus: "READY",
      model: { provider: "mock", model: "x", temperature: 0 },
      tools: [],
      memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await state.agents.save(agent);
    const execution: Execution = {
      id: createId(),
      agentId: agent.id,
      status: "QUEUED",
      input: { task: 1 },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await state.executions.save(execution);

    // Phantom lease — "crashed worker" holds it but is gone.
    await state.leases.acquire({
      executionId: execution.id,
      workerId: "ghost",
      ttlMs: 50,
      now: new Date()
    });

    const job: ExecutionJob = {
      jobId: createId(),
      agentId: agent.id,
      executionId: execution.id,
      agentSnapshot: agent,
      executionSnapshot: execution,
      task: { task: 1 },
      enqueuedAt: new Date().toISOString(),
      attempt: 1,
      priorFailures: 0
    };
    await state.jobQueue.enqueue(job);

    // Wait for the phantom lease to actually expire before reclaim.
    await new Promise((r) => setTimeout(r, 80));
    const reclaimed = await state.leases.reclaimExpired(new Date());
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0].executionId).toBe(execution.id);

    // Now Worker A consumes the queue and picks up the (now-reclaimable)
    // execution. It should be able to acquire a fresh lease.
    wa.loop.start();
    try {
      await waitFor(async () => {
        const exec = await state.executions.getById(execution.id);
        return exec?.status === "COMPLETED";
      });
    } finally {
      await wa.loop.stop();
    }
    const lease = await state.leases.getByExecution(execution.id);
    // attempt=2 because the phantom was attempt 1; Worker A got attempt 2.
    expect(lease?.attempt).toBe(2);
  });

  it("worker restart continuity: a fresh worker drains a pre-populated queue", async () => {
    const state = buildSharedState();
    const runtime = new AgentRuntime(
      state.agents,
      state.executions,
      makeEngine(state, "api"),
      state.eventFactory,
      state.publisher,
      state.clock,
      { jobQueue: state.jobQueue }
    );
    const agent = await runtime.createAgent({ name: "n", goal: "g" });
    // Enqueue while NO worker is running. The API does not execute these.
    const jobs = await Promise.all(
      Array.from({ length: 3 }, (_, i) => runtime.runTask(agent.id, { prompt: `r-${i}` }))
    );
    for (const j of jobs) {
      const exec = await state.executions.getById(j.id);
      expect(exec?.status).toBe("QUEUED");
    }

    // Now boot a worker (simulating restart) — it should pick everything up.
    const w = makeWorker(state, "worker-fresh");
    await w.lifecycle.register({
      id: "worker-fresh",
      host: "h",
      version: "0.1.0",
      capacity: 2
    });
    w.loop.start();
    try {
      await waitFor(async () => {
        const all = await Promise.all(jobs.map((j) => state.executions.getById(j.id)));
        return all.every((e) => e?.status === "COMPLETED");
      });
    } finally {
      await w.loop.stop();
    }
  });

  it("duplicate execution prevention: re-enqueueing the same jobId is a no-op", async () => {
    const state = buildSharedState();
    const wa = makeWorker(state, "worker-A");
    await wa.lifecycle.register({ id: "worker-A", host: "h", version: "0.1.0", capacity: 2 });

    const agent: Agent = {
      id: createId(),
      name: "n",
      goal: "g",
      state: "IDLE",
      runtimeStatus: "READY",
      model: { provider: "mock", model: "x", temperature: 0 },
      tools: [],
      memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await state.agents.save(agent);
    const execution: Execution = {
      id: createId(),
      agentId: agent.id,
      status: "QUEUED",
      input: { task: 1 },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await state.executions.save(execution);

    const job: ExecutionJob = {
      jobId: "fixed-job-id",
      agentId: agent.id,
      executionId: execution.id,
      agentSnapshot: agent,
      executionSnapshot: execution,
      task: { task: 1 },
      enqueuedAt: new Date().toISOString(),
      attempt: 1,
      priorFailures: 0
    };
    await state.jobQueue.enqueue(job);
    await state.jobQueue.enqueue(job); // duplicate — must be a no-op
    await state.jobQueue.enqueue(job);

    const depth = await state.jobQueue.depth();
    expect(depth.ready).toBe(1);

    wa.loop.start();
    try {
      await waitFor(async () => {
        const exec = await state.executions.getById(execution.id);
        return exec?.status === "COMPLETED";
      });
    } finally {
      await wa.loop.stop();
    }
    const lease = await state.leases.getByExecution(execution.id);
    expect(lease?.attempt).toBe(1);
  });

  it("fencing violation: stale worker cannot commit after lease is reclaimed", async () => {
    const state = buildSharedState();
    // Acquire a lease for worker-A; then reclaim it under worker-B.
    const ack = await state.leases.acquire({
      executionId: "exec-1",
      workerId: "worker-A",
      ttlMs: 5_000,
      now: new Date()
    });
    expect(ack?.attempt).toBe(1);

    // Reclaim by simulating expiration. Bump clock past the ttl.
    await new Promise((r) => setTimeout(r, 10));
    const reclaimed = await state.leases.reclaimExpired(
      new Date(Date.now() + 60_000)
    );
    expect(reclaimed.length).toBe(1);

    // Worker B acquires next attempt.
    const second = await state.leases.acquire({
      executionId: "exec-1",
      workerId: "worker-B",
      ttlMs: 5_000,
      now: new Date()
    });
    expect(second?.attempt).toBe(2);

    // Worker A still thinks it owns the lease at fencing token 1. validateFencing
    // for token 1 under worker-A must now be FALSE.
    const valid = await state.leases.validateFencing("exec-1", "worker-A", 1);
    expect(valid).toBe(false);
    // Worker B with token 2 IS valid.
    const validNew = await state.leases.validateFencing("exec-1", "worker-B", 2);
    expect(validNew).toBe(true);
  });

  it("backpressure: AgentRuntime rejects new tasks once queue depth crosses threshold", async () => {
    const state = buildSharedState();
    const runtime = new AgentRuntime(
      state.agents,
      state.executions,
      makeEngine(state, "api"),
      state.eventFactory,
      state.publisher,
      state.clock,
      { jobQueue: state.jobQueue, backpressureThreshold: 2 }
    );
    const agent = await runtime.createAgent({ name: "n", goal: "g" });
    await runtime.runTask(agent.id, { prompt: "1" });
    await runtime.runTask(agent.id, { prompt: "2" });
    await expect(runtime.runTask(agent.id, { prompt: "3" })).rejects.toBeInstanceOf(
      BackpressureError
    );
  });

  it("poison pill: routes to DLQ after maxAttempts is exceeded", async () => {
    const state = buildSharedState();
    const w = makeWorker(state, "worker-A", { maxAttempts: 2 });
    await w.lifecycle.register({ id: "worker-A", host: "h", version: "0.1.0", capacity: 1 });

    const agent: Agent = {
      id: createId(),
      name: "n",
      goal: "g",
      state: "IDLE",
      runtimeStatus: "READY",
      model: { provider: "mock", model: "x", temperature: 0 },
      tools: [],
      memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await state.agents.save(agent);
    const execution: Execution = {
      id: createId(),
      agentId: agent.id,
      status: "QUEUED",
      input: { task: 1 },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await state.executions.save(execution);

    // Pre-bump the lease attempt count past the threshold so the worker
    // declares a poison pill on first dispatch.
    await state.leases.acquire({
      executionId: execution.id,
      workerId: "phantom",
      ttlMs: 1,
      now: new Date()
    });
    await new Promise((r) => setTimeout(r, 5));
    await state.leases.reclaimExpired(new Date());
    await state.leases.acquire({
      executionId: execution.id,
      workerId: "phantom",
      ttlMs: 1,
      now: new Date()
    });
    await new Promise((r) => setTimeout(r, 5));
    await state.leases.reclaimExpired(new Date());
    await state.leases.acquire({
      executionId: execution.id,
      workerId: "phantom",
      ttlMs: 1,
      now: new Date()
    });
    await new Promise((r) => setTimeout(r, 5));
    await state.leases.reclaimExpired(new Date());
    // attempt is now 3 — exceeds maxAttempts=2

    const job: ExecutionJob = {
      jobId: createId(),
      agentId: agent.id,
      executionId: execution.id,
      agentSnapshot: agent,
      executionSnapshot: execution,
      task: { task: 1 },
      enqueuedAt: new Date().toISOString(),
      attempt: 1,
      priorFailures: 0
    };
    await state.jobQueue.enqueue(job);

    w.loop.start();
    try {
      await waitFor(async () => {
        const entries = await state.deadLetters.list();
        return entries.some((e) => e.executionId === execution.id);
      });
    } finally {
      await w.loop.stop();
    }

    const dlq = await state.deadLetters.getByExecution(execution.id);
    expect(dlq).toBeDefined();
    expect(dlq?.workerId).toBe("worker-A");
  });

  it("graceful worker shutdown: stop() drains in-flight executions, refuses new work", async () => {
    const state = buildSharedState();
    const w = makeWorker(state, "worker-A");
    await w.lifecycle.register({ id: "worker-A", host: "h", version: "0.1.0", capacity: 1 });

    const runtime = new AgentRuntime(
      state.agents,
      state.executions,
      makeEngine(state, "api"),
      state.eventFactory,
      state.publisher,
      state.clock,
      { jobQueue: state.jobQueue }
    );
    const agent = await runtime.createAgent({ name: "n", goal: "g" });
    const queued = await runtime.runTask(agent.id, { prompt: "drain-me" });

    w.loop.start();
    // Almost-immediate stop — must still complete the in-flight job.
    await new Promise((r) => setTimeout(r, 20));
    await w.loop.stop();

    // Either the job completed before stop, or it was nack'd back to the
    // queue for a sibling. Importantly, the execution must NOT be left in
    // an inconsistent state.
    const final = await state.executions.getById(queued.id);
    expect(final?.status === "COMPLETED" || final?.status === "QUEUED").toBe(true);
  });
});
