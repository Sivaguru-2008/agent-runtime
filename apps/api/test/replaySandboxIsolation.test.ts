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
import {
  ReplaySandboxEscapeError,
  ReplayPolicyViolationError,
  SandboxedEventStore,
  SandboxedExecutionRepository
} from "../src/runtime/replay/replaySandbox.js";
import type { DomainEvent } from "../src/domain/events.js";
import type { Agent, Execution } from "../src/domain/model.js";
import type { ModelProvider, ToolExecutor } from "../src/domain/ports.js";

class MockModelProvider implements ModelProvider {
  calls = 0;
  async complete() {
    this.calls++;
    return {
      output: { response: "mock model output" },
      tokenUsage: { prompt: 10, completion: 15, total: 25 }
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
  const eventFactory = new EventFactory(clock, "replay-sandbox-test");
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
    id: "agent-sandbox",
    name: "test-agent",
    goal: "validate sandbox rules",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    tools: [
      { name: "web.search", enabled: true },
      { name: "sandbox.payment_refund", enabled: true },
      { name: "sandbox.db_write", enabled: true },
      { name: "email.send", enabled: true },
      { name: "stripe.payment", enabled: true },
      { name: "operator.restart", enabled: true }
    ],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-sandbox",
    ...opts
  };
}

function makeExecution(opts?: Partial<Execution>): Execution {
  const now = new Date().toISOString();
  return {
    id: "exec-sandbox-original",
    agentId: "agent-sandbox",
    status: "LEASE_ACQUISITION",
    input: { prompt: "Validate Sandbox Isolation" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-sandbox",
    ...opts
  };
}

describe("Replay Sandbox Isolation Subsystem", () => {
  beforeEach(() => {
    (globalThis as any).activeSandboxedExecutionRepos?.clear();
    (globalThis as any).activeSandboxedEventStores?.clear();
  });

  it("enforces BLOCKED_REPLAY tool policy", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const original = makeExecution();

    // 1. Run original execution live (with web.search, other tools disabled for simplicity)
    agent.tools = [{ name: "web.search", enabled: true }];
    await harness.engine.execute({
      agent,
      execution: original,
      task: original.input,
      validateLease: async () => true
    });

    // 2. Setup replay execution with a BLOCKED_REPLAY tool run after divergence
    const replay = makeExecution({
      id: "exec-sandbox-replay-blocked",
      parentExecutionId: original.id,
      input: { prompt: "Drifted to call blocked stripe payment tool" }
    });

    // We enable stripe.payment tool which is BLOCKED_REPLAY
    agent.tools = [{ name: "stripe.payment", enabled: true }];

    await expect(
      harness.engine.execute({
        agent,
        execution: replay,
        task: replay.input,
        validateLease: async () => true
      })
    ).rejects.toThrow(ReplayPolicyViolationError);

    // Verify stripe.payment was NEVER executed live
    expect(harness.tools.calls).not.toContain("stripe.payment");
  });

  it("enforces SIMULATED_REPLAY tool policy (suppresses side effect, returns simulation)", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const original = makeExecution();

    // 1. Run original live
    agent.tools = [{ name: "web.search", enabled: true }];
    await harness.engine.execute({
      agent,
      execution: original,
      task: original.input,
      validateLease: async () => true
    });

    // 2. Replay with a SIMULATED_REPLAY tool run after divergence
    const replay = makeExecution({
      id: "exec-sandbox-replay-sim",
      parentExecutionId: original.id,
      input: { prompt: "Drifted to call email send tool" }
    });

    // Enable email.send which is SIMULATED_REPLAY
    agent.tools = [{ name: "email.send", enabled: true }];

    const result = await harness.engine.execute({
      agent,
      execution: replay,
      task: replay.input,
      validateLease: async () => true
    });

    expect(result.status).toBe("COMPLETED");
    // Verify that mock email dispatch was returned and that live MockToolExecutor was NEVER called for it
    expect(harness.tools.calls).not.toContain("email.send");
  });

  it("enforces MANUAL_REPLAY_REQUIRED tool policy", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    const original = makeExecution();

    // 1. Run original live
    agent.tools = [{ name: "web.search", enabled: true }];
    await harness.engine.execute({
      agent,
      execution: original,
      task: original.input,
      validateLease: async () => true
    });

    // 2. Replay with operator.restart which is MANUAL_REPLAY_REQUIRED (without operatorApproved)
    const replayBlocked = makeExecution({
      id: "exec-sandbox-replay-manual-block",
      parentExecutionId: original.id,
      input: { prompt: "Drifted to manual restart" }
    });
    agent.tools = [{ name: "operator.restart", enabled: true }];

    await expect(
      harness.engine.execute({
        agent,
        execution: replayBlocked,
        task: replayBlocked.input,
        validateLease: async () => true
      })
    ).rejects.toThrow(ReplayPolicyViolationError);

    // 3. Replay WITH operator approval
    const replayApproved = makeExecution({
      id: "exec-sandbox-replay-manual-ok",
      parentExecutionId: original.id,
      input: { prompt: "Drifted to manual restart but operator approved", operatorApproved: true }
    });

    const result = await harness.engine.execute({
      agent,
      execution: replayApproved,
      task: replayApproved.input,
      validateLease: async () => true
    });

    expect(result.status).toBe("COMPLETED");
    expect(harness.tools.calls).toContain("operator.restart");
  });

