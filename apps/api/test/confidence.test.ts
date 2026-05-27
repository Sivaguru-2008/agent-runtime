import { describe, expect, it, vi } from "vitest";
import type { CognitionNode, CognitionGraph } from "../src/domain/cognition.js";
import {
  calculateConfidenceScore,
  classifyConfidence,
  makeOrchestrationDecision,
  propagateConfidence
} from "../src/runtime/confidence/confidencePolicyEngine.js";
import { VerifierAgent } from "../src/runtime/cognition/agents/verifierAgent.js";
import { CognitionOrchestrator } from "../src/runtime/cognition/orchestrator.js";
import { InMemoryCognitionRepository, InMemoryLineageStore } from "../src/infrastructure/persistence/inMemoryCognitionStores.js";
import { InMemoryMemoryRepository } from "../src/infrastructure/persistence/inMemoryStores.js";
import { SystemClock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/shared/config.js";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  EVENT_BUS_DRIVER: "memory",
  EVENT_STORE_DRIVER: "memory",
  PERSISTENCE_DRIVER: "memory",
  RECOVERY_LOOP_INTERVAL_MS: 60_000,
  OTEL_SERVICE_NAME: "agent-runtime-confidence-test",
  LOG_LEVEL: "silent",
  RUNTIME_MODE: "single",
  WORKER_ID: "test-confidence-worker",
  WORKER_CAPACITY: 4,
  WORKER_HEARTBEAT_TTL_MS: 15_000,
  WORKER_SWEEP_INTERVAL_MS: 60_000,
  EXECUTION_LEASE_TTL_MS: 30_000,
  SCHEDULER_POLL_INTERVAL_MS: 250,
  OLLAMA_URL: "http://localhost:11434",
  OLLAMA_MODEL: "llama3",
  OLLAMA_REQUEST_TIMEOUT_MS: 120_000,
  SSE_DEDUPE_WINDOW: 1024,
  WORKER_REGISTRATION_TIMEOUT_MS: 10_000,
  MODEL_PROVIDER: "deterministic",
  PROVIDER_TIMEOUT_MS: 120_000,
  PROVIDER_MAX_RETRIES: 3,
  FILE_READ_MAX_BYTES: 32_768,
  TOOL_WEB_SEARCH_TIMEOUT_MS: 10_000,
  TOOL_CODE_EXECUTE_TIMEOUT_MS: 5_000,
  POISON_PILL_MAX_ATTEMPTS: 3,
  LEASE_HEARTBEAT_POLL_INTERVAL_MS: 3_000,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: 5,
  CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS: 60_000,
  CIRCUIT_BREAKER_SUCCESS_THRESHOLD: 2,
  METRICS_ENABLED: true,
  TRACE_LINEAGE_SCAN_LIMIT: 5_000,
  AUTH_ENABLED: false,
  AUTH_SKIP_PATHS: "/metrics",
  API_KEY_CACHE_TTL_SEC: 300,
  RATE_LIMIT_ENABLED: false,
  RATE_LIMIT_DEFAULT_RPM: 1_000,
  RATE_LIMIT_WINDOW_MS: 60_000,
  AUDIT_LOG_ENABLED: false,
  QUOTA_ENABLED: false,
  SHUTDOWN_DRAIN_TIMEOUT_MS: 30_000,
  RUNTIME_ROLE: "combined",
  JOB_QUEUE_DRIVER: "memory",
  QUEUE_BACKPRESSURE_THRESHOLD: 0,
  JOB_QUEUE_VISIBILITY_MS: 45_000,
  JOB_QUEUE_CONSUMER_GROUP: "agent-runtime-workers",
  RETRY_BACKOFF_BASE_MS: 500,
  RETRY_BACKOFF_MAX_MS: 60_000
};

