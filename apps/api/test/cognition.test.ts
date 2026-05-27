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

describe("Sprint Next: cognition + replay + failure", () => {
  it("runs a deterministic cognition and exposes replay frames + a failure report", async () => {
    const app = await buildApp(config);

    // 1. Create an agent.
    const created = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { name: "cognition-pilot", goal: "Investigate runtime", tools: [] }
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json();

    // 2. Start a cognition.
    const cog = await app.inject({
      method: "POST",
      url: "/cognition",
      payload: {
        agentId: agent.id,
        goal: "Investigate runtime",
        task: { prompt: "Audit failures" },
        seed: "deterministic-seed"
      }
    });
    expect(cog.statusCode).toBe(201);
    const graph = cog.json();
    expect(graph.phase === "COMPLETE" || graph.phase === "FAILED").toBe(true);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.nodes[0].role).toBe("PLANNER");
    expect(graph.id).toMatch(/^[0-9a-f]+$/);

    // 3. Determinism: starting the same cognition produces the same ID.
    const cog2 = await app.inject({
      method: "POST",
      url: "/cognition",
      payload: {
        agentId: agent.id,
        goal: "Investigate runtime",
        task: { prompt: "Audit failures" },
        seed: "deterministic-seed"
      }
    });
    expect(cog2.json().id).toBe(graph.id);

    // 4. Frames.
    const framesRes = await app.inject({
      method: "GET",
      url: `/cognition/${graph.id}/replay/frames`
    });
    expect(framesRes.statusCode).toBe(200);
    const frames = framesRes.json();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].kind).toBe("EVENT");
    expect(frames.every((f: { preview: { fingerprint: string } }) => f.preview.fingerprint)).toBe(true);

    // 5. Replay session + seek.
    const sessionRes = await app.inject({
      method: "POST",
      url: `/cognition/${graph.id}/replay`
    });
    expect(sessionRes.statusCode).toBe(201);
    const session = sessionRes.json();
    const seek = await app.inject({
      method: "POST",
      url: `/replay/${session.id}/seek`,
      payload: { frameIndex: Math.min(2, frames.length - 1) }
    });
    expect(seek.statusCode).toBe(200);
    expect(seek.json().cursor.frameIndex).toBeLessThanOrEqual(frames.length - 1);

    // 6. Snapshot at a frame.
    const snap = await app.inject({
      method: "POST",
      url: `/replay/${session.id}/snapshot`,
      payload: { frameIndex: 1 }
    });
    expect(snap.statusCode).toBe(200);
    expect(snap.json().frameIndex).toBe(1);

    // 7. Branch from any node — refetch the current cognition since the
    // memory-manager has appended a record (changing later runs' state).
    const currentRes = await app.inject({ method: "GET", url: `/cognition/${graph.id}` });
    expect(currentRes.statusCode).toBe(200);
    const currentGraph = currentRes.json().graph as { nodes: Array<{ id: string }> };
    const someNode = currentGraph.nodes[Math.min(1, currentGraph.nodes.length - 1)];
    const branch = await app.inject({
      method: "POST",
      url: "/replay/branch",
      payload: {
        sourceCognitionId: graph.id,
        sourceNodeId: someNode.id,
        reason: "test-branch",
        overrides: { seed: "branch-seed" }
      }
    });
    expect(branch.statusCode).toBe(201);
    const pointer = branch.json();
    expect(pointer.sourceCognitionId).toBe(graph.id);

    // 8. Failure report.
    const report = await app.inject({
      method: "GET",
      url: `/cognition/${graph.id}/failure-report`
    });
    expect(report.statusCode).toBe(200);
    const failure = report.json();
    expect(failure.healthScore).toBeGreaterThanOrEqual(0);
    expect(failure.healthScore).toBeLessThanOrEqual(100);

    // 9. Memory influence heatmap.
    const heatmap = await app.inject({
      method: "GET",
      url: `/cognition/${graph.id}/memory-influence`
    });
    expect(heatmap.statusCode).toBe(200);
    const hm = heatmap.json();
    expect(hm.cognitionId).toBe(graph.id);
    expect(Array.isArray(hm.nodes)).toBe(true);

    await app.close();
  });
});
