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
import { DedupingToolExecutor } from "../src/runtime/toolDedupExecutor.js";
import {
  sideEffectCapabilityRegistry,
  assertRetryAllowed,
  AmbiguityDetectedError,
  InvariantViolation
} from "../src/runtime/canonicalSemantics.js";
import { reconciliationRegistry } from "../src/runtime/reconciliation/reconciliationRegistry.js";
import { ReconciliationManager } from "../src/runtime/failure/reconciliationManager.js";
import { MockPaymentProvider } from "../src/runtime/reconciliation/mockPaymentProvider.js";
import { deterministicId } from "../src/shared/determinism.js";
import type { Agent, Execution } from "../src/domain/model.js";
import type { ModelProvider } from "../src/domain/ports.js";
import { createId } from "../src/shared/id.js";
import type { ReplaySessionState } from "../src/runtime/replay/replayExecutionCoordinator.js";

function seedReplaySession(
  engine: ExecutionEngine,
  execution: Execution,
  overrides: Partial<ReplaySessionState>
): void {
  const coordinator = (engine as unknown as { replayCoordinator?: { seedSessionForTest(s: ReplaySessionState): void } })
    .replayCoordinator;
  if (!coordinator) throw new Error("ExecutionEngine missing replayCoordinator — pass events in deps");
  coordinator.seedSessionForTest({
    executionId: execution.id,
    parentExecutionId: execution.parentExecutionId!,
    lifecycle: overrides.diverged ? "REPLAY_DIVERGED" : "REPLAY_EQUIVALENT",
    parentEvents: [],
    replayStepCount: 0,
    parentEventSequenceWatermark: 0,
    diverged: false,
    verified: false,
    ...overrides
  });
}

// ─── Test Helpers & Mocks ───
class InMemoryToolCallDedupStore {
  public records = new Map<string, any>();

  async beginCall(input: any): Promise<any> {
    const record = this.records.get(input.idempotencyKey);
    if (!record) {
      this.records.set(input.idempotencyKey, {
        idempotencyKey: input.idempotencyKey,
        executionId: input.executionId,
        agentId: input.agentId,
        toolName: input.toolName,
        attempt: input.attempt,
        status: "IN_FLIGHT",
        createdAt: new Date().toISOString(),
        tenantId: input.tenantId,
        argsHash: input.argsHash,
        stepSeq: input.stepSeq
      });
      return { mode: "FIRST_CALL" };
    }

    if (record.status === "COMPLETED" || record.status === "SUCCEEDED") {
      return { mode: "RETURN_CACHED", output: record.output! };
    }

    if (input.argsHash && record.argsHash && record.argsHash !== input.argsHash) {
      return { mode: "ARG_DRIFT", recordedArgsHash: record.argsHash, observedArgsHash: input.argsHash };
    }

    return { mode: "POLL_FOR_RESULT", sinceMs: Date.now() };
  }

  async markCompleted(idempotencyKey: string, output: Record<string, unknown>): Promise<void> {
    let r = this.records.get(idempotencyKey);
    if (!r) {
      r = {
        idempotencyKey,
        executionId: "unknown",
        agentId: "unknown",
        toolName: "unknown",
        attempt: 1,
        status: "COMPLETED",
        output,
        createdAt: new Date().toISOString(),
        tenantId: "system"
      };
      this.records.set(idempotencyKey, r);
    } else {
      r.status = "COMPLETED";
      r.output = output;
      r.completedAt = new Date().toISOString();
    }
  }

  async markFailed(idempotencyKey: string, errorMessage: string): Promise<void> {
    let r = this.records.get(idempotencyKey);
    if (!r) {
      r = {
        idempotencyKey,
        executionId: "unknown",
        agentId: "unknown",
        toolName: "unknown",
        attempt: 1,
        status: "FAILED",
        lastError: errorMessage,
        createdAt: new Date().toISOString(),
        tenantId: "system"
      };
      this.records.set(idempotencyKey, r);
    } else {
      r.status = "FAILED";
      r.lastError = errorMessage;
      r.completedAt = new Date().toISOString();
    }
  }

  async get(idempotencyKey: string): Promise<any | undefined> {
    return this.records.get(idempotencyKey);
  }
}

class MockModelProvider implements ModelProvider {
  async complete(): ReturnType<ModelProvider["complete"]> {
    return {
      output: { verdict: "success", summary: "Processed" },
      tokenUsage: { prompt: 10, completion: 20, total: 30 }
    };
  }
}