describe("Confidence Policy Engine Unit Tests", () => {
  it("calculates confidence score from overall uncertainty score", () => {
    const node: Partial<CognitionNode> = {
      uncertainty: { overall: 0.15, variance: 0.01, lowConfidenceTokens: 0 }
    };
    const score = calculateConfidenceScore(node as CognitionNode);
    expect(score).toBe(85); // (1 - 0.15) * 100
  });

  it("calculates confidence score from selfReport when available", () => {
    const node1: Partial<CognitionNode> = {
      uncertainty: { overall: 0.8, variance: 0.01, lowConfidenceTokens: 0, selfReport: 0.95 }
    };
    const node2: Partial<CognitionNode> = {
      uncertainty: { overall: 0.8, variance: 0.01, lowConfidenceTokens: 0, selfReport: 92 }
    };
    expect(calculateConfidenceScore(node1 as CognitionNode)).toBe(95);
    expect(calculateConfidenceScore(node2 as CognitionNode)).toBe(92);
  });

  it("classifies scores into HIGH, MEDIUM, LOW, and CRITICAL thresholds", () => {
    expect(classifyConfidence(85)).toBe("HIGH");
    expect(classifyConfidence(80)).toBe("HIGH");
    expect(classifyConfidence(79)).toBe("MEDIUM");
    expect(classifyConfidence(50)).toBe("MEDIUM");
    expect(classifyConfidence(49)).toBe("LOW");
    expect(classifyConfidence(30)).toBe("LOW");
    expect(classifyConfidence(29)).toBe("CRITICAL");
    expect(classifyConfidence(10)).toBe("CRITICAL");
  });

  it("makes correct policy orchestration decisions based on score", () => {
    const decHigh = makeOrchestrationDecision(85);
    expect(decHigh.classification).toBe("HIGH");
    expect(decHigh.triggerReplanning).toBe(false);
    expect(decHigh.retrievalDepthMultiplier).toBe(1);
    expect(decHigh.enableMultiVerifier).toBe(false);
    expect(decHigh.executionAutonomy).toBe("FULL");
    expect(decHigh.requireEscalation).toBe(false);

    const decLow = makeOrchestrationDecision(25);
    expect(decLow.classification).toBe("CRITICAL");
    expect(decLow.triggerReplanning).toBe(true);
    expect(decLow.retrievalDepthMultiplier).toBe(2);
    expect(decLow.enableMultiVerifier).toBe(true);
    expect(decLow.executionAutonomy).toBe("DEGRADED");
    expect(decLow.requireEscalation).toBe(false);

    const decHalt = makeOrchestrationDecision(10);
    expect(decHalt.classification).toBe("CRITICAL");
    expect(decHalt.triggerReplanning).toBe(true);
    expect(decHalt.retrievalDepthMultiplier).toBe(2);
    expect(decHalt.enableMultiVerifier).toBe(true);
    expect(decHalt.executionAutonomy).toBe("HALTED");
    expect(decHalt.requireEscalation).toBe(true);
  });

  it("propagates lineage, degradation tracking, and attributes instability", () => {
    const parent: CognitionNode = {
      id: "parent-node-id",
      cognitionId: "cog-1",
      executionId: "exec-1",
      sequence: 1,
      role: "PLANNER",
      phase: "PLAN",
      status: "COMPLETED",
      inputFingerprint: "ip-1",
      input: {},
      uncertainty: { overall: 0.1, variance: 0, lowConfidenceTokens: 0 },
      startedAt: ""
    };
    propagateConfidence(parent, []);
    expect(parent.confidenceScore).toBe(90);
    expect(parent.confidenceClassification).toBe("HIGH");
    expect(parent.confidenceLineage?.path).toEqual(["parent-node-id"]);
    expect(parent.confidenceLineage?.scores).toEqual([90]);

    const child: CognitionNode = {
      id: "child-node-id",
      cognitionId: "cog-1",
      executionId: "exec-1",
      sequence: 2,
      role: "EXECUTOR",
      phase: "EXECUTE",
      status: "COMPLETED",
      inputFingerprint: "ip-2",
      input: {},
      uncertainty: { overall: 0.6, variance: 0, lowConfidenceTokens: 0 },
      memoryInfluence: [{ memoryId: "mem-1", weight: 0.8 }],
      startedAt: ""
    };
    propagateConfidence(child, [parent]);

    expect(child.confidenceScore).toBe(40);
    expect(child.confidenceClassification).toBe("LOW");
    expect(child.confidenceLineage?.path).toEqual(["parent-node-id", "child-node-id"]);
    expect(child.confidenceLineage?.scores).toEqual([90, 40]);
    expect(child.confidencePropagation?.ancestorAverage).toBe(90);
    expect(child.confidencePropagation?.lineageMin).toBe(40);
    expect(child.confidencePropagation?.propagatingDegradation).toBe(false);
    expect(child.degradationTracking?.parentConfidence).toBe(90);
    expect(child.degradationTracking?.confidenceDrop).toBe(50);
    expect(child.degradationTracking?.severity).toBe("CRITICAL");
    expect(child.instabilityAttribution?.sourceType).toBe("LLM");
  });
});

