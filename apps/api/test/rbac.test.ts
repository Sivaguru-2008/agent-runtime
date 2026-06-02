/**
 * Production RBAC suite.
 *
 * Proves the three properties the design promises:
 *   1. Inheritance — each operational role is a strict superset of the one
 *      below it (viewer ⊂ developer ⊂ operator ⊂ admin ⊂ owner); owner holds
 *      every permission.
 *   2. Least privilege — the auditor (compliance) role holds broad READ access
 *      and ZERO write/execute/configure permission; the viewer holds only the
 *      read floor; the two are incomparable with developer.
 *   3. Enforcement — requirePermission()/requireRole() guards return 401 when
 *      unauthenticated, 403 when the role lacks the capability, allow otherwise,
 *      and stamp request.authz so the audit logger can record the decision.
 */

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ROLE_PERMISSIONS,
  ALL_PERMISSIONS,
  hasPermission,
  permissionsForRole,
  type Permission
} from "../src/infrastructure/security/permissions.js";
import {
  ROLE_WEIGHT,
  canAccessAllTenants,
  normalizeRole,
  type ApiKeyRole
} from "../src/infrastructure/security/tenantContext.js";
import { requirePermission, requireRole } from "../src/infrastructure/security/rbac.js";

const ROLES: ApiKeyRole[] = ["owner", "admin", "operator", "developer", "auditor", "viewer"];

function perms(role: ApiKeyRole): Set<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}
function isSuperset(a: Set<Permission>, b: Set<Permission>): boolean {
  for (const p of b) if (!a.has(p)) return false;
  return true;
}

// Write/execute/configure capabilities — the ones a read-only role must NEVER hold.
const MUTATING: Permission[] = [
  "agent:write",
  "execution:write",
  "replay:write",
  "certification:write",
  "recovery:execute",
  "tool:execute",
  "tenant:configure",
  "tenant:admin",
  "apikey:manage"
];

describe("permission matrix — inheritance along the operational chain", () => {
  it("viewer ⊂ developer ⊂ operator ⊂ admin ⊂ owner", () => {
    expect(isSuperset(perms("developer"), perms("viewer"))).toBe(true);
    expect(isSuperset(perms("operator"), perms("developer"))).toBe(true);
    expect(isSuperset(perms("admin"), perms("operator"))).toBe(true);
    expect(isSuperset(perms("owner"), perms("admin"))).toBe(true);
  });

  it("each step up the chain adds at least one new permission (strict superset)", () => {
    expect(perms("developer").size).toBeGreaterThan(perms("viewer").size);
    expect(perms("operator").size).toBeGreaterThan(perms("developer").size);
    expect(perms("admin").size).toBeGreaterThan(perms("operator").size);
    expect(perms("owner").size).toBeGreaterThan(perms("admin").size);
  });

  it("owner holds every defined permission", () => {
    expect(perms("owner").size).toBe(ALL_PERMISSIONS.length);
    for (const p of ALL_PERMISSIONS) expect(hasPermission("owner", p)).toBe(true);
  });
});

describe("permission matrix — least privilege", () => {
  it("viewer holds only the read floor", () => {
    expect(permissionsForRole("viewer")).toEqual(
      ["agent:read", "execution:read", "replay:read"].sort()
    );
  });

  it("auditor holds broad reads but NO mutating capability", () => {
    for (const p of MUTATING) {
      expect(hasPermission("auditor", p)).toBe(false);
    }
    // …yet can read the compliance surfaces a reviewer needs.
    for (const p of ["audit:read", "certification:read", "observability:read", "tenant:read"] as Permission[]) {
      expect(hasPermission("auditor", p)).toBe(true);
    }
  });

  it("auditor and developer are incomparable (neither is a superset)", () => {
    expect(isSuperset(perms("developer"), perms("auditor"))).toBe(false);
    expect(isSuperset(perms("auditor"), perms("developer"))).toBe(false);
  });

  it("restricts sensitive capabilities to the intended roles", () => {
    const holders = (p: Permission) => ROLES.filter((r) => hasPermission(r, p)).sort();
    expect(holders("recovery:execute")).toEqual(["admin", "operator", "owner"]);
    expect(holders("certification:write")).toEqual(["admin", "operator", "owner"]);
    expect(holders("tenant:configure")).toEqual(["admin", "owner"]);
    expect(holders("apikey:manage")).toEqual(["admin", "owner"]);
    expect(holders("tenant:admin")).toEqual(["owner"]);
    expect(holders("tool:execute")).toEqual(["admin", "developer", "operator", "owner"]);
    expect(holders("audit:read")).toEqual(["admin", "auditor", "owner"]);
  });
});

