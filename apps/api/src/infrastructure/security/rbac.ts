/**
 * Role-Based Access Control (RBAC) — Fastify preHandler hooks.
 *
 * Production risk solved:
 *   Without RBAC, any valid API key can drain workers, trigger manual
 *   recovery, capture determinism certifications, or read full operator
 *   diagnostics — operations that must be restricted to platform operators,
 *   admins, or compliance reviewers.
 *
 * Two enforcement styles, deliberately co-existing:
 *   • requirePermission(permission) — the PRIMARY guard. Capability-based,
 *     sourced from the permission matrix (permissions.ts). Used for the named
 *     protected resources (replay, certifications, recovery, execution, tool
 *     execution, tenant config) so least-privilege roles like `auditor` resolve
 *     correctly (broad read, zero write).
 *   • requireRole(minRole) — coarse weight-ladder gate retained for backward
 *     compatibility on cluster/operator diagnostic routes. Monotonic by role
 *     weight; see ROLE_WEIGHT in tenantContext.ts.
 *
 * Audit:
 *   Both guards stamp request.authz with the decision so the audit logger
 *   persists WHY a request was allowed or denied (the audit_log.metadata
 *   column). Denials are additionally surfaced as a structured warn-level log
 *   line immediately — the fire-and-forget audit write may lag, and a 403 on a
 *   protected resource is a security signal operators want in real time.
 *
 * Scaling implications:
 *   Both checks are pure in-memory comparisons (O(1)) after auth completes.
 *   No additional database queries are made per-request for authorization.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { ROLE_WEIGHT, canAccessAllTenants, type ApiKeyRole } from "./tenantContext.js";
import { hasPermission, type Permission } from "./permissions.js";

/** Emit a structured, real-time security signal for an authorization denial. */
function logDenial(
  request: FastifyRequest,
  fields: { actorRole?: ApiKeyRole; permission?: Permission; requiredRole?: ApiKeyRole; reason: string }
): void {
  request.log.warn(
    {
      security: "AUTHZ_DENY",
      requestId: request.id,
      method: request.method,
      url: request.url,
      tenantId: request.tenant?.tenantId,
      apiKeyId: request.tenant?.apiKeyId,
      ...fields
    },
    `[AUTHZ] denied ${request.method} ${request.url}: ${fields.reason}`
  );
}

/**
 * Returns a Fastify preHandler that rejects the request unless the
 * authenticated role holds `permission`. This is the production guard for the
 * named protected resources.
 *
 * Usage:
 *   app.post("/cluster/recover", { preHandler: requirePermission("recovery:execute") }, handler);
 */
export function requirePermission(permission: Permission) {
  return async function permissionGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const tenant = request.tenant;
    if (!tenant) {
      request.authz = { decision: "DENY", permission };
      logDenial(request, { permission, reason: "unauthenticated" });
      return reply.status(401).send({ error: "UNAUTHORIZED", message: "Authentication required" });
    }
    if (!hasPermission(tenant.role, permission)) {
      request.authz = { decision: "DENY", permission, actorRole: tenant.role };
      logDenial(request, { actorRole: tenant.role, permission, reason: "missing permission" });
      return reply.status(403).send({
        error: "FORBIDDEN",
        message: `Permission '${permission}' is required; role '${tenant.role}' does not hold it`
      });
    }
    request.authz = { decision: "ALLOW", permission, actorRole: tenant.role };
  };
}

/**
 * Returns a Fastify preHandler that rejects the request unless the
 * authenticated role is at least as privileged as `minRole` on the weight
 * ladder. Retained for coarse gating of operator/cluster diagnostic routes.
 *
 * Usage:
 *   app.get("/cluster/overview", { preHandler: requireRole("operator") }, handler);
 */
export function requireRole(minRole: ApiKeyRole) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const tenant = request.tenant;
    if (!tenant) {
      request.authz = { decision: "DENY", requiredRole: minRole };
      logDenial(request, { requiredRole: minRole, reason: "unauthenticated" });
      return reply.status(401).send({ error: "UNAUTHORIZED", message: "Authentication required" });
    }
    if (ROLE_WEIGHT[tenant.role] < ROLE_WEIGHT[minRole]) {
      request.authz = { decision: "DENY", requiredRole: minRole, actorRole: tenant.role };
      logDenial(request, { actorRole: tenant.role, requiredRole: minRole, reason: "insufficient role" });
      return reply.status(403).send({
        error: "FORBIDDEN",
        message: `Role '${tenant.role}' insufficient — '${minRole}' or higher required`
      });
    }
    request.authz = { decision: "ALLOW", requiredRole: minRole, actorRole: tenant.role };
  };
}

/**
 * Returns a preHandler that enforces the requesting tenant owns the resource
 * identified by `getTenantId`. Owners and admins bypass the check (cross-tenant
 * platform tooling).
 *
 * Usage:
 *   app.get("/agents/:agentId", {
 *     preHandler: requireSameTenant(req => getAgentTenantId(req.params.agentId))
 *   }, handler);
 */
export function requireSameTenant(getTenantId: (request: FastifyRequest) => Promise<string | undefined>) {
  return async function tenantGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const tenant = request.tenant;
    if (!tenant) {
      return reply.status(401).send({ error: "UNAUTHORIZED", message: "Authentication required" });
    }
    if (canAccessAllTenants(tenant.role)) return; // Owner/admin may cross tenants for platform tooling

    const resourceTenantId = await getTenantId(request);
    if (resourceTenantId && resourceTenantId !== tenant.tenantId) {
      logDenial(request, { actorRole: tenant.role, reason: "cross-tenant access" });
      return reply.status(403).send({
        error: "FORBIDDEN",
        message: "Cross-tenant access denied"
      });
    }
  };
}
