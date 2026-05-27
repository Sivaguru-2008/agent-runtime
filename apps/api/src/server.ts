/**
 * PHASE 5 — Production server entry point.
 *
 * Adds graceful shutdown registration on top of the existing app factory so
 * SIGTERM from Kubernetes (rolling deploys, node drains) triggers a clean
 * drain sequence rather than abruptly killing in-flight executions.
 *
 * Sprint Hardening — persistence correctness:
 *   Before instantiating the application factory we now run pending Postgres
 *   migrations (when DATABASE_URL is configured). This eliminates the prior
 *   failure mode where the runtime booted against a stale schema and surfaced
 *   `column does not exist` errors on the first event append. Migrations are
 *   idempotent and tracked in `schema_migrations`, so repeat starts are
 *   no-ops after the first successful run.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// D1: bootstrap OpenTelemetry BEFORE any app module is imported. The NodeSDK
// must register the global tracer provider before app modules call
// trace.getTracer() at module load time, otherwise those callers latch
// onto the no-op tracer for the lifetime of the process.
import { startTracing, shutdownTracing } from "./telemetry/otelBootstrap.js";
import {
  loadConfig,
  isStrictInfrastructureMode,
  isMemoryFallbackPermitted,
  assertActivePersistence,
  ENV_FILE_LOADED
} from "./shared/config.js";

const config = loadConfig();
const tracingResult = await startTracing({
  serviceName: config.OTEL_SERVICE_NAME || "agent-runtime-api",
  role: "api"
});

const { buildApp } = await import("./app.js");
const { registerGracefulShutdown } = await import("./infrastructure/reliability/gracefulShutdown.js");
const { createPgClient } = await import("./infrastructure/persistence/postgres/pgClient.js");
const { MigrationRunner } = await import("./infrastructure/persistence/migrationRunner.js");
const { createLogger } = await import("./infrastructure/logger.js");
const { setLivenessState, setLivenessReason, setStrictMode } = await import("./infrastructure/reliability/livenessState.js");

const bootLogger = createLogger(config);
const strict: boolean = isStrictInfrastructureMode(config.NODE_ENV) || config.STRICT_PROD === true;
bootLogger.info(
  {
    tracing: tracingResult,
    exporter: tracingResult.exporterEndpoint ?? "(none — spans dropped)",
    envFile: ENV_FILE_LOADED ?? "(none — using ambient environment)"
  },
  "[startup] OpenTelemetry tracing initialized"
);
setStrictMode(strict);

/**
 * Pre-flight infrastructure probe.
 *
 * Strict mode (NODE_ENV=production|staging):
 *   A failed probe crashes the process. Silently downgrading to memory
 *   would advertise a durable runtime while writing volatile state — the
 *   exact failure the durability contract forbids.
 *
 * Soft mode (development|test):
 *   A failed probe rewrites the in-memory driver assignment so a developer
 *   without local Postgres can still boot the API. This is the only mode
 *   in which fallback is acceptable; the behaviour is preserved unchanged.
 */
