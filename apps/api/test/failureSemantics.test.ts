import { describe, expect, it, vi } from "vitest";
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
import { assertTransition, LEGAL_TRANSITIONS, IllegalTransitionError } from "../src/runtime/stateMachine.js";
import {
  type ToolCallDedupStore,
  type ToolCallDedupRecord,
  type ToolCallDedupBegin,
  type BeginCallMode,
  type FencedMarkOutcome
} from "../src/domain/toolDedup.js";
import { DedupingToolExecutor } from "../src/runtime/toolDedupExecutor.js";
import {
  verificationRegistry,
  AmbiguityDetectedError,
  RECOVERY_SEMANTICS_MAP
} from "../src/runtime/failure/failureSemantics.js";
import { ReconciliationManager } from "../src/runtime/failure/reconciliationManager.js";
import type { Agent, Execution } from "../src/domain/model.js";
import type { ModelProvider } from "../src/domain/ports.js";
import { createId } from "../src/shared/id.js";
import { deterministicId } from "../src/shared/determinism.js";
import pino from "pino";
import { WorkerExecutionLoop } from "../src/application/cluster/workerExecutionLoop.js";
import { InMemoryExecutionJobQueue } from "../src/infrastructure/queue/inMemoryExecutionJobQueue.js";
import type { ExecutionJob } from "../src/domain/jobQueue.js";
import { InMemoryDeadLetterStore } from "../src/infrastructure/reliability/deadLetterStore.js";
import { InMemoryLeaseStore, InMemoryWorkerRegistry, InMemoryCheckpointStore } from "../src/infrastructure/cluster/inMemoryClusterStores.js";
import { LeaseHeartbeatWorker } from "../src/infrastructure/cluster/leaseHeartbeatWorker.js";
import { InMemoryAgentRepository } from "../src/infrastructure/persistence/inMemoryStores.js";


// ─── Mock Dedup Store ───
class InMemoryToolCallDedupStore implements ToolCallDedupStore {
  public records = new Map<string, ToolCallDedupRecord>();

  async beginCall(input: ToolCallDedupBegin): Promise<BeginCallMode> {
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

  async get(idempotencyKey: string): Promise<ToolCallDedupRecord | undefined> {
    return this.records.get(idempotencyKey);
  }

  async markCompletedFenced(input: {
    idempotencyKey: string;
    executionId: string;
    expectedFencingToken: number;
    output: Record<string, unknown>;
  }): Promise<FencedMarkOutcome> {
    await this.markCompleted(input.idempotencyKey, input.output);
    return { outcome: "COMMITTED" };
  }

  async markFailedFenced(input: {
    idempotencyKey: string;
    executionId: string;
    expectedFencingToken: number;
    errorMessage: string;
  }): Promise<FencedMarkOutcome> {
    await this.markFailed(input.idempotencyKey, input.errorMessage);
    return { outcome: "COMMITTED" };
  }
}

// ─── Mock Model Provider ───
class MockModelProvider implements ModelProvider {
  async complete(): ReturnType<ModelProvider["complete"]> {
    return {
      output: { verdict: "success", summary: "Task processed successfully" },
      tokenUsage: { prompt: 10, completion: 20, total: 30 }
    };
  }
}

// ─── Helpers ───
function buildHarness() {
  const clock = new SystemClock();
  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "failure-semantics-test");
  const executions = new InMemoryExecutionRepository();
  const memory = new InMemoryMemoryRepository();
  const dedupStore = new InMemoryToolCallDedupStore();
  
  const innerExecutor = new BuiltInToolExecutor();
  const tools = new DedupingToolExecutor(innerExecutor, dedupStore, {
    resolveTenantId: () => "tenant-failure"
  });

  const observedEvents: any[] = [];
  bus.subscribe((event) => {
    observedEvents.push(event);
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
    { workerId: "worker-recovery", checkpoints: undefined, events: eventStore }
  );

  return { engine, executions, eventStore, observedEvents, dedupStore, reconciler, clock };
}

function buildLoopHarness(modelProvider: ModelProvider) {
  const clock = new SystemClock();
  const logger = pino({ level: "silent" });
  const workerId = "worker-failure-test";

  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "worker-failure-test");

