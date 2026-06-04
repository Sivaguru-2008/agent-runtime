/**
 * Activation funnel suite — proves the signup→activation instrumentation:
 *   (a) a tenant's first traced task stamps signups.activated_at,
 *   (b) a second task does NOT overwrite the first-activation timestamp,
 *   (c) a DB error in the activation path never disturbs the task response,
 *   (d) GET /admin/funnel computes total / activated / rate / by-source.
 *
 * Reuses the stateful-fake-PgClient pattern from signupRoutes.test.ts: a fake
 * that models the `activated_at is null` guard so the idempotent UPDATE behaves
 * like Postgres, plus a fake that serves the funnel group-by query.
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  registerSignupRoutes,
  markTenantActivated,
  type SignupRouteOptions
} from "../src/interfaces/http/signupRoutes.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";
import type { ApiKeyRole } from "../src/infrastructure/security/tenantContext.js";

// Flush pending microtasks so a fire-and-forget db.query has run before we
// assert on its effect.
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Stateful fake modelling the activation row: `activated_at` starts NULL and is
// set exactly once because the UPDATE carries `where activated_at is null`.
function activationDb(): {
  db: PgClient;
  activatedAt: (tenantId: string) => string | null;
  updateCalls: () => number;
  rowsAffected: () => number[];
} {
  const state = new Map<string, string | null>(); // tenant -> activated_at
  let calls = 0;
  const affected: number[] = [];
  const run = async (sql: string, params: unknown[] = []) => {
    const text = sql.toLowerCase();
    if (text.includes("update signups set activated_at")) {
      calls++;
      const tenant = String(params[0] ?? "");
      const current = state.get(tenant) ?? null;
      // Mirror `where tenant_id=$1 and activated_at is null`: only the first
      // call matches a row and writes a timestamp; later calls match zero rows.
      if (current === null) {
        state.set(tenant, new Date().toISOString());
        affected.push(1);
        return { rows: [], rowCount: 1 };
      }
      affected.push(0);
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const db: PgClient = {
    query: (async (sql: string, params: unknown[] = []) => run(sql, params)) as PgClient["query"],
    async withTransaction(fn) { return fn(db); },
    async acquire() { return { query: (async (s: string, p: unknown[] = []) => run(s, p)) as never, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  };
  return {
    db,
    activatedAt: (t) => state.get(t) ?? null,
    updateCalls: () => calls,
    rowsAffected: () => affected
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

describe("markTenantActivated — first-task activation write", () => {
  it("(a) stamps activated_at on the first task for a tenant", async () => {
    const { db, activatedAt, updateCalls, rowsAffected } = activationDb();
    expect(activatedAt("t1")).toBeNull();

    markTenantActivated(db, "t1");
    await flush();

    expect(updateCalls()).toBe(1);
    expect(rowsAffected()).toEqual([1]);
    expect(activatedAt("t1")).not.toBeNull();
  });

  it("(b) a second task does NOT overwrite the first activation timestamp", async () => {
    const { db, activatedAt, rowsAffected } = activationDb();

    markTenantActivated(db, "t1");
    await flush();
    const first = activatedAt("t1");
    expect(first).not.toBeNull();

    markTenantActivated(db, "t1");
    markTenantActivated(db, "t1");
    await flush();

    // The `activated_at is null` guard means later UPDATEs affect zero rows and
    // the original timestamp is preserved verbatim.
    expect(activatedAt("t1")).toBe(first);
    expect(rowsAffected()).toEqual([1, 0, 0]);
  });

  it("is a no-op (and never throws) when securityDb is null", () => {
    expect(() => markTenantActivated(null, "t1")).not.toThrow();
  });
});

describe("markTenantActivated — fail-safe under a broken DB", () => {
  // A db whose query throws SYNCHRONOUSLY — the harsher case that a bare
  // `.catch()` would miss. markTenantActivated must still not throw.
  const syncThrowingDb = {
    query() { throw new Error("connection pool exhausted"); },
    async withTransaction(fn: (c: unknown) => unknown) { return fn(syncThrowingDb); },
    async acquire() { return { query() { throw new Error("boom"); }, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  } as unknown as PgClient;

  // A db whose query returns a REJECTED promise (async failure path).
  const asyncRejectDb = {
    query: async () => { throw new Error("deadlock detected"); },
    async withTransaction(fn: (c: unknown) => unknown) { return fn(asyncRejectDb); },
    async acquire() { return { query: async () => { throw new Error("boom"); }, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  } as unknown as PgClient;

  it("swallows a synchronous throw from db.query", () => {
    expect(() => markTenantActivated(syncThrowingDb, "t1")).not.toThrow();
  });

  it("swallows an async rejection from db.query (no unhandled rejection)", async () => {
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => { unhandled = reason; };
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(() => markTenantActivated(asyncRejectDb, "t1")).not.toThrow();
      await flush();
      await flush();
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("(c) a route that mirrors the task handler still returns 202 when activation fails", async () => {
    // Tiny stand-in for the real POST /agents/:id/tasks handler: do the work,
    // fire the activation write, return 202. The throwing db must not change it.
    const a = Fastify({ logger: false });
    a.post("/agents/:id/tasks", async (_req, reply) => {
      markTenantActivated(syncThrowingDb, "t1");
      return reply.status(202).send({ id: "exec-1", status: "RUNNING" });
    });
    await a.ready();
    app = a;

    const res = await a.inject({ method: "POST", url: "/agents/abc/tasks", payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: "exec-1", status: "RUNNING" });
  });
});

// ── Funnel aggregates ──────────────────────────────────────────────────────

const OPTS: SignupRouteOptions = {
  enabled: true,
  open: true,
  inviteCodes: [],
  defaultPlan: "starter",
  defaultRpm: 120
};

// Fake that answers the funnel group-by with a fixed result set so we can assert
// the in-process total/activated/rate math is correct.
function funnelDb(rows: Array<{ source: string; signups: number; activated: number }>): PgClient {
  const run = async (sql: string) => {
    if (sql.toLowerCase().includes("group by coalesce(source")) {
      return { rows, rowCount: rows.length };
    }
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

// Inject a tenant holding tenant:read (owner) so the admin-gated route is reached.
function buildFunnel(db: PgClient | null, role: ApiKeyRole = "owner"): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  a.addHook("onRequest", async (request) => {
    request.tenant = { tenantId: "t1", apiKeyId: "k1", role, rateLimitRpm: 1000 };
  });
  return registerSignupRoutes(a, db, OPTS).then(async () => {
    await a.ready();
    app = a;
    return a;
  });
}

describe("GET /admin/funnel — activation aggregates", () => {
  it("(d) computes total, activated, rate and per-source breakdown", async () => {
    const a = await buildFunnel(
      funnelDb([
        { source: "landing", signups: 10, activated: 4 },
        { source: "docs", signups: 5, activated: 5 },
        { source: "direct", signups: 5, activated: 0 }
      ])
    );
    const res = await a.inject({ method: "GET", url: "/admin/funnel" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(20);
    expect(body.activated).toBe(9);
    expect(body.activationRate).toBeCloseTo(9 / 20, 6);
    expect(body.bySource).toEqual([
      { source: "landing", signups: 10, activated: 4, activationRate: 0.4 },
      { source: "docs", signups: 5, activated: 5, activationRate: 1 },
      { source: "direct", signups: 5, activated: 0, activationRate: 0 }
    ]);
  });

  it("returns a zeroed funnel when there are no signups", async () => {
    const a = await buildFunnel(funnelDb([]));
    const res = await a.inject({ method: "GET", url: "/admin/funnel" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 0, activated: 0, activationRate: 0, bySource: [] });
  });

  it("returns a zeroed funnel in MEMORY mode (no security db)", async () => {
    const a = await buildFunnel(null);
    const res = await a.inject({ method: "GET", url: "/admin/funnel" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 0, activated: 0, activationRate: 0, bySource: [] });
  });

  it("is admin-gated: a viewer without tenant:read is rejected 403", async () => {
    const a = await buildFunnel(funnelDb([]), "viewer");
    const res = await a.inject({ method: "GET", url: "/admin/funnel" });
    expect(res.statusCode).toBe(403);
  });
});
