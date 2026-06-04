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
import { setTimeout as sleep } from "node:timers/promises";

// Port conflict detection — probe the target port BEFORE app.listen() so
// operators get a clear "Port 4000 already in use by PID 12345" message
// instead of a raw EADDRINUSE stack trace.
import { checkPortAvailability } from "./infrastructure/reliability/portGuard.js";
// Dev-mode watcher deduplication — guarantees exactly one API instance owns
// port 4000. On conflict the NEWEST instance takes over (terminates the
// previous holder) rather than exiting into a silent zombie watcher, which was
// the root cause of "starts then ERR_CONNECTION_REFUSED": stale `tsx watch`
// trees whose children had all process.exit(1)'d, leaving nobody listening.
import {
  acquireWatcherLock,
  registerLockCleanup,
  defaultWatcherLockDir,
  terminateLockHolder,
  isPidAlive
} from "./infrastructure/reliability/watcherLock.js";

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
// Stable identifier for THIS process instance. Stamped on every lifecycle and
// crash-diagnostic log line so a termination can be correlated back to a
// specific boot when reading aggregated logs.
const runtimeId = `api-${process.pid}-${Date.now().toString(36)}`;
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
const PRIMARY_LISTEN_HOST = process.env.API_HOST ?? "::";
const FALLBACK_LISTEN_HOST = "0.0.0.0";
bootLogger.info(
  {
    tracing: tracingResult,
    exporter: tracingResult.exporterEndpoint ?? "(none — spans dropped)",
    envFile: ENV_FILE_LOADED ?? "(none — using ambient environment)"
  },
  "[startup] OpenTelemetry tracing initialized"
);
setStrictMode(strict);

