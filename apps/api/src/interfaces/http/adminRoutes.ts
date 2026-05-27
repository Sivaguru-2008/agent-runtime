/**
 * Admin routes — API key management and tenant administration.
 *
 * These routes require the 'admin' role. They enable platform operators to:
 *   • Create, list, and revoke API keys per tenant
 *   • Manage tenant records and quota limits
 *   • Resolve dead-letter queue entries
 *
 * Production risk solved:
 *   Without management routes, API keys can only be created by running raw SQL
 *   against the database. This is error-prone, hard to audit, and impossible
 *   for self-service SaaS customers.
 *
 * Security:
 *   All routes under /admin require role='admin'. The raw key is returned
 *   only once on creation and is never stored — only its SHA-256 hash persists.
 *   Revocation takes effect within API_KEY_CACHE_TTL_SEC seconds (typically 5min).
 *
 * Audit trail:
 *   Each request through these routes is captured by the audit logger with
 *   action='admin.key_create', 'admin.key_revoke', etc.
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";
import { requireRole } from "../../infrastructure/security/rbac.js";
import { createId } from "../../shared/id.js";
import { PostgresDeadLetterStore } from "../../infrastructure/reliability/postgresDeadLetterStore.js";

const createKeySchema = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(1).max(255),
  role: z.enum(["admin", "operator", "developer", "readonly"]).default("developer"),
  rateLimitRpm: z.number().int().min(1).max(100_000).default(1_000),
  expiresAt: z.string().datetime().optional()
});

const createTenantSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, "Tenant ID must be lowercase alphanumeric with hyphens/underscores"),
  name: z.string().min(1).max(255),
  plan: z.enum(["starter", "growth", "enterprise"]).default("starter")
});

const updateQuotaSchema = z.object({
  maxExecutionsPerHour: z.number().int().min(1).optional(),
  maxEventsPerDay: z.number().int().min(1).optional(),
  maxConcurrentExecutions: z.number().int().min(1).optional(),
  maxAgents: z.number().int().min(1).optional(),
  storageLimitMb: z.number().int().min(1).optional()
});

function generateApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const rawKey = `sk_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawKey, "utf8").digest("hex");
  const keyPrefix = rawKey.slice(0, 16); // "sk_live_" + 8 chars
  return { rawKey, keyHash, keyPrefix };
}

// Paths that must always be reachable so operators get a deterministic
// 503 (with a clear reason) instead of an unexplained 404 when the API
// is running in degraded memory-only mode. Keep this list in sync with
// the route definitions below.
const ADMIN_ROUTE_REGISTRY: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; path: string }> = [
  { method: "POST", path: "/admin/tenants" },
  { method: "GET", path: "/admin/tenants" },
  { method: "PATCH", path: "/admin/tenants/:tenantId/quotas" },
  { method: "POST", path: "/admin/api-keys" },
  { method: "GET", path: "/admin/api-keys" },
  { method: "DELETE", path: "/admin/api-keys/:keyId" },
  { method: "GET", path: "/admin/dlq" },
  { method: "POST", path: "/admin/dlq/:executionId/resolve" },
  { method: "POST", path: "/admin/retention/archive-events" },
  { method: "POST", path: "/admin/retention/prune-audit-log" }
];

export async function registerAdminRoutes(app: FastifyInstance, db: PgClient | null): Promise<void> {
  if (!db) {
    // Admin routes require a Postgres-backed security DB. Rather than leaving
    // the routes unregistered (the legacy behaviour, which surfaced as opaque
    // 404s from the cognition workbench), we register every admin path as a
    // 503 stub so operators get an actionable error and route inventory stays
    // consistent across modes. Loud, not silent.
    app.log.warn(
      { degradedRoutes: ADMIN_ROUTE_REGISTRY.map((r) => `${r.method} ${r.path}`) },
      "[admin] DATABASE_URL not configured — admin routes registered in DEGRADED mode (503)"
    );
    const degradedHandler = async (_request: unknown, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
      return reply.status(503).send({
        error: "ADMIN_REQUIRES_DATABASE",
        message:
          "Admin endpoints require a Postgres-backed security database. The runtime " +
          "is operating in MEMORY fallback mode — set DATABASE_URL and restart to enable admin operations."
      });
    };
    for (const { method, path } of ADMIN_ROUTE_REGISTRY) {
      app.route({ method, url: path, handler: degradedHandler as never });
    }
    return;
  }

  const adminGuard = requireRole("admin");

  // ── Tenant management ────────────────────────────────────────────────────

  app.post("/admin/tenants", { preHandler: adminGuard }, async (request, reply) => {
    const body = createTenantSchema.parse(request.body);

    await db.withTransaction(async (tx) => {
      await tx.query(
        `insert into tenants (id, name, plan, created_at, updated_at)
         values ($1, $2, $3, now(), now())`,
        [body.id, body.name, body.plan]
      );
      // Create default quotas for the new tenant
      await tx.query(
        `insert into tenant_quotas (tenant_id, updated_at) values ($1, now())
         on conflict (tenant_id) do nothing`,
        [body.id]
      );
    });

    return reply.status(201).send({ id: body.id, name: body.name, plan: body.plan });
  });

  app.get("/admin/tenants", { preHandler: adminGuard }, async () => {
    const { rows } = await db.query<{
      id: string; name: string; plan: string; is_active: boolean; created_at: string;
    }>(
      `select id, name, plan, is_active, created_at
       from tenants order by created_at desc`
    );
    return rows;
  });

  app.patch("/admin/tenants/:tenantId/quotas", { preHandler: adminGuard }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const body = updateQuotaSchema.parse(request.body);

    const setClauses: string[] = ["updated_at = now()"];
    const values: unknown[] = [tenantId];

    if (body.maxExecutionsPerHour !== undefined) {
      values.push(body.maxExecutionsPerHour);
      setClauses.push(`max_executions_per_hour = $${values.length}`);
    }
    if (body.maxEventsPerDay !== undefined) {
      values.push(body.maxEventsPerDay);
      setClauses.push(`max_events_per_day = $${values.length}`);
    }
    if (body.maxConcurrentExecutions !== undefined) {
      values.push(body.maxConcurrentExecutions);
      setClauses.push(`max_concurrent_executions = $${values.length}`);
    }
    if (body.maxAgents !== undefined) {
      values.push(body.maxAgents);
      setClauses.push(`max_agents = $${values.length}`);
    }
    if (body.storageLimitMb !== undefined) {
      values.push(body.storageLimitMb);
      setClauses.push(`storage_limit_mb = $${values.length}`);
    }

    await db.query(
      `insert into tenant_quotas (tenant_id, updated_at)
       values ($1, now())
       on conflict (tenant_id) do update set ${setClauses.join(", ")}`,
      values
    );

    const { rows } = await db.query(
      "select * from tenant_quotas where tenant_id = $1",
      [tenantId]
    );
    return reply.status(200).send(rows[0] ?? {});
  });

  // ── API Key management ───────────────────────────────────────────────────

  app.post("/admin/api-keys", { preHandler: adminGuard }, async (request, reply) => {
    const body = createKeySchema.parse(request.body);
    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    const keyId = createId();

    await db.query(
      `insert into api_keys
         (id, tenant_id, name, key_hash, key_prefix, role, rate_limit_rpm, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [keyId, body.tenantId, body.name, keyHash, keyPrefix, body.role, body.rateLimitRpm, body.expiresAt ?? null]
    );

    // Return the raw key exactly once — it cannot be recovered after this response.
    return reply.status(201).send({
      id: keyId,
      tenantId: body.tenantId,
      name: body.name,
      role: body.role,
      keyPrefix,
      rawKey, // Show-once — store this securely
      createdAt: new Date().toISOString()
    });
  });

  app.get("/admin/api-keys", { preHandler: adminGuard }, async (request) => {
    const { tenantId } = request.query as { tenantId?: string };
    const { rows } = await db.query<{
      id: string; tenant_id: string; name: string; key_prefix: string;
      role: string; rate_limit_rpm: number; is_active: boolean;
      created_at: string; last_used_at: string | null; expires_at: string | null;
    }>(
      `select id, tenant_id, name, key_prefix, role, rate_limit_rpm,
              is_active, created_at, last_used_at, expires_at
       from api_keys
       where ($1::text is null or tenant_id = $1)
         and revoked_at is null
       order by created_at desc
       limit 500`,
      [tenantId ?? null]
    );
    return rows;
  });

  app.delete("/admin/api-keys/:keyId", { preHandler: adminGuard }, async (request, reply) => {
    const { keyId } = request.params as { keyId: string };
    await db.query(
      "update api_keys set revoked_at = now(), is_active = false where id = $1",
      [keyId]
    );
    // Note: Redis cache entry for this key expires naturally within cacheTtlSec.
    // For immediate revocation, call invalidateApiKeyCache() with the raw key
    // if you have it, or accept the up-to-5-minute propagation window.
    return reply.status(204).send();
  });

  // ── Dead-Letter Queue management ─────────────────────────────────────────

  app.get("/admin/dlq", { preHandler: requireRole("operator") }, async () => {
    const { rows } = await db.query<{
      execution_id: string; worker_id: string | null; tenant_id: string;
      attempt: number; error: unknown; moved_at: string; resolved_at: string | null;
    }>(
      `select execution_id, worker_id, tenant_id, attempt, error, moved_at, resolved_at
       from execution_dead_letters
       order by moved_at desc
       limit 200`
    );
    return rows;
  });

  app.post("/admin/dlq/:executionId/resolve", { preHandler: requireRole("operator") }, async (request, reply) => {
    const { executionId } = request.params as { executionId: string };
    const { resolution } = (request.body as { resolution?: string }) ?? {};
    
    const dlqStore = new PostgresDeadLetterStore(db);
    const operatorIdentity = request.tenant?.apiKeyId ?? "system";
    await dlqStore.resolve(executionId, resolution ?? "manually resolved", operatorIdentity);
    
    return reply.status(200).send({ executionId, resolved: true });
  });

  // ── Retention management ──────────────────────────────────────────────────

  app.post("/admin/retention/archive-events", { preHandler: adminGuard }, async (request, reply) => {
    const { olderThanDays = 90, batchSize = 10_000 } = (request.body as {
      olderThanDays?: number;
      batchSize?: number;
    }) ?? {};
    const { rows } = await db.query<{ archive_old_events: number }>(
      "select archive_old_events($1, null, $2) as archive_old_events",
      [olderThanDays, batchSize]
    );
    const archived = rows[0]?.archive_old_events ?? 0;
    return reply.status(200).send({ archived, olderThanDays, batchSize });
  });

  app.post("/admin/retention/prune-audit-log", { preHandler: adminGuard }, async (request, reply) => {
    const { olderThanDays = 365, batchSize = 50_000 } = (request.body as {
      olderThanDays?: number;
      batchSize?: number;
    }) ?? {};
    const { rows } = await db.query<{ prune_audit_log: number }>(
      "select prune_audit_log($1, $2) as prune_audit_log",
      [olderThanDays, batchSize]
    );
    const deleted = rows[0]?.prune_audit_log ?? 0;
    return reply.status(200).send({ deleted, olderThanDays, batchSize });
  });
}
