/**
 * RBAC route-wiring suite — proves the permission guards are attached to the
 * CORRECT real routes (not just that the guards work in isolation, which
 * rbac.test.ts covers). Drives the actual route modules via app.inject with a
 * synthetic tenant per role.
 *
 * Two protected surfaces are exercised end-to-end because they stand up cleanly
 * without the full runtime container:
 *   • Certifications (certificationRoutes) — read vs capture.
 *   • Tenant configuration / key management (adminRoutes) — including the
 *     privilege-escalation guard on key minting.
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerCertificationRoutes } from "../src/interfaces/http/certificationRoutes.js";
import { registerAdminRoutes } from "../src/interfaces/http/adminRoutes.js";
import { createPermissiveTenantGuard } from "../src/infrastructure/security/tenantGuard.js";
import type { RuntimeContainer } from "../src/application/runtimeContainer.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";
import type { ApiKeyRole } from "../src/infrastructure/security/tenantContext.js";

const ROLES: ApiKeyRole[] = ["owner", "admin", "operator", "developer", "auditor", "viewer"];

// Attach a synthetic tenant from the x-test-role header before any guard runs.
function injectRole(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    const role = request.headers["x-test-role"];
    if (typeof role === "string" && role.length) {
      request.tenant = { tenantId: "t1", apiKeyId: "k1", role: role as ApiKeyRole, rateLimitRpm: 1000 };
    }
  });
}

// PgClient stub: every query succeeds with zero rows so ALLOW paths reach a
// terminal (non-403) status instead of crashing.
function stubDb(): PgClient {
  const stub: PgClient = {
    async query() { return { rows: [], rowCount: 0 }; },
    async withTransaction(fn) { return fn(stub); },
    async acquire() { return { async query() { return { rows: [], rowCount: 0 }; }, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  };
  return stub;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

describe("certifications — certification:read vs certification:write", () => {
  async function build(): Promise<FastifyInstance> {
    const a = Fastify({ logger: false });
    injectRole(a);
    const container = {
      tenantGuard: createPermissiveTenantGuard(),
      replayDivergenceDetector: {
        compare: async (executionId: string) => ({ executionId, divergent: false, reason: "NONE" }),
        certify: async (executionId: string) => ({ executionId, chainHash: "h", frameDigests: [] })
      }
    } as unknown as RuntimeContainer;
    await registerCertificationRoutes(a, container);
    await a.ready();
    return a;
  }

  it("GET (read) is allowed for auditor+ readers, denied to viewer", async () => {
    app = await build();
    for (const r of ["auditor", "developer", "operator", "admin", "owner"] as ApiKeyRole[]) {
      const res = await app.inject({ url: "/executions/e1/certification", headers: { "x-test-role": r } });
      expect(res.statusCode, `GET as ${r}`).toBe(200);
    }
    expect((await app.inject({ url: "/executions/e1/certification", headers: { "x-test-role": "viewer" } })).statusCode).toBe(403);
  });

  it("POST (capture) is operator+ only — developer/auditor/viewer denied", async () => {
    app = await build();
    for (const r of ["operator", "admin", "owner"] as ApiKeyRole[]) {
      const res = await app.inject({ method: "POST", url: "/executions/e1/certification", headers: { "x-test-role": r }, payload: {} });
      expect(res.statusCode, `POST as ${r}`).toBe(201);
    }
    for (const r of ["developer", "auditor", "viewer"] as ApiKeyRole[]) {
      const res = await app.inject({ method: "POST", url: "/executions/e1/certification", headers: { "x-test-role": r }, payload: {} });
      expect(res.statusCode, `POST as ${r}`).toBe(403);
    }
  });

  it("rejects an unauthenticated request (401)", async () => {
    app = await build();
    expect((await app.inject({ url: "/executions/e1/certification" })).statusCode).toBe(401);
  });
});

describe("admin key management — apikey:manage + privilege-escalation guard", () => {
  async function build(): Promise<FastifyInstance> {
    const a = Fastify({ logger: false });
    injectRole(a);
    await registerAdminRoutes(a, stubDb());
    await a.ready();
    return a;
  }
  const keyBody = (role: string) => ({ tenantId: "t1", name: "k", role });

  it("denies key creation to roles without apikey:manage", async () => {
    app = await build();
    for (const r of ["operator", "developer", "auditor", "viewer"] as ApiKeyRole[]) {
      const res = await app.inject({ method: "POST", url: "/admin/api-keys", headers: { "x-test-role": r }, payload: keyBody("viewer") });
      expect(res.statusCode, `create as ${r}`).toBe(403);
    }
  });

  it("lets admin mint roles up to its own weight but NOT above (no owner key)", async () => {
    app = await build();
    // admin minting developer → allowed (201)
    expect(
      (await app.inject({ method: "POST", url: "/admin/api-keys", headers: { "x-test-role": "admin" }, payload: keyBody("developer") })).statusCode
    ).toBe(201);
    // admin minting owner → escalation blocked (403)
    expect(
      (await app.inject({ method: "POST", url: "/admin/api-keys", headers: { "x-test-role": "admin" }, payload: keyBody("owner") })).statusCode
    ).toBe(403);
  });

  it("lets owner mint an owner key", async () => {
    app = await build();
    expect(
      (await app.inject({ method: "POST", url: "/admin/api-keys", headers: { "x-test-role": "owner" }, payload: keyBody("owner") })).statusCode
    ).toBe(201);
  });

  it("gates tenant create on tenant:configure (admin+), denies operator-", async () => {
    app = await build();
    expect((await app.inject({ method: "POST", url: "/admin/tenants", headers: { "x-test-role": "admin" }, payload: { id: "t9", name: "T9", plan: "starter" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/admin/tenants", headers: { "x-test-role": "operator" }, payload: { id: "t9", name: "T9" } })).statusCode).toBe(403);
  });
});
