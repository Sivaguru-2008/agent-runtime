import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/shared/config.js";

/**
 * Branch trace inheritance — when a replay is branched from a source cognition,
 * the branch graph must inherit the source's distributed trace id. Without
 * this, an operator looking at a branched run sees a disconnected new trace
 * instead of the original investigation, and the trace pivot in operator
 * tooling fails to surface the source frames.
 *
 * Doc §7.9.3 flagged this as "share parent's trace id by construction" — but
 * `ReplayEngine.branch` did NOT actually copy `source.traceId` onto the branch
 * graph. This test pins the fix.
 */

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  EVENT_BUS_DRIVER: "memory",
  EVENT_STORE_DRIVER: "memory",
  PERSISTENCE_DRIVER: "memory",
  RECOVERY_LOOP_INTERVAL_MS: 60_000,
  OTEL_SERVICE_NAME: "agent-runtime-branch-trace",
  LOG_LEVEL: "silent",
  RUNTIME_MODE: "single",
  WORKER_ID: "test-branch-worker",
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

describe("Replay branch — trace id inheritance", () => {
  it("branches inherit the source cognition's traceId (shared investigation, not a new one)", async () => {
    const app = await buildApp(config);
    try {
      const agent = (
        await app.inject({ method: "POST", url: "/agents", payload: { name: "branch-pilot", goal: "Investigate", tools: [] } })
      ).json();
      const source = (
        await app.inject({
          method: "POST",
          url: "/cognition",
          payload: { agentId: agent.id, goal: "Investigate", task: { prompt: "Investigate" }, seed: "branch-source" }
        })
      ).json();
      expect(typeof source.traceId).toBe("string");
      expect(source.traceId.length).toBeGreaterThan(0);

      // Pick a real source node (any one beyond the first) and branch from it.
      const sourceNode = source.nodes.find((n: { sequence: number }) => n.sequence > 0) ?? source.nodes[0];
      const branchPointer = (
        await app.inject({
          method: "POST",
          url: "/replay/branch",
          payload: {
            sourceCognitionId: source.id,
            sourceNodeId: sourceNode.id,
            reason: "test branch trace inheritance"
          }
        })
      ).json();
      expect(typeof branchPointer.branchCognitionId).toBe("string");

      // Fetch the branch cognition view and assert it carries the SOURCE's trace id.
      const view = (
        await app.inject({ method: "GET", url: `/cognition/${branchPointer.branchCognitionId}` })
      ).json();
      expect(view.graph.traceId).toBe(source.traceId);

      // The branch is a distinct cognition with a distinct execution id —
      // only the trace correlation is shared. Pin that too so a future refactor
      // can't accidentally collapse the two.
      expect(view.graph.id).not.toBe(source.id);
      expect(view.graph.executionId).not.toBe(source.executionId);
    } finally {
      await app.close();
    }
  });
});
