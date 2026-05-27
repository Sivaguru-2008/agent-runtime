import { describe, expect, it } from "vitest";
import pino from "pino";
import { SystemClock } from "../src/shared/clock.js";
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
import { InMemoryExecutionJobQueue } from "../src/infrastructure/queue/inMemoryExecutionJobQueue.js";
import { ExecutionEngine } from "../src/runtime/executionEngine.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import { WorkerExecutionLoop } from "../src/application/cluster/workerExecutionLoop.js";
import type { DomainEvent } from "../src/domain/events.js";
import type { Agent, Execution } from "../src/domain/model.js";
import type { ExecutionJob } from "../src/domain/jobQueue.js";
import type { ModelProvider } from "../src/domain/ports.js";
import { createId } from "../src/shared/id.js";

/**
 * End-to-end cancellation: a worker whose lease is revoked mid-execution
 * receives the abort via the heartbeat → loop → engine → model chain.
 *
 * Scenario: long-running model call, heartbeat detects lease loss, loop's
 * registered listener triggers controller.abort(), engine catches AbortError,
 * publishes EXECUTION_ABORTED with reason "lease-lost", returns
 * input.execution unchanged. The worker loop's reference-equality sentinel
 * routes the outcome to "fence-lost" → queue ack, no retry.
 */

/** Slow model that aborts on signal — same shape as the cancellation test's. */
class SlowAbortableModelProvider implements ModelProvider {
  async complete(input: Parameters<ModelProvider["complete"]>[0]): ReturnType<ModelProvider["complete"]> {
    return new Promise((resolve, reject) => {
      if (input.signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        clearTimeout(handle);
        reject(new DOMException("Aborted", "AbortError"));
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const handle = setTimeout(() => {
        input.signal?.removeEventListener("abort", onAbort);
        resolve({
          output: { result: "completed despite abort" },
          tokenUsage: { prompt: 5, completion: 5, total: 10 }
        });
      }, 10_000);
    });
  }
}

interface Harness {
  loop: WorkerExecutionLoop;
  queue: InMemoryExecutionJobQueue;
  agents: InMemoryAgentRepository;
  executions: InMemoryExecutionRepository;
  workers: InMemoryWorkerRegistry;
  leases: InMemoryLeaseStore;
  heartbeat: LeaseHeartbeatWorker;
  observedEvents: DomainEvent[];
  workerId: string;
}

function buildLoopHarness(): Harness {
  const clock = new SystemClock();
  const logger = pino({ level: "silent" });
  const workerId = "worker-abort-loss";

  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "abort-loss-test");

  const observedEvents: DomainEvent[] = [];
  bus.subscribe((event) => {
    observedEvents.push(event);
  });

  const agents = new InMemoryAgentRepository();
  const executions = new InMemoryExecutionRepository();
  const memory = new InMemoryMemoryRepository();
  const workers = new InMemoryWorkerRegistry();
  const leases = new InMemoryLeaseStore();
  const checkpoints = new InMemoryCheckpointStore();
  const deadLetterQueue = new InMemoryDeadLetterStore();
  const queue = new InMemoryExecutionJobQueue({ visibilityMs: 30_000 });

  const engine = new ExecutionEngine(
    eventFactory,
    publisher,
    executions,
    memory,
    new SlowAbortableModelProvider(),
    new BuiltInToolExecutor(),
    clock,
    { checkpoints, workerId }
  );

  const heartbeat = new LeaseHeartbeatWorker(leases, publisher, eventFactory, clock, logger, {
    workerId,
    leaseTtlMs: 100,
    renewThresholdFactor: 0.9,
    pollIntervalMs: 60_000
  });

  const loop = new WorkerExecutionLoop(
    engine,
    queue,
    executions,
    agents,
    leases,
    workers,
    publisher,
    eventFactory,
    clock,
    deadLetterQueue,
    heartbeat,
    logger,
    {
      workerId,
      leaseTtlMs: 100,
      maxAttempts: 3,
      retryBackoffBaseMs: 100,
      retryBackoffMaxMs: 1_000,
      consumerGroup: "test-group",
      queueBlockMs: 50
    }
  );

  return { loop, queue, agents, executions, workers, leases, heartbeat, observedEvents, workerId };
}

