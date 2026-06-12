import { afterAll, describe, expect, it } from "vitest";
import { tryStartChaosHarness, type ChaosHarness } from "./_setup/chaosHarness.js";
import { recordPhase, evaluateThresholds } from "./_setup/chaosResultBus.js";
import { seedAgentAndExecution, suiteSeed, uuidFromHex, makeEvent } from "../integration/postgres/factories.js";
import { PostgresExecutionRepository } from "../../src/infrastructure/persistence/postgres/postgresExecutionRepository.js";
import { PostgresCheckpointStore } from "../../src/infrastructure/cluster/postgres/postgresCheckpointStore.js";
import { PostgresLeaseStore } from "../../src/infrastructure/cluster/postgres/postgresLeaseStore.js";
import { PostgresEventStore } from "../../src/infrastructure/persistence/postgresEventStore.js";
import { EventFactory } from "../../src/infrastructure/events/eventFactory.js";
import { PersistedEventPublisher } from "../../src/infrastructure/events/persistedEventPublisher.js";
import { CentralizedReplayEnforcer } from "../../src/runtime/replay/replayEnforcer.js";
import { ReplayExecutionCoordinator } from "../../src/runtime/replay/replayExecutionCoordinator.js";
import { ExecutionEngine } from "../../src/runtime/executionEngine.js";
import { toIso, SystemClock } from "../../src/shared/clock.js";
import { deterministicId } from "../../src/shared/determinism.js";
import { createId } from "../../src/shared/id.js";
import { randomUUID } from "node:crypto";
import type { FencingToken } from "../../src/domain/clusterPorts.js";
import type { Execution, ExecutionStep, MemoryRecord } from "../../src/domain/model.js";
import type { DomainEvent } from "../../src/domain/events.js";
import { InvariantViolation, validateFencingMonotonicity } from "../../src/runtime/canonicalSemantics.js";
import { UnsafeReplayDivergenceError, NonReconstructableReplayError } from "../../src/runtime/replay/replayAssertions.js";
import {
  InMemoryEventStore,
  InMemoryExecutionRepository,
  InMemoryMemoryRepository
} from "../../src/infrastructure/persistence/inMemoryStores.js";
import { InMemoryEventBus } from "../../src/infrastructure/events/inMemoryEventBus.js";

// ============================================================================
// DOCKER-BASED CONTAINERIZED CHAOS TESTS (Runs only if Testcontainers is available)
// ============================================================================
const harness: ChaosHarness | null = await tryStartChaosHarness();

afterAll(async () => {
  if (harness) await harness.stop();
});

