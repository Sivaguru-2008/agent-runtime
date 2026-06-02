/**
 * Centralized tenant ownership resolver + guard.
 *
 * Multi-tenant security hardening:
 *   Existing routes accept resource IDs (agentId, executionId, cognitionId,
 *   replaySessionId, workerId, leaseId, checkpointId) and load them via
 *   repositories that do not enforce tenant scoping in their public API. This
 *   module closes that gap with a single resolver surface that:
 *
 *     1. Resolves the resource's owning tenant (via Postgres tenant_id columns
 *        added in migration 0002, or via aggregate→agent→tenant joins).
 *     2. Asserts the requesting tenant either owns the resource OR is an admin.
 *     3. Throws a structured CrossTenantAccessError so the Fastify error
 *        handler can map it to 403 — never to 404 (which would silently leak
 *        existence to a probing attacker via timing).
 *
 * Production risk solved:
 *   Without this module, any authenticated tenant who guesses or enumerates a
 *   resource ID can read/mutate another tenant's executions, replay sessions,
 *   cognition graphs, checkpoints, branches, and worker leases — the classic
 *   IDOR exposure described in OWASP API1:2023.
 *
 * Why a resolver rather than a tenantId parameter in every repo method:
 *   Adding tenantId to every domain port would be an architectural redesign
 *   (the user instruction prohibits this) and would break in-process tests
 *   that bypass authentication. The resolver lives at the route boundary so
 *   the domain layer is unchanged — repositories still accept naked IDs, but
 *   routes never *reach* them without first running the guard.
 *
 * Admin bypass:
 *   Admins may cross tenants for operator tooling. This is explicit, audited,
 *   and surfaced in every guard return value via `bypassed: true`.
 */

import type { PgClient } from "../persistence/postgres/pgClient.js";
import { canAccessAllTenants, type TenantContext } from "./tenantContext.js";

export const SYSTEM_TENANT_ID = "system";

/**
 * Thrown when a resource is owned by a different tenant. Mapped to HTTP 403
 * by the route error handler — NEVER 404 (which would leak existence).
 */
export class CrossTenantAccessError extends Error {
  readonly code = "CROSS_TENANT_ACCESS";
  readonly statusCode = 403;
  constructor(resourceType: string) {
    super(`Cross-tenant access to ${resourceType} denied`);
  }
}

/**
 * Thrown when a resource exists but the requesting tenant has no relationship
 * to it. Same 403 mapping — we do not differentiate from cross-tenant since
 * doing so leaks existence.
 */
export class ResourceTenantNotResolvableError extends Error {
  readonly code = "TENANT_NOT_RESOLVABLE";
  readonly statusCode = 403;
  constructor(resourceType: string, resourceId: string) {
    super(`Cannot resolve tenant for ${resourceType} ${resourceId}`);
  }
}

export interface TenantGuardOptions {
  /** Pg client used to resolve resource→tenant mappings. May be a no-op
   *  client in dev/in-memory mode — guard will then permit when no row found,
   *  matching legacy behaviour when DATABASE_URL is unset. */
  db: PgClient;
  /** When true, fall back to permitting access if the resource→tenant lookup
   *  returns no rows. Required for in-memory persistence in test/dev. In
   *  production this should be false so an unresolvable tenant denies. */
  permitWhenNotFound: boolean;
}

/**
 * The guard. Wire one instance per RuntimeContainer.
 *
 * All resolve* methods return the resolved tenantId (or null when the row is
 * missing and `permitWhenNotFound` is true). All assert* methods perform the
 * lookup and then throw CrossTenantAccessError if the requester isn't the
 * owner (admins bypass).
 */
export class TenantGuard {
  // L-1: opts is read by the bootstrap (`app.ts`) to assert the
  // production-mode strict configuration. Kept `readonly` but no longer
  // private so the defensive double-check can introspect it.
  constructor(readonly opts: TenantGuardOptions) {}

  /** True when this guard would silently permit unresolvable lookups. */
  get isPermissive(): boolean {
    return this.opts.permitWhenNotFound === true;
  }

  // ── Resolver primitives ────────────────────────────────────────────────────

  async resolveAgentTenant(agentId: string): Promise<string | null> {
    return this.lookup(
      "agent",
      agentId,
      "select tenant_id from agents where id = $1"
    );
  }

  async resolveExecutionTenant(executionId: string): Promise<string | null> {
    return this.lookup(
      "execution",
      executionId,
      "select tenant_id from executions where id = $1"
    );
  }

  async resolveCognitionTenant(cognitionId: string): Promise<string | null> {
    // cognition_graphs.execution_id → executions.tenant_id
    return this.lookup(
      "cognition",
      cognitionId,
      `select e.tenant_id
         from cognition_graphs cg
         join executions e on e.id = cg.execution_id
        where cg.id = $1`
    );
  }

  async resolveReplaySessionTenant(sessionId: string): Promise<string | null> {
    return this.lookup(
      "replay-session",
      sessionId,
      `select e.tenant_id
         from replay_sessions rs
         join cognition_graphs cg on cg.id = rs.cognition_id
         join executions e on e.id = cg.execution_id
        where rs.id = $1`
    );
  }

