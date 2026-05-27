/**
 * workerProcess — dedicated worker entry point.
 *
 * Launch with:
 *   RUNTIME_MODE=distributed \
 *   RUNTIME_ROLE=worker \
 *   JOB_QUEUE_DRIVER=redis \
 *   EVENT_BUS_DRIVER=redis-streams \
 *   PERSISTENCE_DRIVER=postgres \
 *   REDIS_URL=redis://... \
 *   DATABASE_URL=postgres://... \
 *   WORKER_ID=worker-$(hostname)-$$ \
 *   node dist/workerProcess.js
 *
 * Responsibilities:
 *   - Run pending Postgres migrations if applicable (idempotent).
 *   - Build the WorkerContainer (no HTTP server is started).
 *   - Block on a termination signal, then drain gracefully.
 *
 * This process must NEVER expose HTTP, NEVER accept user input, and NEVER
 * mutate auth/rate-limit/audit state. Its sole job is queue → execute → ack.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// D1: bootstrap OpenTelemetry BEFORE any app module is imported (see
// server.ts for the rationale — same constraint applies to the worker
// entry point).
import { startTracing, shutdownTracing } from "./telemetry/otelBootstrap.js";
import {
  loadConfig,
  isStrictInfrastructureMode,
  isMemoryFallbackPermitted,
  assertActivePersistence,
  ENV_FILE_LOADED
} from "./shared/config.js";

const config = loadConfig({
  ...process.env,
  // Force role=worker on this entry point regardless of caller env, so a
  // misconfigured process never accidentally turns into an API server.
  RUNTIME_ROLE: "worker"
});

const tracingResult = await startTracing({
  serviceName: (config.OTEL_SERVICE_NAME || "agent-runtime-api") + "-worker",
  role: "worker"
});

const { createLogger } = await import("./infrastructure/logger.js");
const { createWorkerContainer } = await import("./application/workerContainer.js");
const { createPgClient } = await import("./infrastructure/persistence/postgres/pgClient.js");
const { MigrationRunner } = await import("./infrastructure/persistence/migrationRunner.js");
const { setLivenessState, setStrictMode } = await import("./infrastructure/reliability/livenessState.js");

const logger = createLogger(config);
const strict: boolean = isStrictInfrastructureMode(config.NODE_ENV) || config.STRICT_PROD === true;
setStrictMode(strict);
logger.info(
  {
    tracing: tracingResult,
    exporter: tracingResult.exporterEndpoint ?? "(none — spans dropped)",
    envFile: ENV_FILE_LOADED ?? "(none — using ambient environment)"
  },
  "[worker:startup] OpenTelemetry tracing initialized"
);

async function validateConnectivity(config: any, logger: any) {
  // D5: in STRICT_PROD (production/staging or explicit STRICT_PROD=true),
  // unreachable Postgres or Redis MUST fail boot. The previous behavior of
  // silently downgrading to in-memory drivers on the worker was the single
  // most dangerous failure mode: a worker would happily consume jobs against
  // volatile state while the API ran in durable mode.
  if (config.DATABASE_URL && (config.PERSISTENCE_DRIVER === "postgres" || config.EVENT_STORE_DRIVER === "postgres")) {
    const pgClient = createPgClient(config.DATABASE_URL);
    try {
      await Promise.race([
        pgClient.query("SELECT 1"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Database connection timeout")), 2000))
      ]);
      logger.info("worker: PostgreSQL database connection validated successfully.");
    } catch (err: any) {
      const fallbackPermitted = isMemoryFallbackPermitted(config);
      if (!fallbackPermitted) {
        setLivenessState("strict-prod-failure", "postgres-unreachable");
        logger.fatal(
          {
            err: err.message || err,
            env: config.NODE_ENV,
            criticalAlert: true,
            remediation:
              "Start Postgres and set DATABASE_URL. To explicitly opt in to " +
              "volatile in-memory persistence for local dev, set ALLOW_MEMORY_FALLBACK=true."
          },
          "worker[CRITICAL]: PostgreSQL is unreachable and memory-fallback is not permitted — refusing to boot."
        );
        try { await pgClient.close(); } catch { /* ignore */ }
        await shutdownTracing();
        process.exit(2);
      }
      logger.warn(
        { err: err.message || err, allowMemoryFallback: true },
        "worker: PostgreSQL connection validation failed — ALLOW_MEMORY_FALLBACK=true → demoting to MEMORY persistence + event store."
      );
      config.PERSISTENCE_DRIVER = "memory";
      config.EVENT_STORE_DRIVER = "memory";
      config.DATABASE_URL = undefined;
    } finally {
      await pgClient.close();
    }
  }

  if (
    config.REDIS_URL &&
    (config.EVENT_BUS_DRIVER === "redis" ||
      config.EVENT_BUS_DRIVER === "redis-streams" ||
      config.JOB_QUEUE_DRIVER === "redis")
  ) {
    const { Redis } = await import("ioredis");
    const testRedis = new Redis(config.REDIS_URL, {
      connectTimeout: 2000,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null
    });
    try {
      await Promise.race([
        testRedis.connect().then(() => testRedis.ping()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Redis connection timeout")), 2000))
      ]);
      logger.info("worker: Redis connection validated successfully.");
    } catch (err: any) {
      const fallbackPermitted = isMemoryFallbackPermitted(config);
      if (!fallbackPermitted) {
        setLivenessState("strict-prod-failure", "redis-unreachable");
        logger.fatal(
          {
            err: err.message || err,
            env: config.NODE_ENV,
            criticalAlert: true,
            remediation:
              "Start Redis and set REDIS_URL. To explicitly opt in to in-memory " +
              "queue/event bus for local dev, set ALLOW_MEMORY_FALLBACK=true."
          },
          "worker[CRITICAL]: Redis is unreachable and memory-fallback is not permitted — refusing to boot."
        );
        try { testRedis.disconnect(); } catch { /* ignore */ }
        await shutdownTracing();
        process.exit(2);
      }
      logger.warn(
        { err: err.message || err, allowMemoryFallback: true },
        "worker: Redis connection validation failed — ALLOW_MEMORY_FALLBACK=true → demoting to MEMORY event bus & job queue."
      );
      config.EVENT_BUS_DRIVER = "memory";
      config.JOB_QUEUE_DRIVER = "memory";
      config.REDIS_URL = undefined;
    } finally {
      testRedis.disconnect();
    }
  }

  if (
    config.PERSISTENCE_DRIVER === "memory" ||
    config.EVENT_STORE_DRIVER === "memory" ||
    config.JOB_QUEUE_DRIVER === "memory" ||
    config.EVENT_BUS_DRIVER === "memory"
  ) {
    if (strict) {
      setLivenessState("strict-prod-failure", "memory-driver-in-strict-mode");
      logger.fatal(
        {
          persistenceDriver: config.PERSISTENCE_DRIVER,
          eventStoreDriver: config.EVENT_STORE_DRIVER,
          jobQueueDriver: config.JOB_QUEUE_DRIVER,
          eventBusDriver: config.EVENT_BUS_DRIVER
        },
        "worker: STRICT_PROD reached a memory-driver configuration — refusing to boot."
      );
      await shutdownTracing();
      process.exit(2);
    }
    config.RUNTIME_MODE = "single";
  }
}

