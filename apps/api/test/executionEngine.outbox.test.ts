import { describe, expect, it } from "vitest";
import { SystemClock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { PersistedEventPublisher } from "../src/infrastructure/events/persistedEventPublisher.js";
import { OutboxDispatcher } from "../src/infrastructure/events/outboxDispatcher.js";
import {
  InMemoryEventStore,
  InMemoryExecutionRepository,
  InMemoryMemoryRepository
} from "../src/infrastructure/persistence/inMemoryStores.js";
import { ExecutionEngine } from "../src/runtime/executionEngine.js";
import { DeterministicModelProvider } from "../src/runtime/mockModelProvider.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import type { DomainEvent } from "../src/domain/events.js";
import type { Agent, Execution } from "../src/domain/model.js";
import type { EventBus, EventHandler, ExecutionRepository, CommitTerminalInput, CommitTransitionInput } from "../src/domain/ports.js";
import type { FencedWriteOutcome } from "../src/domain/clusterPorts.js";

/**
 * Save-then-publish gap closure via transactional outbox.
 *
 * Today the engine does:
 *   await executions.save(completed);
 *   await writeCheckpoint(...);
 *   await publisher.publish(EXECUTION_COMPLETED);  // <- if this throws, state corrupts
 *
 * The publisher's bus.publish can throw (transient bus failure). When it
 * does, the throw propagates into the engine's catch branch, which then
 * tries to write FAILED — stomping the just-saved COMPLETED row.
 *
 * The fix: a new publisher.publishDurable() that swallows bus errors into
 * an in-process pending map, plus an OutboxDispatcher that drains it. The
 * engine uses publishDurable for terminal events only; the publisher's
 * existing publish() (throw-on-bus-failure) stays unchanged for every other
 * caller (cognition orchestrator, intermediate steps).
 */

/** EventBus stub that captures every successfully-published event. */
class CapturingEventBus implements EventBus {
  readonly published: DomainEvent[] = [];
  private readonly handlers = new Set<EventHandler>();
  async publish(event: DomainEvent): Promise<void> {
    this.published.push(event);
    await Promise.all([...this.handlers].map((h) => h(event)));
  }
  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

/**
 * EventBus stub that throws on publish() for events matching a predicate.
 * Lets the test simulate "bus is down for terminal events only" without
 * also blowing up the engine's earlier intermediate publishes (which use
 * publisher.publish() and are not outbox-routed).
 */
class FlakyEventBus implements EventBus {
  readonly attempts: DomainEvent[] = [];
  readonly delivered: DomainEvent[] = [];
  private failPredicate: (e: DomainEvent) => boolean = () => false;
  private readonly handlers = new Set<EventHandler>();

  async publish(event: DomainEvent): Promise<void> {
    this.attempts.push(event);
    if (this.failPredicate(event)) {
      throw new Error("simulated bus outage");
    }
    this.delivered.push(event);
    await Promise.all([...this.handlers].map((h) => h(event)));
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Configure which events the bus will throw on. */
  failWhen(predicate: (e: DomainEvent) => boolean): void {
    this.failPredicate = predicate;
  }
  /** All future publishes succeed. */
  recover(): void {
    this.failPredicate = () => false;
  }
}

/** ExecutionRepository stub that throws on save() once `breakSave()` is called. */
class FlakyExecutionRepository implements ExecutionRepository {
  private readonly delegate = new InMemoryExecutionRepository();
  private broken = false;
  async save(execution: Execution): Promise<void> {
    if (this.broken) throw new Error("simulated executions repo outage");
    await this.delegate.save(execution);
  }
  // Test-double: this suite exercises outbox behavior, not fencing. The engine
  // only routes through saveFenced when a fence is passed in ExecuteTaskInput;
  // these tests never set one. Throw loudly if anyone wires fencing into this
  // harness in the future without adding the corresponding stub behavior.
  async saveFenced(): Promise<never> {
    throw new Error("FlakyExecutionRepository.saveFenced is not implemented for this suite");
  }
  async commitTerminal(input: CommitTerminalInput): Promise<FencedWriteOutcome> {
    if (this.broken) throw new Error("simulated executions repo outage");
    return this.delegate.commitTerminal(input);
  }
  async commitTransition(input: CommitTransitionInput): Promise<FencedWriteOutcome> {
    if (this.broken) throw new Error("simulated executions repo outage");
    return this.delegate.commitTransition(input);
  }
  async detectPartialCommit(executionId: string): Promise<{ isConsistent: boolean; actualStatus: Execution["status"]; lastEventSeq?: number; error?: string }> {
    return this.delegate.detectPartialCommit(executionId);
  }
  isOutboxEnabled(): boolean {
    return false;
  }
  async getById(id: string): Promise<Execution | undefined> {
    return this.delegate.getById(id);
  }
  async listByAgent(agentId: string): Promise<Execution[]> {
    return this.delegate.listByAgent(agentId);
  }
  breakSave(): void {
    this.broken = true;
  }
}

function makeAgent(): Agent {
  const now = new Date().toISOString();
  return {
    id: "agent-outbox",
    name: "outbox-test-agent",
    goal: "exercise outbox semantics",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    tools: [{ name: "runtime.inspect", enabled: false }],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-outbox"
  };
}

function makeExecution(): Execution {
  const now = new Date().toISOString();
  return {
    id: "exec-outbox",
    agentId: "agent-outbox",
    status: "QUEUED",
    input: { prompt: "irrelevant" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-outbox"
  };
}

describe("ExecutionEngine save-then-publish outbox", () => {
  it("(a) happy path: save and publish both succeed → exactly one EXECUTION_COMPLETED", async () => {
    const clock = new SystemClock();
    const eventStore = new InMemoryEventStore();
    const bus = new CapturingEventBus();
    const publisher = new PersistedEventPublisher(eventStore, bus);
    const eventFactory = new EventFactory(clock, "outbox-test");
    const executions = new InMemoryExecutionRepository();
    const memory = new InMemoryMemoryRepository();

    const engine = new ExecutionEngine(
      eventFactory,
      publisher,
      executions,
      memory,
      new DeterministicModelProvider(),
      new BuiltInToolExecutor(),
      clock,
      { workerId: "worker-outbox" }
    );

    const result = await engine.execute({
      agent: makeAgent(),
      execution: makeExecution(),
      task: { prompt: "irrelevant" }
    });

    expect(result.status).toBe("COMPLETED");

    const completedEvents = bus.published.filter((e) => e.type === "EXECUTION_COMPLETED");
    expect(completedEvents).toHaveLength(1);

    // The publisher's pending outbox must be empty after a successful publish.
    expect(publisher.pendingOutboxSize()).toBe(0);
  });

  it("(b) bus throws on terminal publish → engine still completes; dispatcher delivers EXECUTION_COMPLETED exactly once after recovery", async () => {
    const clock = new SystemClock();
    const eventStore = new InMemoryEventStore();
    const bus = new FlakyEventBus();
    const publisher = new PersistedEventPublisher(eventStore, bus);
    const eventFactory = new EventFactory(clock, "outbox-test");
    const executions = new InMemoryExecutionRepository();
    const memory = new InMemoryMemoryRepository();

    const engine = new ExecutionEngine(
      eventFactory,
      publisher,
      executions,
      memory,
      new DeterministicModelProvider(),
      new BuiltInToolExecutor(),
      clock,
      { workerId: "worker-outbox" }
    );

    // Scope the bus outage to terminal events only. Earlier intermediate
    // events (EXECUTION_STARTED, MODEL_COMPLETED, etc.) still go through
    // publisher.publish() — which is correctly NOT durable — so the engine
    // must reach the terminal save+publish step before encountering the
    // failure. The fix exists specifically to protect that pair.
    bus.failWhen(
      (e) => e.type === "EXECUTION_COMPLETED" || e.type === "EXECUTION_FAILED"
    );

    const result = await engine.execute({
      agent: makeAgent(),
      execution: makeExecution(),
      task: { prompt: "irrelevant" }
    });

    // The engine MUST return a COMPLETED record even though the bus failed —
    // the durable state (executions repo + event store) is the source of
    // truth, not the bus.
    expect(result.status).toBe("COMPLETED");

    // The persisted row matches.
    const persisted = await executions.getById(result.id);
    expect(persisted?.status).toBe("COMPLETED");

    // Intermediate events (EXECUTION_STARTED, MODEL_COMPLETED, etc.) flow
    // through publisher.publish() normally — they are NOT outbox-scoped, by
    // design, because they have no paired durable save. The bus outage we
    // configured only fails the terminal types. Assert specifically: no
    // terminal event was delivered.
    const deliveredTerminals = bus.delivered.filter(
      (e) => e.type === "EXECUTION_COMPLETED" || e.type === "EXECUTION_FAILED"
    );
    expect(deliveredTerminals).toHaveLength(0);

    // The terminal event sits in the publisher's pending outbox awaiting
    // dispatcher delivery.
    expect(publisher.pendingOutboxSize()).toBeGreaterThan(0);
    const pending = publisher.peekPending();
    expect(pending.some((e) => e.type === "EXECUTION_COMPLETED")).toBe(true);

    // Bus recovers. Dispatcher drains the pending outbox.
    bus.recover();
    const dispatcher = new OutboxDispatcher(publisher, bus);
    const drained = await dispatcher.tick();
    expect(drained).toBeGreaterThan(0);

    // After dispatch, the pending outbox is empty.
    expect(publisher.pendingOutboxSize()).toBe(0);

    // The bus received EXECUTION_COMPLETED exactly once (no duplicate).
    const completedDeliveries = bus.delivered.filter((e) => e.type === "EXECUTION_COMPLETED");
    expect(completedDeliveries).toHaveLength(1);

    // A second tick with nothing pending is a no-op (no double-delivery).
    const second = await dispatcher.tick();
    expect(second).toBe(0);
    const completedDeliveriesAfterSecondTick = bus.delivered.filter(
      (e) => e.type === "EXECUTION_COMPLETED"
    );
    expect(completedDeliveriesAfterSecondTick).toHaveLength(1);
  });

  it("(c) save throws → engine does NOT publish a terminal event; pre-existing behavior preserved", async () => {
    const clock = new SystemClock();
    const eventStore = new InMemoryEventStore();
    const bus = new CapturingEventBus();
    const publisher = new PersistedEventPublisher(eventStore, bus);
    const eventFactory = new EventFactory(clock, "outbox-test");
    const flakyExecutions = new FlakyExecutionRepository();
    const memory = new InMemoryMemoryRepository();

    const engine = new ExecutionEngine(
      eventFactory,
      publisher,
      flakyExecutions,
      memory,
      new DeterministicModelProvider(),
      new BuiltInToolExecutor(),
      clock,
      { workerId: "worker-outbox" }
    );

    // Break save AFTER the engine's initial save(RUNNING) succeeds. The
    // simplest path is: break the repo as soon as it's used. The first
    // save(RUNNING) at engine line 132 will throw → outer try catches →
    // catch tries save(FAILED) → also throws → the throw bubbles out of
    // execute(). Net effect: no terminal event published.
    flakyExecutions.breakSave();

    let thrown: unknown;
    try {
      await engine.execute({
        agent: makeAgent(),
        execution: makeExecution(),
        task: { prompt: "irrelevant" }
      });
    } catch (err) {
      thrown = err;
    }

    // Engine surfaces the save failure rather than silently corrupting.
    expect(thrown).toBeInstanceOf(Error);

    // No terminal event ever reaches the bus.
    const terminals = bus.published.filter(
      (e) => e.type === "EXECUTION_COMPLETED" || e.type === "EXECUTION_FAILED"
    );
    expect(terminals).toHaveLength(0);

    // No terminal event ends up pending either.
    const pending = publisher.peekPending();
    const pendingTerminals = pending.filter(
      (e) => e.type === "EXECUTION_COMPLETED" || e.type === "EXECUTION_FAILED"
    );
    expect(pendingTerminals).toHaveLength(0);
  });
});