  it("detects and thwarts Replay Sandbox Escape attempts (parent DB write, production bus event)", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    
    // Instantiate Sandboxed Event Store and Sandboxed Execution Repository directly to test assertions
    const sandboxedEventStore = new SandboxedEventStore(harness.eventStore, "isolated-child-exec-1", "parent-exec-1");
    const sandboxedRepo = new SandboxedExecutionRepository(harness.executions, "isolated-child-exec-1", "parent-exec-1");

    // 1. Attempting to save a foreign execution row throws escape error
    const foreignExecution = makeExecution({ id: "foreign-execution-id" });
    await expect(
      sandboxedRepo.save(foreignExecution)
    ).rejects.toThrow(ReplaySandboxEscapeError);

    // 2. Attempting to append an event for a foreign aggregate throws escape error
    const foreignEvent = harness.eventFactory.create({
      type: "EXECUTION_COMPLETED",
      aggregateId: "foreign-execution-id",
      aggregateType: "EXECUTION",
      payload: { execution: foreignExecution }
    });
    await expect(
      sandboxedEventStore.append(foreignEvent)
    ).rejects.toThrow(ReplaySandboxEscapeError);

    // 3. Verify that real production stores remain completely unpolluted during replay
    const original = makeExecution();
    agent.tools = [{ name: "web.search", enabled: true }];
    await harness.engine.execute({
      agent,
      execution: original,
      task: original.input,
      validateLease: async () => true
    });

    const initialRealEvents = await harness.eventStore.listByExecution(original.id);
    const replay = makeExecution({
      id: "exec-sandbox-isolated-runs",
      parentExecutionId: original.id,
      input: original.input
    });

    harness.observedEvents.length = 0; // Clear production event bus log

    await harness.engine.execute({
      agent,
      execution: replay,
      task: replay.input,
      validateLease: async () => true
    });

    // The real event store must NOT have any new entries for the replay execution ID in its raw, un-sandboxed database array.
    // We prove this by querying listRecent, which bypasses listByExecution's sandboxed interception.
    const rawRecentEvents = await harness.eventStore.listRecent(100);
    const hasReplayEventsInRawStore = rawRecentEvents.some(e => e.aggregateId === replay.id);
    expect(hasReplayEventsInRawStore).toBe(false);

    // The production event bus must NOT have observed any event broadcasts from the replay execution run
    const productionReplayBroadcasts = harness.observedEvents.filter(e => e.aggregateId === replay.id);
    expect(productionReplayBroadcasts).toHaveLength(0);
  });

  it("guarantees concurrency safety of sandbox scopes via AsyncLocalStorage", async () => {
    const harness = buildTestHarness();
    const agent = makeAgent();
    agent.tools = [{ name: "web.search", enabled: true }];

    // Prepare two completely separate original executions
    const originalA = makeExecution({ id: "original-exec-a" });
    const originalB = makeExecution({ id: "original-exec-b" });

    await harness.engine.execute({
      agent,
      execution: originalA,
      task: originalA.input,
      validateLease: async () => true
    });

    await harness.engine.execute({
      agent,
      execution: originalB,
      task: originalB.input,
      validateLease: async () => true
    });

    // Run sandboxed replays for A and B concurrently on the same engine instance!
    const replayA = makeExecution({
      id: "replay-exec-a",
      parentExecutionId: originalA.id,
      input: originalA.input
    });

    const replayB = makeExecution({
      id: "replay-exec-b",
      parentExecutionId: originalB.id,
      input: originalB.input
    });

    const [resA, resB] = await Promise.all([
      harness.engine.execute({
        agent,
        execution: replayA,
        task: replayA.input,
        validateLease: async () => true
      }),
      harness.engine.execute({
        agent,
        execution: replayB,
        task: replayB.input,
        validateLease: async () => true
      })
    ]);

    expect(resA.status).toBe("COMPLETED");
    expect(resB.status).toBe("COMPLETED");

    // Fetch the virtual event logs for A and B from their respective sandboxed stores
    const eventsA = await harness.eventStore.listByExecution(replayA.id);
    const eventsB = await harness.eventStore.listByExecution(replayB.id);

    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);

    // Verify there is absolutely zero cross-pollution or state mixing between A and B!
    expect(eventsA.every(e => e.aggregateId === replayA.id)).toBe(true);
    expect(eventsB.every(e => e.aggregateId === replayB.id)).toBe(true);
  });
});
