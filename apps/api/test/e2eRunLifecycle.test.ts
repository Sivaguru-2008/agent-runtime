import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/shared/config.js";

/**
 * End-to-end run lifecycle — the path that real correctness bugs hid behind.
 *
 * Exercises the full HTTP surface a user drives from Run Studio:
 *   prompt → cognition runs (plan→execute→verify→critique→memory→complete)
 *          → the run COMPLETES (not force-FAILED)
 *          → its execution resolves via /executions/:id with a terminal status
 *          → the failure-timeline reflects THIS run's real frames
 *          → full-analysis returns a well-formed report
 *          → the identity envelope (trace/runtime) is consistent end-to-end
 *
 * These assertions would have caught BOTH the verifier selfReport inversion
 * (every run FAILED) and the phantom-execution defect (executionId 404s) — the
 * two bugs the 500+ unit tests missed because none drove the whole path.
 */

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  EVENT_BUS_DRIVER: "memory",
  EVENT_STORE_DRIVER: "memory",
  PERSISTENCE_DRIVER: "memory",
  RECOVERY_LOOP_INTERVAL_MS: 60_000,
  OTEL_SERVICE_NAME: "agent-runtime-e2e-test",
  LOG_LEVEL: "silent",
  RUNTIME_MODE: "single",
  WORKER_ID: "test-e2e-worker",
  WORKER_CAPACITY: 4,
  WORKER_HEARTBEAT_TTL_MS: 15_000,
  WORKER_SWEEP_INTERVAL_MS: 60_000,
  WORKER_REAP_AFTER_MS: 86_400_000,
  EXECUTION_LEASE_TTL_MS: 30_000,
  SCHEDULER_POLL_INTERVAL_MS: 250,
  GROQ_BASE_URL: "https://api.groq.com/openai/v1",
  GROQ_MODEL: "llama-3.3-70b-versatile",
  GROQ_REQUEST_TIMEOUT_MS: 120_000,
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

