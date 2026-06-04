/**
 * Production authentication hardening suite.
 *
 * Proves:
 *   1. Production / STRICT_PROD cannot start with auth disabled (loadConfig
 *      throws) — the synthetic-tenant fallback can never reach production.
 *   2. registerApiKeyAuth independently refuses the disabled fallback in a
 *      strict environment (defense in depth).
 *   3. The admin fallback is gone: with auth disabled, the synthetic tenant
 *      gets the configured (non-admin) role, so operator/admin routes are
 *      still protected even in dev.
 *   4. With auth enabled, missing/invalid keys are rejected (401) and skip
 *      paths remain open.
 */

import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { loadConfig } from "../src/shared/config.js";
import { registerApiKeyAuth } from "../src/infrastructure/security/apiKeyAuth.js";
import { requireRole } from "../src/infrastructure/security/rbac.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";
import "../src/infrastructure/security/tenantContext.js";

// A PgClient that always returns zero rows — every API key lookup misses.
function emptyDb(): PgClient {
  const stub: PgClient = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async withTransaction(fn) {
      return fn(stub);
    },
    async acquire() {
      return { async query() { return { rows: [], rowCount: 0 }; }, release() {} };
    },
    stats() {
      return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 };
    },
    async close() {}
  };
  return stub;
}

async function buildAuthApp(opts: {
  enabled: boolean;
  strict: boolean;
  disabledFallbackRole?: "viewer" | "auditor" | "developer" | "operator" | "admin" | "owner";
}) {
  const app = Fastify();
  await registerApiKeyAuth(app, {
    redis: null,
    db: emptyDb(),
    skipPaths: ["/metrics"],
    cacheTtlSec: 60,
    enabled: opts.enabled,
    strict: opts.strict,
    disabledFallbackRole: opts.disabledFallbackRole ?? "developer"
  });
  app.get("/dev", { preHandler: requireRole("developer") }, async () => ({ ok: "dev" }));
  app.get("/operator", { preHandler: requireRole("operator") }, async () => ({ ok: "operator" }));
  app.get("/admin", { preHandler: requireRole("admin") }, async () => ({ ok: "admin" }));
  await app.ready();
  return app;
}

describe("loadConfig — production cannot boot with auth disabled", () => {
  it("throws when NODE_ENV=production and AUTH_ENABLED is false", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://localhost/app",
        AUTH_ENABLED: "false"
      } as NodeJS.ProcessEnv)
    ).toThrow(/AUTH_ENABLED must be 'true' in production/);
  });

  it("throws when STRICT_PROD=true and AUTH_ENABLED is false", () => {
    expect(() =>
      loadConfig({
        STRICT_PROD: "true",
        DATABASE_URL: "postgres://localhost/app",
        AUTH_ENABLED: "false"
      } as NodeJS.ProcessEnv)
    ).toThrow(/AUTH_ENABLED must be 'true'/);
  });

  it("accepts production when AUTH_ENABLED=true and DATABASE_URL is set", () => {
    const cfg = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://localhost/app",
      AUTH_ENABLED: "true"
    } as NodeJS.ProcessEnv);
    expect(cfg.AUTH_ENABLED).toBe(true);
    expect(cfg.NODE_ENV).toBe("production");
  });
});

describe("registerApiKeyAuth — strict environment refuses the disabled fallback", () => {
  it("throws when strict=true and enabled=false", async () => {
    const app = Fastify();
    await expect(
      registerApiKeyAuth(app, {
        redis: null,
        db: emptyDb(),
        skipPaths: [],
        cacheTtlSec: 60,
        enabled: false,
        strict: true,
        disabledFallbackRole: "developer"
      })
    ).rejects.toThrow(/Refusing to register auth plugin/);
    await app.close();
  });
});

describe("auth disabled (dev) — no admin fallback", () => {
  it("grants only the configured developer role, blocking operator/admin routes", async () => {
    const app = await buildAuthApp({ enabled: false, strict: false, disabledFallbackRole: "developer" });
    expect((await app.inject({ method: "GET", url: "/dev" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/operator" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin" })).statusCode).toBe(403);
    await app.close();
  });

  it("honors an explicit operator opt-in without granting admin", async () => {
    const app = await buildAuthApp({ enabled: false, strict: false, disabledFallbackRole: "operator" });
    expect((await app.inject({ method: "GET", url: "/operator" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/admin" })).statusCode).toBe(403);
    await app.close();
  });
});

describe("auth enabled — credentials are required", () => {
  it("rejects requests with no API key (401) and invalid keys (401), keeps skip paths open", async () => {
    const app = Fastify();
    await registerApiKeyAuth(app, {
      redis: null,
      db: emptyDb(),
      skipPaths: ["/metrics"],
      cacheTtlSec: 60,
      enabled: true,
      strict: false,
      disabledFallbackRole: "developer"
    });
    app.get("/dev", { preHandler: requireRole("developer") }, async () => ({ ok: "dev" }));
    app.get("/metrics", async () => ({ ok: "metrics" }));
    app.get("/health", async () => ({ ok: "health" }));
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/dev" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/dev", headers: { "x-api-key": "bogus" } })).statusCode
    ).toBe(401);
    // Skip paths and /health remain reachable without credentials.
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await app.close();
  });
});
