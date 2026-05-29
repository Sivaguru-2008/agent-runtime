import { describe, expect, it, beforeEach } from "vitest";
import { SystemClock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { PersistedEventPublisher } from "../src/infrastructure/events/persistedEventPublisher.js";
import {
  InMemoryEventStore,
  InMemoryExecutionRepository,
  InMemoryMemoryRepository
} from "../src/infrastructure/persistence/inMemoryStores.js";
import { ExecutionEngine, PartialCommitError } from "../src/runtime/executionEngine.js";
import { DeterministicModelProvider } from "../src/runtime/mockModelProvider.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import type { Agent, Execution } from "../src/domain/model.js";
import type { DomainEvent } from "../src/domain/events.js";
import { toIso } from "../src/shared/clock.js";
import type { CommitTransitionInput } from "../src/domain/ports.js";
import type { FencedWriteOutcome } from "../src/domain/clusterPorts.js";

// A flaky in-memory execution repository to simulate transactional commit failures
class FlakyInMemoryExecutionRepository extends InMemoryExecutionRepository {
  public failTransitions = false;

  override async commitTransition(input: CommitTransitionInput): Promise<FencedWriteOutcome> {
    if (this.failTransitions) {
      throw new Error("Simulated database transaction commit failure!");
    }
    return super.commitTransition(input);
  }
}

function makeAgent(): Agent {
  const now = new Date().toISOString();
  return {
    id: "agent-test",
    name: "transaction-hardening-agent",
    goal: "validate transaction atomicity and rollbacks",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    tools: [{ name: "runtime.inspect", enabled: false }],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-test"
  };
}

function makeExecution(): Execution {
  const now = new Date().toISOString();
  return {
    id: "exec-test-1",
    agentId: "agent-test",
    status: "QUEUED",
    input: { prompt: "test prompt" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-test"
  };
}

describe("Transactional Hardening and Failure Simulations", () => {
  let clock: SystemClock;
  let eventStore: InMemoryEventStore;
  let executions: FlakyInMemoryExecutionRepository;
  let memory: InMemoryMemoryRepository;
  let publisher: PersistedEventPublisher;
  let eventFactory: EventFactory;
  let engine: ExecutionEngine;

  beforeEach(() => {
    clock = new SystemClock();
    eventStore = new InMemoryEventStore();
    // Stub event bus that succeeds immediately
    const eventBus = {
      publish: async () => {},
      subscribe: () => () => {}
    };
    memory = new InMemoryMemoryRepository();
    executions = new FlakyInMemoryExecutionRepository(undefined, memory, eventStore);
    publisher = new PersistedEventPublisher(eventStore, eventBus);
    eventFactory = new EventFactory(clock, "tx-hardening");

    engine = new ExecutionEngine(
      eventFactory,
      publisher,
      executions,
      memory,
      new DeterministicModelProvider(),
      new BuiltInToolExecutor(),
      clock,
      { workerId: "worker-tx-test" }
    );
  });

  it("1. Database commit failure rollback simulation", async () => {
    // 1. Save the initial execution
    const execution = makeExecution();
    await executions.save(execution);

    // 2. Arm the repository to fail all commit transitions (e.g. database transaction rollback)
    executions.failTransitions = true;

    // 3. Try executing the task and verify it throws a database error
    let thrownError: unknown;
    try {
      await engine.execute({
        agent: makeAgent(),
        execution,
        task: { prompt: "hello" }
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect((thrownError as Error).message).toContain("Simulated database transaction commit failure!");

    // 4. Verify Rollback: status remains QUEUED, no EXECUTION_STARTED event exists in the store, and no checkpoints exist
    const current = await executions.getById(execution.id);
    expect(current?.status).toBe("QUEUED");

    const events = await eventStore.listByExecution(execution.id);
    expect(events.length).toBe(0);

    // Checkpoints in executions should not be created
    const checkpoints = (executions as any).checkpoints ? await (executions as any).checkpoints.listByExecution(execution.id) : [];
    expect(checkpoints.length).toBe(0);
  });

  it("2. Partial-commit detection and startup quarantine", async () => {
    const execution = makeExecution();
    
    // Simulate an inconsistent partial commit where the execution record says FAILED,
    // but the last event in the eventStore is NOT EXECUTION_FAILED (it is empty)
    const inconsistentExec: Execution = {
      ...execution,
      status: "FAILED",
      failure: {
        message: "stale worker crash",
        code: "STALE_WORKER",
        recoverable: true
      }
    };
    await executions.save(inconsistentExec);

    // 1. Verify detectPartialCommit flags it as inconsistent
    const check = await executions.detectPartialCommit(execution.id);
    expect(check.isConsistent).toBe(false);
    expect(check.error).toContain("Partial commit anomaly");

    // 2. Verify that trying to execute this execution throws a PartialCommitError and blocks/quarantines startup
    let thrownError: unknown;
    try {
      await engine.execute({
        agent: makeAgent(),
        execution: inconsistentExec,
        task: { prompt: "run task" }
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(PartialCommitError);
    expect((thrownError as Error).message).toContain("Partial commit anomaly");
  });

  it("3. Happy path atomic consistency", async () => {
    const execution = makeExecution();
    await executions.save(execution);

    // Run happily with no errors
    const completed = await engine.execute({
      agent: makeAgent(),
      execution,
      task: { prompt: "happy path" }
    });

    if (completed.status !== "COMPLETED") {
      console.log("HAPPY PATH FAILED WITH:", JSON.stringify(completed.failure, null, 2));
    }

    expect(completed.status).toBe("COMPLETED");

    // Verify all checkpoints, state changes, and events committed successfully and atomically
    const current = await executions.getById(execution.id);
    expect(current?.status).toBe("COMPLETED");

    const events = await eventStore.listByExecution(execution.id);
    expect(events.some(e => e.type === "EXECUTION_STARTED")).toBe(true);
    expect(events.some(e => e.type === "EXECUTION_COMPLETED")).toBe(true);
  });
});
