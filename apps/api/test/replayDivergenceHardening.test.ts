import { describe, expect, it, vi } from "vitest";
import { SystemClock } from "../src/shared/clock.js";
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
  NonReconstructableReplayError
} from "../src/runtime/replay/replayAssertions.js";
import { ReplayComparisonTool } from "../src/runtime/replay/replayComparisonTool.js";
import type { Execution, ExecutionStep } from "../src/domain/model.js";
import type { DomainEvent } from "../src/domain/events.js";

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

function externalityEvent(step: ExecutionStep, sequence: number, seqIndex?: number): DomainEvent {
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
        stepSequence: seqIndex ?? 1,
        type: step.type,
        timestamp: step.startedAt,
        randomnessSeed: "seed",
        retryAttempt: 1
      }
    }
  } as unknown as DomainEvent;
}

function buildCoordinator(parentEvents: DomainEvent[]) {
  const clock = new SystemClock();
  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "coord-test");
  const executions = new InMemoryExecutionRepository();

  vi.spyOn(eventStore, "listByExecution").mockResolvedValue(parentEvents);

  const coordinator = new ReplayExecutionCoordinator(
    eventStore,
    executions,
    publisher,
    eventFactory
  );

  return { coordinator, eventFactory, executions, publisher, eventStore };
}

