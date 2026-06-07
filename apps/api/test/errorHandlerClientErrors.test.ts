import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/shared/config.js";

/**
 * Global error-handler regression: CLIENT errors must not surface as 500s.
 *
 * The incident: the operator dashboard's Root Cause panel POSTs to
 * `/executions/:id/full-analysis` with `Content-Type: application/json` but NO
 * body. Fastify's JSON body parser rejects an empty body
 * (FST_ERR_CTP_EMPTY_JSON_BODY, a 400) in the PARSING phase — before the route
 * handler runs — so none of the route's per-stage guards can catch it. The
 * global catch-all then mapped that 400 to the opaque
 * `INTERNAL_ERROR (500): Unexpected runtime error` card the operator saw.
 *
 * The fix: the global handler now honours Fastify's own 4xx `statusCode` and
 * returns the real client error. This suite drives the REAL app (buildApp →
 * full global error handler) through app.inject to prove it.
 */

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

describe("global error handler — client errors are not 500s", () => {
  it("bodyless POST with Content-Type: application/json → 400, never the opaque 500", async () => {
    const app = await buildApp(config);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/executions/exec-does-not-matter/full-analysis",
        // application/json + NO payload === the empty-body shape that crashed.
        headers: { "content-type": "application/json" }
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      // Real, non-opaque classification — not "INTERNAL_ERROR"/"Unexpected runtime error".
      expect(body.error).toBe("FST_ERR_CTP_EMPTY_JSON_BODY");
      expect(body.error).not.toBe("INTERNAL_ERROR");
      expect(body.message).not.toMatch(/unexpected runtime error/i);
    } finally {
      await app.close();
    }
  });

  it("bodyless POST WITHOUT a Content-Type → 200 well-formed analysis (the path the fixed client takes)", async () => {
    const app = await buildApp(config);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/executions/exec-does-not-matter/full-analysis"
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.report.healthScore).toBe(100);
      expect(body.degraded).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("GET continues to work (no body parsing involved) → 200", async () => {
    const app = await buildApp(config);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/executions/exec-does-not-matter/full-analysis"
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().report.healthScore).toBe(100);
    } finally {
      await app.close();
    }
  });
});
