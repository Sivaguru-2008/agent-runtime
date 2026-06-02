/**
 * Permission model — the authoritative capability matrix for RBAC.
 *
 * Production risk solved:
 *   A pure role-weight ladder (admin > operator > developer > readonly) cannot
 *   express a *compliance* role. An auditor needs BROADER read access than a
 *   developer (audit log, certifications, cross-tenant observability) while
 *   holding ZERO write capability. On a linear ladder that role is impossible:
 *   any weight high enough to read the audit log also unlocks writes. This
 *   module replaces the ladder, for the protected resources, with an explicit
 *   capability set per role so least-privilege is encoded directly.
 *
 * Design:
 *   • Every protected action maps to a {@link Permission} (resource:action).
 *   • Each role is granted an explicit Set<Permission>, composed by INHERITANCE
 *     along the operational chain (viewer ⊂ developer ⊂ operator ⊂ admin ⊂
 *     owner) plus a side role (auditor = viewer + read-only compliance perms).
 *   • {@link hasPermission} is an O(1) Set lookup — no DB round-trip per request.
 *
 * Inheritance + least privilege (the two explicit requirements):
 *   - Inheritance: a higher operational role is a strict SUPERSET of the one
 *     below it. {@link ROLE_PERMISSIONS} is built by union so a permission added
 *     to `developer` automatically flows up to operator/admin/owner.
 *   - Least privilege: `auditor` is deliberately NOT on the operational chain.
 *     It can read everything a compliance reviewer needs and write NOTHING.
 *     `viewer` is the floor: read-only on its own tenant's product surfaces.
 *
 * Six canonical roles (most → least privileged on the operational chain):
 *   owner     — full control incl. tenant lifecycle + key minting at any level.
 *   admin     — tenant configuration, API-key management, all operator powers.
 *   operator  — recovery + cluster + execution controls, certification capture.
 *   developer — create agents, run tasks, replay/branch, tool execution.
 *   auditor   — read-only compliance: audit log, certifications, observability.
 *   viewer    — minimal read of the caller's own agents/executions/replays.
 */

import type { ApiKeyRole } from "./tenantContext.js";

/**
 * A capability, named `<resource>:<action>`. Adding a value here is the ONLY
 * way to introduce a new protected action — `requirePermission()` accepts a
 * `Permission`, so an unmapped string cannot accidentally guard a route.
 */
export type Permission =
  // Product surfaces
  | "agent:read"
  | "agent:write"
  | "execution:read"
  | "execution:write"
  // Replay / time-travel
  | "replay:read"
  | "replay:write"
  // Determinism certifications
  | "certification:read"
  | "certification:write"
  // Cluster recovery / break-glass controls
  | "recovery:execute"
  // Tool / code execution
  | "tool:execute"
  // Operator observability dashboards
  | "observability:read"
  // Tenant configuration & lifecycle
  | "tenant:read"
  | "tenant:configure"
  | "tenant:admin"
  // Compliance
  | "audit:read"
  // Credential management
  | "apikey:manage";

/** Every permission, for exhaustive iteration (docs, tests, owner grant). */
export const ALL_PERMISSIONS: readonly Permission[] = [
  "agent:read",
  "agent:write",
  "execution:read",
  "execution:write",
  "replay:read",
  "replay:write",
  "certification:read",
  "certification:write",
  "recovery:execute",
  "tool:execute",
  "observability:read",
  "tenant:read",
  "tenant:configure",
  "tenant:admin",
  "audit:read",
  "apikey:manage"
] as const;

// ── Base grant sets ─────────────────────────────────────────────────────────
// Declared as plain arrays and composed below so the inheritance relationships
// are explicit and auditable in one place.

const VIEWER: Permission[] = ["agent:read", "execution:read", "replay:read"];

// Developer extends the viewer floor with the write/execute capabilities a
// builder needs — plus certification:read so they can inspect the determinism
// baseline of their own replays.
const DEVELOPER: Permission[] = [
  ...VIEWER,
  "agent:write",
  "execution:write",
  "replay:write",
  "tool:execute",
  "certification:read"
];

// Operator extends developer with platform controls: recovery/break-glass,
// cross-tenant observability, certification CAPTURE, and tenant read.
const OPERATOR: Permission[] = [
  ...DEVELOPER,
  "recovery:execute",
  "observability:read",
  "certification:write",
  "tenant:read"
];

// Admin extends operator with tenant configuration, key management, and audit.
const ADMIN: Permission[] = [
  ...OPERATOR,
  "tenant:configure",
  "apikey:manage",
  "audit:read"
];

// Owner is the superuser — every permission, including tenant lifecycle.
const OWNER: Permission[] = [...ALL_PERMISSIONS];

// Auditor is the compliance SIDE role: the viewer floor plus read-only access
// to the audit log, certifications, observability, and tenant metadata. It
// holds NO write/execute/configure permission by construction (least privilege).
const AUDITOR: Permission[] = [
  ...VIEWER,
  "audit:read",
  "certification:read",
  "observability:read",
  "tenant:read"
];

/**
 * Frozen role → permission-set matrix. Source of truth for `hasPermission`.
 * Sets give O(1) membership and de-duplicate the inheritance unions.
 */
export const ROLE_PERMISSIONS: Readonly<Record<ApiKeyRole, ReadonlySet<Permission>>> = Object.freeze({
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  operator: new Set(OPERATOR),
  developer: new Set(DEVELOPER),
  auditor: new Set(AUDITOR),
  viewer: new Set(VIEWER)
});

/** True if `role` is granted `permission`. Pure, allocation-free lookup. */
export function hasPermission(role: ApiKeyRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** The sorted list of permissions a role holds — used by docs and the `/whoami` surface. */
export function permissionsForRole(role: ApiKeyRole): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? new Set<Permission>())].sort();
}

/**
 * Authorization decision stamped onto the request by the RBAC guards so the
 * audit logger can record WHY a request was allowed or denied. Surfaced in the
 * `audit_log.metadata` column and on the structured denial warning.
 */
export interface AuthzDecision {
  decision: "ALLOW" | "DENY";
  /** The permission the guard checked (permission-based guards). */
  permission?: Permission;
  /** The minimum role the guard checked (weight-based `requireRole`). */
  requiredRole?: ApiKeyRole;
  /** The caller's role at decision time. */
  actorRole?: ApiKeyRole;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Set by `requirePermission()` / `requireRole()` so the audit logger can
     * persist the authorization outcome alongside the request. Absent on routes
     * that carry no RBAC guard (open reads gated only by tenant ownership).
     */
    authz?: AuthzDecision;
  }
}
