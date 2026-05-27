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
 * AbortSignal plumbing in ExecutionEngine.execute().
 *
 * Goal: a worker that learns mid-execution that its lease was revoked
 * should be able to cancel its in-flight model call instead of running
 * to completion and being fenced out at the end. This costs tokens and
 * delays the legitimate new owner.
 *
 * (a) Signal aborted BEFORE execute() runs → engine surrenders
 *     immediately. No save, no terminal event. Publishes EXECUTION_ABORTED.
 *
 * (b) Signal aborted DURING the model call → modelProvider.complete()
 *     throws AbortError. Engine catches AbortError specifically (NOT as a
 *     generic failure), publishes EXECUTION_ABORTED, returns input.execution
 *     unchanged. No save, no EXECUTION_FAILED.
 */

/**
 * Model provider whose `complete()` resolves after a long delay unless the
 * signal aborts first, in which case it throws an AbortError. Mirrors how a
 * real LLM call behaves under cancellation (fetch with signal).
 */
class CancellableModelProvider implements ModelProvider {
  async complete(input: Parameters<ModelProvider["complete"]>[0]): ReturnType<ModelProvider["complete"]> {
    return new Promise((resolve, reject) => {
      if (input.signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        clearTimeout(handle);
        reject(new DOMException("Aborted", "AbortError"));
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });

      const handle = setTimeout(() => {
        input.signal?.removeEventListener("abort", onAbort);
        resolve({
          output: { result: "completed despite abort attempt" },
          tokenUsage: { prompt: 5, completion: 5, total: 10 }
        });
      }, 10_000);
    });
  }
}

function buildHarness(modelProvider: ModelProvider) {
  const clock = new SystemClock();
  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "cancellation-test");
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
    modelProvider,
    new BuiltInToolExecutor(),
    clock,
    { workerId: "worker-cancellation" }
  );

  return { engine, executions, observedEvents };
}

function makeAgentAndExecution(): { agent: Agent; execution: Execution } {
  const now = new Date().toISOString();
  const agent: Agent = {
    id: "agent-cancellation",
    name: "cancellation-test-agent",
    goal: "exercise abort semantics",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    tools: [{ name: "runtime.inspect", enabled: false }],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-cancellation"
  };
  const execution: Execution = {
    id: "exec-cancellation",
    agentId: agent.id,
    status: "QUEUED",
    input: { prompt: "irrelevant" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-cancellation"
  };
  return { agent, execution };
}

describe("ExecutionEngine AbortSignal plumbing", () => {
  it("(a) signal pre-aborted: engine surrenders, no save, only EXECUTION_ABORTED published", async () => {
    const { engine, executions, observedEvents } = buildHarness(new CancellableModelProvider());
    const { agent, execution } = makeAgentAndExecution();

    const controller = new AbortController();
    controller.abort();

    const result = await engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: "worker-cancellation",
      signal: controller.signal
    });

    // Returned value must be the unmodified input — no transition, no save.
    expect(result.status).toBe("QUEUED");
    expect(result).toBe(execution); // reference-equal, same sentinel as fencing rejection

    const persisted = await executions.getById(execution.id);
    // The engine's first save (RUNNING) must NOT have happened.
    expect(persisted).toBeUndefined();

    // No terminal events of any kind.
    const failed = observedEvents.filter((e) => e.type === "EXECUTION_FAILED");
    const completed = observedEvents.filter((e) => e.type === "EXECUTION_COMPLETED");
    expect(failed).toHaveLength(0);
    expect(completed).toHaveLength(0);

    // Exactly one EXECUTION_ABORTED with the right shape.
    const aborted = observedEvents.filter((e) => e.type === "EXECUTION_ABORTED");
    expect(aborted).toHaveLength(1);
    const payload = aborted[0]!.payload as {
      executionId: string;
      workerId: string;
      reason: string;
    };
    expect(payload.executionId).toBe(execution.id);
    expect(payload.workerId).toBe("worker-cancellation");
    expect(payload.reason).toBe("manual");
  });

  it("(b) signal aborted during model call: engine surrenders, publishes EXECUTION_ABORTED, no FAILED", async () => {
    const { engine, executions, observedEvents } = buildHarness(new CancellableModelProvider());
    const { agent, execution } = makeAgentAndExecution();

    const controller = new AbortController();

    // Kick off the execution, then abort after the engine is mid-model-call.
    // The model provider's setTimeout means execute() is "live" within a
    // few microseconds; setting a short setTimeout to fire the abort.
    const pending = engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: "worker-cancellation",
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 25);
    const result = await pending;

    // Returned value MUST be the unmodified input — same surrender semantics
    // as fencing rejection. The engine's RUNNING save did happen earlier
    // (line 132), but no terminal save followed.
    expect(result).toBe(execution);

    const persisted = await executions.getById(execution.id);
    // The persisted record exists in RUNNING state — the engine wrote it
    // before invoking the model call. Crucially it MUST NOT have been
    // mutated to FAILED by the catch branch.
    expect(persisted?.status).toBe("RUNNING");

    const failed = observedEvents.filter((e) => e.type === "EXECUTION_FAILED");
    expect(failed).toHaveLength(0);

    const aborted = observedEvents.filter((e) => e.type === "EXECUTION_ABORTED");
    expect(aborted).toHaveLength(1);
    const payload = aborted[0]!.payload as {
      executionId: string;
      workerId: string;
      reason: string;
    };
    expect(payload.executionId).toBe(execution.id);
    expect(payload.workerId).toBe("worker-cancellation");
    expect(payload.reason).toBe("manual");
  });
});