describe("Replay Divergence Hardening & Equivalence Enforcement", () => {
  it("Scenario 1: Detect Changed Execution Ordering and Halt Replay", async () => {
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
    const { coordinator, executions } = buildCoordinator([
      externalityEvent(parentStep, 1, 1),
      stepEvent(parentStep, 2)
    ]);
    const execution = makeExecution();
    await executions.save(execution);
    await coordinator.beginReplay(execution);

    // Act & Assert ordering mismatch (expected PLANNING, replayed MODEL_GENERATION)
    await expect(
      coordinator.tryReconstructStep({
        execution,
        agentId: "agent-1",
        type: "MODEL_GENERATION",
        stepInput: {},
        context: { traceId: "test-ordering" },
        publish: async () => {}
      })
    ).rejects.toThrow(UnsafeReplayDivergenceError);

    // Verify execution status was escalated to RECONCILIATION_REQUIRED
    const saved = await executions.getById(execution.id);
    expect(saved?.status).toBe("RECONCILIATION_REQUIRED");
    expect(() => coordinator.getSession(execution.id)).toThrow(/Replay safety reconstruction violation/);
  });

  it("Scenario 2: Detect Changed Tool Outputs / Arguments and Halt Replay", async () => {
    const parentStep: ExecutionStep = {
      id: "step-1",
      executionId: "parent-exec",
      agentId: "agent-1",
      type: "TOOL_CALL",
      status: "COMPLETED",
      input: { toolName: "sandbox.payment_refund", args: { amount: 100 } },
      output: { ok: true },
      startedAt: "2020-01-01T00:00:00.000Z",
      completedAt: "2020-01-01T00:00:01.000Z",
      durationMs: 1000
    };
    const { coordinator, executions } = buildCoordinator([
      externalityEvent(parentStep, 1, 1),
      stepEvent(parentStep, 2)
    ]);
    const execution = makeExecution();
    await executions.save(execution);
    await coordinator.beginReplay(execution);

    // Act & Assert tool args changed (amount: 200 instead of 100)
    await expect(
      coordinator.tryReconstructStep({
        execution,
        agentId: "agent-1",
        type: "TOOL_CALL",
        stepInput: { toolName: "sandbox.payment_refund", args: { amount: 200 } },
        context: { traceId: "test-tool" },
        publish: async () => {}
      })
    ).rejects.toThrow(UnsafeReplayDivergenceError);

    // Verify it entered recovery/reconciliation
    const saved = await executions.getById(execution.id);
    expect(saved?.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("Scenario 3: Detect Inconsistent LLM Outputs and Halt Replay", async () => {
    const parentStep: ExecutionStep = {
      id: "step-1",
      executionId: "parent-exec",
      agentId: "agent-1",
      type: "MODEL_GENERATION",
      status: "COMPLETED",
      input: { prompt: "Explain quantum computing simply" },
      output: { text: "quantum is cool" },
      startedAt: "2020-01-01T00:00:00.000Z",
      completedAt: "2020-01-01T00:00:01.000Z",
      durationMs: 1000
    };
    const { coordinator, executions } = buildCoordinator([
      externalityEvent(parentStep, 1, 1),
      stepEvent(parentStep, 2)
    ]);
    const execution = makeExecution();
    await executions.save(execution);
    await coordinator.beginReplay(execution);

    // Act & Assert prompt mismatches
    await expect(
      coordinator.tryReconstructStep({
        execution,
        agentId: "agent-1",
        type: "MODEL_GENERATION",
        stepInput: { prompt: "Explain black holes" },
        context: { traceId: "test-llm" },
        publish: async () => {}
      })
    ).rejects.toThrow(UnsafeReplayDivergenceError);

    const saved = await executions.getById(execution.id);
    expect(saved?.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("Scenario 4: Detect Missing Persisted Externalities and Halt Replay", async () => {
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
    // No EXTERNALITY_RECORDED in parent events!
    const { coordinator, executions } = buildCoordinator([
      stepEvent(parentStep, 2)
    ]);
    const execution = makeExecution();
    await executions.save(execution);
    await coordinator.beginReplay(execution);

    // Act & Assert missing externality throws NonReconstructableReplayError
    await expect(
      coordinator.tryReconstructStep({
        execution,
        agentId: "agent-1",
        type: "PLANNING",
        stepInput: { task: {} },
        context: { traceId: "test-missing" },
        publish: async () => {}
      })
    ).rejects.toThrow(NonReconstructableReplayError);

    const saved = await executions.getById(execution.id);
    expect(saved?.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("Scenario 5: Detect Replay Timing Inconsistency and Halt Replay", async () => {
    const parentStep: ExecutionStep = {
      id: "step-1",
      executionId: "parent-exec",
      agentId: "agent-1",
      type: "PLANNING",
      status: "COMPLETED",
      input: { task: {} },
      output: { ok: true },
      // Mismatch between durationMs and completedAt - startedAt (drift of > 100s)
      startedAt: "2020-01-01T00:00:00.000Z",
      completedAt: "2020-01-01T00:00:01.000Z",
      durationMs: 150000 
    };
    const { coordinator, executions } = buildCoordinator([
      externalityEvent(parentStep, 1, 1),
      stepEvent(parentStep, 2)
    ]);
    const execution = makeExecution();
    await executions.save(execution);
    await coordinator.beginReplay(execution);

    // Act & Assert timing inconsistency throws UnsafeReplayDivergenceError
    await expect(
      coordinator.tryReconstructStep({
        execution,
        agentId: "agent-1",
        type: "PLANNING",
        stepInput: { task: {} },
        context: { traceId: "test-timing" },
        publish: async () => {}
      })
    ).rejects.toThrow(UnsafeReplayDivergenceError);

    const saved = await executions.getById(execution.id);
    expect(saved?.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("Scenario 6: Side-by-side Replay Comparison Diagnostic Report Rendering", () => {
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

    const originalEvents: DomainEvent[] = [
      stepEvent(parentStep, 2)
    ];

    const replayEvents: DomainEvent[] = [
      {
        ...stepEvent(parentStep, 2),
        // Simulate changed inputs in replay
        payload: {
          step: {
            ...parentStep,
            input: { task: { drifted: true } }
          }
        }
      }
    ];

    const report = ReplayComparisonTool.compare("child-exec", originalEvents, replayEvents);
    expect(report.equivalenceStatus).toBe("DIVERGED");
    expect(report.divergencePoint.stepIndex).toBe(0);
    expect(report.steps[0].comparison).toBe("MISMATCH");

    const consoleOutput = ReplayComparisonTool.renderConsoleReport(report);
    expect(consoleOutput).toContain("REPLAY COMPARISON AUDIT REPORT: child-exec");
    expect(consoleOutput).toContain("Status: DIVERGED");
    expect(consoleOutput).toContain("Idx  Step Type");
  });
});
