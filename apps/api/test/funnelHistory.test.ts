/**
 * Historical funnel — read-side suite.
 *
 *   • historicalFunnel maps bucket rows → ISO buckets, computes per-bucket and
 *     total activation rate, and degrades to an empty (but well-formed) result
 *     for a null db.
 *   • coerceGranularity narrows arbitrary input to the closed set.
 *   • GET /admin/funnel/history is admin-gated (tenant:read) and returns the
 *     history payload for an authorized caller.
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  historicalFunnel,
  coerceGranularity,
  type FunnelGranularity
} from "../src/application/analytics/funnelQueries.js";
import {
  registerSignupRoutes,
  type SignupRouteOptions
} from "../src/interfaces/http/signupRoutes.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";
import type { ApiKeyRole } from "../src/infrastructure/security/tenantContext.js";

interface BucketRow { bucket: Date | string; signups: number; activated: number }

// Fake that answers the history group-by with a fixed result set.
function historyDb(rows: BucketRow[]): PgClient {
  const run = async (sql: string) => {
    if (sql.toLowerCase().includes("from funnel_events")) {
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

describe("coerceGranularity", () => {
  it.each([
    ["day", "day"],
    ["week", "week"],
    ["month", "month"],
    ["hour", "day"],
    [undefined, "day"],
    ["", "day"]
  ] as Array<[string | undefined, FunnelGranularity]>)("%o → %s", (input, expected) => {
    expect(coerceGranularity(input)).toBe(expected);
  });
});

describe("historicalFunnel", () => {
  const from = new Date("2026-03-01T00:00:00.000Z");
  const to = new Date("2026-04-01T00:00:00.000Z");

  it("maps buckets, computes per-bucket + total activation rate", async () => {
    const db = historyDb([
      { bucket: new Date("2026-03-01T00:00:00.000Z"), signups: 10, activated: 4 },
      { bucket: new Date("2026-03-08T00:00:00.000Z"), signups: 5, activated: 5 },
      { bucket: new Date("2026-03-15T00:00:00.000Z"), signups: 5, activated: 0 }
    ]);
    const result = await historicalFunnel(db, { from, to, granularity: "week" });

    expect(result.granularity).toBe("week");
    expect(result.from).toBe(from.toISOString());
    expect(result.to).toBe(to.toISOString());
    expect(result.buckets).toEqual([
      { bucket: "2026-03-01T00:00:00.000Z", signups: 10, activated: 4, activationRate: 0.4 },
      { bucket: "2026-03-08T00:00:00.000Z", signups: 5, activated: 5, activationRate: 1 },
      { bucket: "2026-03-15T00:00:00.000Z", signups: 5, activated: 0, activationRate: 0 }
    ]);
    expect(result.totals.signups).toBe(20);
    expect(result.totals.activated).toBe(9);
    expect(result.totals.activationRate).toBeCloseTo(9 / 20, 6);
  });

  it("returns a well-formed empty result for an empty range", async () => {
    const result = await historicalFunnel(historyDb([]), { from, to, granularity: "day" });
    expect(result.buckets).toEqual([]);
    expect(result.totals).toEqual({ signups: 0, activated: 0, activationRate: 0 });
  });

  it("returns an empty result (no throw) for a null db (MEMORY mode)", async () => {
    const result = await historicalFunnel(null, { from, to, granularity: "day" });
    expect(result.buckets).toEqual([]);
    expect(result.totals.signups).toBe(0);
    expect(result.from).toBe(from.toISOString());
  });
});

// ── Route gating ────────────────────────────────────────────────────────────

const OPTS: SignupRouteOptions = {
  enabled: true,
  open: true,
  inviteCodes: [],
  defaultPlan: "starter",
  defaultRpm: 120
};

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
  return registerSignupRoutes(a, db, OPTS).then(async () => {
    await a.ready();
    app = a;
    return a;
  });
}

describe("GET /admin/funnel/history", () => {
  it("returns the history payload for an admin (tenant:read) caller", async () => {
    const a = await build(historyDb([
      { bucket: new Date("2026-03-01T00:00:00.000Z"), signups: 3, activated: 1 }
    ]));
    const res = await a.inject({
      method: "GET",
      url: "/admin/funnel/history?granularity=week&from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z"
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.granularity).toBe("week");
    expect(body.buckets).toHaveLength(1);
    expect(body.totals.signups).toBe(3);
  });

  it("works with no query params (defaults to a 30-day daily window)", async () => {
    const a = await build(historyDb([]));
    const res = await a.inject({ method: "GET", url: "/admin/funnel/history" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.granularity).toBe("day");
    expect(body.buckets).toEqual([]);
  });

  it("is admin-gated: a viewer without tenant:read is rejected 403", async () => {
    const a = await build(historyDb([]), "viewer");
    const res = await a.inject({ method: "GET", url: "/admin/funnel/history" });
    expect(res.statusCode).toBe(403);
  });
});
