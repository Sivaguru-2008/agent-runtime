/**
 * PHASE 5 — App Factory (Production Readiness)
 *
 * Phase 5 adds enterprise-grade production protections on top of the existing
 * Phase 4 observability wiring:
 *
 *   1. API Key Authentication (registerApiKeyAuth)
 *      Every request (except /health and AUTH_SKIP_PATHS) must carry a valid
 *      X-Api-Key or Authorization: Bearer token. Keys are validated against
 *      Postgres with a Redis cache, attaching a TenantContext to the request.
 *
 *   2. Redis Sliding-Window Rate Limiting (registerRateLimiter)
 *      Per-tenant (or per-IP for unauthenticated paths) limits enforced via
 *      an atomic Lua script. Fails open on Redis unavailability.
 *
 *   3. Structured Audit Logging (registerAuditLogger)
 *      Every authenticated request writes a fire-and-forget row to audit_log,
 *      partitioned by month for efficient retention.
 *
 *   4. Quota Enforcement (QuotaEnforcer)
 *      Attached as a Fastify decorator so route handlers can call
 *      checkExecutionStart() / checkAgentCreation() before writes.
 *
 *   5. Graceful Shutdown (registerGracefulShutdown — called in server.ts)
 *      SIGTERM triggers app.close() → RuntimeContainer.close() drain chain.
 *
 * Hook ordering (Fastify lifecycle):
 *   onRequest: auth → rate-limit → (handler)
 *   onResponse: metrics, audit log (after reply is sent)
 *   onClose: RuntimeContainer.close() + security infra teardown
 *
 * Resource lifecycle:
 *   Security DB/Redis connections are independent of the RuntimeContainer so
 *   auth continues to work even if the main container enters a degraded state.
 */

import cors from "@fastify/cors";
import { Redis } from "ioredis";
import Fastify from "fastify";
import type { AppConfig } from "./shared/config.js";
import { createLogger } from "./infrastructure/logger.js";
import { createRedisClient } from "./infrastructure/reliability/redisClient.js";
import { createRuntimeContainer } from "./application/runtimeContainer.js";
import { registerRoutes } from "./interfaces/http/routes.js";
import { registerOperatorRoutes } from "./interfaces/http/operatorRoutes.js";
import { createId } from "./shared/id.js";
import { createPgClient, type PgClient } from "./infrastructure/persistence/postgres/pgClient.js";
import { registerApiKeyAuth } from "./infrastructure/security/apiKeyAuth.js";
import { registerRateLimiter } from "./infrastructure/security/rateLimiter.js";
import { AuditLogger, registerAuditLogger } from "./infrastructure/security/auditLogger.js";
import { QuotaEnforcer } from "./infrastructure/quota/quotaEnforcer.js";
import "./infrastructure/security/fastifyTypes.js";
import { registerAdminRoutes } from "./interfaces/http/adminRoutes.js";

// UUID-like segments that inflate histogram cardinality if left in paths.
const ID_PATTERN = /\/[0-9a-f-]{8,}(?=\/|$)/gi;

function normaliseRoute(url: string): string {
  return url.split("?")[0]!.replace(ID_PATTERN, "/:id");
}

// Minimal no-op PgClient for when DATABASE_URL is unavailable in a feature
// path. Used for security middleware in pure in-memory development mode.
function createNoopPgClient(): PgClient {
  return {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async withTransaction(fn) {
      return fn(createNoopPgClient());
    },
    async acquire() {
      return {
        async query() {
          return { rows: [], rowCount: 0 };
        },
        release() {
          /* noop */
        }
      };
    },
    stats() {
      return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 };
    },
    async close() {
      return;
    }
  };
}

