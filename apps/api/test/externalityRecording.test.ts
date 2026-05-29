import { describe, expect, it } from "vitest";
import { SystemClock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { InMemoryEventBus } from "../src/infrastructure/events/inMemoryEventBus.js";
import { PersistedEventPublisher } from "../src/infrastructure/events/persistedEventPublisher.js";
import {
  InMemoryEventStore,
  InMemoryExecutionRepository,
  InMemoryMemoryRepository
} from "../src/infrastructure/persistence/inMemoryStores.js";
import { ExecutionEngine, PartialCommitError } from "../src/runtime/executionEngine.js";
import { ReplaySandboxViolationError } from "../src/domain/replay.js";
import { InvariantViolation } from "../src/runtime/canonicalSemantics.js";
import type { DomainEvent } from "../src/domain/events.js";
import type { Agent, Execution, ExecutionStep } from "../src/domain/model.js";
import type { ModelProvider, ToolExecutor } from "../src/domain/ports.js";

// Mock providers to track calls
class MockModelProvider implements ModelProvider {
  calls = 0;
  async complete(): ReturnType<ModelProvider["complete"]> {
    this.calls++;
    return {
      output: { response: "live generated answer" },
      tokenUsage: { prompt: 10, completion: 20, total: 30 }
    };
  }
}

class MockToolExecutor implements ToolExecutor {
  calls: string[] = [];
  inner = {}; // to satisfy fence check S2
  dedup = {
    get: async () => null,
    put: async () => {}
  } as any;

  async execute(input: any): Promise<Record<string, unknown>> {
    this.calls.push(input.toolName);
    return { success: true, toolExecuted: input.toolName };
  }
}

function buildTestHarness() {
  const clock = new SystemClock();
  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "externality-test");
  const executions = new InMemoryExecutionRepository();
  const memory = new InMemoryMemoryRepository();
  const modelProvider = new MockModelProvider();
  const tools = new MockToolExecutor();

  const observedEvents: DomainEvent[] = [];
  bus.subscribe((event) => {
    observedEvents.push(event);
  });

  const engine = new ExecutionEngine(
    eventFactory,
    publisher,
    executions,
    memory,
    modelProvider,
    tools,
    clock,
    { workerId: "test-worker", events: eventStore }
  );

  return { engine, executions, eventStore, observedEvents, modelProvider, tools, eventFactory, clock };
}

function makeAgent(opts?: Partial<Agent>): Agent {
  const now = new Date().toISOString();
  return {
    id: "agent-replay",
    name: "test-agent",
    goal: "perform replay actions",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    tools: [
      { name: "web.search", enabled: true },
      { name: "sandbox.payment_refund", enabled: true }
    ],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-replay",
    ...opts
  };
}

