import { describe, expect, it, vi } from "vitest";
import { SystemClock, FrozenClock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { InMemoryEventBus } from "../src/infrastructure/events/inMemoryEventBus.js";
import { PersistedEventPublisher } from "../src/infrastructure/events/persistedEventPublisher.js";
import {
  InMemoryEventStore,
  InMemoryExecutionRepository
} from "../src/infrastructure/persistence/inMemoryStores.js";
import { ReplayExecutionCoordinator } from "../src/runtime/replay/replayExecutionCoordinator.js";
import {
  UnsafeReplayDivergenceError,
  NonReconstructableReplayError,
  assertNoUntrackedNondeterminism,
  assertUnsafeRandomnessUsage,
  assertTimingReconstruction
} from "../src/runtime/replay/replayAssertions.js";
import { ExecutionEngine } from "../src/runtime/executionEngine.js";
import { DeterministicModelProvider } from "../src/runtime/mockModelProvider.js";
import { DedupingToolExecutor, NoopToolCallDedupStore } from "../src/runtime/toolDedupExecutor.js";
import { deterministicId, seededRandom } from "../src/shared/determinism.js";
import { InvariantViolation } from "../src/runtime/canonicalSemantics.js";
import type { Execution, ExecutionStep } from "../src/domain/model.js";
import type { DomainEvent } from "../src/domain/events.js";

// Setup standard mock objects
function makeExecution(overrides?: Partial<Execution>): Execution {
  const now = new Date().toISOString();
  return {
    id: "child-exec",
    agentId: "agent-1",
    parentExecutionId: "parent-exec",
    status: "REPLAYING",
    input: {},
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-1",
    ...overrides
  };
}

function stepEvent(step: ExecutionStep, sequence: number): DomainEvent {
  return {
    id: `ev-${sequence}`,
    type: "EXECUTION_STEP_COMPLETED",
    aggregateId: "parent-exec",
    aggregateType: "EXECUTION",
    sequence,
    occurredAt: step.completedAt ?? step.startedAt,
    payload: { step }
  } as unknown as DomainEvent;
}

function externalityEvent(step: ExecutionStep, sequence: number, overrides?: any): DomainEvent {
  return {
    id: `ev-ext-${sequence}`,
    type: "EXTERNALITY_RECORDED",
    aggregateId: "parent-exec",
    aggregateType: "EXECUTION",
    sequence: sequence - 0.5,
    occurredAt: step.startedAt,
    payload: {
      externality: {
        id: `ext-${step.id}`,
        executionId: "parent-exec",
        stepSequence: overrides?.stepSequence ?? 1,
        type: step.type,
        timestamp: step.startedAt,
        randomnessSeed: overrides?.randomnessSeed ?? "parent-seed-stable",
        providerResponseFingerprint: overrides?.providerResponseFingerprint ?? "parent-fingerprint",
        retryAttempt: 1,
        logicalTime: overrides?.logicalTime ?? 1
      }
    }
  } as unknown as DomainEvent;
}

describe("Deterministic Boundary Enforcement Tests", () => {

  it("1. Intercept and Block Untracked Nondeterminism (Math.random / Date.now)", async () => {
    const clock = new SystemClock();
    const eventStore = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const publisher = new PersistedEventPublisher(eventStore, bus);
    const eventFactory = new EventFactory(clock, "test-intercept");
    const executions = new InMemoryExecutionRepository();
    const modelProvider = new DeterministicModelProvider();
    
    const rawTools = {
      execute: async () => ({})
    };
    const tools = new DedupingToolExecutor(rawTools as any, new NoopToolCallDedupStore());

    const engine = new ExecutionEngine(
      eventFactory,
      publisher,
      executions,
      new InMemoryExecutionRepository() as any,
      modelProvider,
      tools,
      clock,
      { events: eventStore }
    );

    const agent = {
      id: "agent-1",
      goal: "Test Untracked RNG",
      tools: [],
      memoryPolicy: { maxRetrievedItems: 5 },
      tenantId: "tenant-1"
    };

    const execution = makeExecution({ parentExecutionId: undefined, status: "RUNNING" });

    // We verify that calling Math.random() directly inside the step callback throws an InvariantViolation
    await expect(
      (engine as any).runStep(agent, execution, "PLANNING", {}, async (step: any) => {
        // Direct unsafe Math.random usage!
        const r = Math.random();
        return { value: r };
      }, { traceId: "test-rnd" }, undefined, undefined, 1)
    ).rejects.toThrow(/Untracked Nondeterminism Detected: Unsafe usage of Math.random\(\)/);

    // We verify that calling new Date() directly inside the step callback throws an InvariantViolation
    await expect(
      (engine as any).runStep(agent, execution, "PLANNING", {}, async (step: any) => {
        // Direct unsafe Date usage!
        const d = new Date();
        return { value: d.getTime() };
      }, { traceId: "test-date" }, undefined, undefined, 1)
    ).rejects.toThrow(/Untracked Nondeterminism Detected: Unsafe usage of global Date/);

    // We verify that calling Date.now() directly inside the step callback throws an InvariantViolation
    await expect(
      (engine as any).runStep(agent, execution, "PLANNING", {}, async (step: any) => {
        // Direct unsafe Date.now usage!
        const t = Date.now();
        return { value: t };
      }, { traceId: "test-date-now" }, undefined, undefined, 1)
    ).rejects.toThrow(/Untracked Nondeterminism Detected: Unsafe usage of Date\.now\(\)/);
  });

  it("2. Execute Step Safely using Injected step.random and step.clock", async () => {
    const clock = new SystemClock();
    const eventStore = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const publisher = new PersistedEventPublisher(eventStore, bus);
    const eventFactory = new EventFactory(clock, "test-safe");
    const executions = new InMemoryExecutionRepository();
    const modelProvider = new DeterministicModelProvider();
    
    const rawTools = {
      execute: async () => ({})
    };
    const tools = new DedupingToolExecutor(rawTools as any, new NoopToolCallDedupStore());

    const engine = new ExecutionEngine(
      eventFactory,
      publisher,
      executions,
      new InMemoryExecutionRepository() as any,
      modelProvider,
      tools,
      clock,
      { events: eventStore }
    );

    const agent = {
      id: "agent-1",
      goal: "Test Seeded RNG",
      tools: [],
      memoryPolicy: { maxRetrievedItems: 5 },
      tenantId: "tenant-1"
    };

    const execution = makeExecution({ parentExecutionId: undefined, status: "RUNNING" });

    // Call safely using step.random and step.clock without triggering untracked assertions
    const output = await (engine as any).runStep(agent, execution, "PLANNING", {}, async (step: any) => {
      expect(step.random).toBeDefined();
      expect(step.clock).toBeDefined();
      const r1 = step.random();
      const r2 = step.random();
      const t = step.clock.now();
      return { r1, r2, t: t.toISOString() };
    }, { traceId: "test-safe" }, undefined, undefined, 1);

    expect(output.r1).toBeGreaterThanOrEqual(0);
    expect(output.r1).toBeLessThan(1);
    expect(output.r2).toBeGreaterThanOrEqual(0);
    expect(output.r2).toBeLessThan(1);
    expect(output.t).toBeDefined();
  });

  it("3. Detect Timing Reconstruction Failure (drift past safety threshold)", () => {
    // Assert timing reconstruction fails when actual duration significantly drifts
    expect(() => {
      assertTimingReconstruction(
        "exec-123",
        1000,   // Expected 1 second
        50000,  // Actual 50 seconds (49s drift, exceeds 10s threshold)
        10000
      );
    }).toThrow(UnsafeReplayDivergenceError);

    // Safe within threshold
    expect(() => {
      assertTimingReconstruction(
        "exec-123",
        1000,
        1500,  // 500ms drift, well within 10s
        10000
      );
    }).not.toThrow();
  });

  it("4. Detect Unsafe Randomness Usage (missing randomness seeds)", () => {
    // Assert that a missing randomness seed triggers an immediate exception
    expect(() => {
      assertUnsafeRandomnessUsage("exec-123", null);
    }).toThrow(InvariantViolation);

    expect(() => {
      assertUnsafeRandomnessUsage("exec-123", "");
    }).toThrow(InvariantViolation);

    // Valid seed passes
    expect(() => {
      assertUnsafeRandomnessUsage("exec-123", "stable-seed-string");
    }).not.toThrow();
  });

  it("5. Simulate Clock Drift in Replay Validation", async () => {
    const parentStep: ExecutionStep = {
      id: "step-1",
      executionId: "parent-exec",
      agentId: "agent-1",
      type: "PLANNING",
      status: "COMPLETED",
      input: { task: {} },
      output: { ok: true },
      startedAt: "2020-01-01T00:00:00.000Z",
      completedAt: "2020-01-01T00:00:01.000Z",
      durationMs: 120000 // Inconsistent duration compared to complete - start timestamps!
    };

    const clock = new SystemClock();
    const eventStore = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const publisher = new PersistedEventPublisher(eventStore, bus);
    const eventFactory = new EventFactory(clock, "test-drift");
    const executions = new InMemoryExecutionRepository();

    const parentEvents = [
      externalityEvent(parentStep, 1, { stepSequence: 1 }),
      stepEvent(parentStep, 2)
    ];

    vi.spyOn(eventStore, "listByExecution").mockResolvedValue(parentEvents);

    const coordinator = new ReplayExecutionCoordinator(
      eventStore,
      executions,
      publisher,
      eventFactory
    );

    const execution = makeExecution();
    await executions.save(execution);
    await coordinator.beginReplay(execution);

    // Should halt and throw UnsafeReplayDivergenceError due to clock duration drift
    await expect(
      coordinator.tryReconstructStep({
        execution,
        agentId: "agent-1",
        type: "PLANNING",
        stepInput: { task: {} },
        context: { traceId: "test-drift" },
        publish: async () => {}
      })
    ).rejects.toThrow(UnsafeReplayDivergenceError);

    const saved = await executions.getById(execution.id);
    expect(saved?.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("6. Simulate Distributed Ordering Variance (Out-of-Order Execution)", async () => {
    const parentStep: ExecutionStep = {
      id: "step-1",
      executionId: "parent-exec",
      agentId: "agent-1",
      type: "PLANNING",
      status: "COMPLETED",
      input: { task: {} },
      output: { ok: true },
      startedAt: "2020-01-01T00:00:00.000Z",
      completedAt: "2020-01-01T00:00:01.000Z",
      durationMs: 1000
    };

    const clock = new SystemClock();
    const eventStore = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const publisher = new PersistedEventPublisher(eventStore, bus);
    const eventFactory = new EventFactory(clock, "test-order");
    const executions = new InMemoryExecutionRepository();

    const parentEvents = [
      externalityEvent(parentStep, 1, { stepSequence: 1 }),
      stepEvent(parentStep, 2)
    ];

    vi.spyOn(eventStore, "listByExecution").mockResolvedValue(parentEvents);

    const coordinator = new ReplayExecutionCoordinator(
      eventStore,
      executions,
      publisher,
      eventFactory
    );

    const execution = makeExecution();
    await executions.save(execution);
    await coordinator.beginReplay(execution);

    // Try to execute MODEL_GENERATION instead of expected PLANNING step
    await expect(
      coordinator.tryReconstructStep({
        execution,
        agentId: "agent-1",
        type: "MODEL_GENERATION",
        stepInput: {},
        context: { traceId: "test-order" },
        publish: async () => {}
      })
    ).rejects.toThrow(UnsafeReplayDivergenceError);

    const saved = await executions.getById(execution.id);
    expect(saved?.status).toBe("RECONCILIATION_REQUIRED");
  });
});