  const observedEvents: any[] = [];
  bus.subscribe((event) => {
    observedEvents.push(event);
  });

  const agents = new InMemoryAgentRepository();
  const executions = new InMemoryExecutionRepository();
  const memory = new InMemoryMemoryRepository();
  const workers = new InMemoryWorkerRegistry();
  const leases = new InMemoryLeaseStore();
  const checkpoints = new InMemoryCheckpointStore();
  const deadLetterQueue = new InMemoryDeadLetterStore();
  const queue = new InMemoryExecutionJobQueue({ visibilityMs: 30_000 });

  const engine = new ExecutionEngine(
    eventFactory,
    publisher,
    executions,
    memory,
    modelProvider,
    new BuiltInToolExecutor(),
    clock,
    { checkpoints, workerId }
  );

  const heartbeat = new LeaseHeartbeatWorker(leases, publisher, eventFactory, clock, logger, {
    workerId,
    leaseTtlMs: 60_000,
    renewThresholdFactor: 0.4,
    pollIntervalMs: 60_000
  });

  const loop = new WorkerExecutionLoop(
    engine,
    queue,
    executions,
    agents,
    leases,
    workers,
    publisher,
    eventFactory,
    clock,
    deadLetterQueue,
    heartbeat,
    logger,
    {
      workerId,
      leaseTtlMs: 60_000,
      maxAttempts: 3,
      retryBackoffBaseMs: 10,
      retryBackoffMaxMs: 100,
      consumerGroup: "test-group",
      queueBlockMs: 50
    }
  );

  return { loop, queue, agents, executions, workers, leases, deadLetterQueue, observedEvents, workerId };
}

function makeTestAgentAndExecution(): { agent: Agent; execution: Execution } {
  const now = new Date().toISOString();
  const agent: Agent = {
    id: "agent-failure",
    name: "failure-semantics-agent",
    goal: "assert failure semantics",
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
    tools: [
      { name: "sandbox.payment_refund", enabled: true },
      { name: "sandbox.db_write", enabled: false }
    ],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
    createdAt: now,
    updatedAt: now,
    tenantId: "tenant-failure"
  };
  const execution: Execution = {
    id: "exec-failure",
    agentId: agent.id,
    status: "QUEUED",
    input: { prompt: "test safety" },
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: now,
    updatedAt: now,
    tenantId: "tenant-failure"
  };
  return { agent, execution };
}