export async function buildApp(config: AppConfig) {
  const logger = createLogger(config);
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      base: {
        service: "agent-runtime-api",
        environment: config.NODE_ENV
      }
    },
    genReqId: () => createId()
  });

  const container = await createRuntimeContainer(config, logger);
  app.decorate("runtimeContainer", container);
  app.addHook("onClose", async () => {
    await container.close();
  });

  // ── Phase 5: Security infrastructure ───────────────────────────────────────
  //
  // Security components get dedicated DB/Redis connections so auth continues
  // functioning under main event-bus Redis pressure or pool exhaustion.

  // Security Redis — used for API key cache and rate limiting.
  // enableOfflineQueue=false means a Redis outage rejects auth-cache lookups
  // immediately rather than queueing them (callers fall back to Postgres for
  // auth, fail-open for rate-limit). The hardened factory adds bounded
  // retryStrategy + READONLY-triggered reconnect on top.
  let securityRedis: Redis | null = null;
  if (config.REDIS_URL && (config.AUTH_ENABLED || config.RATE_LIMIT_ENABLED)) {
    securityRedis = createRedisClient(config.REDIS_URL, {
      name: "security",
      overrides: {
        enableOfflineQueue: false,
        connectTimeout: 2_000,
        lazyConnect: false
      },
      onError: (name, err) =>
        logger.warn({ name, err }, "Security Redis connection error")
    });
    app.addHook("onClose", async () => {
      securityRedis?.disconnect();
    });
  }

  // Security Postgres — used for API key lookup and audit logging.
  //
  // Sprint Stabilization — fail closed if AUTH/AUDIT/QUOTA was requested but
  // DATABASE_URL is absent. The previous code silently substituted a no-op
  // PgClient via `securityDb ?? createNoopPgClient()`, which meant
  // AUTH_ENABLED=true + no DATABASE_URL would boot a server that rejected
  // every API key as "unknown". Refuse explicitly with a structured alert.
  let securityDb: PgClient | null = null;
  if (config.DATABASE_URL && (config.AUTH_ENABLED || config.AUDIT_LOG_ENABLED || config.QUOTA_ENABLED)) {
    const db = createPgClient(config.DATABASE_URL);
    securityDb = db;
    app.addHook("onClose", async () => {
      await db.close();
    });
  } else if (
    (config.AUTH_ENABLED || config.AUDIT_LOG_ENABLED || config.QUOTA_ENABLED) &&
    !config.DATABASE_URL
  ) {
    logger.fatal(
      {
        criticalAlert: true,
        authEnabled: config.AUTH_ENABLED,
        auditEnabled: config.AUDIT_LOG_ENABLED,
        quotaEnabled: config.QUOTA_ENABLED,
        databaseUrlConfigured: false,
        remediation:
          "Set DATABASE_URL. AUTH/AUDIT/QUOTA require a Postgres-backed " +
          "security store; falling back to a no-op client would silently " +
          "either reject every authenticated request (AUTH) or drop every " +
          "audit row (AUDIT_LOG)."
      },
      "[app][CRITICAL] refusing to boot — AUTH/AUDIT/QUOTA enabled but no DATABASE_URL is configured"
    );
    throw new Error(
      "[security] Refusing to boot: AUTH/AUDIT/QUOTA require DATABASE_URL but none was provided."
    );
  }

  // 1. API Key Authentication ─────────────────────────────────────────────────
  // Runs first in onRequest so tenant context is available for all subsequent hooks.
  await registerApiKeyAuth(app, {
    redis: securityRedis,
    db: securityDb ?? createNoopPgClient(),
    skipPaths: config.AUTH_SKIP_PATHS.split(",").map((p) => p.trim()).filter(Boolean),
    cacheTtlSec: config.API_KEY_CACHE_TTL_SEC,
    enabled: config.AUTH_ENABLED
  });

  // 2. Rate Limiting ──────────────────────────────────────────────────────────
  // Runs after auth so per-tenant RPM from the API key record is available.
  await registerRateLimiter(app, {
    redis: securityRedis,
    enabled: config.RATE_LIMIT_ENABLED,
    defaultRpm: config.RATE_LIMIT_DEFAULT_RPM,
    windowMs: config.RATE_LIMIT_WINDOW_MS
  });

  // 3. Audit Logger ───────────────────────────────────────────────────────────
  // Registers onResponse hook — runs after the reply is sent, never blocking.
  const auditLogger = new AuditLogger(
    securityDb ?? createNoopPgClient(),
    config.AUDIT_LOG_ENABLED && securityDb !== null
  );
  await registerAuditLogger(app, auditLogger);

  // 4. Quota Enforcer ─────────────────────────────────────────────────────────
  // Decorated onto the app so route handlers can call it without prop-drilling.
  const quotaEnforcer = new QuotaEnforcer(
    securityRedis,
    securityDb ?? createNoopPgClient(),
    config.QUOTA_ENABLED && securityDb !== null
  );
  app.decorate("quotaEnforcer", quotaEnforcer);

  // 5. Tenant Guard ───────────────────────────────────────────────────────────
  // Sprint Stabilization — the runtime container is now the authoritative
  // source of the tenant guard. It builds a strict guard when the shared
  // Postgres pool is available and refuses to construct a permissive guard
  // in production/staging/STRICT_PROD. The HTTP layer reuses that exact
  // instance so background workers and the route layer always agree on the
  // ownership policy.
  //
  // We retain a defensive double-check here so a future refactor cannot
  // re-introduce a permissive guard in production through any path.
  const tenantGuard = container.tenantGuard;
  if (
    (config.NODE_ENV === "production" ||
      config.NODE_ENV === "staging" ||
      config.STRICT_PROD === true) &&
    tenantGuard.isPermissive
  ) {
    logger.fatal(
      {
        criticalAlert: true,
        env: config.NODE_ENV,
        strictProd: config.STRICT_PROD
      },
      "[security][CRITICAL] tenant guard is permissive in a strict environment — refusing to boot"
    );
    throw new Error(
      "[L-1] Refusing to boot: TenantGuard is permissive under a strict " +
        "environment. The runtime container should never produce a permissive " +
        "guard in production/staging/STRICT_PROD."
    );
  }
  logger.info(
    {
      tenantGuardMode: tenantGuard.isPermissive ? "permissive-dev" : "strict-postgres",
      databaseConfigured: Boolean(securityDb)
    },
    "[security] tenant guard initialised"
  );
  app.decorate("tenantGuard", tenantGuard);

  // ── Phase 4: HTTP metrics instrumentation ──────────────────────────────────
  // Record request start time so the onResponse hook can observe duration.
  app.addHook("onRequest", async (request) => {
    (request as unknown as Record<string, unknown>)["_metricStart"] = performance.now();
  });

  // Stamp the per-request id on every response so the frontend (cognition-api
  // reads x-runtime-id at lib/cognition-api.ts) can correlate a UI-visible
  // error with the exact server log line. Cheap, safe, no payload impact.
  app.addHook("onSend", async (request, reply, payload) => {
    if (!reply.getHeader("x-runtime-id")) {
      reply.header("x-runtime-id", request.id);
    }
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const start = (request as unknown as Record<string, unknown>)["_metricStart"];
    if (typeof start !== "number") return;
    const durationSec = (performance.now() - start) / 1000;
    const route = normaliseRoute(request.url);
    container.metrics.httpRequestDuration.observe(
      {
        method: request.method,
        route,
        status_code: String(reply.statusCode)
      },
      durationSec
    );

    // V3 — feed the http_availability SLO. Status < 500 counts as good;
    // 5xx is bad. 4xx is user-driven and excluded from availability per
    // the SRE workbook (it would otherwise inflate the error budget on
    // legitimate authentication failures).
    if (reply.statusCode < 400 || (reply.statusCode >= 400 && reply.statusCode < 500)) {
      container.reliability.slo.observe("http_availability", true);
    } else {
      container.reliability.slo.observe("http_availability", false);
    }
  });

  await app.register(cors, { origin: true });
  await registerRoutes(app, container);

  // ── Phase 4: Operator platform routes ─────────────────────────────────────
  await registerOperatorRoutes(app, container);

  // ── Phase 5: Admin routes (API key + tenant + DLQ management) ─────────────
  await registerAdminRoutes(app, securityDb);

  return app;
}
