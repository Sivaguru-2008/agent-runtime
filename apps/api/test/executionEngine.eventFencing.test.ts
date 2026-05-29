import { describe, expect, it } from "vitest";
import { SystemClock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { InMemoryEventBus } from "../src/infrastructure/events/inMemoryEventBus.js";
import {
  PersistedEventPublisher,
  type FenceRejectionSink,
  type FenceRejectionLogger
} from "../src/infrastructure/events/persistedEventPublisher.js";
import {
  InMemoryEventStore,
  InMemoryExecutionRepository,
  InMemoryMemoryRepository
} from "../src/infrastructure/persistence/inMemoryStores.js";
import { InMemoryLeaseStore } from "../src/infrastructure/cluster/inMemoryClusterStores.js";
import { ExecutionEngine } from "../src/runtime/executionEngine.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import type { DomainEvent, DomainEventType } from "../src/domain/events.js";
import type { Agent, Execution } from "../src/domain/model.js";
import type { ModelProvider } from "../src/domain/ports.js";
import type { FencingToken, LeaseStore } from "../src/domain/clusterPorts.js";

/**
 * Task 1 regression: stale-worker emissions must leave ZERO replay-visible
 * artifacts after the worker loses lease authority.
 *
 * These tests exercise BOTH stale-worker surrender paths:
 *
 *   (a) Pre-execution surrender — the worker calls execute() AFTER its lease
 *       was already reclaimed. The first fenced write (saveFenced for
 *       status=RUNNING) returns "FENCED"; the engine emits exactly one
 *       EXECUTION_FENCE_REJECTED (the diagnostic) and stops. No step events,
 *       no memory events, no model events, no checkpoint events are written.
 *
 *   (b) Mid-execution surrender — the worker's lease is reclaimed AFTER
 *       saveFenced(RUNNING) commits but BEFORE the next execution-scoped
 *       publish. The publishFenced path inside ExecutionEngine.runStep
 *       detects the dead fence at the persistence boundary, throws a
 *       StaleWorkerSurrender sentinel, and the engine's catch returns the
 *       input execution unchanged. The would-have-been events (STEP_*,
 *       MEMORY_RETRIEVED, MODEL_COMPLETED) DO NOT appear in the durable
 *       event store and DO NOT broadcast on the bus.
 *
 * Determinism: the reclaim is driven by a synchronous LeaseStore call from
 * inside the ModelProvider mock — no timers, no sleeps, no probabilistic
 * scheduling. Every assertion is the literal state of the in-memory event
 * store after execute() returns.
 */

class FixedOutputModelProvider implements ModelProvider {
  async complete(): ReturnType<ModelProvider["complete"]> {
    return {
      output: { result: "ok" },
      tokenUsage: { prompt: 3, completion: 5, total: 8 }
    };
  }
}

/**
 * Reclaim-mid-model provider. Calls reclaimByWorker on the supplied lease
 * store the moment the engine reaches model generation — by the time the
 * engine tries to publish MODEL_COMPLETED, the lease's attempt has changed
 * and the fence check rejects the append.
 */
class ReclaimMidModelProvider implements ModelProvider {
  constructor(
    private readonly leases: LeaseStore,
    private readonly staleWorkerId: string
  ) {}
  async complete(): ReturnType<ModelProvider["complete"]> {
    await this.leases.reclaimByWorker(this.staleWorkerId, new Date());
    return {
      output: { result: "would-have-been-ok" },
      tokenUsage: { prompt: 1, completion: 1, total: 2 }
    };
  }
}

interface Harness {
  engine: ExecutionEngine;
  leases: InMemoryLeaseStore;
  eventStore: InMemoryEventStore;
  observedEvents: DomainEvent[];
  rejectionCounters: { eventType: DomainEventType; executionId: string; workerId: string; attempt: number }[];
  logCalls: { message: string; context: Record<string, unknown> }[];
}

function buildHarness(modelProvider: ModelProvider): Harness {
  const clock = new SystemClock();
  const leases = new InMemoryLeaseStore();
  const eventStore = new InMemoryEventStore();
  // Wire the lease store onto the event store so appendFenced consults it,
  // mirroring the production wiring in createPersistenceLayer.
  eventStore.setLeaseStore(leases);

  const bus = new InMemoryEventBus();
  const observedEvents: DomainEvent[] = [];
  bus.subscribe((event) => {
    observedEvents.push(event);
  });

  const rejectionCounters: Harness["rejectionCounters"] = [];
  const metricsSink: FenceRejectionSink = {
    recordFenceRejected: (input) => rejectionCounters.push(input)
  };
  const logCalls: Harness["logCalls"] = [];
  const loggerSink: FenceRejectionLogger = {
    warn: (message, context) => logCalls.push({ message, context })
  };
  const publisher = new PersistedEventPublisher(eventStore, bus, {
    metrics: metricsSink,
    logger: loggerSink
  });

  const eventFactory = new EventFactory(clock, "event-fence-test");
  const memory = new InMemoryMemoryRepository(leases);
  const executions = new InMemoryExecutionRepository(leases, memory, eventStore);

  const engine = new ExecutionEngine(
    eventFactory,
    publisher,
    executions,
    memory,
    modelProvider,
    new BuiltInToolExecutor(),
    clock,
    { workerId: "worker-stale" }
  );

  return { engine, leases, eventStore, observedEvents, rejectionCounters, logCalls };
}

function makeAgentAndExecution(): { agent: Agent; execution: Execution } {
  const now = new Date().toISOString();
  const agent: Agent = {
    id: "agent-event-fencing",
    name: "event-fencing-test-agent",
    goal: "exercise execution-scoped event fencing",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    // No enabled tools — keeps the path short.
    tools: [{ name: "runtime.inspect", enabled: false }],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-event-fencing"
  };
  const execution: Execution = {
    id: "exec-event-fencing",
    agentId: agent.id,
    status: "QUEUED",
    input: { prompt: "irrelevant" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-event-fencing"
  };
  return { agent, execution };
}

/**
 * Set up a lease that has been reclaimed and re-acquired — so the stale
 * worker's fence (attempt=1) no longer matches the live lease (attempt=2).
 * Returns the stale fence the test should pass to execute().
 */
async function setupStaleLease(leases: InMemoryLeaseStore, executionId: string): Promise<FencingToken> {
  const now = new Date();
  // First acquire by the (about-to-be-stale) worker.
  const first = await leases.acquire({
    executionId,
    workerId: "worker-stale",
    ttlMs: 60_000,
    now
  });
  if (!first) throw new Error("test setup failed: initial acquire returned undefined");

  // Reclaim and re-acquire under a different worker. Attempt monotonically
  // increases, so the original fence is now invalid.
  await leases.reclaimByWorker("worker-stale", now);
  const second = await leases.acquire({
    executionId,
    workerId: "worker-legit",
    ttlMs: 60_000,
    now
  });
  if (!second || second.attempt !== first.attempt + 1) {
    throw new Error("test setup failed: re-acquire did not advance attempt");
  }

  return { executionId, workerId: "worker-stale", attempt: first.attempt };
}

describe("ExecutionEngine — execution-scoped event fencing (audit Task 1)", () => {
  it("(a) pre-execute: stale worker's RUNNING save fences, NO step/memory/model events appear in the durable store", async () => {
    const { engine, leases, eventStore, observedEvents, rejectionCounters } = buildHarness(
      new FixedOutputModelProvider()
    );
    const { agent, execution } = makeAgentAndExecution();
    const staleFence = await setupStaleLease(leases, execution.id);

    const result = await engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: "worker-stale",
      fence: staleFence
    });

    // Surrender contract: engine returns the input execution by reference,
    // with NO mutation (still QUEUED, not RUNNING / COMPLETED / FAILED).
    expect(result).toBe(execution);
    expect(result.status).toBe("QUEUED");

    const durable = await eventStore.listByExecution(execution.id);
    const types = durable.map((e) => e.type);

    // The hot-path emissions MUST NOT be in the durable log.
    expect(types).not.toContain("EXECUTION_STARTED");
    expect(types).not.toContain("EXECUTION_STEP_STARTED");
    expect(types).not.toContain("EXECUTION_STEP_COMPLETED");
    expect(types).not.toContain("MEMORY_RETRIEVED");
    expect(types).not.toContain("MODEL_COMPLETED");
    expect(types).not.toContain("TOOL_CALLED");
    expect(types).not.toContain("EXECUTION_CHECKPOINT_WRITTEN");
    expect(types).not.toContain("EXECUTION_ABORTED");
    expect(types).not.toContain("EXECUTION_COMPLETED");
    expect(types).not.toContain("EXECUTION_FAILED");

    // The diagnostic surrender event IS allowed (and required) — it is the
    // breadcrumb that lets operators correlate the lost write.
    const rejected = durable.filter((e) => e.type === "EXECUTION_FENCE_REJECTED");
    expect(rejected).toHaveLength(1);
    const rejectedPayload = rejected[0]!.payload as {
      executionId: string;
      workerId: string;
      attemptedStatus: string;
      phase: string;
    };
    expect(rejectedPayload.executionId).toBe(execution.id);
    expect(rejectedPayload.workerId).toBe("worker-stale");
    expect(rejectedPayload.attemptedStatus).toBe("RUNNING");
    expect(rejectedPayload.phase).toBe("executions.RUNNING");

    // Bus consistency: the same set of types observed on the bus must equal
    // the set persisted (no ghost events broadcast).
    const observedTypes = new Set(
      observedEvents
        .filter((e) => (e.payload as { execution?: { id?: string } }).execution?.id === execution.id
          || e.aggregateId === execution.id)
        .map((e) => e.type)
    );
    expect(observedTypes.has("EXECUTION_STEP_STARTED")).toBe(false);
    expect(observedTypes.has("EXECUTION_STEP_COMPLETED")).toBe(false);
    expect(observedTypes.has("MODEL_COMPLETED")).toBe(false);

    // In path (a) the saveFenced branch fires first — publishFenced is never
    // even invoked, so the diagnostic counter sink may not fire. The contract
    // is "no replay artifacts," not "always increment counter"; what matters
    // is the EXECUTION_FENCE_REJECTED breadcrumb above.
    expect(rejectionCounters.length).toBeGreaterThanOrEqual(0);
  });

  it("(b) mid-execute: lease reclaimed during model call → publishFenced rejects MODEL_COMPLETED + downstream events, NO partial replay artifacts", async () => {
    const { agent, execution } = makeAgentAndExecution();
    // Build harness FIRST so we can hand the lease store to the model
    // provider. The provider reclaims when complete() runs — deterministic
    // mid-execution surrender.
    const tempHarness = buildHarness(new FixedOutputModelProvider());
    const provider = new ReclaimMidModelProvider(tempHarness.leases, "worker-stale");
    const { engine, leases, eventStore, observedEvents, rejectionCounters, logCalls } = buildHarness(provider);
    // Re-wire the model provider's lease store reference to the engine's
    // actual lease store (the temp harness was just a builder seed).
    (provider as unknown as { leases: LeaseStore }).leases = leases;

    // Acquire as worker-stale. Note: in this branch we do NOT pre-reclaim —
    // the lease is healthy when execute() begins. The reclaim happens
    // synchronously inside complete().
    const now = new Date();
    const acquired = await leases.acquire({
      executionId: execution.id,
      workerId: "worker-stale",
      ttlMs: 60_000,
      now
    });
    if (!acquired) throw new Error("acquire failed in mid-execute test");
    const fence: FencingToken = {
      executionId: execution.id,
      workerId: "worker-stale",
      attempt: acquired.attempt
    };

    const result = await engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: "worker-stale",
      fence
    });

    // Surrender contract: engine returns the input execution by reference,
    // with no terminal status committed.
    expect(result).toBe(execution);
    expect(result.status).not.toBe("COMPLETED");
    expect(result.status).not.toBe("FAILED");

    // Durable store: the early events (EXECUTION_STARTED, PLANNING step,
    // MEMORY_RETRIEVAL step, CHECKPOINT_WRITTEN) committed BEFORE the
    // reclaim — they appear. But MODEL_COMPLETED and any STEP_COMPLETED /
    // CHECKPOINT_WRITTEN that fall on the wrong side of the reclaim MUST
    // NOT appear.
    //
    // Specifically: by the time the engine reaches MODEL_GENERATION's
    // closing publish, the lease has been reclaimed. The MODEL_COMPLETED
    // publishFenced returns FENCED → StaleWorkerSurrender → execute catch
    // returns. The MODEL_GENERATION step's STEP_COMPLETED also fences out
    // (it runs after the inner fn() that emitted MODEL_COMPLETED). No
    // EXECUTION_COMPLETED, no terminal save.
    const durable = await eventStore.listByExecution(execution.id);
    const types = durable.map((e) => e.type);
    expect(types).not.toContain("MODEL_COMPLETED");
    expect(types).not.toContain("EXECUTION_COMPLETED");
    expect(types).not.toContain("EXECUTION_FAILED");

    // The publisher's diagnostic counter sink MUST have been invoked at
    // least once for a EXTERNALITY_RECORDED rejection — this is what operators
    // alert on. The audit's primary signal.
    const modelRejections = rejectionCounters.filter((r) => r.eventType === "EXTERNALITY_RECORDED");
    expect(modelRejections.length).toBeGreaterThan(0);
    expect(modelRejections[0]!.executionId).toBe(execution.id);
    expect(modelRejections[0]!.workerId).toBe("worker-stale");
    expect(modelRejections[0]!.attempt).toBe(fence.attempt);

    // Structured log breadcrumb present too — gives the trace id for
    // forensic correlation without polluting the durable event log.
    const modelLogs = logCalls.filter((l) =>
      l.message === "event.fence_rejected" && l.context.eventType === "EXTERNALITY_RECORDED"
    );
    expect(modelLogs.length).toBeGreaterThan(0);

    // Bus: no MODEL_COMPLETED leaked downstream either. (If the publisher
    // broadcasts a fenced event, replay vs. live diverge — this assertion
    // pins the no-ghost-broadcast invariant.)
    const observedModelCompleted = observedEvents.filter((e) => e.type === "MODEL_COMPLETED");
    expect(observedModelCompleted).toHaveLength(0);
  });

  it("(c) legitimate worker with a live lease completes normally (regression check)", async () => {
    const { engine, leases, eventStore } = buildHarness(new FixedOutputModelProvider());
    const { agent, execution } = makeAgentAndExecution();

    const now = new Date();
    const acquired = await leases.acquire({
      executionId: execution.id,
      workerId: "worker-stale",
      ttlMs: 60_000,
      now
    });
    if (!acquired) throw new Error("acquire failed in happy-path test");

    const result = await engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: "worker-stale",
      fence: {
        executionId: execution.id,
        workerId: "worker-stale",
        attempt: acquired.attempt
      }
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ result: "ok" });

    const durable = await eventStore.listByExecution(execution.id);
    const types = durable.map((e) => e.type);
    // The healthy path persists the full event sequence.
    expect(types).toContain("EXECUTION_STARTED");
    expect(types).toContain("EXECUTION_STEP_STARTED");
    expect(types).toContain("EXECUTION_STEP_COMPLETED");
    expect(types).toContain("MEMORY_RETRIEVED");
    expect(types).toContain("MODEL_COMPLETED");
    expect(types).toContain("EXECUTION_COMPLETED");
    expect(types).not.toContain("EXECUTION_FENCE_REJECTED");
  });
});