async function validateConnectivity(config: any, logger: any) {
  if (config.DATABASE_URL && (config.PERSISTENCE_DRIVER === "postgres" || config.EVENT_STORE_DRIVER === "postgres")) {
    const pgClient = createPgClient(config.DATABASE_URL);
    try {
      await Promise.race([
        pgClient.query("SELECT 1"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Database connection timeout")), 2000))
      ]);
      logger.info("PostgreSQL database connection validated successfully.");
    } catch (err: any) {
      // Sprint Stabilization — the previous behaviour was "any non-strict env
      // silently downgrades to memory mode". That concealed misconfiguration:
      // a developer who forgot `docker-compose up postgres` got a green-light
      // boot whose every execution evaporated on restart. Strict mode still
      // crashes; non-strict mode crashes UNLESS ALLOW_MEMORY_FALLBACK=true.
      const fallbackPermitted = isMemoryFallbackPermitted(config);

      if (!fallbackPermitted) {
        logger.fatal(
          {
            err: err.message || err,
            env: config.NODE_ENV,
            criticalAlert: true,
            persistenceDriver: config.PERSISTENCE_DRIVER,
            remediation:
              "Start Postgres (e.g. `docker-compose up postgres`), set DATABASE_URL, " +
              "then restart. To explicitly opt in to volatile in-memory persistence " +
              "for local development, set ALLOW_MEMORY_FALLBACK=true."
          },
          "[BOOT][CRITICAL] PostgreSQL is unreachable and memory-fallback is not permitted — refusing to boot."
        );
        try { await pgClient.close(); } catch { /* ignore */ }
        setLivenessState("strict-prod-failure", err.message ?? "infra-probe-failed");
        await shutdownTracing();
        process.exit(2);
      }

      logger.warn(
        {
          err: err.message || err,
          databaseUrl: config.DATABASE_URL,
          allowMemoryFallback: true,
          degradedSubsystems: [
            "persistence (memory — execution state lost on restart)",
            "event store (memory — replay history lost on restart)",
            "admin routes (/admin/* → 503 ADMIN_REQUIRES_DATABASE)",
            "audit log (disabled)",
            "tenant guard (permissive in development)"
          ],
          remediation:
            "Start Postgres (docker-compose up postgres) and set DATABASE_URL, then restart this process."
        },
        "[BOOT] PostgreSQL unreachable — ALLOW_MEMORY_FALLBACK=true → demoting to MEMORY persistence + event store. " +
          "Cognition execution IDs, replay frames, and retry state will NOT survive a restart."
      );
      config.PERSISTENCE_DRIVER = "memory";
      config.EVENT_STORE_DRIVER = "memory";
      config.DATABASE_URL = undefined;
    } finally {
      await pgClient.close();
    }
  } else if (strict && config.PERSISTENCE_DRIVER !== "postgres") {
    // Caught earlier by loadConfig, but defence-in-depth: a misconfigured
    // strict-mode boot without DATABASE_URL never gets past this point.
    logger.fatal(
      { env: config.NODE_ENV, persistenceDriver: config.PERSISTENCE_DRIVER },
      "Strict mode requires DATABASE_URL and PERSISTENCE_DRIVER=postgres."
    );
    setLivenessState("strict-prod-failure", "strict-mode-without-postgres");
    await shutdownTracing();
    process.exit(2);
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
      // Probe-only client: do not let ioredis loop forever in the background.
      maxRetriesPerRequest: 1,
      retryStrategy: () => null
    });
    try {
      await Promise.race([
        testRedis.connect().then(() => testRedis.ping()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Redis connection timeout")), 2000))
      ]);
      logger.info("Redis connection validated successfully.");
    } catch (err: any) {
      const fallbackPermitted = isMemoryFallbackPermitted(config);
      if (!fallbackPermitted) {
        logger.fatal(
          {
            err: err.message || err,
            env: config.NODE_ENV,
            criticalAlert: true,
            remediation:
              "Start Redis (e.g. `docker-compose up redis`) and set REDIS_URL. " +
              "To explicitly opt in to in-memory event bus + queue for local " +
              "development, set ALLOW_MEMORY_FALLBACK=true."
          },
          "[BOOT][CRITICAL] Redis is unreachable and memory-fallback is not permitted — refusing to boot."
        );
        try { testRedis.disconnect(); } catch { /* ignore */ }
        setLivenessState("strict-prod-failure", err.message ?? "infra-probe-failed");
        await shutdownTracing();
        process.exit(2);
      }
      logger.warn(
        { err: err.message || err, allowMemoryFallback: true },
        "Redis connection validation failed — ALLOW_MEMORY_FALLBACK=true → demoting to MEMORY event bus & job queue."
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
      // Should be unreachable after the strict probes above, but a future
      // refactor that adds a new memory-driver short-circuit must not be
      // able to silently demote RUNTIME_MODE in production.
      logger.fatal(
        {
          persistenceDriver: config.PERSISTENCE_DRIVER,
          eventStoreDriver: config.EVENT_STORE_DRIVER,
          jobQueueDriver: config.JOB_QUEUE_DRIVER,
          eventBusDriver: config.EVENT_BUS_DRIVER
        },
        "Strict mode reached a memory-driver configuration — refusing to boot."
      );
      setLivenessState("strict-prod-failure", "memory-driver-in-strict-mode");
      await shutdownTracing();
      process.exit(2);
    }
    config.RUNTIME_MODE = "single";
  }
}

await validateConnectivity(config, bootLogger);

/**
 * Single structured boot report. Concentrates every operator-relevant boot
 * decision into one log line so the startup state can be diffed across
 * deploys and grepped from log aggregators without piecing together a dozen
 * scattered messages.
 */
function emitStartupReport(reason: "ready" | "skipped-migrations" = "ready"): void {
  bootLogger.info(
    {
      reason,
      env: config.NODE_ENV,
      strict,
      runtimeMode: config.RUNTIME_MODE,
      runtimeRole: config.RUNTIME_ROLE,
      drivers: {
        persistence: config.PERSISTENCE_DRIVER,
        eventStore: config.EVENT_STORE_DRIVER,
        eventBus: config.EVENT_BUS_DRIVER,
        jobQueue: config.JOB_QUEUE_DRIVER
      },
      provider: {
        model: config.MODEL_PROVIDER,
        modelName: config.MODEL_NAME ?? "(provider default)",
        timeoutMs: config.PROVIDER_TIMEOUT_MS,
        maxRetries: config.PROVIDER_MAX_RETRIES
      },
      security: {
        auth: config.AUTH_ENABLED,
        rateLimit: config.RATE_LIMIT_ENABLED,
        audit: config.AUDIT_LOG_ENABLED,
        quota: config.QUOTA_ENABLED
      },
      shutdown: {
        drainTimeoutMs: config.SHUTDOWN_DRAIN_TIMEOUT_MS
      },
      databaseConfigured: Boolean(config.DATABASE_URL),
      redisConfigured: Boolean(config.REDIS_URL)
    },
    "[startup] runtime boot report"
  );
}


// Defensive: the HTTP server entry point refuses to run as RUNTIME_ROLE=worker.
// Workers are launched through workerProcess.ts which forces role=worker.
// Crossed wires here would silently turn a worker pod into an API server,
// breaking the topology guarantee. Fail loudly at boot instead.
if (config.RUNTIME_ROLE === "worker") {
  // eslint-disable-next-line no-console
  console.error(
    "[server.ts] RUNTIME_ROLE=worker is invalid for this entry point. " +
      "Launch the worker via `node dist/workerProcess.js` (or `npm run worker`)."
  );
  process.exit(2);
}

// Resolve the on-disk locations of schema.sql and db/migrations relative to
// the compiled server.js. The repository layout is apps/api/db/* and the
// build emits apps/api/dist/server.js, so a single resolve from the module's
// dirname covers both `dist` and direct tsx execution from src/.
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
      logger: bootLogger
    });
    const result = await runner.run();
    bootLogger.info(
      {
        applied: result.applied.map((m) => m.filename),
        skipped: result.skipped,
        schemaApplied: result.schemaApplied
      },
      "schema migrations complete"
    );
  } catch (err) {
    // Migration failure in strict mode is unrecoverable: any later write
    // against a half-migrated schema corrupts the durable state. Crash so
    // the orchestrator escalates rather than serving traffic against a
    // broken database.
    bootLogger.fatal({ err }, "schema migrations failed");
    if (strict) {
      setLivenessState("strict-prod-failure", "schema-migrations-failed");
      await migrationClient.close().catch(() => undefined);
      await shutdownTracing();
      process.exit(2);
    }
    throw err;
  } finally {
    await migrationClient.close();
  }
}