// ── Dev-mode single-instance guarantee (take-over) ──────────────────────────
// ROOT-CAUSE FIX. The previous logic refused to boot (process.exit(1)) when
// another instance held the lock. Under `tsx watch` a child that exits 1 leaves
// its watcher parent ALIVE but IDLE — so accumulated `npm run dev` trees became
// zombies that owned no port, and frequently NOBODY was listening on 4000
// → ERR_CONNECTION_REFUSED. The fix: the newest instance TAKES OVER. It
// terminates the previous holder and reclaims the lock, so a fresh `npm run dev`
// (or a watcher restart) always converges to exactly one healthy listener.
//
// The lock now lives in the OS temp dir (defaultWatcherLockDir), OUTSIDE the
// `tsx watch` source tree, so writing it can never itself trigger a reload.
const LOCK_DIR = config.NODE_ENV === "development" ? defaultWatcherLockDir() : "";
if (config.NODE_ENV === "development") {
  let lockResult = acquireWatcherLock(LOCK_DIR);

  if (!lockResult.acquired && lockResult.holder && lockResult.holder.pid !== process.pid) {
    const holder = lockResult.holder;
    if (isPidAlive(holder.pid)) {
      bootLogger.warn(
        {
          existingPid: holder.pid,
          existingStartedAt: holder.timestamp,
          lockPath: lockResult.lockPath
        },
        `[startup] An existing API dev instance (PID ${holder.pid}) holds the lock — ` +
          `taking over so this newest instance owns port ${config.PORT}.`
      );
      const term = await terminateLockHolder(holder.pid);
      bootLogger.info(
        { existingPid: holder.pid, terminated: term.terminated, alreadyDead: term.alreadyDead },
        "[startup] previous dev instance terminated — reclaiming lock"
      );
      lockResult = acquireWatcherLock(LOCK_DIR);
    }
  }

  if (!lockResult.acquired) {
    bootLogger.fatal(
      { lockPath: lockResult.lockPath, holder: lockResult.holder },
      "[startup] Could not acquire the dev watcher lock even after take-over — " +
        "refusing to start a duplicate API instance."
    );
    process.exit(1);
  }
  registerLockCleanup(LOCK_DIR);
  bootLogger.info(
    { pid: process.pid, runtimeId, lockPath: lockResult.lockPath },
    "[startup] Dev watcher lock acquired"
  );
}

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
  // Checksum-repair recovery is DEV ONLY. In strict/production mode the request
  // is refused outright: it would silence the tamper guard that exists to stop
  // a mutated migration from diverging schemas across deployments.
  const repairChecksumsInDev = config.MIGRATIONS_REPAIR_CHECKSUMS === true && !strict;
  if (config.MIGRATIONS_REPAIR_CHECKSUMS === true && strict) {
    bootLogger.warn(
      {},
      "MIGRATIONS_REPAIR_CHECKSUMS ignored in strict/production mode — checksum validation stays enforced"
    );
  }
  try {
    const runner = new MigrationRunner(migrationClient, {
      schemaPath: SCHEMA_PATH,
      migrationsDir: MIGRATIONS_DIR,
      logger: bootLogger,
      repairChecksumsInDev
    });
    const result = await runner.run();
    bootLogger.info(
      {
        applied: result.applied.map((m) => m.filename),
        skipped: result.skipped,
        repaired: result.repaired,
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
//
// In development the drain window is capped low so a `tsx watch` restart frees
// port 4000 almost immediately instead of holding it open for the full
// production drain (long-lived SSE streams would otherwise keep the old process
// — and the port — alive for the whole timeout, recreating the "unreachable
// after a save" symptom). The app is also built with forceCloseConnections in
// development so SSE streams are destroyed on close rather than blocking it.
const drainTimeoutMs =
  config.NODE_ENV === "development"
    ? Math.min(config.SHUTDOWN_DRAIN_TIMEOUT_MS, 3_000)
    : config.SHUTDOWN_DRAIN_TIMEOUT_MS;

// The execution engine is already loaded (buildApp wired it). Importing the
// AsyncLocalStorage handle here — after the app is built and tracing is up —
// lets crash diagnostics surface the active execution id when the async
// context is preserved, without pulling the engine into the boot's top imports.
const { deterministicStorage } = await import("./runtime/executionEngine.js");

// In development an uncaughtException must NOT exit the process: `tsx watch`
// does not restart a crashed child (it only reloads on a file change), so a
// single stray synchronous throw from a background timer/callback would leave
// the backend permanently unreachable (the "Backend offline / ERR_CONNECTION_
// REFUSED" symptom). Keep the listener alive and log the fatal snapshot; the
// next save hot-reloads a clean process. Production/staging keep the fatal
// policy so the orchestrator restarts a clean process. Escape hatch:
// DEV_UNCAUGHT_FATAL=true restores crash-on-uncaught in development.
const fatalOnUncaughtException =
  config.NODE_ENV !== "development" || process.env.DEV_UNCAUGHT_FATAL === "true";

registerGracefulShutdown(app, {
  drainTimeoutMs,
  runtimeId,
  role: "api",
  fatalOnUncaughtException,
  getExecutionId: () => deterministicStorage.getStore()?.executionId,
  afterClose: async () => {
    await shutdownTracing();
  }
});

setLivenessState("healthy");

// ── Pre-flight port check ────────────────────────────────────────────────────
// Probe the target port BEFORE calling app.listen(). This turns a confusing
// EADDRINUSE crash into a clear, actionable message identifying the owning PID.
let listenHost = PRIMARY_LISTEN_HOST;
let portCheck = await checkPortAvailability(config.PORT, listenHost);

// Development take-over: if the port is held by a stale/previous instance, the
// dev lock take-over above should already have terminated it — but a zombie
// that bound the port WITHOUT our lock (e.g. a leftover from before this fix)
// would still squat it. Reclaim the port so the newest instance always wins,
// then re-probe until the OS releases the socket.
if (!portCheck.available && config.NODE_ENV === "development" && portCheck.pid) {
  bootLogger.warn(
    { port: config.PORT, pid: portCheck.pid, processName: portCheck.processName },
    `[startup] Port ${config.PORT} held by PID ${portCheck.pid} — taking over (development).`
  );
  await terminateLockHolder(portCheck.pid);
  for (let attempt = 0; attempt < 20; attempt++) {
    portCheck = await checkPortAvailability(config.PORT, listenHost);
    if (portCheck.available) break;
    await sleep(150);
  }
}

// Prefer the IPv6 wildcard because Node binds it dual-stack by default on the
// supported dev targets: ::1, localhost, and 127.0.0.1 all reach one listener.
// If IPv6 is unavailable, fall back to the original IPv4 wildcard explicitly.
if (
  !portCheck.available &&
  listenHost === "::" &&
  /cannot be bound/i.test(portCheck.message)
) {
  bootLogger.warn(
    { preferredHost: listenHost, fallbackHost: FALLBACK_LISTEN_HOST, message: portCheck.message },
    "[startup] IPv6 dual-stack bind unavailable; falling back to IPv4 wildcard"
  );
  listenHost = FALLBACK_LISTEN_HOST;
  portCheck = await checkPortAvailability(config.PORT, listenHost);
}

if (!portCheck.available) {
  bootLogger.fatal(
    {
      port: config.PORT,
      pid: portCheck.pid,
      processName: portCheck.processName,
      message: portCheck.message
    },
    `[startup][CRITICAL] ${portCheck.message}`
  );
  setLivenessState("strict-prod-failure");
  setLivenessReason(portCheck.message);
  try { await app.close(); } catch { /* ignore */ }
  await shutdownTracing();
  process.exit(1);
}

try {
  await app.listen({ port: config.PORT, host: listenHost });

  // ── Startup diagnostics banner ───────────────────────────────────────────
  // Single structured log line with every operator-relevant boot detail.
  bootLogger.info(
    {
      pid: process.pid,
      port: config.PORT,
      host: listenHost,
      acceptsIPv4Loopback: listenHost === "::" || listenHost === "0.0.0.0",
      acceptsIPv6Loopback: listenHost === "::",
      environment: config.NODE_ENV,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      runtimeMode: config.RUNTIME_MODE,
      runtimeRole: config.RUNTIME_ROLE,
      strict,
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    },
    `[startup] ✅ API server listening — PID ${process.pid} | port ${config.PORT} | ${config.NODE_ENV}`
  );

  // ── Post-listen health verification ───────────────────────────────────────
  // "Listening" only proves the socket bound. Verify the critical routes
  // actually answer (in-process via app.inject — no network needed) so a boot
  // that cannot serve /health, /agents, /cognition, or /observability is caught
  // now instead of surfacing later as a browser ERR_CONNECTION_REFUSED.
  const { runStartupSelfCheck } = await import("./infrastructure/reliability/startupSelfCheck.js");
  const selfCheck = await runStartupSelfCheck(app);
  const probeSummary = selfCheck.probes.map(
    (p) => `${p.name}:${p.statusCode ?? "ERR"}${p.required ? "" : "?"}`
  );
  if (selfCheck.ok) {
    bootLogger.info(
      { runtimeId, durationMs: selfCheck.durationMs, probes: probeSummary },
      "[startup] ✅ health self-check passed — all required routes responding"
    );
  } else {
    // Fail-fast policy: strict environments (and any explicit opt-in) refuse to
    // stay up advertising a broken API. Development logs loudly but keeps
    // serving so a single failing read path does not re-create an unreachable
    // backend — set STARTUP_SELFCHECK_FATAL=true to make dev fatal too.
    const selfCheckFatal = strict || process.env.STARTUP_SELFCHECK_FATAL === "true";
    bootLogger.error(
      {
        runtimeId,
        durationMs: selfCheck.durationMs,
        probes: probeSummary,
        failed: selfCheck.failed,
        fatal: selfCheckFatal
      },
      "[startup][CRITICAL] health self-check FAILED — one or more required routes did not respond"
    );
    if (selfCheckFatal) {
      setLivenessState("strict-prod-failure", "startup-selfcheck-failed");
      try { await app.close(); } catch { /* ignore */ }
      await shutdownTracing();
      process.exit(2);
    }
  }
} catch (error) {
  // Defence-in-depth: detect EADDRINUSE from the listen() call itself in case
  // the port becomes occupied between the pre-flight check and the bind.
  const isAddrInUse = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
  if (isAddrInUse) {
    const { checkPortAvailability: recheck } = await import("./infrastructure/reliability/portGuard.js");
    const reResult = await recheck(config.PORT, listenHost);
    const msg = !reResult.available
      ? reResult.message
      : `Port ${config.PORT} already in use (PID could not be determined)`;
    bootLogger.fatal(
      { port: config.PORT, pid: !reResult.available ? reResult.pid : null },
      `[startup][CRITICAL] ${msg}`
    );
  } else {
    app.log.error(error);
  }
  setLivenessState("strict-prod-failure");
  setLivenessReason(error instanceof Error ? error.message : String(error));
  await shutdownTracing();
  process.exit(1);
}
