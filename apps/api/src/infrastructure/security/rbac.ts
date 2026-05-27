/**
 * Role-Based Access Control (RBAC) — Fastify preHandler hooks.
 *
 * Production risk solved:
 *   Without RBAC, any valid API key can drain workers, trigger manual
 *   recovery, or read full operator diagnostics — operations that should
 *   be restricted to platform operators or admins.
 *
 * Role matrix:
 *   readonly   — GET reads on agents, executions, events, observability
 *   developer  — readonly + create agents, run tasks, manage memory
 *   operator   — developer + cluster management (drain, stop, recover)
 *   admin      — operator + key management, tenant admin, DLQ resolution
 *
 * Scaling implications:
 *   Role checks are pure in-memory comparisons (O(1)) after auth completes.
 *   No additional database queries are made per-request for authorization.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import type { ApiKeyRole } from "./tenantContext.js";

const ROLE_WEIGHT: Record<ApiKeyRole, number> = {
  admin: 40,
  operator: 30,
  developer: 20,
  readonly: 10
};

/**
 * Returns a Fastify preHandler that rejects the request unless the
 * authenticated role is at least as privileged as `minRole`.
 *
 * Usage in route registration:
 *   app.post("/cluster/recover", { preHandler: requireRole("operator") }, handler);
 */
export function requireRole(minRole: ApiKeyRole) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const tenant = request.tenant;
    if (!tenant) {
      return reply.status(401).send({
        error: "UNAUTHORIZED",
        message: "Authentication required"
      });
    }
    if (ROLE_WEIGHT[tenant.role] < ROLE_WEIGHT[minRole]) {
      return reply.status(403).send({
        error: "FORBIDDEN",
        message: `Role '${tenant.role}' insufficient — '${minRole}' or higher required`
      });
    }
  };
}

/**
 * Returns a preHandler that enforces the requesting tenant owns the resource
 * identified by `getTenantId`. Admins bypass the check (cross-tenant tooling).
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
    if (tenant.role === "admin") return; // Admins may cross tenants for operator tooling

    const resourceTenantId = await getTenantId(request);
    if (resourceTenantId && resourceTenantId !== tenant.tenantId) {
      return reply.status(403).send({
        error: "FORBIDDEN",
        message: "Cross-tenant access denied"
      });
    }
  };
}
