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
import { ExecutionEngine } from "../src/runtime/executionEngine.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import type { DomainEvent } from "../src/domain/events.js";
import type { Agent, Execution } from "../src/domain/model.js";
import type { ModelProvider } from "../src/domain/ports.js";

/**
 * Fencing in the FAILURE branch of ExecutionEngine.execute().
 *
 * Background: the success branch calls assertFencing() before save+publish
 * (executionEngine.ts:216). The failure branch did not — a worker whose
 * lease was revoked could still write status="FAILED" over a successful
 * COMPLETED row already committed by the legitimate new owner.
 *
 * These tests pin both branches of the corrected behavior:
 *   (a) Valid lease + model failure → status FAILED is saved and
 *       EXECUTION_FAILED is published. Pre-existing behavior; must not regress.
 *   (b) Revoked lease + model failure → execution row is NOT mutated,
 *       EXECUTION_FAILED is NOT published, and EXECUTION_FENCE_REJECTED IS
 *       published with the attempted status and the original model error.
 */

class FailingModelProvider implements ModelProvider {
  constructor(private readonly message: string) {}
  async complete(): ReturnType<ModelProvider["complete"]> {
    throw new Error(this.message);
  }
}

function buildEngineHarness() {
  const clock = new SystemClock();
  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "fencing-test");
  const executions = new InMemoryExecutionRepository();
  const memory = new InMemoryMemoryRepository();

  const observedEvents: DomainEvent[] = [];
  bus.subscribe((event) => {
    observedEvents.push(event);
  });

  const engine = new ExecutionEngine(
    eventFactory,
    publisher,
    executions,
    memory,
    new FailingModelProvider("simulated provider failure"),
    new BuiltInToolExecutor(),
    clock,
    { workerId: "worker-stale" }
  );

  return { engine, executions, eventStore, observedEvents };
}

function makeAgentAndExecution(): { agent: Agent; execution: Execution } {
  const now = new Date().toISOString();
  const agent: Agent = {
    id: "agent-fencing",
    name: "fencing-test-agent",
    goal: "exercise the failure branch",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    // No enabled tools — keeps the engine path short, only model call throws.
    tools: [{ name: "runtime.inspect", enabled: false }],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-fencing"
  };
  const execution: Execution = {
    id: "exec-fencing",
    agentId: agent.id,
    status: "QUEUED",
    input: { prompt: "irrelevant" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-fencing"
  };
  return { agent, execution };
}

describe("ExecutionEngine failure-branch fencing", () => {
  it("(a) failure with a valid lease writes FAILED and publishes EXECUTION_FAILED", async () => {
    const { engine, executions, observedEvents } = buildEngineHarness();
    const { agent, execution } = makeAgentAndExecution();

    const result = await engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: "worker-stale",
      validateLease: async () => true
    });

    expect(result.status).toBe("FAILED");
    expect(result.failure?.message).toBe("simulated provider failure");

    const persisted = await executions.getById(execution.id);
    expect(persisted?.status).toBe("FAILED");

    const failedEvents = observedEvents.filter((e) => e.type === "EXECUTION_FAILED");
    expect(failedEvents).toHaveLength(1);

    const rejectedEvents = observedEvents.filter((e) => e.type === "EXECUTION_FENCE_REJECTED");
    expect(rejectedEvents).toHaveLength(0);
  });

  it("(b) failure with a revoked lease does NOT save FAILED, suppresses EXECUTION_FAILED, and emits EXECUTION_FENCE_REJECTED", async () => {
    const { engine, executions, observedEvents } = buildEngineHarness();
    const { agent, execution } = makeAgentAndExecution();

    // Lease validator returns false — simulates the legitimate new owner having
    // taken over while this worker was mid-model-call.
    const result = await engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: "worker-stale",
      validateLease: async () => false
    });

    // Returned value must NOT be a mutated FAILED record. The stale worker
    // surrenders silently — the engine returns the original (RUNNING) row.
    expect(result.status).not.toBe("FAILED");

    // Persisted state: the execution row may still be RUNNING (from the
    // engine's first save at line 132) — but it MUST NOT have been overwritten
    // with FAILED by the stale worker.
    const persisted = await executions.getById(execution.id);
    expect(persisted?.status).not.toBe("FAILED");

    // Bus: no EXECUTION_FAILED leaked downstream.
    const failedEvents = observedEvents.filter((e) => e.type === "EXECUTION_FAILED");
    expect(failedEvents).toHaveLength(0);

    // Bus: exactly one EXECUTION_FENCE_REJECTED carrying the attempted status
    // and the original underlying error.
    const rejectedEvents = observedEvents.filter((e) => e.type === "EXECUTION_FENCE_REJECTED");
    expect(rejectedEvents).toHaveLength(1);

    const payload = rejectedEvents[0]!.payload as {
      executionId: string;
      workerId: string;
      attemptedStatus: string;
      originalError: string;
    };
    expect(payload.executionId).toBe(execution.id);
    expect(payload.workerId).toBe("worker-stale");
    expect(payload.attemptedStatus).toBe("FAILED");
    expect(payload.originalError).toBe("simulated provider failure");
  });
});