describe.skipIf(!harness)("Consolidated Replay Chaos & Hardening Tests - Testcontainers Mode", () => {

  it("Chaos Scenario 1 — crash recovery replay rehydrates and play forward", async () => {
    const t0 = Date.now();
    const pg = harness!.pg;
    const executions = new PostgresExecutionRepository(pg);
    const events = new PostgresEventStore(pg);
    const clock = new SystemClock();
    const eventFactory = new EventFactory(clock);
    const publisher = new PersistedEventPublisher(events, {
      publish: async () => {},
      subscribe: () => () => {}
    });

    const agentId = randomUUID();
    const parentExecutionId = randomUUID();
    const childExecutionId = randomUUID();

    await seedAgentAndExecution(pg, { agentId, executionId: parentExecutionId });
    await seedAgentAndExecution(pg, { agentId, executionId: childExecutionId });

    const parentPlanStep: ExecutionStep = {
      id: randomUUID(),
      executionId: parentExecutionId,
      agentId,
      type: "PLANNING",
      status: "COMPLETED",
      input: { task: { prompt: "test-prompt" } },
      output: { objective: "do-something", task: {}, next: ["MEMORY_RETRIEVAL"] },
      startedAt: toIso(new Date()),
      completedAt: toIso(new Date()),
      durationMs: 100
    };

    const parentEvent1 = eventFactory.create({
      type: "EXECUTION_STARTED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { execution: { id: parentExecutionId, agentId } }
    });

    const parentPlanCompletedEvent = eventFactory.create({
      type: "EXECUTION_STEP_COMPLETED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { step: parentPlanStep }
    });

    const parentPlanExternality = eventFactory.create({
      type: "EXTERNALITY_RECORDED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: {
        externality: {
          id: randomUUID(),
          executionId: parentExecutionId,
          stepSequence: 1,
          type: "PLANNING",
          logicalTime: 1,
          randomnessSeed: "seed1",
          durationMs: 100,
          providerResponseFingerprint: "fingerprint-plan",
          prompt: "test-prompt"
        }
      }
    });

    await events.append(parentEvent1);
    await events.append(parentPlanExternality);
    await events.append(parentPlanCompletedEvent);

    const childExec = await executions.getById(childExecutionId);
    expect(childExec).toBeDefined();
    childExec!.parentExecutionId = parentExecutionId;
    childExec!.status = "REPLAYING";
    await executions.save(childExec!);

    const replayCoordinator = new ReplayExecutionCoordinator(events, executions, publisher, eventFactory);
    const session = await replayCoordinator.beginReplay(childExec!);
    expect(session).toBeDefined();
    expect(session!.lifecycle).toBe("REPLAYING");

    const transitionEvent = replayCoordinator.buildLifecycleTransitionEvent(session!, "REPLAY_PENDING", "REPLAYING", { traceId: childExecutionId });
    await events.append(transitionEvent);

    const coordinator2 = new ReplayExecutionCoordinator(events, executions, publisher, eventFactory);
    const reconstructedSession = await coordinator2.getOrReconstructSession(childExecutionId);
    expect(reconstructedSession).toBeDefined();
    expect(reconstructedSession!.parentExecutionId).toBe(parentExecutionId);
    expect(reconstructedSession!.lifecycle).toBe("REPLAYING");

    const { ok, thresholds } = evaluateThresholds({
      sessionReconstructed: { observed: reconstructedSession ? 1 : 0, required: "== 1", predicate: (v) => v === 1 },
      parentReferenceIntact: { observed: reconstructedSession?.parentExecutionId === parentExecutionId ? 1 : 0, required: "== 1", predicate: (v) => v === 1 }
    });
    expect(ok).toBe(true);

    await recordPhase("phase3.chaos.replayCrashRecovery", {
      ok,
      durationMs: Date.now() - t0,
      metrics: { duration: Date.now() - t0 },
      thresholds
    });
  }, 20_000);

  it("Chaos Scenario 2 — distributed replay recovery with lease fencing rejects stale workers", async () => {
    const t0 = Date.now();
    const pg = harness!.pg;
    const leases = new PostgresLeaseStore(pg);
    const executions = new PostgresExecutionRepository(pg);
    const workerDead = randomUUID();
    const workerFresh = randomUUID();

    const agentId = randomUUID();
    const parentExecutionId = randomUUID();
    const childExecutionId = randomUUID();

    await seedAgentAndExecution(pg, { agentId, executionId: parentExecutionId });
    await seedAgentAndExecution(pg, { agentId, executionId: childExecutionId });

    const childExec = await executions.getById(childExecutionId);
    childExec!.parentExecutionId = parentExecutionId;
    await executions.save(childExec!);

    const t = new Date();
    const firstLease = await leases.acquire({ executionId: childExecutionId, workerId: workerDead, ttlMs: 100, now: t });
    const staleFence: FencingToken = { executionId: childExecutionId, workerId: workerDead, attempt: firstLease!.attempt };

    await leases.reclaimByWorker(workerDead, t);

    const secondLease = await leases.acquire({ executionId: childExecutionId, workerId: workerFresh, ttlMs: 30_000, now: t });
    const freshFence: FencingToken = { executionId: childExecutionId, workerId: workerFresh, attempt: secondLease!.attempt };

    expect(secondLease!.attempt).toBeGreaterThan(firstLease!.attempt);

    // The durable lease store is the authority on the current attempt — the
    // enforcer compares each presented fence against it (L2 freshness).
    const authoritativeLease = await leases.getByExecution(childExecutionId);
    const currentAttempt = Number(authoritativeLease!.attempt);
    expect(currentAttempt).toBe(Number(secondLease!.attempt));

    let deadFailed = false;
    try {
      CentralizedReplayEnforcer.validateFence(childExec!, staleFence, "replay.begin", currentAttempt);
    } catch (e) {
      deadFailed = true;
    }

    let freshSucceeded = false;
    try {
      CentralizedReplayEnforcer.validateFence(childExec!, freshFence, "replay.begin", currentAttempt);
      freshSucceeded = true;
    } catch (e) {}

    const { ok, thresholds } = evaluateThresholds({
      staleFenceRejected: { observed: deadFailed ? 1 : 0, required: "== 1", predicate: (v) => v === 1 },
      freshFenceAccepted: { observed: freshSucceeded ? 1 : 0, required: "== 1", predicate: (v) => v === 1 }
    });
    expect(ok).toBe(true);

    await recordPhase("phase3.chaos.replayDistributedRecovery", {
      ok,
      durationMs: Date.now() - t0,
      metrics: { deadFailed: deadFailed ? 1 : 0, freshSucceeded: freshSucceeded ? 1 : 0 },
      thresholds
    });
  }, 20_000);

});

