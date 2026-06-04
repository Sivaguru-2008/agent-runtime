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
import { createLogger, trueClockTimestamp } from "./infrastructure/logger.js";
import { createRedisClient } from "./infrastructure/reliability/redisClient.js";
import { createRuntimeContainer } from "./application/runtimeContainer.js";
import { registerRoutes } from "./interfaces/http/routes.js";
import { registerOperatorRoutes } from "./interfaces/http/operatorRoutes.js";
import { createId } from "./shared/id.js";
import { RUNTIME_INSTANCE_ID } from "./interfaces/http/observabilityMetadata.js";
import { createPgClient, type PgClient } from "./infrastructure/persistence/postgres/pgClient.js";
import { registerApiKeyAuth } from "./infrastructure/security/apiKeyAuth.js";
import { registerRateLimiter } from "./infrastructure/security/rateLimiter.js";
import { AuditLogger, registerAuditLogger } from "./infrastructure/security/auditLogger.js";
import { QuotaEnforcer } from "./infrastructure/quota/quotaEnforcer.js";
import "./infrastructure/security/fastifyTypes.js";
import { registerAdminRoutes } from "./interfaces/http/adminRoutes.js";
import { registerSignupRoutes } from "./interfaces/http/signupRoutes.js";
import { registerFunnelAnalyticsRoutes } from "./interfaces/http/funnelRoutes.js";
import { DEFAULT_ALERT_CONFIG } from "./application/analytics/funnelAlerts.js";

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
      },
      // Use the true clock for timestamps. Without this, Fastify builds its own
      // pino with the DEFAULT timestamp (pino's epochTime → global Date.now),
      // which executionEngine patches to throw S_UNSAFE_REPLAY inside an
      // execution step. app.log is what processLifecycle's uncaughtException
      // handler logs through, so a fatal raised inside a step would call the
      // patched Date.now during timestamping and crash the whole process —
      // masking the real error and taking the backend permanently offline.
      timestamp: trueClockTimestamp
    },
    genReqId: () => createId(),
    // Connection-drain policy on app.close():
    //   development → true: destroy ALL open connections immediately, including
    //     long-lived SSE streams. Without this a `tsx watch` restart would keep
    //     the old process (and port 4000) alive for the whole drain window while
    //     the dashboard's SSE connection refused to close — the "unreachable
    //     after a save" symptom. Destroying them lets the newest instance bind
    //     the port at once.
    //   production → "idle": close idle keep-alive sockets immediately but let
    //     in-flight requests finish, so a rolling deploy drains cleanly.
    forceCloseConnections: config.NODE_ENV === "development" ? true : "idle"
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
  if (config.DATABASE_URL) {
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

  // Expose the security store (or null in MEMORY mode) to request handlers that
  // need a fire-and-forget write outside the runtime container — e.g. the
  // task-creation handler stamping signups.activated_at on first activation.
  app.decorate("securityDb", securityDb);

  // 1. API Key Authentication ─────────────────────────────────────────────────
  // Runs first in onRequest so tenant context is available for all subsequent hooks.
  //
  // Strict-environment guarantee (defense in depth): production / STRICT_PROD
  // must run authenticated. loadConfig already rejects AUTH_ENABLED=false in
  // those environments; we re-assert here and inside registerApiKeyAuth so the
  // unauthenticated synthetic-tenant fallback can never be installed in prod
  // through any boot path.
  const authStrict = config.NODE_ENV === "production" || config.STRICT_PROD === true;
  if (authStrict && !config.AUTH_ENABLED) {
    logger.fatal(
      { criticalAlert: true, env: config.NODE_ENV, strictProd: config.STRICT_PROD },
      "[security][CRITICAL] AUTH_ENABLED=false in a strict environment — refusing to boot"
    );
    throw new Error(
      "[security] Refusing to boot: AUTH_ENABLED must be true in production / STRICT_PROD."
    );
  }
  // The public self-serve signup endpoint runs unauthenticated by design (the
  // caller has no key yet — that is the whole point). We append it to the skip
  // list unconditionally; the SIGNUP_ENABLED gate inside the route is what
  // actually controls availability, so a disabled signup is still a clean 403,
  // never a 401 that leaks the auth boundary.
  const authSkipPaths = config.AUTH_SKIP_PATHS.split(",").map((p) => p.trim()).filter(Boolean);
  if (!authSkipPaths.includes("/signup")) authSkipPaths.push("/signup");
  await registerApiKeyAuth(app, {
    redis: securityRedis,
    db: securityDb ?? createNoopPgClient(),
    skipPaths: authSkipPaths,
    cacheTtlSec: config.API_KEY_CACHE_TTL_SEC,
    enabled: config.AUTH_ENABLED,
    strict: authStrict,
    disabledFallbackRole: config.AUTH_DISABLED_FALLBACK_ROLE ?? "developer"
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

  // Stamp identity headers on every response. Two DISTINCT ids:
  //   x-runtime-id : the stable runtime-instance id (RUNTIME_INSTANCE_ID) — the
  //                  same for every response from this process, so the console's
  //                  "Runtime ID" field stops changing on each request and
  //                  actually identifies the running runtime. cognition-api.ts
  //                  reads this header into CognitionApiError.runtimeId.
  //   x-request-id : the per-request id (request.id, logged as reqId) for
  //                  correlating a single UI-visible error with its log line.
  // Cheap, safe, no payload impact.
  app.addHook("onSend", async (request, reply, payload) => {
    if (!reply.getHeader("x-runtime-id")) {
      reply.header("x-runtime-id", RUNTIME_INSTANCE_ID);
    }
    if (!reply.getHeader("x-request-id")) {
      reply.header("x-request-id", request.id);
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

  // ── Self-serve onboarding (public POST /signup + admin /signups) ──────────
  await registerSignupRoutes(app, securityDb, {
    enabled: config.SIGNUP_ENABLED ?? false,
    open: config.SIGNUP_OPEN ?? false,
    inviteCodes: (config.SIGNUP_INVITE_CODES ?? "").split(",").map((c) => c.trim()).filter(Boolean),
    defaultPlan: config.SIGNUP_DEFAULT_PLAN ?? "starter",
    defaultRpm: config.SIGNUP_DEFAULT_RPM ?? 120
  });

  // ── Phase 2: Funnel analytics (cohorts, segments, compare, health, alerts) ─
  await registerFunnelAnalyticsRoutes(app, securityDb, {
    enabled: config.FUNNEL_ALERTS_ENABLED ?? DEFAULT_ALERT_CONFIG.enabled,
    minActivationRate: config.FUNNEL_ALERT_MIN_ACTIVATION_RATE ?? DEFAULT_ALERT_CONFIG.minActivationRate,
    activationWindowDays: config.FUNNEL_ALERT_ACTIVATION_WINDOW_DAYS ?? DEFAULT_ALERT_CONFIG.activationWindowDays,
    minSample: config.FUNNEL_ALERT_MIN_SAMPLE ?? DEFAULT_ALERT_CONFIG.minSample,
    maxSignupGapHours: config.FUNNEL_ALERT_MAX_SIGNUP_GAP_HOURS ?? DEFAULT_ALERT_CONFIG.maxSignupGapHours
  });

  return app;
}
