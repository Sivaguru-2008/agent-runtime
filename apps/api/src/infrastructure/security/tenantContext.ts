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
 * Role hierarchy:
 *   admin > operator > developer > readonly
 *   Each role inherits all permissions of roles below it.
 */

export type ApiKeyRole = "admin" | "operator" | "developer" | "readonly";

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

const ROLE_WEIGHT: Record<ApiKeyRole, number> = {
  admin: 40,
  operator: 30,
  developer: 20,
  readonly: 10
};

/** Returns true if ctx.role is at least as privileged as `required`. */
export function hasRole(ctx: TenantContext, required: ApiKeyRole): boolean {
  return ROLE_WEIGHT[ctx.role] >= ROLE_WEIGHT[required];
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
 * Admins are implicitly allowed cross-tenant access for operator tooling.
 */
export function assertSameTenant(ctx: TenantContext, resourceTenantId: string): void {
  if (ctx.role === "admin") return;
  if (ctx.tenantId !== resourceTenantId) {
    const err = new Error("Cross-tenant access denied");
    (err as NodeJS.ErrnoException).code = "CROSS_TENANT_ACCESS";
    throw err;
  }
}