describe("Failure Semantics & Ambiguity Handling", () => {
  
  describe("State Transitions & Semantics", () => {
    it("defines canonical failure taxonomy explicitly in RECOVERY_SEMANTICS_MAP", () => {
      expect(RECOVERY_SEMANTICS_MAP.PROCESS_CRASH.retryable).toBe(true);
      expect(RECOVERY_SEMANTICS_MAP.PROCESS_CRASH.terminal).toBe(false);
      expect(RECOVERY_SEMANTICS_MAP.AMBIGUOUS_EXTERNAL_COMMIT.requiresHumanIntervention).toBe(true);
      expect(RECOVERY_SEMANTICS_MAP.AMBIGUOUS_EXTERNAL_COMMIT.retryable).toBe(false);
      expect(RECOVERY_SEMANTICS_MAP.STALE_WORKER_MUTATION.terminal).toBe(true);
    });

    it("verifies state machine legal transitions for AMBIGUOUS & RECONCILIATION_REQUIRED", () => {
      // Legal: RUNNING -> AMBIGUOUS -> RECONCILIATION_REQUIRED -> RECOVERING
      expect(() => assertTransition("exec-1", "RUNNING", "AMBIGUOUS")).not.toThrow();
      expect(() => assertTransition("exec-1", "AMBIGUOUS", "RECONCILIATION_REQUIRED")).not.toThrow();
      expect(() => assertTransition("exec-1", "RECONCILIATION_REQUIRED", "RECOVERING")).not.toThrow();
      expect(() => assertTransition("exec-1", "RECONCILIATION_REQUIRED", "RUNNING")).not.toThrow();

      // Illegal: COMPLETED -> AMBIGUOUS
      expect(() => assertTransition("exec-1", "COMPLETED", "AMBIGUOUS")).toThrow(IllegalTransitionError);
    });
  });

  describe("ReconciliationManager Flows", () => {
    it("resolves to COMMITTED successfully if hook matches", async () => {
      const { reconciler, dedupStore, executions } = buildHarness();
      const { execution } = makeTestAgentAndExecution();
      await executions.save(execution);

      // Register COMMITTED hook
      verificationRegistry.register("sandbox.payment_refund", async (ctx) => {
        return { status: "COMMITTED", output: { refunded: true, transaction: "TX_100" } };
      });

      const reconCtx = {
        executionId: execution.id,
        toolName: "sandbox.payment_refund",
        args: { amount: 100 },
        idempotencyKey: "idem_1",
        stepSequence: 1
      };

      const result = await reconciler.verifyAndReconcile(reconCtx, execution, new Date());
      expect(result.status).toBe("COMMITTED");
      expect(result.output?.refunded).toBe(true);

      const cached = await dedupStore.get("idem_1");
      expect(cached?.status).toBe("COMPLETED");
      expect(cached?.output?.transaction).toBe("TX_100");

      verificationRegistry.clear();
    });

    it("resolves to NOT_COMMITTED successfully if hook indicates no side effect happened", async () => {
      const { reconciler, executions } = buildHarness();
      const { execution } = makeTestAgentAndExecution();
      await executions.save(execution);

      verificationRegistry.register("sandbox.payment_refund", async () => {
        return { status: "NOT_COMMITTED" };
      });

      const reconCtx = {
        executionId: execution.id,
        toolName: "sandbox.payment_refund",
        args: { amount: 100 },
        idempotencyKey: "idem_2",
        stepSequence: 1
      };

      const result = await reconciler.verifyAndReconcile(reconCtx, execution, new Date());
      expect(result.status).toBe("NOT_COMMITTED");

      verificationRegistry.clear();
    });

    it("escalates to AMBIGUOUS and RECONCILIATION_REQUIRED when hook is ambiguous or missing for unsafe tool", async () => {
      const { reconciler, executions, observedEvents } = buildHarness();
      const { execution } = makeTestAgentAndExecution();
      execution.status = "SIDE_EFFECT_PENDING";
      await executions.save(execution);

      // No hook registered, sandbox.payment_refund is unsafe (not listed in safe tools)
      const reconCtx = {
        executionId: execution.id,
        toolName: "sandbox.payment_refund",
        args: { amount: 1200 },
        idempotencyKey: "idem_3",
        stepSequence: 2
      };

      await expect(
        reconciler.verifyAndReconcile(reconCtx, execution, new Date())
      ).rejects.toThrow(AmbiguityDetectedError);

      const updated = await executions.getById(execution.id);
      expect(updated?.status).toBe("RECONCILIATION_REQUIRED");
      expect(updated?.failure?.code).toBe("AMBIGUOUS_EXTERNAL_COMMIT");

      const reconciliationEvents = observedEvents.filter(e => e.type === "EXECUTION_RECONCILIATION_REQUIRED");
      expect(reconciliationEvents).toHaveLength(1);
      expect(reconciliationEvents[0].payload.toolName).toBe("sandbox.payment_refund");
    });

    it("enables manual operator override resolutions (operatorResolve COMMIT/ABORT)", async () => {
      const { reconciler, executions, observedEvents, dedupStore } = buildHarness();
      const { execution } = makeTestAgentAndExecution();
      execution.status = "RECONCILIATION_REQUIRED";
      await executions.save(execution);

      // 1. operator overrides with COMMIT
      const resolved = await reconciler.operatorResolve(
        execution.id,
        "COMMIT",
        new Date(),
        { status: "manually-verified", refundId: "ref_1" }
      );

      expect(resolved.status).toBe("RECOVERING");
      
      const persisted = await executions.getById(execution.id);
      expect(persisted?.status).toBe("RECOVERING");

      const cache = await dedupStore.get(execution.id);
      expect(cache?.status).toBe("COMPLETED");
      expect(cache?.output?.refundId).toBe("ref_1");

      const resolvedEvents = observedEvents.filter(e => e.type === "EXECUTION_RECONCILIATION_RESOLVED");
      expect(resolvedEvents).toHaveLength(1);
      expect(resolvedEvents[0].payload.resolution).toBe("COMMIT");

      // 2. operator overrides with ABORT
      persisted!.status = "RECONCILIATION_REQUIRED";
      await executions.save(persisted!);

      const aborted = await reconciler.operatorResolve(
        execution.id,
        "ABORT",
        new Date(),
        undefined,
        "Manual rejection by operator due to refund verification failure"
      );

      expect(aborted.status).toBe("FAILED");
      expect(aborted.failure?.message).toContain("verification failure");
    });
  });

  describe("Engine Interception & Crash-after-side-effect Prevention", () => {
    it("successfully bypasses execution when resume verification confirms COMMITTED", async () => {
      const { engine, executions, dedupStore, observedEvents } = buildHarness();
      const { agent, execution } = makeTestAgentAndExecution();
      
      // Simulate crash-after-side-effect: execution is in RECOVERING state,
      // dedup store has IN_FLIGHT status for the side effect
      execution.status = "RECOVERING";
      await executions.save(execution);

      const idempotencyKey = deterministicId([execution.id, "seq:3"]); // stepSequence 3
      await dedupStore.beginCall({
        idempotencyKey,
        executionId: execution.id,
        agentId: agent.id,
        toolName: "sandbox.payment_refund",
        attempt: 1,
        tenantId: "tenant-failure",
        stepSeq: 3
      });

      // Register COMMITTED hook to confirm it went through
      verificationRegistry.register("sandbox.payment_refund", async () => {
        return { status: "COMMITTED", output: { success: true, txn: "991" } };
      });

      // The execute job is re-run. Payment refund tool must be bypassed because
      // of verification confirmation.
      const result = await engine.execute({
        agent,
        execution,
        task: { prompt: "run step" },
        validateLease: async () => true,
        fence: { executionId: execution.id, workerId: "worker-recovery", attempt: 1 }
      });

      expect(result.status).toBe("COMPLETED");
      expect(result.output?.verdict).toBe("success");

      // Verify that TOOL_CALLED event contains the bypassed output
      const toolEvents = observedEvents.filter(e => e.type === "TOOL_CALLED");
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0].payload.toolCall.output.txn).toBe("991");

      verificationRegistry.clear();
    });

    it("throws AmbiguityDetectedError and quarantines execution when resume verification is ambiguous/missing", async () => {
      const { engine, executions, dedupStore } = buildHarness();
      const { agent, execution } = makeTestAgentAndExecution();
      
      execution.status = "RECOVERING";
      await executions.save(execution);

      const idempotencyKey = deterministicId([execution.id, "seq:3"]);
      await dedupStore.beginCall({
        idempotencyKey,
        executionId: execution.id,
        agentId: agent.id,
        toolName: "sandbox.payment_refund",
        attempt: 1,
        tenantId: "tenant-failure",
        stepSeq: 3
      });

      // payment_refund is unsafe, and NO hook is registered, so we expect an ambiguity escalation!
      await expect(
        engine.execute({
          agent,
          execution,
          task: { prompt: "run step" },
          validateLease: async () => true,
          fence: { executionId: execution.id, workerId: "worker-recovery", attempt: 1 }
        })
      ).rejects.toThrow(AmbiguityDetectedError);

      const updated = await executions.getById(execution.id);
      expect(updated?.status).toBe("RECONCILIATION_REQUIRED");
    });
  });

  describe("Replay Safety & Assertions", () => {
    it("Invariant RP1: Replay Side-Effect Mutex prevents execution of unsafe tool after replay divergence", async () => {
      const { engine, executions } = buildHarness();
      const { agent, execution } = makeTestAgentAndExecution();
      
      // Mark as replay execution and simulate replay divergence
      execution.parentExecutionId = "parent-123";
      execution.status = "LEASE_ACQUISITION";
      await executions.save(execution);

      const coordinator = (engine as unknown as {
        replayCoordinator?: { seedSessionForTest(s: unknown): void };
      }).replayCoordinator;
      coordinator?.seedSessionForTest({
        executionId: execution.id,
        parentExecutionId: execution.parentExecutionId!,
        lifecycle: "REPLAY_DIVERGED",
        parentEvents: [],
        replayStepCount: 0,
        parentEventSequenceWatermark: 0,
        diverged: true,
        verified: false
      });

      // Try running the execute engine containing the payment refund step.
      // Replay Side-Effect Mutex assertion (RP1) must throw and block progress.
      await expect(
        engine.execute({
          agent,
          execution,
          task: { prompt: "unsafe tool step" },
          validateLease: async () => true,
          fence: { executionId: execution.id, workerId: "worker-recovery", attempt: 1 }
        })
      ).rejects.toThrow(/Replay Side-Effect Mutex violation/);
    });
  });

  describe("Silent Ambiguity Bypass & Recovery Fencing Assertions", () => {
    it("Invariant S3: Silent ambiguity bypass prevention prevents executing quarantined tasks", async () => {
      const { engine, executions } = buildHarness();
      const { agent, execution } = makeTestAgentAndExecution();
      
      execution.status = "RECONCILIATION_REQUIRED";
      await executions.save(execution);

      await expect(
        engine.execute({
          agent,
          execution,
          task: { prompt: "run step" },
          validateLease: async () => true,
          fence: { executionId: execution.id, workerId: "worker-recovery", attempt: 2 }
        })
      ).rejects.toThrow(/Ambiguity Bypass Blocked/);
    });

    it("Invariant R1: Recovery fence monotonicity asserts attempt count is strictly monotonic", async () => {
      const { engine, executions } = buildHarness();
      const { agent, execution } = makeTestAgentAndExecution();
      
      execution.status = "RECOVERING";
      await executions.save(execution);

      // attempt count must be > 1 for recovery mode, otherwise duplicate recovery race is flagged
      await expect(
        engine.execute({
          agent,
          execution,
          task: { prompt: "run step" },
          validateLease: async () => true,
          fence: { executionId: execution.id, workerId: "worker-production", attempt: 1 },
          workerId: "worker-production"
        })
      ).rejects.toThrow(/Recovery Fence Monotonicity violation/);
    });
  });

  describe("Unsafe Retry & Dead Letter Queue Integration", () => {
    class FailingModelProvider implements ModelProvider {
      async complete(): ReturnType<ModelProvider["complete"]> {
        throw new Error("simulated replay divergence error");
      }
    }

    it("Invariant R2: unsafe retry prevention dead-letters a non-retryable failure immediately", async () => {
      const h = buildLoopHarness(new FailingModelProvider());
      const now = new Date().toISOString();

      await h.workers.register({
        id: h.workerId,
        host: "test-host",
        version: "0.1.0",
        capacity: 4,
        status: "READY",
        load: { cpu: 0, memory: 0, inFlight: 0, queueDepth: 0, eventsPerSecond: 0 },
        startedAt: now,
        lastHeartbeatAt: now
      });

      const agent: Agent = {
        id: "agent-retry-test",
        name: "retry-test-agent",
        goal: "test unsafe retry prevention",
        state: "RUNNING",
        runtimeStatus: "BUSY",
        model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
        tools: [],
        memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
        createdAt: now,
        updatedAt: now,
        tenantId: "tenant-retry"
      };
      await h.agents.save(agent);

      const execution: Execution = {
        id: "exec-retry-test",
        agentId: agent.id,
        status: "QUEUED",
        input: { prompt: "irrelevant" },
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        startedAt: now,
        updatedAt: now,
        tenantId: "tenant-retry"
      };
      await h.executions.save(execution);

      const job: ExecutionJob = {
        jobId: createId(),
        agentId: agent.id,
        executionId: execution.id,
        agentSnapshot: agent,
        executionSnapshot: execution,
        task: execution.input,
        enqueuedAt: now,
        attempt: 1,
        priorFailures: 0
      };
      await h.queue.enqueue(job);

      const consumed = await h.loop.tick();
      expect(consumed).toBe(true);

      const deadline = Date.now() + 2000;
      while (h.loop.inFlightCount() > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }

      const dlqEntries = await h.deadLetterQueue.list();
      expect(dlqEntries).toHaveLength(1);
      expect(dlqEntries[0].executionId).toBe(execution.id);
      expect(dlqEntries[0].lastError).toContain("Unsafe retry blocked");

      const finalExec = await h.executions.getById(execution.id);
      expect(finalExec?.status).toBe("DEAD_LETTERED");
    });
  });
});
