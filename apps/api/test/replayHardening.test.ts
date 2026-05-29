import { describe, expect, it, beforeEach } from "vitest";
import { SystemClock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { InMemoryEventBus } from "../src/infrastructure/events/inMemoryEventBus.js";
import { PersistedEventPublisher } from "../src/infrastructure/events/persistedEventPublisher.js";
import {
  InMemoryEventStore,
  InMemoryExecutionRepository,
  InMemoryMemoryRepository
} from "../src/infrastructure/persistence/inMemoryStores.js";
import { ExecutionEngine } from "../src/runtime/executionEngine.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import { ReplaySandboxViolationError } from "../src/domain/replay.js";
import type { DomainEvent } from "../src/domain/events.js";
import type { Agent, Execution, ExecutionStep } from "../src/domain/model.js";
import type { ModelProvider, ToolExecutor } from "../src/domain/ports.js";

// Mock providers to track and verify if live calls are bypassed under equivalence
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
  const eventFactory = new EventFactory(clock, "replay-hardening-test");
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

describe("Replay-Equivalent Execution Semantics & sandbox Isolation", () => {
  beforeEach(() => {
    (globalThis as any).activeSandboxedExecutionRepos?.clear();
    (globalThis as any).activeSandboxedEventStores?.clear();
  });

  it("fully replays persisted outputs without invoking live APIs, and honors clock freezing", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const originalExecution = makeExecution();

    // 1. Run the original execution live
    const completedOriginal = await harness.engine.execute({
      agent,
      execution: originalExecution,
      task: originalExecution.input,
      validateLease: async () => true
    });

    expect(completedOriginal.status).toBe("COMPLETED");
    expect(harness.modelProvider.calls).toBe(1);
    expect(harness.tools.calls).toEqual(["web.search", "sandbox.payment_refund"]);

    // Capture the original events and list them
    const originalEvents = await harness.eventStore.listByExecution(originalExecution.id);
    const completedStepEvents = originalEvents.filter(e => e.type === "EXECUTION_STEP_COMPLETED");
    expect(completedStepEvents.length).toBe(5);
    expect(completedStepEvents.map((e) => (e.payload.step as ExecutionStep).type)).toEqual([
      "PLANNING",
      "MEMORY_RETRIEVAL",
      "TOOL_CALL",
      "TOOL_CALL",
      "MODEL_GENERATION"
    ]);

    // 2. Perform a replay execution with identical inputs
    const replayExecution = makeExecution({
      id: "exec-replay",
      parentExecutionId: originalExecution.id,
      input: originalExecution.input
    });

    harness.modelProvider.calls = 0;
    harness.tools.calls = [];

    const completedReplay = await harness.engine.execute({
      agent,
      execution: replayExecution,
      task: replayExecution.input,
      validateLease: async () => true
    });

    expect(completedReplay.status).toBe("COMPLETED");
    
    // VERIFICATION:
    // Under replay-equivalence, both the model provider and tools must NOT be invoked live!
    expect(harness.modelProvider.calls).toBe(0);
    expect(harness.tools.calls).toHaveLength(0);

    // Verify clock freezing: the replayed completed steps must carry the exact timestamps of the original
    const replayEvents = await harness.eventStore.listByExecution(replayExecution.id);
    const replayCompletedSteps = replayEvents.filter(e => e.type === "EXECUTION_STEP_COMPLETED");
    
    expect(replayCompletedSteps.length).toBe(completedStepEvents.length);
    for (let i = 0; i < replayCompletedSteps.length; i++) {
      const origStep = completedStepEvents[i].payload.step as ExecutionStep;
      const replStep = replayCompletedSteps[i].payload.step as ExecutionStep;
      expect(replStep.startedAt).toBe(origStep.startedAt);
      expect(replStep.completedAt).toBe(origStep.completedAt);
      expect(replStep.durationMs).toBe(origStep.durationMs);
    }
  });

  it("detects branch drift / input mismatch, emits REPLAY_DIVERGENCE_DETECTED, and enters sandbox", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const originalExecution = makeExecution();

    // Run original live
    await harness.engine.execute({
      agent,
      execution: originalExecution,
      task: originalExecution.input,
      validateLease: async () => true
    });

    // Run a replay with a DIFFERENT prompt (drift)
    const replayExecution = makeExecution({
      id: "exec-replay-drift",
      parentExecutionId: originalExecution.id,
      input: { prompt: "Drifted inputs" }
    });

    // Reset calls trackers
    harness.modelProvider.calls = 0;
    harness.tools.calls = [];

    // The execution should proceed live on the first step (PLANNING) because its input changed,
    // which causes a divergence right at sequence 0.
    // Inside the planning step, it will call live, but wait! PLANNING does not use tools.
    // The next step is MEMORY_RETRIEVAL (which doesn't call tools).
    // The next steps are TOOL_CALL (which calls tools live!).
    // Because the replay has diverged, any state-mutating tool like `sandbox.payment_refund` MUST be blocked by the sandbox!
    // `web.search` is marked safe, so it should execute live.
    // But `sandbox.payment_refund` is marked unsafe, so it must throw ReplaySandboxViolationError which causes the engine to fail the run gracefully.
    await expect(
      harness.engine.execute({
        agent,
        execution: replayExecution,
        task: replayExecution.input,
        validateLease: async () => true
      })
    ).rejects.toThrow(/Replay Side-Effect Mutex violation/);

    // The sandbox must have allowed the safe tool (`web.search`) to run, but blocked the unsafe one (`sandbox.payment_refund`)
    expect(harness.tools.calls).toContain("web.search");
    expect(harness.tools.calls).not.toContain("sandbox.payment_refund");
  });

  it("emits REPLAY_DIVERGENCE_DETECTED on drift with lifecycle payload", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const originalExecution = makeExecution();

    await harness.engine.execute({
      agent,
      execution: originalExecution,
      task: originalExecution.input,
      validateLease: async () => true
    });

    const replayExecution = makeExecution({
      id: "exec-replay-events",
      parentExecutionId: originalExecution.id,
      input: { prompt: "Drifted" }
    });

    await expect(
      harness.engine.execute({
        agent,
        execution: replayExecution,
        task: replayExecution.input,
        validateLease: async () => true
      })
    ).rejects.toThrow(/Replay Side-Effect Mutex/);

    const replayEvents = await harness.eventStore.listByExecution(replayExecution.id);
    const divergence = replayEvents.find((e) => e.type === "REPLAY_DIVERGENCE_DETECTED");
    expect(divergence).toBeDefined();
    expect((divergence?.payload as any).lifecycle).toBe("REPLAY_DIVERGED");
  });

  it("beginReplay is idempotent for the same execution id", async () => {
    const harness = buildTestHarness();
    const coordinator = (harness.engine as any).replayCoordinator;
    expect(coordinator).toBeDefined();

    const execution = makeExecution({
      id: "exec-concurrent",
      parentExecutionId: "exec-parent",
      status: "REPLAYING"
    });
    await harness.executions.save(execution);

    const first = await coordinator.beginReplay(execution);
    const second = await coordinator.beginReplay(execution);
    expect(second).toBe(first);
    coordinator.endReplay(execution.id);
  });

  it("crash-recovery style replay: equivalent prefix after parent completed", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const original = makeExecution({ id: "exec-crash-src" });

    await harness.engine.execute({
      agent,
      execution: original,
      task: original.input,
      validateLease: async () => true
    });

    const recoveryReplay = makeExecution({
      id: "exec-crash-replay",
      parentExecutionId: original.id,
      input: original.input
    });

    harness.modelProvider.calls = 0;
    harness.tools.calls = [];

    const result = await harness.engine.execute({
      agent,
      execution: recoveryReplay,
      task: recoveryReplay.input,
      validateLease: async () => true
    });

    expect(result.status).toBe("COMPLETED");
    expect(harness.modelProvider.calls).toBe(0);
    expect(harness.tools.calls).toHaveLength(0);
  });

  it("emits REPLAY_LIFECYCLE_TRANSITIONED through verified completion", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const original = makeExecution({ id: "exec-lifecycle-src" });

    await harness.engine.execute({
      agent,
      execution: original,
      task: original.input,
      validateLease: async () => true
    });

    const replay = makeExecution({
      id: "exec-lifecycle-replay",
      parentExecutionId: original.id,
      input: original.input
    });

    await harness.executions.save(replay);

    await harness.engine.execute({
      agent,
      execution: replay,
      task: replay.input,
      validateLease: async () => true
    });

    const events = await harness.eventStore.listByExecution(replay.id);
    const lifecycle = events.filter((e) => e.type === "REPLAY_LIFECYCLE_TRANSITIONED");
    expect(lifecycle.length).toBeGreaterThan(0);
    const verified = lifecycle.find(
      (e) => (e.payload as { to?: string }).to === "REPLAY_VERIFIED"
    );
    expect(verified).toBeDefined();
  });
});
