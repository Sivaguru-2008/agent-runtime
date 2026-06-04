import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/shared/config.js";

/**
 * Regression: a cognition started via /cognition (Run Studio "+ run") used to
 * advertise a derived executionId that had NO backing execution row. Every UI
 * surface that resolved that id via GET /executions/:id therefore 404'd
 * ("Unable to load execution") and the run looked phantom. The orchestrator
 * now materialises + finalises the Execution record, so the id resolves
 * consistently. These tests pin that behaviour.
 */

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  EVENT_BUS_DRIVER: "memory",
  EVENT_STORE_DRIVER: "memory",
  PERSISTENCE_DRIVER: "memory",
  RECOVERY_LOOP_INTERVAL_MS: 60_000,
  OTEL_SERVICE_NAME: "agent-runtime-phantom-test",
  LOG_LEVEL: "silent",
  RUNTIME_MODE: "single",
  WORKER_ID: "test-phantom-worker",
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

describe("Phantom execution fix: cognition runs back a real Execution row", () => {
  it("materialises an Execution that resolves via GET /executions/:id", async () => {
    const app = await buildApp(config);

    const created = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { name: "phantom-pilot", goal: "Investigate runtime", tools: [] }
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json();

    const cog = await app.inject({
      method: "POST",
      url: "/cognition",
      payload: {
        agentId: agent.id,
        goal: "Investigate runtime",
        task: { prompt: "Audit failures" },
        seed: "phantom-seed"
      }
    });
    expect(cog.statusCode).toBe(201);
    const graph = cog.json();
    expect(typeof graph.executionId).toBe("string");
    expect(graph.executionId.length).toBeGreaterThan(0);

    // The crux: the derived executionId now resolves instead of 404-ing.
    const execRes = await app.inject({
      method: "GET",
      url: `/executions/${graph.executionId}`
    });
    expect(execRes.statusCode).toBe(200);
    const body = execRes.json();
    expect(body.execution.id).toBe(graph.executionId);
    expect(body.execution.agentId).toBe(agent.id);
    // A clean run (verifier passes) must reach COMPLETED — regression guard for
    // the verifier selfReport inversion that previously force-HALTED every run.
    expect(body.execution.status).toBe("COMPLETED");
    expect(graph.phase).toBe("COMPLETE");

    await app.close();
  });

  it("lists the cognition's execution under its agent (workbench/dashboard resolvable)", async () => {
    const app = await buildApp(config);

    const agent = (
      await app.inject({
        method: "POST",
        url: "/agents",
        payload: { name: "phantom-pilot-2", goal: "Investigate runtime", tools: [] }
      })
    ).json();

    const graph = (
      await app.inject({
        method: "POST",
        url: "/cognition",
        payload: {
          agentId: agent.id,
          goal: "Investigate runtime",
          task: { prompt: "Audit failures" },
          seed: "phantom-seed-2"
        }
      })
    ).json();

    const agentRes = await app.inject({ method: "GET", url: `/agents/${agent.id}` });
    expect(agentRes.statusCode).toBe(200);
    const detail = agentRes.json();
    const ids = (detail.executions as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain(graph.executionId);

    await app.close();
  });
});

describe("Observability metadata pipeline: traceId + runtimeId", () => {
  it("cognition → execution returns traceId AND runtimeId", async () => {
    const app = await buildApp(config);

    const agent = (
      await app.inject({
        method: "POST",
        url: "/agents",
        payload: { name: "trace-pilot", goal: "Investigate runtime", tools: [] }
      })
    ).json();

    const cogRes = await app.inject({
      method: "POST",
      url: "/cognition",
      payload: {
        agentId: agent.id,
        goal: "Investigate runtime",
        task: { prompt: "Audit failures" },
        seed: "trace-seed"
      }
    });
    expect(cogRes.statusCode).toBe(201);
    const graph = cogRes.json();
    // The creation response is a complete identity envelope.
    expect(typeof graph.traceId).toBe("string");
    expect(graph.traceId.length).toBeGreaterThan(0);
    expect(typeof graph.runtimeId).toBe("string");
    expect(graph.runtimeId.length).toBeGreaterThan(0);

    // The backing execution exposes the SAME traceId + a runtimeId.
    const execRes = await app.inject({ method: "GET", url: `/executions/${graph.executionId}` });
    expect(execRes.statusCode).toBe(200);
    const body = execRes.json();
    expect(typeof body.traceId).toBe("string");
    expect(body.traceId.length).toBeGreaterThan(0);
    expect(body.traceId).toBe(graph.traceId);
    expect(typeof body.runtimeId).toBe("string");
    expect(body.runtimeId.length).toBeGreaterThan(0);
    // Trace id is also persisted on the execution row itself (not only top-level).
    expect(body.execution.traceId).toBe(graph.traceId);

    // The cognition view DTO carries them too (Run Studio / Replay surfaces).
    const viewRes = await app.inject({ method: "GET", url: `/cognition/${graph.id}` });
    expect(viewRes.statusCode).toBe(200);
    const view = viewRes.json();
    expect(view.traceId).toBe(graph.traceId);
    expect(typeof view.runtimeId).toBe("string");
    expect(view.runtimeId.length).toBeGreaterThan(0);

    await app.close();
  });

  it("replay session returns traceId AND runtimeId on create and fetch", async () => {
    const app = await buildApp(config);

    const agent = (
      await app.inject({
        method: "POST",
        url: "/agents",
        payload: { name: "replay-pilot", goal: "Investigate runtime", tools: [] }
      })
    ).json();

    const graph = (
      await app.inject({
        method: "POST",
        url: "/cognition",
        payload: {
          agentId: agent.id,
          goal: "Investigate runtime",
          task: { prompt: "Audit failures" },
          seed: "replay-trace-seed"
        }
      })
    ).json();

    const createRes = await app.inject({ method: "POST", url: `/cognition/${graph.id}/replay` });
    expect(createRes.statusCode).toBe(201);
    const session = createRes.json();
    expect(typeof session.traceId).toBe("string");
    expect(session.traceId.length).toBeGreaterThan(0);
    expect(typeof session.runtimeId).toBe("string");
    expect(session.runtimeId.length).toBeGreaterThan(0);

    const getRes = await app.inject({ method: "GET", url: `/replay/${session.id}` });
    expect(getRes.statusCode).toBe(200);
    const fetched = getRes.json();
    expect(fetched.traceId).toBe(session.traceId);
    expect(typeof fetched.runtimeId).toBe("string");
    expect(fetched.runtimeId.length).toBeGreaterThan(0);

    await app.close();
  });
});
