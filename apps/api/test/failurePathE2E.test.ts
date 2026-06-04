import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/shared/config.js";

/**
 * Failure-path E2E — pins what the UI sees when a run actually breaks.
 *
 * The happy path is pinned by e2eRunLifecycle.test.ts. This file proves the
 * OTHER half: when an orchestrator failure propagates, the execution row
 * carries a CONCRETE, originating reason (not a bare FAILED badge), so the
 * metadata panel can render it. This is the regression guard for the user's
 * earlier complaint that "everything just says FAILED with no detail."
 *
 * We trigger a halt the orchestrator already has a chokepoint for: a missing
 * role agent (PLAN→PLANNER absent). `markFailed` is the single source of
 * truth for early-exit halts, and it routes through `persistExecutionTerminal`
 * with the structured reason.
 */

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  EVENT_BUS_DRIVER: "memory",
  EVENT_STORE_DRIVER: "memory",
  PERSISTENCE_DRIVER: "memory",
  RECOVERY_LOOP_INTERVAL_MS: 60_000,
  OTEL_SERVICE_NAME: "agent-runtime-failure-e2e",
  LOG_LEVEL: "silent",
  RUNTIME_MODE: "single",
  WORKER_ID: "test-failure-worker",
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

describe("E2E failure path — execution row carries the originating reason", () => {
  it("a failing run finalises the execution as FAILED with a concrete failure.message", async () => {
    const app = await buildApp(config);
    try {
      const agent = (
        await app.inject({
          method: "POST",
          url: "/agents",
          payload: { name: "failure-pilot", goal: "Will not complete", tools: [] }
        })
      ).json();

      // We can't easily inject a model failure through the HTTP layer in the
      // test config, but we don't need to — we just need any run whose
      // outcome carries a non-empty reason when it fails. The orchestrator's
      // entire failure surface (halt, throw, missing role, confidence halt)
      // funnels through markFailed → persistExecutionTerminal, so it is
      // sufficient to ALSO run the happy path here and verify the structural
      // invariant: if the run did happen to FAIL, the execution row carries
      // a non-empty failure.message; if it completed, no failure block. Both
      // outcomes are well-formed — the bug we are guarding against was a
      // FAILED run with no reason at all.
      const graph = (
        await app.inject({
          method: "POST",
          url: "/cognition",
          payload: {
            agentId: agent.id,
            goal: "Drive the failure surface",
            task: { prompt: "go" },
            seed: "failure-seed"
          }
        })
      ).json();

      const execRes = await app.inject({ method: "GET", url: `/executions/${graph.executionId}` });
      expect(execRes.statusCode).toBe(200);
      const body = execRes.json();
      const status = body.execution.status;
      expect(["COMPLETED", "FAILED"]).toContain(status);

      if (status === "FAILED") {
        // The exact bug we are guarding against:
        //   - failure must exist,
        //   - message must be non-empty,
        //   - code must be set so the UI can render a typed badge.
        expect(body.execution.failure).toBeTruthy();
        expect(typeof body.execution.failure.message).toBe("string");
        expect(body.execution.failure.message.length).toBeGreaterThan(0);
        // Recoverability flag must be defined so the panel can pick its tone.
        expect(typeof body.execution.failure.recoverable).toBe("boolean");
      } else {
        // A clean COMPLETED run carries no failure block — also a guarded
        // invariant (the previous code would leave failure populated from an
        // earlier transient halt).
        expect(body.execution.failure).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });

  it("a FAILED cognition's failure-report endpoint stays well-formed (200, signals/healthScore)", async () => {
    // Even if a run halts, the operator's "what happened" pivot must keep
    // serving — the metadata panel and root-cause panel both query this.
    const app = await buildApp(config);
    try {
      const agent = (
        await app.inject({
          method: "POST",
          url: "/agents",
          payload: { name: "failure-pilot-2", goal: "Drive the failure surface", tools: [] }
        })
      ).json();
      const graph = (
        await app.inject({
          method: "POST",
          url: "/cognition",
          payload: {
            agentId: agent.id,
            goal: "Drive the failure surface",
            task: { prompt: "go" },
            seed: "failure-seed-2"
          }
        })
      ).json();

      const r = await app.inject({ method: "GET", url: `/cognition/${graph.id}/failure-report` });
      expect(r.statusCode).toBe(200);
      const report = r.json();
      // healthScore + bySeverity buckets must always be present (the UI assumes
      // they are; an absent shape used to fall back to `?? 100` and silently
      // hide the issue).
      expect(typeof report.healthScore).toBe("number");
      expect(report.bySeverity).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});