async function createAgent(app: Awaited<ReturnType<typeof buildApp>>, name: string) {
  const res = await app.inject({
    method: "POST",
    url: "/agents",
    payload: { name, goal: "Investigate runtime", tools: [] }
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function startCognition(
  app: Awaited<ReturnType<typeof buildApp>>,
  agentId: string,
  prompt: string,
  seed?: string
) {
  const res = await app.inject({
    method: "POST",
    url: "/cognition",
    payload: { agentId, goal: prompt, task: { prompt }, ...(seed ? { seed } : {}) }
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("E2E: prompt → completed run → resolvable execution → real timeline", () => {
  it("drives a user prompt through the full cognition lifecycle", async () => {
    const app = await buildApp(config);
    try {
      const agent = await createAgent(app, "e2e-pilot");
      const graph = await startCognition(app, agent.id, "Summarise the incident and propose a fix", "e2e-seed-1");

      // 1. The run actually COMPLETES (regression guard: verifier inversion).
      expect(graph.phase).toBe("COMPLETE");
      expect(Array.isArray(graph.nodes)).toBe(true);
      expect(graph.nodes.length).toBeGreaterThan(0);
      const roles = new Set(graph.nodes.map((n: { role: string }) => n.role));
      expect(roles.has("PLANNER")).toBe(true);
      expect(roles.has("EXECUTOR")).toBe(true);
      expect(roles.has("VERIFIER")).toBe(true);

      // 2. Identity envelope present at creation.
      expect(typeof graph.traceId).toBe("string");
      expect(graph.traceId.length).toBeGreaterThan(0);
      expect(typeof graph.runtimeId).toBe("string");

      // 3. The backing execution resolves (regression guard: phantom execution).
      const execRes = await app.inject({ method: "GET", url: `/executions/${graph.executionId}` });
      expect(execRes.statusCode).toBe(200);
      const execBody = execRes.json();
      expect(execBody.execution.id).toBe(graph.executionId);
      expect(execBody.execution.status).toBe("COMPLETED");
      expect(execBody.execution.failure).toBeUndefined();
      expect(execBody.traceId).toBe(graph.traceId);
      expect(typeof execBody.runtimeId).toBe("string");

      // 4. The failure-timeline reflects THIS run's real frames (data-driven,
      //    not a fixed story). A clean run has frames but zero failure signals.
      const tlRes = await app.inject({ method: "GET", url: `/cognition/${graph.id}/failure-timeline` });
      expect(tlRes.statusCode).toBe(200);
      const timeline = tlRes.json();
      expect(Array.isArray(timeline.frames)).toBe(true);
      expect(timeline.frames.length).toBeGreaterThan(0);
      // Frames carry real runtime event types — never empty/placeholder.
      for (const f of timeline.frames) {
        expect(typeof f.eventType).toBe("string");
        expect(f.eventType.length).toBeGreaterThan(0);
        expect(["ROOT_CAUSE", "PROPAGATION", "TERMINAL", "CLEAN"]).toContain(f.causalRole);
      }

      // A COMPLETED run must not carry HIGH/CRITICAL failure signals — those
      // are reserved for genuine failures. Low-severity observability signals
      // (e.g. an uncertainty note on synthetic tokens) are acceptable.
      const reportRes = await app.inject({ method: "GET", url: `/cognition/${graph.id}/failure-report` });
      expect(reportRes.statusCode).toBe(200);
      const report = reportRes.json();
      expect(report.bySeverity?.CRITICAL ?? 0).toBe(0);
      expect(report.bySeverity?.HIGH ?? 0).toBe(0);
      // Health should remain in the healthy band for a clean run.
      expect(report.healthScore).toBeGreaterThanOrEqual(0.5);

      // 5. full-analysis returns a well-formed report for the real execution.
      const faRes = await app.inject({ method: "POST", url: `/executions/${graph.executionId}/full-analysis` });
      expect(faRes.statusCode).toBe(200);
      const analysis = faRes.json();
      expect(analysis.executionId).toBe(graph.executionId);
      expect(analysis.report).toBeTruthy();
      expect(typeof analysis.report.healthScore).toBe("number");

      // 6. The cognition view DTO is consistent with the run.
      const viewRes = await app.inject({ method: "GET", url: `/cognition/${graph.id}` });
      expect(viewRes.statusCode).toBe(200);
      const view = viewRes.json();
      expect(view.graph.id).toBe(graph.id);
      expect(view.graph.executionId).toBe(graph.executionId);
      expect(view.traceId).toBe(graph.traceId);
    } finally {
      await app.close();
    }
  });

  it("is deterministic for a fixed seed (same cognition id + frame count)", async () => {
    const app = await buildApp(config);
    try {
      const agent = await createAgent(app, "e2e-determinism");
      const a = await startCognition(app, agent.id, "Same task", "fixed-seed");
      const b = await startCognition(app, agent.id, "Same task", "fixed-seed");
      expect(b.id).toBe(a.id);

      const [ta, tb] = await Promise.all([
        app.inject({ method: "GET", url: `/cognition/${a.id}/failure-timeline` }).then((r) => r.json()),
        app.inject({ method: "GET", url: `/cognition/${b.id}/failure-timeline` }).then((r) => r.json())
      ]);
      expect(tb.frames.length).toBe(ta.frames.length);
    } finally {
      await app.close();
    }
  });

  it("distinct prompts yield distinct runs with their own identity envelopes", async () => {
    const app = await buildApp(config);
    try {
      const agent = await createAgent(app, "e2e-distinct");
      const a = await startCognition(app, agent.id, "Task A");
      const b = await startCognition(app, agent.id, "Task B");

      // Different runs — distinct ids, executions, and trace ids.
      expect(a.id).not.toBe(b.id);
      expect(a.executionId).not.toBe(b.executionId);
      expect(a.traceId).not.toBe(b.traceId);

      const [ea, eb] = await Promise.all([
        app.inject({ method: "GET", url: `/executions/${a.executionId}` }).then((r) => r.json()),
        app.inject({ method: "GET", url: `/executions/${b.executionId}` }).then((r) => r.json())
      ]);
      expect(ea.execution.id).toBe(a.executionId);
      expect(eb.execution.id).toBe(b.executionId);
      expect(ea.execution.id).not.toBe(eb.execution.id);
    } finally {
      await app.close();
    }
  });

  it("runTask (Run Trace path) materialises a resolvable, trace-stamped execution", async () => {
    const app = await buildApp(config);
    try {
      const agent = await createAgent(app, "e2e-runtask");
      const taskRes = await app.inject({
        method: "POST",
        url: `/agents/${agent.id}/tasks`,
        payload: { prompt: "Explain the failure and remediate" }
      });
      // Accepted onto the queue/scheduler.
      expect(taskRes.statusCode).toBe(202);
      const execution = taskRes.json();
      expect(typeof execution.id).toBe("string");

      // The execution row exists immediately and is trace-stamped + tenant-scoped.
      const getRes = await app.inject({ method: "GET", url: `/executions/${execution.id}` });
      expect(getRes.statusCode).toBe(200);
      const body = getRes.json();
      expect(body.execution.id).toBe(execution.id);
      expect(body.execution.agentId).toBe(agent.id);
      expect(typeof body.runtimeId).toBe("string");
    } finally {
      await app.close();
    }
  });
});