function buildHarness() {
  const clock = new SystemClock();
  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "idempotency-policy-test");
  const executions = new InMemoryExecutionRepository();
  const memory = new InMemoryMemoryRepository();
  const dedupStore = new InMemoryToolCallDedupStore();
  
  const innerExecutor = new BuiltInToolExecutor();
  const tools = new DedupingToolExecutor(innerExecutor, dedupStore, {
    resolveTenantId: () => "tenant-idempotency"
  });

  const reconciler = new ReconciliationManager(executions, dedupStore, publisher, eventFactory);

  const engine = new ExecutionEngine(
    eventFactory,
    publisher,
    executions,
    memory,
    new MockModelProvider(),
    tools,
    clock,
    { workerId: "worker-idempotency", checkpoints: undefined, events: eventStore }
  );

  return { engine, executions, eventStore, dedupStore, reconciler, clock };
}

function makeAgentAndExecution(toolsList: string[] = []): { agent: Agent; execution: Execution } {
  const now = new Date().toISOString();
  const agent: Agent = {
    id: "agent-idempotency",
    name: "idempotency-agent",
    goal: "validate capability safety",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    tools: toolsList.map((t) => ({ name: t, enabled: true })),
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-idempotency"
  };
  const execution: Execution = {
    id: "exec-idempotency",
    agentId: agent.id,
    status: "QUEUED",
    input: { prompt: "run checks" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-idempotency"
  };
  return { agent, execution };
}

describe("Idempotency Capability Enforcement Policies", () => {
  beforeEach(() => {
    sideEffectCapabilityRegistry.reset();
    reconciliationRegistry.clear();
    (globalThis as any).activeSandboxedExecutionRepos?.clear();
    (globalThis as any).activeSandboxedEventStores?.clear();
  });

  describe("1. Missing Capability Declarations (CAP1 Invariant)", () => {
    it("halt execution instantly when executing a tool missing capability declaration", async () => {
      const { engine, executions } = buildHarness();
      const { agent, execution } = makeAgentAndExecution(["sandbox.undeclared_tool"]);
      await executions.save(execution);

      // Do NOT register 'sandbox.undeclared_tool' in the registry

      await expect(
        engine.execute({
          agent,
          execution,
          task: { prompt: "test undeclared" },
          validateLease: async () => true,
          fence: { executionId: execution.id, workerId: "worker-idempotency", attempt: 1 }
        })
      ).rejects.toThrow(
        /\[invariant:CAP1\] Missing capability declaration for tool 'sandbox.undeclared_tool'/
      );
    });
  });

  describe("2. Unsafe Replay Safety (CAP3 Invariant & RP1)", () => {
    it("blocks live execution of NON_IDEMPOTENT and UNSAFE tools during replay before divergence", async () => {
      const { engine, executions } = buildHarness();
      const { agent, execution } = makeAgentAndExecution(["sandbox.payment_refund"]);
      
      execution.parentExecutionId = "parent-99";
      execution.status = "LEASE_ACQUISITION";
      await executions.save(execution);

      seedReplaySession(engine, execution, { diverged: false, lifecycle: "REPLAY_EQUIVALENT" });

      // payment_refund is NON_IDEMPOTENT. Trying to execute it live (without a cached match in parentEvents) must throw CAP3 or RP1.
      await expect(
        engine.execute({
          agent,
          execution,
          task: { prompt: "run step" },
          validateLease: async () => true,
          fence: { executionId: execution.id, workerId: "worker-idempotency", attempt: 1 }
        })
      ).rejects.toThrow(
        /\[invariant:(CAP3|RP1)\]/
      );
    });

    it("blocks execution of NON_IDEMPOTENT and UNSAFE tools during replay after divergence (RP1)", async () => {
      const { engine, executions } = buildHarness();
      const { agent, execution } = makeAgentAndExecution(["sandbox.payment_refund"]);
      
      execution.parentExecutionId = "parent-99";
      execution.status = "LEASE_ACQUISITION";
      await executions.save(execution);

      seedReplaySession(engine, execution, { diverged: true, lifecycle: "REPLAY_DIVERGED" });

      await expect(
        engine.execute({
          agent,
          execution,
          task: { prompt: "run step" },
          validateLease: async () => true,
          fence: { executionId: execution.id, workerId: "worker-idempotency", attempt: 1 }
        })
      ).rejects.toThrow(
        /Replay Side-Effect Mutex violation/
      );
    });
  });

  describe("3. Non-Idempotent Retries Enforcement (CAP4 Invariant)", () => {
    it("asserts that retrying a non-idempotent failed execution without reconciliation is illegal", async () => {
      const { executions } = buildHarness();
      const { execution } = makeAgentAndExecution();
      
      execution.status = "FAILED";
      execution.failure = {
        message: "refund timeout",
        code: "AMBIGUOUS_EXTERNAL_COMMIT",
        recoverable: false
      };
      await executions.save(execution);

      // Attempting to retry a non-idempotent/ambiguous failure must throw CAP4 Invariant Violation
      expect(() => {
        assertRetryAllowed("AMBIGUOUS_EXTERNAL_COMMIT", execution.id);
      }).toThrow(
        /\[invariant:CAP4\] Unsafe retry blocked: execution '.*' failed due to non-idempotent side effect/
      );
    });
  });

  describe("4. Provider Inconsistency Quarantine", () => {
    it("quarantines execution in RECONCILIATION_REQUIRED when provider reconciliation fails or returns UNKNOWN", async () => {
      const { reconciler, executions } = buildHarness();
      const { execution } = makeAgentAndExecution();
      execution.status = "SIDE_EFFECT_PENDING";
      await executions.save(execution);

      const mockProvider = new MockPaymentProvider();
      mockProvider.behavior.forceStatus = "UNKNOWN"; // simulate inconsistency
      reconciliationRegistry.register("sandbox.payment_refund", mockProvider);

      // Pre-initialize record with maxAttempts = 1 to force immediate operator escalation on inconclusive check
      reconciler.engine.initiateReconciliation(
        execution.id,
        "idem_key_inconsistent",
        "sandbox.payment_refund",
        { amount: 500 },
        1
      );

      const reconCtx = {
        executionId: execution.id,
        toolName: "sandbox.payment_refund",
        args: { amount: 500 },
        idempotencyKey: "idem_key_inconsistent",
        stepSequence: 1
      };

      await expect(
        reconciler.verifyAndReconcile(reconCtx, execution, new Date())
      ).rejects.toThrow(AmbiguityDetectedError);

      const updated = await executions.getById(execution.id);
      expect(updated?.status).toBe("RECONCILIATION_REQUIRED");
      expect(updated?.failure?.code).toBe("AMBIGUOUS_EXTERNAL_COMMIT");
    });
  });

  describe("5. Replay After Ambiguity Prevention (Bypass Blocked)", () => {
    it("prevents execution engine from running when execution is quarantined in reconciliation states", async () => {
      const { engine, executions } = buildHarness();
      const { agent, execution } = makeAgentAndExecution(["sandbox.payment_refund"]);
      
      execution.status = "RECONCILIATION_REQUIRED";
      await executions.save(execution);

      await expect(
        engine.execute({
          agent,
          execution,
          task: { prompt: "try to bypass quarantine" },
          validateLease: async () => true,
          fence: { executionId: execution.id, workerId: "worker-idempotency", attempt: 2 }
        })
      ).rejects.toThrow(/Ambiguity Bypass Blocked/);
    });
  });

  describe("6. UNSAFE requires Operator Approval (CAP2 Invariant)", () => {
    it("blocks UNSAFE execution when operatorApproved is absent or false", async () => {
      const { engine, executions } = buildHarness();
      const { agent, execution } = makeAgentAndExecution(["sandbox.unsafe_command"]);
      await executions.save(execution);

      // Declare 'sandbox.unsafe_command' as UNSAFE
      sideEffectCapabilityRegistry.register("sandbox.unsafe_command", "UNSAFE");

      await expect(
        engine.execute({
          agent,
          execution,
          task: { prompt: "run unsafe command" },
          validateLease: async () => true,
          fence: { executionId: execution.id, workerId: "worker-idempotency", attempt: 1 }
        })
      ).rejects.toThrow(
        /\[invariant:CAP2\] Unsafe execution blocked: tool 'sandbox.unsafe_command' is classified as UNSAFE and requires operator approval/
      );
    });

    it("allows UNSAFE execution when operatorApproved is true", async () => {
      const { engine, executions } = buildHarness();
      const { agent, execution } = makeAgentAndExecution(["sandbox.unsafe_command"]);
      execution.input = { prompt: "run unsafe command", operatorApproved: true }; // pre-approval
      await executions.save(execution);

      // Declare 'sandbox.unsafe_command' as UNSAFE
      sideEffectCapabilityRegistry.register("sandbox.unsafe_command", "UNSAFE");

      // We simulate pre-approved execution by wrapping arguments with operatorApproved = true
      const result = await engine.execute({
        agent,
        execution,
        task: { prompt: "run unsafe command", operatorApproved: true }, // pre-approval
        validateLease: async () => true,
        fence: { executionId: execution.id, workerId: "worker-idempotency", attempt: 1 }
      });

      expect(result.status).toBe("COMPLETED");
    });
  });
});
