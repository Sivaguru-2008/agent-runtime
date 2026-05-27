/**
 * V3 — Runtime invariant suite.
 *
 * Each invariant has a happy-path case and a rejection case so a future
 * refactor that silently weakens the check trips the test.
 */

import { describe, it, expect } from "vitest";
import {
  assertProductionInvariants,
  InvariantViolation,
  listInvariants
} from "../../src/runtime/invariants.js";
import type { AppConfig } from "../../src/shared/config.js";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: "production",
    PORT: 4000,
    EVENT_BUS_DRIVER: "redis-streams",
    EVENT_STORE_DRIVER: "postgres",
    PERSISTENCE_DRIVER: "postgres",
    DATABASE_URL: "postgres://x",
    REDIS_URL: "redis://x",
    RECOVERY_LOOP_INTERVAL_MS: 5000,
    OTEL_SERVICE_NAME: "x",
    LOG_LEVEL: "info",
    RUNTIME_MODE: "distributed",
    RUNTIME_ROLE: "api",
    JOB_QUEUE_DRIVER: "redis",
    QUEUE_BACKPRESSURE_THRESHOLD: 100,
    JOB_QUEUE_VISIBILITY_MS: 45_000,
    JOB_QUEUE_CONSUMER_GROUP: "g",
    RETRY_BACKOFF_BASE_MS: 500,
    RETRY_BACKOFF_MAX_MS: 60000,
    WORKER_ID: "w",
    WORKER_CAPACITY: 4,
    WORKER_HEARTBEAT_TTL_MS: 15000,
    WORKER_SWEEP_INTERVAL_MS: 5000,
    EXECUTION_LEASE_TTL_MS: 30000,
    SCHEDULER_POLL_INTERVAL_MS: 250,
    OLLAMA_URL: "x",
    OLLAMA_MODEL: "x",
    OLLAMA_REQUEST_TIMEOUT_MS: 1000,
    SSE_DEDUPE_WINDOW: 1024,
    WORKER_REGISTRATION_TIMEOUT_MS: 10000,
    POISON_PILL_MAX_ATTEMPTS: 3,
    LEASE_HEARTBEAT_POLL_INTERVAL_MS: 3000,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: 5,
    CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS: 60000,
    CIRCUIT_BREAKER_SUCCESS_THRESHOLD: 2,
    MODEL_PROVIDER: "deterministic",
    PROVIDER_TIMEOUT_MS: 120000,
    PROVIDER_MAX_RETRIES: 3,
    FILE_READ_MAX_BYTES: 32768,
    TOOL_WEB_SEARCH_TIMEOUT_MS: 10000,
    TOOL_CODE_EXECUTE_TIMEOUT_MS: 5000,
    METRICS_ENABLED: true,
    TRACE_LINEAGE_SCAN_LIMIT: 5000,
    AUTH_ENABLED: true,
    AUTH_SKIP_PATHS: "/metrics,/ready",
    API_KEY_CACHE_TTL_SEC: 300,
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_DEFAULT_RPM: 1000,
    RATE_LIMIT_WINDOW_MS: 60000,
    AUDIT_LOG_ENABLED: false,
    QUOTA_ENABLED: false,
    SHUTDOWN_DRAIN_TIMEOUT_MS: 30000,
    ...overrides
  };
}

describe("runtime invariants — happy path", () => {
  it("passes a fully configured production context", () => {
    expect(() =>
      assertProductionInvariants({
        config: baseConfig(),
        otelStarted: true,
        securityDbBound: true,
        tenantGuardStrict: true
      })
    ).not.toThrow();
  });
});

describe("runtime invariants — rejections", () => {
  it("rejects production without AUTH_ENABLED", () => {
    expect(() =>
      assertProductionInvariants({
        config: baseConfig({ AUTH_ENABLED: false }),
        otelStarted: true,
        securityDbBound: true,
        tenantGuardStrict: true
      })
    ).toThrow(InvariantViolation);
  });

  it("rejects production with permissive tenant guard", () => {
    expect(() =>
      assertProductionInvariants({
        config: baseConfig(),
        otelStarted: true,
        securityDbBound: true,
        tenantGuardStrict: false
      })
    ).toThrow(/strict-tenant-guard/);
  });

  it("rejects distributed mode in combined role", () => {
    expect(() =>
      assertProductionInvariants({
        config: baseConfig({ RUNTIME_ROLE: "combined" }),
        otelStarted: true,
        securityDbBound: true,
        tenantGuardStrict: true
      })
    ).toThrow(/distributed-role-split/);
  });

  it("rejects queue visibility shorter than lease ttl", () => {
    expect(() =>
      assertProductionInvariants({
        config: baseConfig({ JOB_QUEUE_VISIBILITY_MS: 10_000, EXECUTION_LEASE_TTL_MS: 30_000 }),
        otelStarted: true,
        securityDbBound: true,
        tenantGuardStrict: true
      })
    ).toThrow(/queue-visibility-vs-lease/);
  });

  it("rejects in-memory persistence in production", () => {
    expect(() =>
      assertProductionInvariants({
        config: baseConfig({ PERSISTENCE_DRIVER: "memory" }),
        otelStarted: true,
        securityDbBound: true,
        tenantGuardStrict: true
      })
    ).toThrow(/non-memory-persistence/);
  });

  it("enumerates all invariants", () => {
    const names = listInvariants();
    expect(names).toContain("production-auth-and-db");
    expect(names).toContain("production-strict-tenant-guard");
    expect(names).toContain("queue-visibility-vs-lease");
    expect(names).toContain("distributed-role-split");
    expect(names).toContain("distributed-bus-and-queue");
    expect(names).toContain("non-memory-persistence");
  });
});
