/**
 * API Key Authentication — Fastify plugin.
 *
 * Production risk solved:
 *   All API endpoints are publicly reachable without this plugin. A single
 *   compromised network path (misconfigured ALB, SSRF, internal service
 *   misconfiguration) exposes every agent, execution, and runtime secret.
 *
 * Security design:
 *   • SHA-256 hash of the raw key is the lookup token — hash is never the key.
 *   • Redis caches validated key→tenant mappings with a configurable TTL
 *     (default 5 minutes) to eliminate per-request Postgres queries.
 *   • Cache invalidation on revocation happens via cache key deletion after
 *     the revocation write. Keys live in Redis for up to TTL after revocation,
 *     an intentional tradeoff (strong consistency requires distributed locks).
 *   • last_used_at update is fire-and-forget to avoid blocking the response.
 *
 * Operational tradeoffs:
 *   Redis unavailability causes auth to fall back to Postgres — latency rises
 *   but service remains available. If both Redis and Postgres are unavailable,
 *   auth fails closed (401) to prevent unauthenticated access under degraded
 *   infrastructure.
 *
 * Skip paths:
 *   /health is always unauthenticated for load-balancer probes. Additional
 *   paths can be configured via AUTH_SKIP_PATHS for Prometheus scrapers etc.
 */

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Redis } from "ioredis";
import type { PgClient } from "../persistence/postgres/pgClient.js";
import { normalizeRole, type TenantContext, type ApiKeyRole } from "./tenantContext.js";

export interface ApiKeyAuthOptions {
  redis: Redis | null;
  db: PgClient;
  skipPaths: string[];
  cacheTtlSec: number;
  enabled: boolean;
  /**
   * Strict environment (production / STRICT_PROD). When true, auth MUST be
   * enabled — registering with `enabled:false` throws rather than installing
   * the unauthenticated fallback. Defense in depth: loadConfig already rejects
   * this combination, but the plugin refuses independently so no boot path can
   * ever install the fallback in a strict environment.
   */
  strict: boolean;
  /**
   * Role granted to the synthetic tenant when auth is disabled (dev/test only).
   * Defaults to the least-privileged useful role. NEVER "admin" implicitly —
   * the previous behaviour silently granted admin to every caller.
   */
  disabledFallbackRole: ApiKeyRole;
}

interface CachedKeyData {
  id: string;
  tenantId: string;
  role: ApiKeyRole;
  rateLimitRpm: number;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function extractRawKey(request: FastifyRequest): string | undefined {
  const xApiKey = request.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.length > 0) return xApiKey;

  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    if (token.length > 0) return token;
  }
  return undefined;
}

function isSkippedPath(url: string, skipPaths: string[]): boolean {
  const path = url.split("?")[0]!;
  return skipPaths.some((p) => path === p || path.startsWith(p + "/"));
}

async function lookupFromRedis(redis: Redis, hash: string): Promise<CachedKeyData | null> {
  try {
    const hit = await redis.get(`apk:${hash}`);
    if (hit) return JSON.parse(hit) as CachedKeyData;
  } catch {
    // Redis failure is non-fatal — fall through to Postgres
  }
  return null;
}

async function lookupFromPostgres(
  db: PgClient,
  hash: string
): Promise<CachedKeyData | null> {
  const { rows } = await db.query<{
    id: string;
    tenant_id: string;
    role: ApiKeyRole;
    rate_limit_rpm: number;
  }>(
    `select ak.id, ak.tenant_id, ak.role, ak.rate_limit_rpm
     from api_keys ak
     join tenants t on t.id = ak.tenant_id
     where ak.key_hash = $1
       and ak.is_active = true
       and t.is_active = true
       and (ak.expires_at is null or ak.expires_at > now())
       and ak.revoked_at is null`,
    [hash]
  );
  if (!rows.length) return null;
  const row = rows[0]!;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    // Normalize the legacy "readonly" label to "viewer" so any pre-migration
    // key row keeps authenticating with the equivalent capability set.
    role: normalizeRole(row.role),
    rateLimitRpm: row.rate_limit_rpm
  };
}

async function populateRedisCache(redis: Redis | null, hash: string, data: CachedKeyData, ttlSec: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.setex(`apk:${hash}`, ttlSec, JSON.stringify(data));
  } catch {
    // Non-fatal: cache population failure just means next request hits Postgres
  }
}