// ============================================================================
// IN-MEMORY HIGH-FIDELITY CHAOS TESTS (Runs unconditionally everywhere)
// ============================================================================
describe("Consolidated Replay Chaos & Hardening Tests - High-Fidelity In-Memory Mode", () => {

  const buildInMemoryHarness = () => {
    const clock = new SystemClock();
    const events = new InMemoryEventStore();
    const executions = new InMemoryExecutionRepository();
    const memory = new InMemoryMemoryRepository();
    const bus = new InMemoryEventBus();
    const publisher = new PersistedEventPublisher(events, bus);
    const eventFactory = new EventFactory(clock, "replay-chaos-test");
    
    // Mock Provider and Tools
    const mockModelProvider = {
      calls: 0,
      async complete() {
        this.calls++;
        return {
          output: { response: "live completion answer" },
          tokenUsage: { prompt: 1, completion: 2, total: 3 }
        };
      }
    };

    const mockToolExecutor = {
      calls: [] as string[],
      async execute(input: any) {
        this.calls.push(input.toolName);
        return { success: true };
      }
    };

    const replayCoordinator = new ReplayExecutionCoordinator(events, executions, publisher, eventFactory);

    const engine = new ExecutionEngine(
      eventFactory,
      publisher,
      executions,
      memory,
      mockModelProvider as any,
      mockToolExecutor as any,
      clock,
      { workerId: "chaos-worker", events, replayCoordinator }
    );

    return { clock, events, executions, memory, publisher, eventFactory, mockModelProvider, mockToolExecutor, replayCoordinator, engine };
  };

  it("Chaos Scenario 1 — crash recovery replay rehydrates and plays forward in-memory", async () => {
    const h = buildInMemoryHarness();
    const agentId = "agent-1";
    const parentExecutionId = "parent-exec";
    const childExecutionId = "child-exec";

    // Setup planning step sequence completed on parent
    const parentPlanStep: ExecutionStep = {
      id: "step-1",
      executionId: parentExecutionId,
      agentId,
      type: "PLANNING",
      status: "COMPLETED",
      input: { task: { prompt: "test-prompt" } },
      output: { objective: "do-something", task: {}, next: ["MEMORY_RETRIEVAL"] },
      startedAt: toIso(new Date()),
      completedAt: toIso(new Date()),
      durationMs: 100
    };

    const parentEvent1 = h.eventFactory.create({
      type: "EXECUTION_STARTED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { execution: { id: parentExecutionId, agentId } }
    });

    const parentPlanCompletedEvent = h.eventFactory.create({
      type: "EXECUTION_STEP_COMPLETED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { step: parentPlanStep }
    });

    const parentPlanExternality = h.eventFactory.create({
      type: "EXTERNALITY_RECORDED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: {
        externality: {
          id: "ext-1",
          executionId: parentExecutionId,
          stepSequence: 1,
          type: "PLANNING",
          logicalTime: 1,
          randomnessSeed: "seed1",
          durationMs: 100,
          providerResponseFingerprint: "fingerprint-plan",
          prompt: "test-prompt"
        }
      }
    });

    await h.events.append(parentEvent1);
    await h.events.append(parentPlanExternality);
    await h.events.append(parentPlanCompletedEvent);

    // Save child referencing parent
    const childExec: Execution = {
      id: childExecutionId,
      agentId,
      status: "REPLAYING",
      parentExecutionId,
      input: { prompt: "test-prompt" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(new Date()),
      updatedAt: toIso(new Date()),
      tenantId: "system"
    };
    await h.executions.save(childExec);

    // Start replay and write transition event
    const session = await h.replayCoordinator.beginReplay(childExec);
    expect(session).toBeDefined();
    expect(session!.lifecycle).toBe("REPLAYING");

    const transitionEvent = h.replayCoordinator.buildLifecycleTransitionEvent(session!, "REPLAY_PENDING", "REPLAYING", { traceId: childExecutionId });
    await h.events.append(transitionEvent);

    // Reconstruct durably and check
    const coordinator2 = new ReplayExecutionCoordinator(h.events, h.executions, h.publisher, h.eventFactory);
    const reconstructed = await coordinator2.getOrReconstructSession(childExecutionId);
    expect(reconstructed).toBeDefined();
    expect(reconstructed!.parentExecutionId).toBe(parentExecutionId);
    expect(reconstructed!.lifecycle).toBe("REPLAYING");
  });

  it("Chaos Scenario 2 — distributed replay recovery fencing rejects stale workers in-memory", async () => {
    const h = buildInMemoryHarness();
    const parentExecutionId = "parent-exec";
    const childExecutionId = "child-exec";

    const childExec: Execution = {
      id: childExecutionId,
      agentId: "agent-1",
      status: "RECOVERING",
      parentExecutionId,
      input: { prompt: "test-prompt" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(new Date()),
      updatedAt: toIso(new Date()),
      tenantId: "system"
    };

    const staleFence: FencingToken = { executionId: childExecutionId, workerId: "stale-worker", attempt: 1 };
    const freshFence: FencingToken = { executionId: childExecutionId, workerId: "fresh-worker", attempt: 2 };

    // The fresh worker's lease attempt (2) is the authoritative current attempt.
    const currentAttempt = freshFence.attempt;

    // Stale worker rejected: its fence attempt is below the authoritative lease attempt (L2)
    let deadFailed = false;
    try {
      CentralizedReplayEnforcer.validateFence(childExec, staleFence, "replay.begin", currentAttempt);
      validateFencingMonotonicity(staleFence.attempt, childExec.status, "stale-worker");
    } catch (e) {
      deadFailed = true;
    }

    // Attempt 2 accepted: matches the authoritative lease attempt
    let freshSucceeded = false;
    try {
      CentralizedReplayEnforcer.validateFence(childExec, freshFence, "replay.begin", currentAttempt);
      validateFencingMonotonicity(freshFence.attempt, childExec.status, "fresh-worker");
      freshSucceeded = true;
    } catch (e) {}

    expect(deadFailed).toBe(true);
    expect(freshSucceeded).toBe(true);
  });

  it("Chaos Scenario 3 — tool parameter drift halts replay in-memory", async () => {
    const h = buildInMemoryHarness();
    const agentId = "agent-1";
    const parentExecutionId = "parent-exec";
    const childExecutionId = "child-exec";

    const parentToolStep: ExecutionStep = {
      id: "step-1",
      executionId: parentExecutionId,
      agentId,
      type: "TOOL_CALL",
      status: "COMPLETED",
      input: { toolName: "file.read", args: { path: "config.json" } },
      output: { content: "{}" },
      startedAt: toIso(new Date()),
      completedAt: toIso(new Date()),
      durationMs: 200
    };

    const parentEvent1 = h.eventFactory.create({
      type: "EXECUTION_STARTED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { execution: { id: parentExecutionId, agentId } }
    });

    const parentToolCompletedEvent = h.eventFactory.create({
      type: "EXECUTION_STEP_COMPLETED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { step: parentToolStep }
    });

    const parentToolExternality = h.eventFactory.create({
      type: "EXTERNALITY_RECORDED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: {
        externality: {
          id: "ext-1",
          executionId: parentExecutionId,
          stepSequence: 1,
          type: "TOOL_CALL",
          logicalTime: 1,
          randomnessSeed: "seed2",
          durationMs: 200,
          providerResponseFingerprint: "fingerprint-tool",
          toolName: "file.read",
          toolInput: { path: "config.json" }
        }
      }
    });

    await h.events.append(parentEvent1);
    await h.events.append(parentToolExternality);
    await h.events.append(parentToolCompletedEvent);

    const childExec: Execution = {
      id: childExecutionId,
      agentId,
      status: "REPLAYING",
      parentExecutionId,
      input: { prompt: "test-prompt" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(new Date()),
      updatedAt: toIso(new Date()),
      tenantId: "system"
    };
    await h.executions.save(childExec);

    await h.replayCoordinator.beginReplay(childExec);

    // Replay runs, but tool arguments drift (modified.json)
    let divergenceThrew = false;
    try {
      await h.replayCoordinator.tryReconstructStep({
        execution: childExec,
        agentId,
        type: "TOOL_CALL",
        stepInput: { toolName: "file.read", args: { path: "modified.json" } },
        context: { traceId: childExecutionId },
        publish: async (e) => {}
      });
    } catch (e: any) {
      if (e instanceof UnsafeReplayDivergenceError) {
        divergenceThrew = true;
      }
    }

    expect(divergenceThrew).toBe(true);

    const updatedChild = await h.executions.getById(childExecutionId);
    expect(updatedChild!.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("Chaos Scenario 4 — partial persistence (missing externalities) fails fast in-memory", async () => {
    const h = buildInMemoryHarness();
    const agentId = "agent-1";
    const parentExecutionId = "parent-exec";
    const childExecutionId = "child-exec";

    // Setup completed planning step, but NO EXTERNALITY (partial persistence)
    const parentPlanStep: ExecutionStep = {
      id: "step-1",
      executionId: parentExecutionId,
      agentId,
      type: "PLANNING",
      status: "COMPLETED",
      input: { task: { prompt: "test-prompt" } },
      output: { objective: "do-something", task: {}, next: ["MEMORY_RETRIEVAL"] },
      startedAt: toIso(new Date()),
      completedAt: toIso(new Date()),
      durationMs: 100
    };

    const parentEvent1 = h.eventFactory.create({
      type: "EXECUTION_STARTED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { execution: { id: parentExecutionId, agentId } }
    });

    const parentPlanCompletedEvent = h.eventFactory.create({
      type: "EXECUTION_STEP_COMPLETED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { step: parentPlanStep }
    });

    await h.events.append(parentEvent1);
    await h.events.append(parentPlanCompletedEvent);

    const childExec: Execution = {
      id: childExecutionId,
      agentId,
      status: "REPLAYING",
      parentExecutionId,
      input: { prompt: "test-prompt" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(new Date()),
      updatedAt: toIso(new Date()),
      tenantId: "system"
    };
    await h.executions.save(childExec);

    await h.replayCoordinator.beginReplay(childExec);

    let partialPersistenceThrew = false;
    try {
      await h.replayCoordinator.tryReconstructStep({
        execution: childExec,
        agentId,
        type: "PLANNING",
        stepInput: { task: { prompt: "test-prompt" } },
        context: { traceId: childExecutionId },
        publish: async (e) => {}
      });
    } catch (e: any) {
      if (e instanceof NonReconstructableReplayError) {
        partialPersistenceThrew = true;
      }
    }

    expect(partialPersistenceThrew).toBe(true);

    const updatedChild = await h.executions.getById(childExecutionId);
    expect(updatedChild!.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("Chaos Scenario 5 — provider nondeterminism complete verification in-memory", async () => {
    const h = buildInMemoryHarness();
    const agentId = "agent-1";
    const parentExecutionId = "parent-exec";
    const childExecutionId = "child-exec";

    // Seed completed MODEL_GENERATION step
    const parentModelStep: ExecutionStep = {
      id: "step-1",
      executionId: parentExecutionId,
      agentId,
      type: "MODEL_GENERATION",
      status: "COMPLETED",
      input: { prompt: "give me a seed" },
      output: { result: "verbatim-replayed-output" },
      startedAt: toIso(new Date()),
      completedAt: toIso(new Date()),
      durationMs: 150
    };

    const parentEvent1 = h.eventFactory.create({
      type: "EXECUTION_STARTED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { execution: { id: parentExecutionId, agentId } }
    });

    const parentModelCompletedEvent = h.eventFactory.create({
      type: "EXECUTION_STEP_COMPLETED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { step: parentModelStep }
    });

    const parentModelExternality = h.eventFactory.create({
      type: "EXTERNALITY_RECORDED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: {
        externality: {
          id: "ext-1",
          executionId: parentExecutionId,
          stepSequence: 1,
          type: "MODEL_GENERATION",
          logicalTime: 1,
          randomnessSeed: "seed3",
          durationMs: 150,
          providerResponseFingerprint: "fingerprint-model",
          prompt: "give me a seed",
          llmOutput: { result: "verbatim-replayed-output" }
        }
      }
    });

    await h.events.append(parentEvent1);
    await h.events.append(parentModelExternality);
    await h.events.append(parentModelCompletedEvent);

    const childExec: Execution = {
      id: childExecutionId,
      agentId,
      status: "REPLAYING",
      parentExecutionId,
      input: { prompt: "test-prompt" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(new Date()),
      updatedAt: toIso(new Date()),
      tenantId: "system"
    };
    await h.executions.save(childExec);

    await h.replayCoordinator.beginReplay(childExec);

    // Reconstruct step and assert it returns replayed answer verbatim
    const reconstructed = await h.replayCoordinator.tryReconstructStep<{ result: string }>({
      execution: childExec,
      agentId,
      type: "MODEL_GENERATION",
      stepInput: { prompt: "give me a seed" },
      context: { traceId: childExecutionId },
      publish: async (e) => {}
    });

    expect(reconstructed).toBeDefined();
    expect(reconstructed!.output.result).toBe("verbatim-replayed-output");
  });

  it("Chaos Scenario 6 — quarantined executions block replay under ambiguity in-memory", async () => {
    const h = buildInMemoryHarness();
    const agentId = "agent-1";
    const childExecutionId = "child-exec";

    const childExec: Execution = {
      id: childExecutionId,
      agentId,
      status: "RECONCILIATION_REQUIRED",
      parentExecutionId: "parent-exec",
      input: { prompt: "test-prompt" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(new Date()),
      updatedAt: toIso(new Date()),
      tenantId: "system"
    };
    await h.executions.save(childExec);

    let quarantineEnforced = false;
    try {
      await h.engine.execute({
        agent: { id: agentId, goal: "test", tools: [], memoryPolicy: { maxRetrievedItems: 1 } } as any,
        execution: childExec,
        task: {}
      });
    } catch (e: any) {
      if (e instanceof InvariantViolation && e.invariant === "S3") {
        quarantineEnforced = true;
      }
    }

    expect(quarantineEnforced).toBe(true);
  });

  it("Chaos Scenario 7 — stale replay metadata (stale parent log watermark) throws NonReconstructableReplayError in-memory", async () => {
    const h = buildInMemoryHarness();
    const agentId = "agent-1";
    const parentExecutionId = "parent-exec";
    const childExecutionId = "child-exec";

    // Seed planning step sequence on parent
    const parentPlanStep: ExecutionStep = {
      id: "step-1",
      executionId: parentExecutionId,
      agentId,
      type: "PLANNING",
      status: "COMPLETED",
      input: { task: { prompt: "test-prompt" } },
      output: { objective: "do-something", task: {}, next: ["MEMORY_RETRIEVAL"] },
      startedAt: toIso(new Date()),
      completedAt: toIso(new Date()),
      durationMs: 100
    };

    const parentEvent1 = h.eventFactory.create({
      type: "EXECUTION_STARTED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { execution: { id: parentExecutionId, agentId } }
    });

    const parentPlanCompletedEvent = h.eventFactory.create({
      type: "EXECUTION_STEP_COMPLETED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { step: parentPlanStep }
    });

    const parentPlanExternality = h.eventFactory.create({
      type: "EXTERNALITY_RECORDED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: {
        externality: {
          id: "ext-1",
          executionId: parentExecutionId,
          stepSequence: 1,
          type: "PLANNING",
          logicalTime: 1,
          randomnessSeed: "seed4",
          durationMs: 100,
          providerResponseFingerprint: "fingerprint-plan-stale",
          prompt: "test-prompt"
        }
      }
    });

    await h.events.append(parentEvent1);
    await h.events.append(parentPlanExternality);
    await h.events.append(parentPlanCompletedEvent);

    const childExec: Execution = {
      id: childExecutionId,
      agentId,
      status: "REPLAYING",
      parentExecutionId,
      input: { prompt: "test-prompt" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: toIso(new Date()),
      updatedAt: toIso(new Date()),
      tenantId: "system"
    };
    await h.executions.save(childExec);

    const session = await h.replayCoordinator.beginReplay(childExec);

    // Inject out-of-band event into parent event log AFTER the session watermark is captured
    const outOfBandParentEvent = h.eventFactory.create({
      type: "EXECUTION_STEP_COMPLETED",
      aggregateId: parentExecutionId,
      aggregateType: "EXECUTION",
      payload: { step: { ...parentPlanStep, id: "step-2", startedAt: toIso(new Date()) } }
    });

    const appended = await h.events.append(outOfBandParentEvent);
    expect(Number(appended.sequence)).toBeGreaterThan(session!.parentEventSequenceWatermark);

    let staleLogThrew = false;
    try {
      await h.replayCoordinator.tryReconstructStep({
        execution: childExec,
        agentId,
        type: "PLANNING",
        stepInput: { task: { prompt: "test-prompt" } },
        context: { traceId: childExecutionId },
        publish: async (e) => {}
      });
    } catch (e: any) {
      if (e instanceof NonReconstructableReplayError && e.message.includes("stale replay attempt")) {
        staleLogThrew = true;
      }
    }

    expect(staleLogThrew).toBe(true);
  });

});
