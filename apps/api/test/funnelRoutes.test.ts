/**
 * Phase 2 funnel analytics routes — gating + contract suite.
 *
 *   • Every route is admin-gated (tenant:read) → a viewer is 403.
 *   • /admin/funnel/segments rejects an unknown dimension with 400.
 *   • Authorized callers receive the well-formed payload.
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerFunnelAnalyticsRoutes } from "../src/interfaces/http/funnelRoutes.js";
import { DEFAULT_ALERT_CONFIG } from "../src/application/analytics/funnelAlerts.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";
import type { ApiKeyRole } from "../src/infrastructure/security/tenantContext.js";

// Minimal fake answering every Phase-2 query with empty/zero result sets — the
// query logic is unit-tested elsewhere; here we only exercise routing + gating.
function emptyDb(): PgClient {
  const run = async (sql: string) => {
    const t = sql.toLowerCase();
    if (t.includes("max(occurred_at) as last_signup_at")) return { rows: [{ last_signup_at: null }], rowCount: 1 };
    if (t.includes("left join funnel_events a")) return { rows: [{ signups: 0, activated: 0 }], rowCount: 1 };
    if (t.includes("last_event_at")) return { rows: [{ total: 0, signups: 0, activations: 0, last_event_at: null }], rowCount: 1 };
    if (t.includes("orphan_activations")) return { rows: [{ orphan_activations: 0, reversed_timestamps: 0, activation_drift: 0, signup_event_drift: 0 }], rowCount: 1 };
    if (t.includes("count(*)::int as n from funnel_daily")) return { rows: [{ n: 0 }], rowCount: 1 };
    if (t.includes("from signups")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  const db: PgClient = {
    query: (async (sql: string) => run(sql)) as PgClient["query"],
    async withTransaction(fn) { return fn(db); },
    async acquire() { return { query: (async (s: string) => run(s)) as never, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  };
  return db;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

function build(db: PgClient | null, role: ApiKeyRole = "owner"): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  a.addHook("onRequest", async (request) => {
    request.tenant = { tenantId: "t1", apiKeyId: "k1", role, rateLimitRpm: 1000 };
  });
  return registerFunnelAnalyticsRoutes(a, db, { ...DEFAULT_ALERT_CONFIG, enabled: true }).then(async () => {
    await a.ready();
    app = a;
    return a;
  });
}

const ROUTES = [
  "/admin/funnel/cohorts",
  "/admin/funnel/segments",
  "/admin/funnel/compare",
  "/admin/funnel/health",
  "/admin/funnel/alerts",
  "/admin/funnel/retention",
  "/admin/funnel/export"
];

describe("admin-gating (tenant:read)", () => {
  it.each(ROUTES)("rejects a viewer with 403 on %s", async (url) => {
    const a = await build(emptyDb(), "viewer");
    const res = await a.inject({ method: "GET", url });
    expect(res.statusCode).toBe(403);
  });

  it.each(ROUTES)("allows an owner with 200 on %s", async (url) => {
    const a = await build(emptyDb(), "owner");
    const res = await a.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
  });
});

describe("/admin/funnel/segments validation", () => {
  it("400s on an unknown segmentBy", async () => {
    const a = await build(emptyDb());
    const res = await a.inject({ method: "GET", url: "/admin/funnel/segments?segmentBy=email" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_SEGMENT");
  });

  it("defaults to source when segmentBy is omitted", async () => {
    const a = await build(emptyDb());
    const res = await a.inject({ method: "GET", url: "/admin/funnel/segments" });
    expect(res.statusCode).toBe(200);
    expect(res.json().segmentBy).toBe("source");
  });
});

describe("/admin/funnel/cohorts contract", () => {
  it("returns a well-formed (empty) cohort report", async () => {
    const a = await build(emptyDb());
    const res = await a.inject({ method: "GET", url: "/admin/funnel/cohorts?cohortBy=month&periods=6" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cohortBy).toBe("month");
    expect(body.periods).toBe(6);
    expect(body.cohorts).toEqual([]);
  });
});

describe("/admin/funnel/rollup/refresh", () => {
  it("is admin-gated and returns a refresh result", async () => {
    const viewer = await build(emptyDb(), "viewer");
    expect((await viewer.inject({ method: "POST", url: "/admin/funnel/rollup/refresh" })).statusCode).toBe(403);
    await viewer.close();

    const owner = await build(emptyDb(), "owner");
    const res = await owner.inject({ method: "POST", url: "/admin/funnel/rollup/refresh" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("days");
  });
});

describe("/admin/funnel/export", () => {
  it("streams CSV with a header and download disposition", async () => {
    const db: PgClient = {
      query: (async (sql: string) => {
        if (sql.toLowerCase().includes("from signups")) {
          return {
            rows: [
              { email: "ada@x.com", tenant_id: "t-ada", plan: "starter", source_norm: "twitter", invite_code: null, created_at: new Date("2026-03-01T00:00:00Z"), activated_at: new Date("2026-03-02T00:00:00Z") },
              // A value with a comma must be quote-escaped per RFC-4180.
              { email: "bob@x.com", tenant_id: "t-bob", plan: "growth", source_norm: "list, q2", invite_code: "INV", created_at: new Date("2026-03-03T00:00:00Z"), activated_at: null }
            ],
            rowCount: 2
          };
        }
        return { rows: [], rowCount: 0 };
      }) as PgClient["query"],
      async withTransaction(fn) { return fn(db); },
      async acquire() { return { query: (async () => ({ rows: [], rowCount: 0 })) as never, release() {} }; },
      stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
      async close() {}
    };
    const a = await build(db);
    const res = await a.inject({ method: "GET", url: "/admin/funnel/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    const lines = res.body.trim().split("\n");
    expect(lines[0]).toBe("email,tenant_id,plan,source,invite_code,created_at,activated_at,activated");
    expect(lines[1]).toContain("ada@x.com");
    expect(lines[1]).toContain("true");
    expect(lines[2]).toContain('"list, q2"'); // comma value quote-escaped
    expect(lines[2]).toContain("false");
  });
});