await validateConnectivity(config, logger);


// Resolve schema migration paths. Same layout as server.ts so a single
// migration runner serves both processes.
const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..");
const SCHEMA_PATH = resolve(API_ROOT, "db", "schema.sql");
const MIGRATIONS_DIR = resolve(API_ROOT, "db", "migrations");

if (
  config.DATABASE_URL &&
  (config.PERSISTENCE_DRIVER === "postgres" || config.EVENT_STORE_DRIVER === "postgres")
) {
  const migrationClient = createPgClient(config.DATABASE_URL);
  try {
    const runner = new MigrationRunner(migrationClient, {
      schemaPath: SCHEMA_PATH,
      migrationsDir: MIGRATIONS_DIR,
      logger
    });
    const result = await runner.run();
    logger.info(
      {
        applied: result.applied.map((m) => m.filename),
        skipped: result.skipped,
        schemaApplied: result.schemaApplied
      },
      "worker: schema migrations complete"
    );
  } finally {
    await migrationClient.close();
  }
}

const worker = await createWorkerContainer(config, logger);

// Sprint Stabilization — post-build assertion that the worker's persistence
// driver matches config. Catches the failure mode where a worker silently
// constructs an in-memory adapter against a config that claims "postgres",
// which would cause durable cluster state (leases, checkpoints, DLQ) to
// diverge between API and worker.
try {
  const actualDriver = worker.persistence?.driver;
  if (!actualDriver) {
    throw new Error("[worker:startup] worker.persistence.driver is undefined.");
  }
  assertActivePersistence(config, actualDriver);
  logger.info(
    { configured: config.PERSISTENCE_DRIVER, actual: actualDriver },
    "[worker:startup] persistence driver assertion passed"
  );
} catch (assertErr) {
  logger.fatal(
    { err: assertErr instanceof Error ? assertErr.message : String(assertErr), criticalAlert: true },
    "[worker:startup][CRITICAL] persistence driver assertion failed — refusing to start consumer loop"
  );
  setLivenessState("strict-prod-failure", "persistence-driver-mismatch");
  try { await worker.close(); } catch { /* ignore */ }
  await shutdownTracing();
  process.exit(2);
}

setLivenessState("healthy");

// Surface unexpected throws inside the worker loop. Exit non-zero so the
// orchestrator (Kubernetes, systemd) restarts a clean process. Lease
// reclamation by sibling workers will cover any executions in flight.
// D1: flush spans on every exit path so the final lease-handover and DLQ
// transitions land in the collector before termination.
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "worker uncaughtException — exiting");
  void worker
    .close()
    .finally(() => shutdownTracing())
    .finally(() => process.exit(1));
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "worker unhandledRejection — exiting");
  void worker
    .close()
    .finally(() => shutdownTracing())
    .finally(() => process.exit(1));
});

await worker.runUntilSignal();
await shutdownTracing();
logger.info({ workerId: worker.workerId }, "worker exit clean");
process.exit(0);
