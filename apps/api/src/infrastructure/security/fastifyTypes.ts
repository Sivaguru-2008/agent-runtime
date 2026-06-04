/**
 * Fastify type augmentations for Phase 5 decorators.
 *
 * Importing this file in app.ts (or any entry point) merges these declarations
 * into the global Fastify namespace so all route handlers have typed access to
 * the Phase 5 decorators without unsafe casts.
 *
 * The actual decorator values are set in app.ts via app.decorate().
 */

import type { QuotaEnforcer } from "../quota/quotaEnforcer.js";
import type { TenantGuard } from "./tenantGuard.js";
import type { PgClient } from "../persistence/postgres/pgClient.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * The Postgres-backed security store (api keys, tenants, signups), or null
     * when the runtime is in MEMORY fallback mode. Decorated so request handlers
     * (e.g. the task-creation handler's fire-and-forget activation write) can
     * reach it without coupling to in-memory mode. Always present as a decorator;
     * the value is null when no DATABASE_URL is configured.
     */
    securityDb: PgClient | null;
    /**
     * Phase 5: Per-tenant quota enforcement.
     * Call checkExecutionStart() before creating an execution.
     * Call checkAgentCreation() before creating an agent.
     */
    quotaEnforcer: QuotaEnforcer;
    /**
     * Multi-tenant ownership resolver. Use its assertOwns* methods to guard
     * any route that accepts a resource ID from client input (agentId,
     * executionId, cognitionId, replaySessionId, …).
     */
    tenantGuard: TenantGuard;
  }
}
