import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/shared/config.js";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  EVENT_BUS_DRIVER: "memory",
  EVENT_STORE_DRIVER: "memory",
  PERSISTENCE_DRIVER: "memory",
  RECOVERY_LOOP_INTERVAL_MS: 60_000,
  OTEL_SERVICE_NAME: "agent-runtime-api-test",
  LOG_LEVEL: "silent",
  RUNTIME_MODE: "single",
  WORKER_ID: "test-worker",
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

describe("agent runtime API", () => {
  it("creates an agent, runs a task, and exposes execution trace events", async () => {
    const app = await buildApp(config);

    const created = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        name: "infra-operator",
        goal: "Diagnose runtime failures",
        tools: [{ name: "runtime.inspect", enabled: true }]
      }
    });

    expect(created.statusCode).toBe(201);
    const agent = created.json();

    const taskResponse = await app.inject({
      method: "POST",
      url: `/agents/${agent.id}/tasks`,
      payload: {
        prompt: "Check why the previous deployment failed"
      }
    });

    expect(taskResponse.statusCode).toBe(202);
    const execution = taskResponse.json();
    // True-distributed topology: the API enqueues the task and returns the
    // QUEUED execution immediately. A worker (running in-process here because
    // RUNTIME_ROLE=combined) leases and completes the execution asynchronously.
    expect(execution.status).toBe("QUEUED");

    // Wait for the embedded worker loop to complete the execution.
    let finalTrace: { events: { type: string }[]; graph: { nodes: unknown[] }; timeline: unknown[]; execution: { status: string; tokenUsage: { total: number } } } | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const traceResponse = await app.inject({
        method: "GET",
        url: `/executions/${execution.id}`
      });
      if (traceResponse.statusCode === 200) {
        const t = traceResponse.json();
        if (t.execution?.status === "COMPLETED") {
          finalTrace = t;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(finalTrace).toBeDefined();
    const trace = finalTrace!;
    expect(trace.execution.status).toBe("COMPLETED");
    expect(trace.execution.tokenUsage.total).toBeGreaterThan(0);
    expect(trace.events.some((event: { type: string }) => event.type === "TOOL_CALLED")).toBe(true);
    expect(trace.graph.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(trace.timeline)).toBe(true);

    const replayResponse = await app.inject({
      method: "POST",
      url: `/executions/${execution.id}/replay`
    });

    expect(replayResponse.statusCode).toBe(202);
    const replay = replayResponse.json();
    // Audit CRITICAL-5: replay is now fenced. When a jobQueue is wired
    // (as in this integration setup), replayExecution enqueues the replay
    // job and returns the QUEUED record immediately — the worker handles
    // completion asynchronously. Previously replay ran synchronously in
    // the API process with no fence, which could stomp a live execution's
    // terminal state. The QUEUED status here is the new correct contract.
    expect(replay.status).toBe("QUEUED");
    expect(replay.parentExecutionId).toBe(execution.id);

    await app.close();
  });
});
