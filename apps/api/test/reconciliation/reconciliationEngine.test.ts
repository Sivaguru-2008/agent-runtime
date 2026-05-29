import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReconciliationEngine } from "../../src/runtime/reconciliation/reconciliationEngine.js";
import { MockPaymentProvider } from "../../src/runtime/reconciliation/mockPaymentProvider.js";
import { reconciliationRegistry } from "../../src/runtime/reconciliation/reconciliationRegistry.js";
import { InMemoryExecutionRepository } from "../../src/infrastructure/persistence/inMemoryStores.js";
import { InMemoryEventStore } from "../../src/infrastructure/persistence/inMemoryStores.js";
import { InMemoryEventBus } from "../../src/infrastructure/events/inMemoryEventBus.js";
import { PersistedEventPublisher } from "../../src/infrastructure/events/persistedEventPublisher.js";
import { EventFactory } from "../../src/infrastructure/events/eventFactory.js";
import { SystemClock } from "../../src/shared/clock.js";
import { toIso } from "../../src/shared/clock.js";
import type { Execution } from "../../src/domain/model.js";

// Mock ToolCallDedupStore
class InMemoryToolCallDedupStore {
  public records = new Map<string, any>();

  async markCompleted(idempotencyKey: string, output: Record<string, unknown>): Promise<void> {
    this.records.set(idempotencyKey, { status: "COMPLETED", output });
  }

  async markFailed(idempotencyKey: string, errorMessage: string): Promise<void> {
    this.records.set(idempotencyKey, { status: "FAILED", lastError: errorMessage });
  }

  async get(idempotencyKey: string): Promise<any> {
    return this.records.get(idempotencyKey);
  }
}

