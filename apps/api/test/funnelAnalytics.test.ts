/**
 * Phase 2 funnel analytics — unit suite (pure aggregation logic over faked SQL).
 *
 * SQL behaviour (date_trunc, age, cumulative offsets) is proven in the Postgres
 * integration suite; here we assert the JS aggregation: cumulative cohort cells,
 * segment/rate math, period delta math, and health status derivation.
 */

import { describe, expect, it } from "vitest";
import {
  cohortFunnel,
  coerceCohortGranularity,
  segmentedFunnel,
  isSegmentDimension,
  periodComparison,
  startOfUtcPeriod,
  funnelHealth,
  retentionCurve
} from "../src/application/analytics/funnelAnalytics.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";

function fakeDb(handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number }): PgClient {
  const run = async (sql: string, params: unknown[] = []) => handler(sql, params);
  const db: PgClient = {
    query: (async (sql: string, params: unknown[] = []) => run(sql, params)) as PgClient["query"],
    async withTransaction(fn) { return fn(db); },
    async acquire() { return { query: (async (s: string, p: unknown[] = []) => run(s, p)) as never, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  };
  return db;
}

describe("coerceCohortGranularity / isSegmentDimension", () => {
  it("narrows cohort granularity", () => {
    expect(coerceCohortGranularity("month")).toBe("month");
    expect(coerceCohortGranularity("week")).toBe("week");
    expect(coerceCohortGranularity("day")).toBe("week");
    expect(coerceCohortGranularity(undefined)).toBe("week");
  });
  it("validates segment dimensions", () => {
    for (const d of ["source", "plan", "invite", "campaign"]) expect(isSegmentDimension(d)).toBe(true);
    expect(isSegmentDimension("email")).toBe(false);
    expect(isSegmentDimension(undefined)).toBe(false);
  });
});

describe("cohortFunnel — cumulative cells", () => {
  it("builds monotonically non-decreasing cumulative activation per cohort", async () => {
    const db = fakeDb((sql) => {
      const t = sql.toLowerCase();
      if (t.includes("as size")) {
        return { rows: [{ cohort: new Date("2026-03-02T00:00:00Z"), size: 10 }], rowCount: 1 };
      }
      if (t.includes("period_offset")) {
        return {
          rows: [
            { cohort: new Date("2026-03-02T00:00:00Z"), period_offset: 0, n: 2 },
            { cohort: new Date("2026-03-02T00:00:00Z"), period_offset: 1, n: 3 },
            { cohort: new Date("2026-03-02T00:00:00Z"), period_offset: 3, n: 1 }
          ],
          rowCount: 3
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const report = await cohortFunnel(db, { cohortBy: "week", periods: 3, from: new Date("2026-01-01T00:00:00Z") });
    expect(report.cohortBy).toBe("week");
    expect(report.periods).toBe(3);
    expect(report.cohorts).toHaveLength(1);
    const c = report.cohorts[0];
    expect(c.size).toBe(10);
    expect(c.cells.map((x) => x.activated)).toEqual([2, 5, 5, 6]); // cumulative, gap at p2
    expect(c.cells.map((x) => x.rate)).toEqual([0.2, 0.5, 0.5, 0.6]);
  });

  it("returns empty for a null db", async () => {
    const r = await cohortFunnel(null, { cohortBy: "month", periods: 6, from: new Date() });
    expect(r).toEqual({ cohortBy: "month", periods: 6, cohorts: [] });
  });
});

describe("segmentedFunnel", () => {
  it("computes per-segment + total rates", async () => {
    const db = fakeDb((sql) => {
      if (sql.toLowerCase().includes("from signups")) {
        return {
          rows: [
            { key: "starter", signups: 8, activated: 2 },
            { key: "growth", signups: 2, activated: 2 }
          ],
          rowCount: 2
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = await segmentedFunnel(db, "plan");
    expect(r.segmentBy).toBe("plan");
    expect(r.segments).toEqual([
      { key: "starter", signups: 8, activated: 2, activationRate: 0.25 },
      { key: "growth", signups: 2, activated: 2, activationRate: 1 }
    ]);
    expect(r.totals).toEqual({ signups: 10, activated: 4, activationRate: 0.4 });
  });
});

describe("startOfUtcPeriod", () => {
  it("rolls a week back to UTC Monday", () => {
    // 2026-03-04 is a Wednesday → Monday is 2026-03-02.
    expect(startOfUtcPeriod(new Date("2026-03-04T15:00:00Z"), "week").toISOString())
      .toBe("2026-03-02T00:00:00.000Z");
  });
  it("rolls a month back to the 1st UTC", () => {
    expect(startOfUtcPeriod(new Date("2026-03-18T15:00:00Z"), "month").toISOString())
      .toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("periodComparison", () => {
  it("computes signups %delta and activation-rate point delta", async () => {
    const now = new Date("2026-03-04T12:00:00Z"); // week starts 2026-03-02
    const currentStart = startOfUtcPeriod(now, "week").toISOString();
    const db = fakeDb((sql, params) => {
      if (sql.toLowerCase().includes("left join funnel_events a")) {
        const from = (params[0] as Date).toISOString();
        // current window: 10 signups, 5 activated (50%); previous: 8 signups, 2 (25%)
        return from === currentStart
          ? { rows: [{ signups: 10, activated: 5 }], rowCount: 1 }
          : { rows: [{ signups: 8, activated: 2 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = await periodComparison(db, "week", now);
    expect(r.current.signups).toBe(10);
    expect(r.current.activationRate).toBe(0.5);
    expect(r.previous.signups).toBe(8);
    expect(r.previous.activationRate).toBe(0.25);
    expect(r.delta.signupsPct).toBeCloseTo((10 - 8) / 8, 6);
    expect(r.delta.activationRatePoints).toBeCloseTo(0.25, 6);
  });

  it("guards divide-by-zero when previous period had no signups", async () => {
    const now = new Date("2026-03-04T12:00:00Z");
    const currentStart = startOfUtcPeriod(now, "week").toISOString();
    const db = fakeDb((sql, params) => {
      if (sql.toLowerCase().includes("left join funnel_events a")) {
        const from = (params[0] as Date).toISOString();
        return from === currentStart
          ? { rows: [{ signups: 4, activated: 1 }], rowCount: 1 }
          : { rows: [{ signups: 0, activated: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = await periodComparison(db, "week", now);
    expect(r.delta.signupsPct).toBeNull();
    expect(r.previous.activationRate).toBe(0);
  });
});

describe("funnelHealth", () => {
  const now = new Date("2026-03-10T00:00:00Z");

  function healthDb(pipeline: Record<string, unknown>, quality: Record<string, number>): PgClient {
    return fakeDb((sql) => {
      const t = sql.toLowerCase();
      if (t.includes("last_event_at")) return { rows: [pipeline], rowCount: 1 };
      if (t.includes("orphan_activations")) return { rows: [quality], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }

  it("reports ok + freshness when clean", async () => {
    const h = await funnelHealth(
      healthDb(
        { total: 100, signups: 60, activations: 40, last_event_at: new Date("2026-03-09T23:00:00Z") },
        { orphan_activations: 0, reversed_timestamps: 0, activation_drift: 0, signup_event_drift: 0 }
      ),
      now
    );
    expect(h.pipeline.status).toBe("ok");
    expect(h.pipeline.totalEvents).toBe(100);
    expect(h.pipeline.freshnessMs).toBe(60 * 60 * 1000); // 1h
    expect(h.dataQuality.status).toBe("ok");
    expect(h.dataQuality.checks.every((c) => c.ok)).toBe(true);
  });

  it("escalates to error on orphan activations, warn on drift", async () => {
    const errH = await funnelHealth(
      healthDb(
        { total: 10, signups: 6, activations: 4, last_event_at: new Date("2026-03-09T23:00:00Z") },
        { orphan_activations: 2, reversed_timestamps: 0, activation_drift: 5, signup_event_drift: 0 }
      ),
      now
    );
    expect(errH.dataQuality.status).toBe("error"); // error severity wins over warn
    expect(errH.dataQuality.checks.find((c) => c.id === "orphan_activations")?.ok).toBe(false);

    const warnH = await funnelHealth(
      healthDb(
        { total: 10, signups: 6, activations: 4, last_event_at: new Date("2026-03-09T23:00:00Z") },
        { orphan_activations: 0, reversed_timestamps: 0, activation_drift: 5, signup_event_drift: 1 }
      ),
      now
    );
    expect(warnH.dataQuality.status).toBe("warn");
  });

  it("reports empty pipeline when no events", async () => {
    const h = await funnelHealth(
      healthDb(
        { total: 0, signups: 0, activations: 0, last_event_at: null },
        { orphan_activations: 0, reversed_timestamps: 0, activation_drift: 0, signup_event_drift: 0 }
      ),
      now
    );
    expect(h.pipeline.status).toBe("empty");
    expect(h.pipeline.freshnessMs).toBeNull();
  });

  it("returns empty health for a null db", async () => {
    const h = await funnelHealth(null, now);
    expect(h.pipeline.status).toBe("empty");
    expect(h.dataQuality.checks).toEqual([]);
  });
});

describe("retentionCurve — non-cumulative active-per-period", () => {
  it("computes per-period retention rates (not cumulative)", async () => {
    const db = fakeDb((sql) => {
      const t = sql.toLowerCase();
      if (t.includes("as size")) {
        return { rows: [{ cohort: new Date("2026-03-02T00:00:00Z"), size: 10 }], rowCount: 1 };
      }
      if (t.includes("period_offset")) {
        return {
          rows: [
            { cohort: new Date("2026-03-02T00:00:00Z"), period_offset: 0, n: 10 },
            { cohort: new Date("2026-03-02T00:00:00Z"), period_offset: 1, n: 4 },
            { cohort: new Date("2026-03-02T00:00:00Z"), period_offset: 2, n: 2 }
          ],
          rowCount: 3
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = await retentionCurve(db, { cohortBy: "week", periods: 3, from: new Date("2026-01-01T00:00:00Z") });
    const c = r.cohorts[0];
    expect(c.size).toBe(10);
    expect(c.cells.map((x) => x.active)).toEqual([10, 4, 2, 0]); // NOT cumulative
    expect(c.cells.map((x) => x.rate)).toEqual([1, 0.4, 0.2, 0]);
  });

  it("returns empty for a null db", async () => {
    const r = await retentionCurve(null, { cohortBy: "week", periods: 4, from: new Date() });
    expect(r).toEqual({ cohortBy: "week", periods: 4, cohorts: [] });
  });
});
