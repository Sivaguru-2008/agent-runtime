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
import { DeterministicModelProvider } from "../src/runtime/mockModelProvider.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import { WorkerExecutionLoop } from "../src/application/cluster/workerExecutionLoop.js";
import type { DomainEvent } from "../src/domain/events.js";
import type { Agent, Execution } from "../src/domain/model.js";
import type { ExecutionJob } from "../src/domain/jobQueue.js";
import type { ModelProvider } from "../src/domain/ports.js";
import type { LeaseStore } from "../src/domain/clusterPorts.js";
import { createId } from "../src/shared/id.js";

/**
 * Fencing awareness in WorkerExecutionLoop.
 *
 * Background: ExecutionEngine.execute() now refuses to write FAILED when the
 * lease was lost (returns input.execution unchanged + publishes
 * EXECUTION_FENCE_REJECTED). Pre-fix, the worker loop's post-execute settle
 * block would still read the latest agent and overwrite its runtimeStatus
 * with IDLE/READY — corrupting state owned by the legitimate new worker.
 *
 * These tests pin the corrected loop behavior:
 *   (a) Happy path: agent BUSY → loop runs → agent IDLE/READY.
 *   (b) Fence rejected: agent BUSY → loop runs but lease was reclaimed
 *       mid-execution → agent still BUSY (loop must NOT settle), and the
 *       outcome must be classified as "fence-lost" (ack queue, no retry).
 */

/**
 * Model provider that reclaims the worker's lease (simulating a competing
 * worker's takeover) immediately before throwing. The subsequent fencing
 * check in the engine's catch branch will therefore fail.
 */
class FenceLosingModelProvider implements ModelProvider {
  constructor(
    private readonly leases: LeaseStore,
    private readonly workerId: string,
    private readonly clock: SystemClock
  ) {}
  async complete(): ReturnType<ModelProvider["complete"]> {
    await this.leases.reclaimByWorker(this.workerId, this.clock.now());
    throw new Error("simulated provider failure mid-execution");
  }
}

interface Harness {
  loop: WorkerExecutionLoop;
  queue: InMemoryExecutionJobQueue;
  agents: InMemoryAgentRepository;
  executions: InMemoryExecutionRepository;
  workers: InMemoryWorkerRegistry;
  leases: InMemoryLeaseStore;
  observedEvents: DomainEvent[];
  workerId: string;
}

function buildLoopHarness(
  buildModelProvider: ModelProvider | ((deps: { leases: LeaseStore; clock: SystemClock; workerId: string }) => ModelProvider)
): Harness {
  const clock = new SystemClock();
  const logger = pino({ level: "silent" });
  const workerId = "worker-stale";

  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "worker-fencing-test");

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

  const modelProvider =
    typeof buildModelProvider === "function"
      ? buildModelProvider({ leases, clock, workerId })
      : buildModelProvider;

  const engine = new ExecutionEngine(
    eventFactory,
    publisher,
    executions,
    memory,
    modelProvider,
    new BuiltInToolExecutor(),
    clock,
    { checkpoints, workerId }
  );

  // Heartbeat worker is constructed but never .start()-ed; the test drives
  // executeJob via tick(), and track/untrack are synchronous map operations.
  const heartbeat = new LeaseHeartbeatWorker(leases, publisher, eventFactory, clock, logger, {
    workerId,
    leaseTtlMs: 60_000,
    renewThresholdFactor: 0.4,
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
      leaseTtlMs: 60_000,
      maxAttempts: 3,
      retryBackoffBaseMs: 100,
      retryBackoffMaxMs: 1_000,
      consumerGroup: "test-group",
      queueBlockMs: 50
    }
  );

  return { loop, queue, agents, executions, workers, leases, observedEvents, workerId };
}

/**
 * `loop.tick()` consumes a queue message and *dispatches* executeJob as
 * fire-and-forget so the worker can keep pulling at capacity. To make the
 * tests deterministic we poll inFlightCount until it drains, then return.
 */
async function waitForIdle(h: Harness, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (h.loop.inFlightCount() > 0) {
    if (Date.now() > deadline) {
      throw new Error(`worker loop never drained — inFlight=${h.loop.inFlightCount()}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
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
    id: "agent-fencing-loop",
    name: "loop-fencing-agent",
    goal: "exercise loop settle behavior under fencing",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    // No enabled tool: engine path = PLAN → MEMORY → MODEL (no tool step).
    tools: [{ name: "runtime.inspect", enabled: false }],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-loop-fencing"
  };
  await h.agents.save(agent);

  const execution: Execution = {
    id: "exec-loop-fencing",
    agentId: agent.id,
    status: "QUEUED",
    input: { prompt: "irrelevant" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-loop-fencing"
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

describe("WorkerExecutionLoop fencing-rejection awareness", () => {
  it("(a) happy path settles BUSY agent to IDLE/READY", async () => {
    const h = buildLoopHarness(new DeterministicModelProvider());
    const { agent } = await seedBusyAgentAndQueueJob(h);

    const consumed = await h.loop.tick();
    expect(consumed).toBe(true);
    await waitForIdle(h);

    const settled = await h.agents.getById(agent.id);
    expect(settled?.runtimeStatus).toBe("READY");
    expect(settled?.state).toBe("IDLE");

    // Queue empty — job was ack'd, not nack'd or re-enqueued.
    const depth = await h.queue.depth();
    expect(depth.ready + depth.inFlight + depth.delayed).toBe(0);
  });

  it("(b) fence rejection leaves agent BUSY, emits EXECUTION_FENCE_REJECTED, suppresses EXECUTION_FAILED, acks queue without retry", async () => {
    const h = buildLoopHarness(({ leases, clock, workerId }) => new FenceLosingModelProvider(leases, workerId, clock));
    const { agent } = await seedBusyAgentAndQueueJob(h);

    const consumed = await h.loop.tick();
    expect(consumed).toBe(true);
    await waitForIdle(h);

    // Agent runtimeStatus MUST remain BUSY — the stale worker must not stomp.
    const settled = await h.agents.getById(agent.id);
    expect(settled?.runtimeStatus).toBe("BUSY");
    expect(settled?.state).toBe("RUNNING");

    // Bus: EXECUTION_FAILED suppressed, exactly one EXECUTION_FENCE_REJECTED.
    const failedEvents = h.observedEvents.filter((e) => e.type === "EXECUTION_FAILED");
    expect(failedEvents).toHaveLength(0);

    const rejectedEvents = h.observedEvents.filter((e) => e.type === "EXECUTION_FENCE_REJECTED");
    expect(rejectedEvents).toHaveLength(1);

    // Queue: ack'd, no retry. fence-loss outcome must NOT trigger nack /
    // re-enqueue (the winner owns the result).
    const depth = await h.queue.depth();
    expect(depth.ready + depth.inFlight + depth.delayed).toBe(0);

    // RETRY_TRIGGERED must NOT fire on a fence-rejected outcome.
    const retryEvents = h.observedEvents.filter((e) => e.type === "RETRY_TRIGGERED");
    expect(retryEvents).toHaveLength(0);
  });
});