describe("Reconciliation Engine - Exhaustive Correctness Scenarios", () => {
  let executions: InMemoryExecutionRepository;
  let dedupStore: InMemoryToolCallDedupStore;
  let publisher: PersistedEventPublisher;
  let eventFactory: EventFactory;
  let clock: SystemClock;
  let engine: ReconciliationEngine;
  let mockProvider: MockPaymentProvider;

  beforeEach(() => {
    executions = new InMemoryExecutionRepository();
    dedupStore = new InMemoryToolCallDedupStore();
    const eventStore = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    publisher = new PersistedEventPublisher(eventStore, bus);
    clock = new SystemClock();
    eventFactory = new EventFactory(clock, "reconciliation-test");
    engine = new ReconciliationEngine(executions, dedupStore as any, publisher, eventFactory);
    mockProvider = new MockPaymentProvider();

    reconciliationRegistry.clear();
    reconciliationRegistry.register("sandbox.payment_refund", mockProvider);
  });

  it("Scenario 1: Crash-After-Side-Effect Verification", async () => {
    const execution: Execution = {
      id: "exec-1",
      agentId: "agent-1",
      status: "RUNNING",
      input: {},
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(clock.now()),
      updatedAt: toIso(clock.now()),
      tenantId: "tenant-1"
    };
    await executions.save(execution);

    // Scenario: worker crashed AFTER the refund completed on Stripe
    // but BEFORE local CAS commit completed. Remote Stripe is COMMITTED,
    // local is unresolved.
    const idempotencyKey = "idem-refund-1";
    const args = { amount: 150 };
    mockProvider.recordRemoteEffect(idempotencyKey, args, "COMMITTED");

    // Reconciler initializes and polling starts
    engine.initiateReconciliation(execution.id, idempotencyKey, "sandbox.payment_refund", args);
    const result = await engine.reconcile(idempotencyKey);

    expect(result.status).toBe("RECONCILED_COMMITTED");
    expect(result.output).toBeDefined();
    expect(result.output?.stripeId).toBe("ch_idem-refund-1");

    // Ensure the cache is updated so subsequent retry gets cached response
    const cached = await dedupStore.get(idempotencyKey);
    expect(cached.status).toBe("COMPLETED");
    expect(cached.output.stripeId).toBe("ch_idem-refund-1");

    // Check Audit history contains key checkpoints
    expect(result.auditHistory.some(a => a.action === "INITIATED")).toBe(true);
    expect(result.auditHistory.some(a => a.action === "VERDICT_RESOLVED")).toBe(true);
  });

  it("Scenario 2: Timeout-After-Provider-Commit (Retry Loop Success)", async () => {
    const execution: Execution = {
      id: "exec-2",
      agentId: "agent-1",
      status: "RUNNING",
      input: {},
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(clock.now()),
      updatedAt: toIso(clock.now()),
      tenantId: "tenant-1"
    };
    await executions.save(execution);

    const idempotencyKey = "idem-refund-2";
    const args = { amount: 200 };

    // Simulate Stripe API timeout during charge execution
    mockProvider.behavior.timeoutOnLookup = true;

    engine.initiateReconciliation(execution.id, idempotencyKey, "sandbox.payment_refund", args);

    // First attempt fails due to timeout/unreachable
    let result = await engine.reconcile(idempotencyKey);
    expect(result.status).toBe("RECONCILIATION_REQUIRED"); // Retries allowed
    expect(result.attemptsCount).toBe(1);

    // Stripe recovers, API becomes available
    mockProvider.behavior.timeoutOnLookup = false;
    mockProvider.recordRemoteEffect(idempotencyKey, args, "COMMITTED");

    // Next reconciliation cycle resolves successfully
    result = await engine.reconcile(idempotencyKey);
    expect(result.status).toBe("RECONCILED_COMMITTED");
    expect(result.attemptsCount).toBe(2);
  });

  it("Scenario 3: Inconsistent Provider Responses (Unknown -> Committed)", async () => {
    const execution: Execution = {
      id: "exec-3",
      agentId: "agent-1",
      status: "RUNNING",
      input: {},
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(clock.now()),
      updatedAt: toIso(clock.now()),
      tenantId: "tenant-1"
    };
    await executions.save(execution);

    const idempotencyKey = "idem-refund-3";
    const args = { amount: 300 };

    // Stripe returns UNKNOWN state initially
    mockProvider.behavior.forceStatus = "UNKNOWN";

    engine.initiateReconciliation(execution.id, idempotencyKey, "sandbox.payment_refund", args);
    let result = await engine.reconcile(idempotencyKey);
    expect(result.status).toBe("RECONCILIATION_REQUIRED");

    // Later Stripe confirms commit
    mockProvider.behavior.forceStatus = "COMMITTED";
    result = await engine.reconcile(idempotencyKey);
    expect(result.status).toBe("RECONCILED_COMMITTED");
  });

  it("Scenario 4: Duplicate Reconciliation Attempts (Audit Logs Protection)", async () => {
    const execution: Execution = {
      id: "exec-4",
      agentId: "agent-1",
      status: "RUNNING",
      input: {},
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(clock.now()),
      updatedAt: toIso(clock.now()),
      tenantId: "tenant-1"
    };
    await executions.save(execution);

    const idempotencyKey = "idem-refund-4";
    const args = { amount: 400 };
    mockProvider.recordRemoteEffect(idempotencyKey, args, "COMMITTED");

    // Multiple workers try to initialize and reconcile
    const record1 = engine.initiateReconciliation(execution.id, idempotencyKey, "sandbox.payment_refund", args);
    const record2 = engine.initiateReconciliation(execution.id, idempotencyKey, "sandbox.payment_refund", args);

    // Collapsed onto single record
    expect(record1.id).toBe(record2.id);

    const res1 = await engine.reconcile(idempotencyKey);
    const res2 = await engine.reconcile(idempotencyKey);

    expect(res1.status).toBe("RECONCILED_COMMITTED");
    expect(res2.status).toBe("RECONCILED_COMMITTED");
    expect(res1.attemptsCount).toBe(1); // Second call bypassed since already reconciled
  });

  it("Scenario 5: Concurrent Reconciliation Races (Polling vs. Manual Operator Override)", async () => {
    const execution: Execution = {
      id: "exec-5",
      agentId: "agent-1",
      status: "RECONCILIATION_REQUIRED",
      input: {},
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(clock.now()),
      updatedAt: toIso(clock.now()),
      tenantId: "tenant-1"
    };
    await executions.save(execution);

    const idempotencyKey = "idem-refund-5";
    const args = { amount: 500 };

    engine.initiateReconciliation(execution.id, idempotencyKey, "sandbox.payment_refund", args);

    // Background polling returns UNKNOWN, forcing operator intervention
    mockProvider.behavior.forceStatus = "UNKNOWN";
    await engine.reconcile(idempotencyKey);
    await engine.reconcile(idempotencyKey);
    const record = await engine.reconcile(idempotencyKey);

    expect(record.status).toBe("RECONCILED_UNKNOWN"); // Escalated

    // Operator overrides resolution to COMMIT
    await engine.operatorOverride(idempotencyKey, "COMMIT", clock.now(), { manual: true, reference: "ST-992" });

    expect(record.status).toBe("RECONCILED_COMMITTED");
    expect(record.output?.reference).toBe("ST-992");

    const updatedExec = await executions.getById(execution.id);
    expect(updatedExec?.status).toBe("RECOVERING");
  });
});
