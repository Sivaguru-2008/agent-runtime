/**
 * Tenant isolation context — attached to every authenticated Fastify request.
 *
 * Production risk solved:
 *   Without tenant isolation, a single API key grants access to every agent,
 *   execution, and event in the system. A compromised key from one customer
 *   exposes all other customers' data (IDOR vulnerability).
 *
 * Isolation model:
 *   Application-layer isolation enforced at the route handler level via
 *   requireTenant() + tenant-scoped WHERE clauses. This is checked by the
 *   auth middleware before any handler runs, and enforced in repository calls
 *   by passing tenantId as a query parameter.
 *
 * Role hierarchy (operational chain, most → least privileged):
 *   owner > admin > operator > developer > viewer
 *   Each role on the chain inherits all permissions of the roles below it.
 *
 *   `auditor` is a SIDE role, not on the chain: a read-only compliance reviewer
 *   that can read the audit log / certifications / observability but holds no
 *   write capability. Its weight sits between viewer and developer so the
 *   weight-based requireRole() write gates correctly reject it; its broad reads
 *   are granted through the explicit permission matrix (see permissions.ts).
 *
 * For the named protected resources (replay, certifications, recovery,
 * execution, tool execution, tenant config) authorization is enforced through
 * the capability matrix in permissions.ts via requirePermission(), not the
 * coarse weight ladder. The ladder is retained for backward-compatible coarse
 * gating (hasRole / requireRole) of cluster/operator diagnostic routes.
 */

export type ApiKeyRole =
  | "owner"
  | "admin"
  | "operator"
  | "developer"
  | "auditor"
  | "viewer";

/**
 * Legacy role label retained only at the trust boundary. The pre-RBAC schema
 * used "readonly"; it is normalized to "viewer" on read so stale API-key rows
 * or cached entries keep working until migration 0026 rewrites them.
 */
export function normalizeRole(role: string): ApiKeyRole {
  if (role === "readonly") return "viewer";
  return role as ApiKeyRole;
}

export interface TenantContext {
  tenantId: string;
  apiKeyId: string;
  role: ApiKeyRole;
  rateLimitRpm: number;
}

// Augment FastifyRequest so every handler has typed access to tenant context
// without unsafe casts. The field is optional because unauthenticated paths
// (e.g. /health) legitimately have no tenant.
declare module "fastify" {
  interface FastifyRequest {
    tenant?: TenantContext;
  }
}

/**
 * Coarse privilege weight for the operational chain. Used only by the
 * weight-based hasRole()/requireRole() gates. `auditor` sits between viewer and
 * developer: high enough to pass nothing that grants writes, low enough that
 * every write/operator gate rejects it. Fine-grained authorization for the
 * named protected resources uses the capability matrix (permissions.ts).
 */
export const ROLE_WEIGHT: Record<ApiKeyRole, number> = {
  owner: 60,
  admin: 50,
  operator: 40,
  developer: 30,
  auditor: 20,
  viewer: 10
};

/** Returns true if ctx.role is at least as privileged as `required` (weight ladder). */
export function hasRole(ctx: TenantContext, required: ApiKeyRole): boolean {
  return ROLE_WEIGHT[ctx.role] >= ROLE_WEIGHT[required];
}

/**
 * Roles permitted to operate ACROSS tenant boundaries (platform tooling).
 * Owner and admin only — every per-resource ownership check defers to this so
 * adding `owner` did not silently downgrade it to a tenant-scoped role.
 */
export function canAccessAllTenants(role: ApiKeyRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Assert that the request carries a valid tenant context.
 * Throws if called from a code path that was not covered by the auth hook —
 * this is a programming bug, not a user error.
 */
export function requireTenant(request: { tenant?: TenantContext }): TenantContext {
  if (!request.tenant) {
    throw new Error("BUG: requireTenant() called on an unauthenticated request — route is missing auth hook coverage");
  }
  return request.tenant;
}

/**
 * Verify that the requesting tenant owns the resource.
 * Owners and admins are implicitly allowed cross-tenant access for platform tooling.
 */
export function assertSameTenant(ctx: TenantContext, resourceTenantId: string): void {
  if (canAccessAllTenants(ctx.role)) return;
  if (ctx.tenantId !== resourceTenantId) {
    const err = new Error("Cross-tenant access denied");
    (err as NodeJS.ErrnoException).code = "CROSS_TENANT_ACCESS";
    throw err;
  }
}