describe("role weight ladder + helpers", () => {
  it("orders the six roles strictly", () => {
    expect(ROLE_WEIGHT.owner).toBeGreaterThan(ROLE_WEIGHT.admin);
    expect(ROLE_WEIGHT.admin).toBeGreaterThan(ROLE_WEIGHT.operator);
    expect(ROLE_WEIGHT.operator).toBeGreaterThan(ROLE_WEIGHT.developer);
    expect(ROLE_WEIGHT.developer).toBeGreaterThan(ROLE_WEIGHT.auditor);
    expect(ROLE_WEIGHT.auditor).toBeGreaterThan(ROLE_WEIGHT.viewer);
  });

  it("only owner and admin may cross tenant boundaries", () => {
    expect(canAccessAllTenants("owner")).toBe(true);
    expect(canAccessAllTenants("admin")).toBe(true);
    for (const r of ["operator", "developer", "auditor", "viewer"] as ApiKeyRole[]) {
      expect(canAccessAllTenants(r)).toBe(false);
    }
  });

  it("normalizes the legacy 'readonly' label to 'viewer'", () => {
    expect(normalizeRole("readonly")).toBe("viewer");
    expect(normalizeRole("operator")).toBe("operator");
  });
});

// ── Guard enforcement harness ───────────────────────────────────────────────
// A tiny app that injects request.tenant from an x-test-role header, then mounts
// the guards under test. ALLOW echoes request.authz so we can assert it is
// stamped for the audit logger.

async function buildGuardApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    const role = request.headers["x-test-role"];
    if (typeof role === "string" && role.length) {
      request.tenant = {
        tenantId: "t1",
        apiKeyId: "k1",
        role: role as ApiKeyRole,
        rateLimitRpm: 1000
      };
    }
  });
  app.post("/recover", { preHandler: requirePermission("recovery:execute") }, async (req) => ({ authz: req.authz }));
  app.get("/audit", { preHandler: requirePermission("audit:read") }, async (req) => ({ authz: req.authz }));
  app.post("/certify", { preHandler: requirePermission("certification:write") }, async (req) => ({ authz: req.authz }));
  app.post("/operate", { preHandler: requireRole("operator") }, async (req) => ({ authz: req.authz }));
  await app.ready();
  return app;
}

describe("requirePermission — enforcement + audit stamping", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = await buildGuardApp();
    expect((await app.inject({ method: "POST", url: "/recover" })).statusCode).toBe(401);
    await app.close();
  });

  it("allows recovery:execute for operator/admin/owner, denies the rest", async () => {
    const app = await buildGuardApp();
    for (const r of ["operator", "admin", "owner"] as ApiKeyRole[]) {
      const res = await app.inject({ method: "POST", url: "/recover", headers: { "x-test-role": r } });
      expect(res.statusCode).toBe(200);
      expect(res.json().authz).toEqual({ decision: "ALLOW", permission: "recovery:execute", actorRole: r });
    }
    for (const r of ["developer", "auditor", "viewer"] as ApiKeyRole[]) {
      const res = await app.inject({ method: "POST", url: "/recover", headers: { "x-test-role": r } });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  it("grants audit:read to the auditor but not to developer/operator", async () => {
    const app = await buildGuardApp();
    expect((await app.inject({ url: "/audit", headers: { "x-test-role": "auditor" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/audit", headers: { "x-test-role": "admin" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/audit", headers: { "x-test-role": "developer" } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/audit", headers: { "x-test-role": "operator" } })).statusCode).toBe(403);
    await app.close();
  });

  it("blocks the auditor from certification:write (least privilege)", async () => {
    const app = await buildGuardApp();
    const res = await app.inject({ method: "POST", url: "/certify", headers: { "x-test-role": "auditor" } });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/certify", headers: { "x-test-role": "operator" } })).statusCode).toBe(200);
    await app.close();
  });
});

describe("requireRole — weight ladder still gates writes against auditor", () => {
  it("rejects auditor/developer/viewer, allows operator+", async () => {
    const app = await buildGuardApp();
    for (const r of ["owner", "admin", "operator"] as ApiKeyRole[]) {
      expect((await app.inject({ method: "POST", url: "/operate", headers: { "x-test-role": r } })).statusCode).toBe(200);
    }
    for (const r of ["developer", "auditor", "viewer"] as ApiKeyRole[]) {
      expect((await app.inject({ method: "POST", url: "/operate", headers: { "x-test-role": r } })).statusCode).toBe(403);
    }
    await app.close();
  });
});