async function seedBusyAgentAndQueueJob(h: Harness): Promise<{
  agent: Agent;
  execution: Execution;
  job: ExecutionJob;
}> {
  const now = new Date().toISOString();
  await h.workers.register({
    id: h.workerId,
    host: "test-host",
    version: "0.1.0",
    capacity: 4,
    status: "READY",
    load: { cpu: 0, memory: 0, inFlight: 0, queueDepth: 0, eventsPerSecond: 0 },
    startedAt: now,
    lastHeartbeatAt: now
  });

  const agent: Agent = {
    id: "agent-abort-loss",
    name: "abort-loss-agent",
    goal: "exercise abort-on-lease-loss",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    tools: [{ name: "runtime.inspect", enabled: false }],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-abort-loss"
  };
  await h.agents.save(agent);

  const execution: Execution = {
    id: "exec-abort-loss",
    agentId: agent.id,
    status: "QUEUED",
    input: { prompt: "irrelevant" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-abort-loss"
  };
  await h.executions.save(execution);

  const job: ExecutionJob = {
    jobId: createId(),
    agentId: agent.id,
    executionId: execution.id,
    agentSnapshot: agent,
    executionSnapshot: execution,
    task: execution.input,
    enqueuedAt: now,
    attempt: 1,
    priorFailures: 0
  };
  await h.queue.enqueue(job);

  return { agent, execution, job };
}

async function waitForIdle(h: Harness, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (h.loop.inFlightCount() > 0) {
    if (Date.now() > deadline) {
      throw new Error(`worker loop never drained — inFlight=${h.loop.inFlightCount()}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("WorkerExecutionLoop abort-on-lease-loss", () => {
  it("(a) heartbeat reports lease lost → engine aborts mid-call → EXECUTION_ABORTED reason=lease-lost, agent untouched, queue ack'd no retry", async () => {
    const h = buildLoopHarness();
    const { agent, execution } = await seedBusyAgentAndQueueJob(h);

    // Start the worker — dispatches executeJob with a slow model call.
    const consumed = await h.loop.tick();
    expect(consumed).toBe(true);

    // Give the engine a microtask to enter the model call before we trigger
    // the lease loss. The heartbeat path is the one we want to exercise; the
    // engine's own pre-execute short-circuit would mask the loop-side wiring
    // if we fired the abort too early.
    await new Promise((r) => setTimeout(r, 30));

    // Simulate the heartbeat detecting lease loss. Since we don't actually
    // run heartbeat.start() (which would poll), we fire notifyLeaseLost
    // directly by invoking tick() after reclaiming the lease. The lease
    // store's reclaimByWorker flips the lease to RECLAIMED — which makes
    // leases.renew() return undefined on the heartbeat's next renewOne.
    await h.leases.reclaimByWorker(h.workerId, new Date());
    await h.heartbeat.tick();

    await waitForIdle(h);

    // Engine surrender contract: input.execution returned by reference →
    // the persisted row is still RUNNING (the engine's first save). It must
    // NOT have been mutated to FAILED by the catch branch.
    const persisted = await h.executions.getById(execution.id);
    expect(persisted?.status).toBe("RUNNING");

    // Bus: zero FAILED, exactly one ABORTED with reason "lease-lost".
    const failed = h.observedEvents.filter((e) => e.type === "EXECUTION_FAILED");
    expect(failed).toHaveLength(0);

    const aborted = h.observedEvents.filter((e) => e.type === "EXECUTION_ABORTED");
    expect(aborted).toHaveLength(1);
    const payload = aborted[0]!.payload as {
      executionId: string;
      workerId: string;
      reason: string;
    };
    expect(payload.executionId).toBe(execution.id);
    expect(payload.workerId).toBe(h.workerId);
    expect(payload.reason).toBe("lease-lost");

    // Agent must NOT have been touched by the stale worker's settle block.
    // Reference-equality return triggers the existing "fence-lost" branch
    // in workerExecutionLoop, which skips the agent settle.
    const settledAgent = await h.agents.getById(agent.id);
    expect(settledAgent?.runtimeStatus).toBe("BUSY");
    expect(settledAgent?.state).toBe("RUNNING");

    // Queue ack'd, no retry — fence-lost outcome does not re-enqueue.
    const depth = await h.queue.depth();
    expect(depth.ready + depth.inFlight + depth.delayed).toBe(0);

    const retryEvents = h.observedEvents.filter((e) => e.type === "RETRY_TRIGGERED");
    expect(retryEvents).toHaveLength(0);
  });
});
