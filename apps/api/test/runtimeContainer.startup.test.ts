/**
 * Sprint Hardening 3 — fail-fast worker startup.
 *
 * Before: `void (async () => workerLifecycle.register(...))()` swallowed
 * any registration error and let `createRuntimeContainer` return a
 * half-initialized container. A Postgres outage at boot was therefore
 * silent.
 *
 * Now: registration is awaited, bounded by WORKER_REGISTRATION_TIMEOUT_MS,
 * and a failure rejects with a `RuntimeStartupError`. Best-effort cleanup
 * tears down the event bus and persistence pool so the caller never
 * observes leaked resources.
 *
 * These tests cover three contracts:
 *   1. Happy path — successful registration produces a usable container.
 *   2. Loud failure — a throwing registry surfaces a structured error,
 *      not a silent log line.
 *   3. Timeout — a registration that never resolves is bounded and reports
 *      it as a startup failure.
 */
import { describe, expect, it } from "vitest";
import pino from "pino";
import { createRuntimeContainer } from "../src/application/runtimeContainer.js";
import { RuntimeStartupError } from "../src/shared/errors.js";
import type { AppConfig } from "../src/shared/config.js";
import type { PersistenceLayer } from "../src/infrastructure/persistence/persistenceFactory.js";
import {
  InMemoryAgentRepository,
  InMemoryEventStore,
  InMemoryExecutionRepository,
  InMemoryMemoryRepository
} from "../src/infrastructure/persistence/inMemoryStores.js";
import {
  InMemoryBranchRegistry,
  InMemoryCognitionRepository,
  InMemoryFailureSignalStore,
  InMemoryLineageStore,
  InMemoryReplayCertificationStore,
  InMemoryReplaySessionStore,
  InMemorySnapshotStore
} from "../src/infrastructure/persistence/inMemoryCognitionStores.js";
import {
  InMemoryCheckpointStore,
  InMemoryLeaseStore,
  InMemoryWorkerRegistry
} from "../src/infrastructure/cluster/inMemoryClusterStores.js";
import type { WorkerRegistry } from "../src/domain/clusterPorts.js";
import type { RuntimeWorker, WorkerStatus } from "../src/domain/cluster.js";

function buildConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: "test",
    PORT: 0,
    EVENT_BUS_DRIVER: "memory",
    EVENT_STORE_DRIVER: "memory",
    PERSISTENCE_DRIVER: "memory",
    RECOVERY_LOOP_INTERVAL_MS: 60_000,
    OTEL_SERVICE_NAME: "test",
    LOG_LEVEL: "silent",
    RUNTIME_MODE: "single",
    WORKER_ID: "fail-fast-test-worker",
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
    // True-distributed topology fields (default to memory/in-process so the
    // existing fail-fast tests run unchanged in combined mode).
    RUNTIME_ROLE: "combined",
    JOB_QUEUE_DRIVER: "memory",
    QUEUE_BACKPRESSURE_THRESHOLD: 0,
    JOB_QUEUE_VISIBILITY_MS: 45_000,
    JOB_QUEUE_CONSUMER_GROUP: "agent-runtime-workers",
    RETRY_BACKOFF_BASE_MS: 500,
    RETRY_BACKOFF_MAX_MS: 60_000,
    ...overrides
  };
}

function silentLogger() {
  return pino({ level: "silent" });
}

interface PersistenceWithCloseTracker extends PersistenceLayer {
  /** Set to true when the container's failure path calls close(). */
  closed: { value: boolean };
}

function buildPersistence(registry: WorkerRegistry): PersistenceWithCloseTracker {
  const closed = { value: false };
  return {
    driver: "memory",
    eventStore: new InMemoryEventStore(),
    // Sprint Hardening: PersistenceLayer now bundles the agent/execution/memory
    // repositories so runtimeContainer can stop defaulting them to in-memory
    // in production paths. Tests keep the legacy in-memory adapters here.
    agents: new InMemoryAgentRepository(),
    executions: new InMemoryExecutionRepository(),
    memory: new InMemoryMemoryRepository(),
    cognitions: new InMemoryCognitionRepository(),
    lineage: new InMemoryLineageStore(),
    snapshots: new InMemorySnapshotStore(),
    replaySessions: new InMemoryReplaySessionStore(),
    branches: new InMemoryBranchRegistry(),
    failureSignals: new InMemoryFailureSignalStore(),
    workers: registry,
    leases: new InMemoryLeaseStore(),
    checkpoints: new InMemoryCheckpointStore(),
    replayCertifications: new InMemoryReplayCertificationStore(),
    closed,
    async close() {
      closed.value = true;
    }
  };
}

class AlwaysFailingRegistry implements WorkerRegistry {
  constructor(private readonly cause: Error) {}
  async register(): Promise<RuntimeWorker> {
    throw this.cause;
  }
  async heartbeat() { return undefined; }
  async markStatus() { return undefined; }
  async getById() { return undefined; }
  async list() { return []; }
  async expireStale() { return []; }
}

class StalledRegistry implements WorkerRegistry {
  /** Returns a promise that never resolves — simulates a stuck DB connect. */
  async register(): Promise<RuntimeWorker> {
    return new Promise(() => {
      // intentional: never resolves
    });
  }
  async heartbeat() { return undefined; }
  async markStatus() { return undefined; }
  async getById() { return undefined; }
  async list() { return []; }
  async expireStale() { return []; }
}

describe("createRuntimeContainer — fail-fast startup", () => {
  it("happy path: returns a container when registration succeeds", async () => {
    const persistence = buildPersistence(new InMemoryWorkerRegistry());
    const container = await createRuntimeContainer(buildConfig(), silentLogger(), {
      persistence
    });
    try {
      expect(container.workerId).toBe("fail-fast-test-worker");
      // The embedded worker should be registered (visible via list()).
      const workers = await container.workers.list();
      expect(workers.some((w) => w.id === "fail-fast-test-worker")).toBe(true);
    } finally {
      await container.close();
    }
  });

  it("rejects loudly with RuntimeStartupError when the registry throws", async () => {
    const cause = new Error("pg connection refused: ECONNREFUSED 127.0.0.1:5432");
    const persistence = buildPersistence(new AlwaysFailingRegistry(cause));
    let caught: unknown = undefined;
    try {
      await createRuntimeContainer(buildConfig(), silentLogger(), { persistence });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RuntimeStartupError);
    const startupErr = caught as RuntimeStartupError;
    expect(startupErr.stage).toBe("worker-registration");
    // The original Postgres error must be preserved as the cause, not
    // swallowed — operators need this signal to triage.
    expect(startupErr.cause).toBe(cause);
    // Persistence must be torn down so no pool is leaked.
    expect(persistence.closed.value).toBe(true);
  });

  it("rejects with a timeout when registration never completes", async () => {
    const persistence = buildPersistence(new StalledRegistry());
    let caught: unknown = undefined;
    const start = Date.now();
    try {
      await createRuntimeContainer(
        buildConfig({ WORKER_REGISTRATION_TIMEOUT_MS: 150 }),
        silentLogger(),
        { persistence }
      );
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(RuntimeStartupError);
    expect((caught as RuntimeStartupError).stage).toBe("worker-registration");
    // The timeout must fire close to the configured bound — at least the
    // bound, but well under a second.
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(2_000);
    expect(persistence.closed.value).toBe(true);
  });
});
