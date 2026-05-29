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
import { NonReconstructableReplayError } from "../src/runtime/replay/replayAssertions.js";
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

async function seedExecution(executions: InMemoryExecutionRepository, execution: Execution) {
  await executions.save(execution);
}

describe("ReplayExecutionCoordinator", () => {
  it("reconstructs equivalent planning step without live boundary", async () => {
    const parentStep: ExecutionStep = {
      id: "step-1",
      executionId: "parent-exec",
      agentId: "agent-1",
      type: "PLANNING",
      status: "COMPLETED",
      input: { task: { prompt: "hi" } },
      output: { objective: "goal" },
      startedAt: "2020-01-01T00:00:00.000Z",
      completedAt: "2020-01-01T00:00:01.000Z",
      durationMs: 1000
    };
    const { coordinator, executions } = buildCoordinator([
      externalityEvent(parentStep, 1),
      stepEvent(parentStep, 2)
    ]);
    const execution = makeExecution();
    await seedExecution(executions, execution);

    await coordinator.beginReplay(execution);
    const published: string[] = [];
    const reconstructed = await coordinator.tryReconstructStep({
      execution,
      agentId: "agent-1",
      type: "PLANNING",
      stepInput: { task: { prompt: "hi" } },
      context: { traceId: "t1" },
      publish: async (event) => {
        published.push(event.type);
      }
    });

    expect(reconstructed?.output).toEqual({ objective: "goal" });
    expect(coordinator.getSession(execution.id)?.lifecycle).toBe("REPLAY_EQUIVALENT");

    await coordinator.emitReconstructedStep({
      execution,
      completed: reconstructed!.completed,
      nestedEmitters: reconstructed!.nestedEmitters,
      context: { traceId: "t1" },
      publish: async (event) => {
        published.push(event.type);
      }
    });

    expect(published).toContain("EXECUTION_STEP_STARTED");
    expect(published).toContain("EXECUTION_STEP_COMPLETED");
  });

  it("marks partial persistence as MISSING_STEP divergence", async () => {
    const { coordinator, executions } = buildCoordinator([]);
    const execution = makeExecution();
    await seedExecution(executions, execution);
    await coordinator.beginReplay(execution);

    const publish = vi.fn();
    await expect(
      coordinator.tryReconstructStep({
        execution,
        agentId: "agent-1",
        type: "PLANNING",
        stepInput: { task: {} },
        context: { traceId: "t1" },
        publish
      })
    ).rejects.toThrow(NonReconstructableReplayError);

    expect(() => coordinator.getSession(execution.id)).toThrow(/Replay safety reconstruction violation/);

    const saved = await executions.getById(execution.id);
    expect(saved).toBeDefined();
  });

  it("finalizes to REPLAY_VERIFIED when all parent steps replayed", async () => {
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
      externalityEvent(parentStep, 1),
      stepEvent(parentStep, 2)
    ]);
    const execution = makeExecution();
    await seedExecution(executions, execution);
    await coordinator.beginReplay(execution);

    await coordinator.tryReconstructStep({
      execution,
      agentId: "agent-1",
      type: "PLANNING",
      stepInput: { task: {} },
      context: { traceId: "t1" },
      publish: async () => {}
    });

    const session = await coordinator.finalize(execution, true);
    expect(session?.lifecycle).toBe("REPLAY_VERIFIED");
    expect(session?.verified).toBe(true);
  });

  it("diverges on stale parent log when sequence exceeds watermark", async () => {
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
      externalityEvent(parentStep, 1),
      stepEvent(parentStep, 2)
    ]);
    const execution = makeExecution();
    await seedExecution(executions, execution);
    await coordinator.beginReplay(execution);

    const session = coordinator.getSession(execution.id)!;
    session.parentEvents = [...session.parentEvents, stepEvent(parentStep, 99)];

    await expect(
      coordinator.tryReconstructStep({
        execution,
        agentId: "agent-1",
        type: "PLANNING",
        stepInput: { task: {} },
        context: { traceId: "stale" },
        publish: async () => {}
      })
    ).rejects.toThrow(NonReconstructableReplayError);

    expect(() => coordinator.getSession(execution.id)).toThrow(/Replay safety reconstruction violation/);
  });

  it("blocks unsafe live tool after divergence", async () => {
    const { coordinator, executions } = buildCoordinator([]);
    const execution = makeExecution();
    await seedExecution(executions, execution);
    await coordinator.beginReplay(execution);
    const session = coordinator.getSession(execution.id)!;
    session.diverged = true;
    session.lifecycle = "REPLAY_DIVERGED";

    expect(() => coordinator.validateLiveTool(execution, "sandbox.payment_refund")).toThrow(
      /Replay Side-Effect Mutex/
    );
  });
});