function makeExecution(opts?: Partial<Execution>): Execution {
  const now = new Date().toISOString();
  return {
    id: "exec-original",
    agentId: "agent-replay",
    status: "LEASE_ACQUISITION",
    input: { prompt: "Run standard process" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-replay",
    ...opts
  };
}

describe("Externality Recording & Chaos Recovery Tests", () => {
  
  it("Partial persistence failure: detects partial commit and throws PartialCommitError", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const execution = makeExecution();

    await harness.executions.save(execution);

    // Mock detectPartialCommit to simulate partial persistence corruption
    harness.executions.detectPartialCommit = async () => ({
      isConsistent: false,
      actualStatus: "RUNNING",
      error: "Partial commit detected on execution"
    });

    await expect(
      harness.engine.execute({
        agent,
        execution,
        task: execution.input,
        validateLease: async () => true
      })
    ).rejects.toThrow(PartialCommitError);
  });

  it("Crash-before-recording: recovers tool call output from reconciliation when cached in dedup store", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const execution = makeExecution({ status: "RECOVERING" });

    // Mock the dedup store containing a cached output for the tool call
    const mockIdempotencyKey = "mock-key";
    harness.tools.dedup = {
      get: async (key: string) => {
        return {
          status: "COMPLETED",
          output: { success: true, reconciled: true }
        };
      },
      put: async () => {}
    };

    // Run the execution in recovery mode
    const completed = await harness.engine.execute({
      agent,
      execution,
      task: execution.input,
      validateLease: async () => true,
      fence: { executionId: execution.id, workerId: "test-worker", attempt: 2 }
    });

    expect(completed.status).toBe("COMPLETED");
    // The live tool should NOT be called because it was resolved via reconciliation
    expect(harness.tools.calls).not.toContain("web.search");
  });

  it("Ordering races: out-of-order execution steps are immediately caught by assertions", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const originalExecution = makeExecution({ id: "exec-original" });

    // 1. Run standard original execution
    await harness.engine.execute({
      agent,
      execution: originalExecution,
      task: originalExecution.input,
      validateLease: async () => true
    });

    // 2. Mock a parent event list where the step type is modified to cause a mismatch
    const parentEvents = await harness.eventStore.listByExecution(originalExecution.id);
    const stepCompletedEvent = parentEvents.find(e => e.type === "EXECUTION_STEP_COMPLETED");
    if (stepCompletedEvent) {
      // Intentionally tamper with the parent step type to mock an ordering race
      (stepCompletedEvent.payload.step as any).type = "MODEL_GENERATION";
    }

    const replayExecution = makeExecution({
      id: "exec-replay-race",
      parentExecutionId: originalExecution.id,
      input: originalExecution.input
    });

    // The replay execution should fail fast with step ordering mismatch
    await expect(
      harness.engine.execute({
        agent,
        execution: replayExecution,
        task: replayExecution.input,
        validateLease: async () => true
      })
    ).rejects.toThrow(/Replay ordering reconstruction violation: step order mismatch/);
  });

  it("Missing replay dependencies: gaps in parent logs are caught immediately", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const originalExecution = makeExecution({ id: "exec-original" });

    // Run standard original
    await harness.engine.execute({
      agent,
      execution: originalExecution,
      task: originalExecution.input,
      validateLease: async () => true
    });

    // Tamper with event log by deleting all completed steps to simulate a gap in dependencies
    const originalEvents = await harness.eventStore.listByExecution(originalExecution.id);
    const originalSteps = originalEvents.filter(e => e.type === "EXECUTION_STEP_COMPLETED");
    for (const stepEvent of originalSteps) {
      // Remove step from list
      const idx = originalEvents.indexOf(stepEvent);
      if (idx !== -1) originalEvents.splice(idx, 1);
    }

    const replayExecution = makeExecution({
      id: "exec-replay-gap",
      parentExecutionId: originalExecution.id,
      input: originalExecution.input
    });

    await expect(
      harness.engine.execute({
        agent,
        execution: replayExecution,
        task: replayExecution.input,
        validateLease: async () => true
      })
    ).rejects.toThrow(/Replay persistence gap violation: detected missing or unpersisted steps/);
  });

  it("Retry persistence corruption: non-monotonic fence attempts fail fast", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const execution = makeExecution({ status: "RECOVERING" });

    // Attempting execution with invalid non-monotonic attempt count (0 or negative)
    await expect(
      harness.engine.execute({
        agent,
        execution,
        task: execution.input,
        validateLease: async () => true,
        fence: { executionId: execution.id, workerId: "test-worker", attempt: 0 }
      })
    ).rejects.toThrow(/Lease token attempt must be a positive integer/);
  });

  it("Durable session recovery: dynamic dynamic reconstruction of ReplaySessionState works", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const originalExecution = makeExecution({ id: "exec-original-recovery" });

    await harness.engine.execute({
      agent,
      execution: originalExecution,
      task: originalExecution.input,
      validateLease: async () => true
    });

    const replayExecution = makeExecution({
      id: "exec-replay-recovery",
      parentExecutionId: originalExecution.id,
      input: originalExecution.input
    });

    await harness.executions.save(replayExecution);

    const coordinator = (harness.engine as any).replayCoordinator;
    expect(coordinator).toBeDefined();

    // Begin replay to initialize lifecycle events
    const initialSession = await coordinator.beginReplay(replayExecution);
    expect(initialSession.lifecycle).toBe("REPLAYING");

    // Clear coordinator in-memory map to simulate worker restart / process crash
    (coordinator as any).sessions.clear();
    expect(coordinator.getSession(replayExecution.id)).toBeUndefined();

    // Call getOrReconstructSession to dynamically restore from event log
    const restoredSession = await coordinator.getOrReconstructSession(replayExecution.id, replayExecution);
    expect(restoredSession).toBeDefined();
    expect(restoredSession.lifecycle).toBe("REPLAYING");
    expect(restoredSession.parentExecutionId).toBe(originalExecution.id);
  });
});
