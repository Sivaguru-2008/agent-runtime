/**
 * Funnel daily rollup — unit suite (re-bucketing + refresh contract over faked
 * SQL). The cohort-correctness of the rollup vs the live event log is proven in
 * the Postgres integration suite.
 */

import { describe, expect, it } from "vitest";
import { refreshFunnelDaily, dailyFunnel } from "../src/application/analytics/funnelRollup.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";

function fakeDb(handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number }): {
  db: PgClient;
  calls: () => string[];
} {
  const calls: string[] = [];
  const run = async (sql: string, params: unknown[] = []) => {
    calls.push(sql);
    return handler(sql, params);
  };
  const db: PgClient = {
    query: (async (sql: string, params: unknown[] = []) => run(sql, params)) as PgClient["query"],
    async withTransaction(fn) { return fn(db); },
    async acquire() { return { query: (async (s: string, p: unknown[] = []) => run(s, p)) as never, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  };
  return { db, calls: () => calls };
}

describe("refreshFunnelDaily", () => {
  it("upserts the rollup and returns the row count", async () => {
    const { db, calls } = fakeDb((sql) => {
      const t = sql.toLowerCase();
      if (t.includes("insert into funnel_daily")) return { rows: [], rowCount: 0 };
      if (t.includes("count(*)::int as n from funnel_daily")) return { rows: [{ n: 42 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const r = await refreshFunnelDaily(db);
    expect(r.days).toBe(42);
    expect(typeof r.refreshedAt).toBe("string");
    expect(calls().some((s) => s.toLowerCase().includes("on conflict (day) do update"))).toBe(true);
  });

  it("is a no-op (days 0) for a null db", async () => {
    const r = await refreshFunnelDaily(null);
    expect(r.days).toBe(0);
  });
});

describe("dailyFunnel — re-bucketing from the rollup", () => {
  const from = new Date("2026-03-01T00:00:00Z");
  const to = new Date("2026-04-01T00:00:00Z");

  it("maps rollup buckets and sums totals", async () => {
    const { db } = fakeDb((sql) => {
      if (sql.toLowerCase().includes("from funnel_daily")) {
        return {
          rows: [
            { bucket: new Date("2026-03-02T00:00:00Z"), signups: 12, activated: 6 },
            { bucket: new Date("2026-03-09T00:00:00Z"), signups: 8, activated: 2 }
          ],
          rowCount: 2
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = await dailyFunnel(db, { from, to, granularity: "week" });
    expect(r.granularity).toBe("week");
    expect(r.buckets).toEqual([
      { bucket: "2026-03-02T00:00:00.000Z", signups: 12, activated: 6, activationRate: 0.5 },
      { bucket: "2026-03-09T00:00:00.000Z", signups: 8, activated: 2, activationRate: 0.25 }
    ]);
    expect(r.totals).toEqual({ signups: 20, activated: 8, activationRate: 0.4 });
  });

  it("returns a well-formed empty window for a null db", async () => {
    const r = await dailyFunnel(null, { from, to, granularity: "day" });
    expect(r.buckets).toEqual([]);
    expect(r.totals.signups).toBe(0);
    expect(r.from).toBe(from.toISOString());
  });
});