function updateLastUsed(db: PgClient, keyId: string): void {
  // Fire-and-forget: never block the request path for a housekeeping write.
  db.query("update api_keys set last_used_at = now() where id = $1", [keyId]).catch(() => undefined);
}

export async function registerApiKeyAuth(
  app: FastifyInstance,
  opts: ApiKeyAuthOptions
): Promise<void> {
  if (!opts.enabled) {
    // Defense in depth: a strict environment must NEVER install the
    // unauthenticated fallback. loadConfig already rejects this combination;
    // refusing here too means no alternate boot path (a future refactor, a
    // direct buildApp caller, a test misconfiguration) can punch the hole.
    if (opts.strict) {
      throw new Error(
        "[security] Refusing to register auth plugin with AUTH_ENABLED=false in a " +
          "strict environment (production / STRICT_PROD). Unauthenticated endpoints " +
          "are not acceptable in production."
      );
    }

    // Auth disabled (dev/test only). Inject a synthetic tenant so downstream
    // guards (tenant ownership, role checks) behave consistently — but with the
    // configured fallback role, NOT admin. The pre-hardening code granted
    // "admin" + unlimited rate to every unauthenticated caller; that
    // privilege-escalation fallback is removed. Operators who need the
    // operator/admin dashboard in a local unauthenticated run must opt in
    // explicitly via AUTH_DISABLED_FALLBACK_ROLE.
    app.log.warn(
      { fallbackRole: opts.disabledFallbackRole },
      "API key authentication is DISABLED — all endpoints are publicly accessible with the fallback role"
    );
    app.addHook("onRequest", async (request: FastifyRequest) => {
      if (request.tenant) return;
      request.tenant = {
        tenantId: "system",
        apiKeyId: "auth-disabled",
        role: opts.disabledFallbackRole,
        rateLimitRpm: 100_000
      };
    });
    return;
  }

  // Always include /health, /live, and /ready in the skip list regardless of
  // config — Kubernetes liveness/readiness probes do not present credentials.
  const skipPaths = Array.from(new Set(["/health", "/live", "/ready", ...opts.skipPaths]));

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isSkippedPath(request.url, skipPaths)) return;

    const rawKey = extractRawKey(request);
    if (!rawKey) {
      return reply.status(401).send({
        error: "UNAUTHORIZED",
        message: "API key required. Provide via X-Api-Key header or Authorization: Bearer <key>"
      });
    }

    const hash = sha256(rawKey);

    // 1. Redis cache hit — fast path (~1 ms)
    let keyData = opts.redis ? await lookupFromRedis(opts.redis, hash) : null;

    // 2. Postgres fallback — cache miss or Redis unavailable (~5-20 ms)
    if (!keyData) {
      try {
        keyData = await lookupFromPostgres(opts.db, hash);
      } catch (err) {
        // Database failure: fail closed to prevent unauthenticated access
        app.log.error({ err }, "Auth database lookup failed — rejecting request");
        return reply.status(503).send({
          error: "SERVICE_UNAVAILABLE",
          message: "Authentication service temporarily unavailable"
        });
      }

      if (!keyData) {
        return reply.status(401).send({
          error: "UNAUTHORIZED",
          message: "Invalid, revoked, or expired API key"
        });
      }

      // Populate cache for next request and update usage timestamp
      void populateRedisCache(opts.redis, hash, keyData, opts.cacheTtlSec);
      updateLastUsed(opts.db, keyData.id);
    }

    const tenant: TenantContext = {
      tenantId: keyData.tenantId,
      apiKeyId: keyData.id,
      // Normalize again at the construction boundary: a Redis entry cached
      // before the migration may still carry the legacy "readonly" label.
      role: normalizeRole(keyData.role),
      rateLimitRpm: keyData.rateLimitRpm
    };
    request.tenant = tenant;
  });
}

/**
 * Invalidate the Redis cache entry for a key hash. Call after revocation
 * so the next request forces a Postgres re-validation within the TTL window.
 */
export async function invalidateApiKeyCache(redis: Redis, rawKey: string): Promise<void> {
  const hash = sha256(rawKey);
  try {
    await redis.del(`apk:${hash}`);
  } catch {
    // Non-fatal: key will expire naturally
  }
}