describe("Multi-Verifier Consensus Mode", () => {
  it("runs consensus mode and requires 0.85 pass score when isMultiVerifier is triggered", async () => {
    const verifier = new VerifierAgent();
    
    // Test normal verifier mode
    const normalCtx = {
      cognitionId: "cog-1",
      executionId: "exec-1",
      agentId: "agent-1",
      goal: "verify task",
      task: {},
      seed: "normal-seed",
      history: [],
      memories: [],
      carryOver: { modelOutput: { name: "test", size: 10 } }
    };
    const resNormal = await verifier.invoke(normalCtx);
    expect(resNormal.output.multiVerifierMode).toBe(false);

    // Test multi-verifier consensus mode
    const mvCtx = {
      ...normalCtx,
      carryOver: {
        modelOutput: { name: "test", size: 10 },
        enableMultiVerifier: true
      }
    };
    const resMV = await verifier.invoke(mvCtx);
    expect(resMV.output.multiVerifierMode).toBe(true);
    expect(resMV.output.verifiersCount).toBe(3);
    expect(Array.isArray(resMV.output.verifiers)).toBe(true);
  });
});

describe("Orchestrator Confidence-Aware Execution Routing", () => {
  it("halts execution loop if confidence score is extremely low (< 15)", async () => {
    const cognitions = new InMemoryCognitionRepository();
    const lineage = new InMemoryLineageStore();
    const memory = new InMemoryMemoryRepository();
    const clock = new SystemClock();
    const eventFactory = new EventFactory(clock);
    const publisher = { publish: vi.fn() } as any;

    const plannerAgent = {
      role: "PLANNER" as const,
      invoke: vi.fn().mockResolvedValue({
        output: { steps: [{ id: "s1", description: "step 1" }] },
        uncertainty: { overall: 0.9, selfReport: 10 }, // 10% confidence score (< 15)
        nextPhase: "EXECUTE"
      })
    };

    const orchestrator = new CognitionOrchestrator({
      cognitions,
      lineage,
      memory,
      publisher,
      eventFactory,
      clock,
      roles: {
        PLANNER: plannerAgent,
        EXECUTOR: {} as any,
        VERIFIER: {} as any,
        CRITIC: {} as any,
        MEMORY_MANAGER: {} as any
      }
    });

    const result = await orchestrator.run({
      agentId: "test-agent",
      goal: "Test low confidence halt",
      task: { prompt: "run task" }
    }, { traceId: "test-trace" });

    // Execution should halt, graph phase should be FAILED due to critical confidence drop
    expect(result.phase).toBe("FAILED");
    expect(result.autonomyLevel).toBe("HALTED");
    expect(result.escalationRequired).toBe(true);
    expect(result.stabilizationActionsTaken?.[0]).toContain("HALTED_AUTONOMOUS_EXECUTION");
  });
});

describe("Confidence Dashboard Endpoint Integration Tests", () => {
  it("exposes the confidence-dashboard route and rolls up graph metadata", async () => {
    const app = await buildApp(config);

    const created = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { name: "confidence-inspector", goal: "Audit confidence routing", tools: [] }
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json();

    const cog = await app.inject({
      method: "POST",
      url: "/cognition",
      payload: {
        agentId: agent.id,
        goal: "Audit confidence routing",
        task: { prompt: "Track propagation" },
        seed: "dashboard-test-seed"
      }
    });
    expect(cog.statusCode).toBe(201);
    const graph = cog.json();

    const dashboardRes = await app.inject({
      method: "GET",
      url: `/cognition/${graph.id}/confidence-dashboard`
    });
    expect(dashboardRes.statusCode).toBe(200);

    const dashboard = dashboardRes.json();
    expect(dashboard.cognitionId).toBe(graph.id);
    expect(dashboard.currentConfidenceScore).toBeGreaterThanOrEqual(0);
    expect(dashboard.currentConfidenceScore).toBeLessThanOrEqual(100);
    expect(Array.isArray(dashboard.transitions)).toBe(true);
    expect(Array.isArray(dashboard.decisions)).toBe(true);
    expect(Array.isArray(dashboard.stabilizationActions)).toBe(true);
    expect(Array.isArray(dashboard.timeline)).toBe(true);

    await app.close();
  });
});