emitStartupReport();

// Loud, structured banner when the runtime is degraded. Operators reading logs
// after a boot must not have to piece together a dozen lines to realise that
// admin endpoints are 503, persistence is volatile, and execution IDs from a
// previous run will 404 on lookup. This block is the single source of truth
// for "what does memory mode actually mean for users".
if (config.PERSISTENCE_DRIVER === "memory" || config.EVENT_STORE_DRIVER === "memory") {
  bootLogger.warn(
    {
      mode: "DEGRADED_MEMORY_FALLBACK",
      drivers: {
        persistence: config.PERSISTENCE_DRIVER,
        eventStore: config.EVENT_STORE_DRIVER,
        eventBus: config.EVENT_BUS_DRIVER,
        jobQueue: config.JOB_QUEUE_DRIVER
      },
      consequences: [
        "All executions, cognitions, and replay frames are lost on restart.",
        "Stale execution IDs from a previous run will return 404 from /executions/:id (expected).",
        "All /admin/* endpoints return 503 ADMIN_REQUIRES_DATABASE.",
        "Audit logging and tenant quota enforcement are disabled."
      ],
      remediation: "Start Postgres and set DATABASE_URL, then restart."
    },
    "[BOOT] RUNTIME IS OPERATING IN DEGRADED MEMORY-ONLY MODE"
  );
}

const app = await buildApp(config);

// Sprint Stabilization — post-build assertion that the persistence layer the
// container actually constructed matches the configured driver. Catches the
// failure mode where a refactor silently inserts an in-memory adapter into a
// process whose config claims "postgres". Throws in strict; throws in
// non-strict unless ALLOW_MEMORY_FALLBACK genuinely caused the downgrade.
try {
  const actualDriver = (app as { runtimeContainer?: { persistence?: { driver?: "memory" | "postgres" } } })
    .runtimeContainer?.persistence?.driver;
  if (!actualDriver) {
    throw new Error(
      "[startup] runtimeContainer.persistence.driver is undefined — container did not wire a persistence layer."
    );
  }
  assertActivePersistence(config, actualDriver);
  bootLogger.info(
    { configured: config.PERSISTENCE_DRIVER, actual: actualDriver },
    "[startup] persistence driver assertion passed"
  );
} catch (assertErr) {
  bootLogger.fatal(
    { err: assertErr instanceof Error ? assertErr.message : String(assertErr), criticalAlert: true },
    "[startup][CRITICAL] persistence driver assertion failed — refusing to listen"
  );
  setLivenessState("strict-prod-failure", "persistence-driver-mismatch");
  try { await app.close(); } catch { /* ignore */ }
  await shutdownTracing();
  process.exit(2);
}

// Phase 5: Graceful shutdown — must be registered before listen() so signals
// arriving before the server is fully bound are still handled correctly.
// D1: also flush the OTel BatchSpanProcessor so the last spans of a
// draining pod actually reach the collector rather than die with the process.
registerGracefulShutdown(app, {
  drainTimeoutMs: config.SHUTDOWN_DRAIN_TIMEOUT_MS,
  afterClose: async () => {
    await shutdownTracing();
  }
});

setLivenessState("healthy");

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (error) {
  setLivenessState("strict-prod-failure");
  setLivenessReason(error instanceof Error ? error.message : String(error));
  app.log.error(error);
  await shutdownTracing();
  process.exit(1);
}