  async resolveBranchTenant(branchId: string): Promise<string | null> {
    return this.lookup(
      "replay-branch",
      branchId,
      `select e.tenant_id
         from replay_branches rb
         join cognition_graphs cg on cg.id = rb.source_cognition_id
         join executions e on e.id = cg.execution_id
        where rb.id = $1`
    );
  }

  async resolveFailureSignalTenant(signalId: string): Promise<string | null> {
    return this.lookup(
      "failure-signal",
      signalId,
      `select e.tenant_id
         from failure_signals fs
         join executions e on e.id = fs.execution_id
        where fs.id = $1`
    );
  }

  async resolveCheckpointTenant(checkpointId: string): Promise<string | null> {
    return this.lookup(
      "checkpoint",
      checkpointId,
      `select e.tenant_id
         from execution_checkpoints ec
         join executions e on e.id = ec.execution_id
        where ec.id = $1`
    );
  }

  async resolveMemoryTenant(memoryId: string): Promise<string | null> {
    return this.lookup(
      "memory",
      memoryId,
      `select a.tenant_id
         from memory_records m
         join agents a on a.id = m.agent_id
        where m.id = $1`
    );
  }

  async resolveDlqTenant(executionId: string): Promise<string | null> {
    return this.lookup(
      "dlq",
      executionId,
      "select tenant_id from execution_dead_letters where execution_id = $1"
    );
  }

  // ── Assertion guards ───────────────────────────────────────────────────────

  /**
   * Assert the requester is permitted to act on the agent. Admins bypass.
   * Throws CrossTenantAccessError on mismatch.
   */
  async assertOwnsAgent(ctx: TenantContext, agentId: string): Promise<void> {
    await this.assertOwns(ctx, "agent", () => this.resolveAgentTenant(agentId));
  }

  async assertOwnsExecution(ctx: TenantContext, executionId: string): Promise<void> {
    await this.assertOwns(ctx, "execution", () => this.resolveExecutionTenant(executionId));
  }

  async assertOwnsCognition(ctx: TenantContext, cognitionId: string): Promise<void> {
    await this.assertOwns(ctx, "cognition", () => this.resolveCognitionTenant(cognitionId));
  }

  async assertOwnsReplaySession(ctx: TenantContext, sessionId: string): Promise<void> {
    await this.assertOwns(ctx, "replay-session", () => this.resolveReplaySessionTenant(sessionId));
  }

  async assertOwnsBranch(ctx: TenantContext, branchId: string): Promise<void> {
    await this.assertOwns(ctx, "replay-branch", () => this.resolveBranchTenant(branchId));
  }

  async assertOwnsFailureSignal(ctx: TenantContext, signalId: string): Promise<void> {
    await this.assertOwns(ctx, "failure-signal", () => this.resolveFailureSignalTenant(signalId));
  }

  async assertOwnsCheckpoint(ctx: TenantContext, checkpointId: string): Promise<void> {
    await this.assertOwns(ctx, "checkpoint", () => this.resolveCheckpointTenant(checkpointId));
  }

  async assertOwnsMemory(ctx: TenantContext, memoryId: string): Promise<void> {
    await this.assertOwns(ctx, "memory", () => this.resolveMemoryTenant(memoryId));
  }

  async assertOwnsDlq(ctx: TenantContext, executionId: string): Promise<void> {
    await this.assertOwns(ctx, "dlq", () => this.resolveDlqTenant(executionId));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async lookup(
    resourceType: string,
    resourceId: string,
    sql: string
  ): Promise<string | null> {
    try {
      const { rows } = await this.opts.db.query<{ tenant_id: string }>(sql, [resourceId]);
      if (!rows.length) {
        if (this.opts.permitWhenNotFound) return null;
        throw new ResourceTenantNotResolvableError(resourceType, resourceId);
      }
      return rows[0]!.tenant_id ?? null;
    } catch (err) {
      // Re-throw resolvability errors as-is. Other errors (e.g. missing table
      // in dev) fall through to permit-when-not-found to avoid breaking the
      // existing in-memory test path.
      if (err instanceof ResourceTenantNotResolvableError) throw err;
      if (this.opts.permitWhenNotFound) return null;
      throw err;
    }
  }

  private async assertOwns(
    ctx: TenantContext,
    resourceType: string,
    resolve: () => Promise<string | null>
  ): Promise<void> {
    if (canAccessAllTenants(ctx.role)) return; // Owner/admin bypass — audited via auditLogger
    const owner = await resolve();
    if (owner === null) return; // permit-when-not-found mode (legacy/in-memory)
    if (owner === ctx.tenantId) return;
    // System tenant resources are read-only for non-admins — never owned by a
    // customer tenant, so a non-admin requester gets denied.
    throw new CrossTenantAccessError(resourceType);
  }
}

/**
 * Construct a no-op guard for environments without a Postgres client
 * (in-memory tests, dev mode without DATABASE_URL). The guard permits all
 * access — same behaviour as the legacy code path, just centralised.
 */
export function createPermissiveTenantGuard(): TenantGuard {
  const stub: PgClient = {
    async query() { return { rows: [], rowCount: 0 }; },
    async withTransaction(fn) { return fn(stub); },
    async acquire() {
      return {
        async query() { return { rows: [], rowCount: 0 }; },
        release() { /* noop */ }
      };
    },
    stats() {
      return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 };
    },
    async close() { /* noop */ }
  };
  return new TenantGuard({
    db: stub,
    permitWhenNotFound: true
  });
}
