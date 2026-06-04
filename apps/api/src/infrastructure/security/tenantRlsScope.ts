/**
 * Tenant RLS session-scope helper.
 *
 * The wiring primitive for the Row-Level Security policies installed by
 * migration 0024_tenant_rls.sql. It runs `fn` inside a transaction that has the
 * session tenant (and optional admin bypass) set as transaction-local GUCs, so
 * every statement issued through the supplied `tx` is filtered by the database
 * to the caller's tenant — defense in depth beneath the application-layer
 * TenantGuard.
 *
 * `set_config(name, value, true)` sets the GUC LOCAL to the surrounding
 * transaction; it is reset automatically at COMMIT/ROLLBACK, so a pooled
 * connection never leaks one request's tenant into the next.
 *
 * Usage (recommended for tenant-scoped repository writes/reads):
 *
 *   await withTenantRlsScope(db, ctx, async (tx) => {
 *     return tx.query("select * from executions where id = $1", [id]);
 *   });
 *
 * Admins resolve with `bypass: true`, mirroring TenantGuard's admin cross-tenant
 * bypass — the RLS policy then permits cross-tenant rows.
 *
 * This helper is intentionally standalone (not yet threaded through every query
 * path) so it can be adopted incrementally; see docs/specs/multi-tenant-rls.md
 * for the rollout plan. Until then RLS runs in its non-breaking "transparent
 * when unset" mode and this helper is the on-ramp to full enforcement.
 */

import type { PgClient } from "../persistence/postgres/pgClient.js";
import { canAccessAllTenants, type TenantContext } from "./tenantContext.js";

export interface TenantScope {
  tenantId: string;
  /** When true, set app.bypass_rls=on (admin cross-tenant tooling). */
  bypass?: boolean;
}

/** Derive an RLS scope from a request's TenantContext. Owners/admins bypass. */
export function scopeFromContext(ctx: TenantContext): TenantScope {
  return { tenantId: ctx.tenantId, bypass: canAccessAllTenants(ctx.role) };
}

export async function withTenantRlsScope<T>(
  db: PgClient,
  scope: TenantScope | TenantContext,
  fn: (tx: PgClient) => Promise<T>
): Promise<T> {
  const resolved: TenantScope =
    "role" in scope ? scopeFromContext(scope) : scope;

  return db.withTransaction(async (tx) => {
    // Transaction-local: auto-reset at COMMIT/ROLLBACK, pool-safe.
    await tx.query("select set_config('app.current_tenant', $1, true)", [resolved.tenantId]);
    if (resolved.bypass) {
      await tx.query("select set_config('app.bypass_rls', 'on', true)");
    }
    return fn(tx);
  });
}

/**
 * System/background scope — sets `app.bypass_rls=on` for the transaction.
 *
 * The cross-tenant background paths (recovery loop, outbox dispatcher, DLQ
 * remediation, migration runner) legitimately operate over EVERY tenant's rows
 * in a single sweep: a per-tenant recovery loop would be wrong, and the outbox
 * dispatcher's claim CTE must see all pending side effects regardless of
 * tenant. Those paths do not carry a request-scoped TenantContext.
 *
 * This helper is the explicit, audited bypass for exactly those paths and is
 * the on-ramp to STRICT RLS (docs/specs/tenant-scope-rollout.md): once the
 * background paths wrap their writes in `withSystemRlsScope` and the request
 * paths in `withTenantRlsScope`, every connection sets one of the two GUCs, so
 * the deny-by-default STRICT policy can be flipped without stranding the
 * system writers. Until STRICT is flipped this is a no-op behaviourally (RLS is
 * transparent-when-unset), so adopting it early is non-breaking.
 *
 * Per-transaction `set_config(..., true)` resets at COMMIT/ROLLBACK, so a
 * pooled connection never leaks the bypass into the next request.
 */
export async function withSystemRlsScope<T>(
  db: PgClient,
  fn: (tx: PgClient) => Promise<T>
): Promise<T> {
  return db.withTransaction(async (tx) => {
    await tx.query("select set_config('app.bypass_rls', 'on', true)");
    return fn(tx);
  });
}
