/**
 * Phase 3 funnel — Postgres contract for the daily rollup + retention.
 *
 *   • refreshFunnelDaily populates funnel_daily and dailyFunnel() reproduces
 *     historicalFunnel() EXACTLY (cohort-correct under day + week re-bucketing).
 *   • retentionCurve computes non-cumulative active-per-period from
 *     retention_ping events.
 *
 * Skips cleanly when neither Docker nor INTEGRATION_DATABASE_URL is available.
 */
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { tryStartHarness, type PgHarness } from "./harness.js";
import { historicalFunnel } from "../../../src/application/analytics/funnelQueries.js";
import { refreshFunnelDaily, dailyFunnel } from "../../../src/application/analytics/funnelRollup.js";
import { retentionCurve } from "../../../src/application/analytics/funnelAnalytics.js";

const harness = await tryStartHarness();
afterAll(async () => { if (harness) await harness.stop(); });

async function reset(h: PgHarness): Promise<void> {
  await h.pg.query("truncate funnel_events, funnel_daily, signups, tenants cascade");
}
async function tenant(h: PgHarness, id: string): Promise<void> {
  await h.pg.query(
    `insert into tenants (id, name, plan, created_at, updated_at) values ($1,$1,'starter',now(),now())
     on conflict (id) do nothing`,
    [id]
  );
}
async function ev(h: PgHarness, t: string, type: string, at: string, dedupeSuffix = ""): Promise<void> {
  await h.pg.query(
    `insert into funnel_events (id, tenant_id, event_type, occurred_at, dedupe_key)
     values (gen_random_uuid()::text, $1, $2, $3, $2||':'||$1||$4)`,
    [t, type, at, dedupeSuffix]
  );
}

describe.skipIf(!harness)("Phase 3 funnel — rollup + retention Postgres contract", () => {
  beforeEach(async () => { await reset(harness!); });

  it("dailyFunnel reproduces historicalFunnel after a rollup refresh", async () => {
    const h = harness!;
    // Two signup days, mixed activation, spanning a week boundary.
    for (const id of ["a", "b", "c", "d", "e"]) await tenant(h, id);
    await ev(h, "a", "signup", "2026-03-02T09:00:00Z");
    await ev(h, "b", "signup", "2026-03-02T10:00:00Z");
    await ev(h, "c", "signup", "2026-03-03T10:00:00Z");
    await ev(h, "d", "signup", "2026-03-09T10:00:00Z");
    await ev(h, "e", "signup", "2026-03-10T10:00:00Z");
    await ev(h, "a", "activation", "2026-03-04T10:00:00Z");
    await ev(h, "c", "activation", "2026-03-06T10:00:00Z");
    await ev(h, "d", "activation", "2026-03-12T10:00:00Z");

    const refresh = await refreshFunnelDaily(h.pg);
    expect(refresh.days).toBeGreaterThan(0);

    const range = { from: new Date("2026-02-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") };
    for (const granularity of ["day", "week"] as const) {
      const live = await historicalFunnel(h.pg, { ...range, granularity });
      const rollup = await dailyFunnel(h.pg, { ...range, granularity });
      expect(rollup.buckets).toEqual(live.buckets);
      expect(rollup.totals).toEqual(live.totals);
    }
  });

  it("retentionCurve computes non-cumulative active-per-period", async () => {
    const h = harness!;
    for (const id of ["r1", "r2"]) await tenant(h, id);
    // Cohort week of 2026-03-02.
    await ev(h, "r1", "signup", "2026-03-02T09:00:00Z");
    await ev(h, "r2", "signup", "2026-03-02T09:00:00Z");
    // r1 active in week 0 and week 1; r2 active only week 0.
    await ev(h, "r1", "retention_ping", "2026-03-02T12:00:00Z", ":d0");
    await ev(h, "r1", "retention_ping", "2026-03-10T12:00:00Z", ":d1"); // 8 days → offset 1
    await ev(h, "r2", "retention_ping", "2026-03-03T12:00:00Z", ":d0");

    const report = await retentionCurve(h.pg, { cohortBy: "week", periods: 3, from: new Date("2026-01-01T00:00:00Z") });
    expect(report.cohorts).toHaveLength(1);
    const c = report.cohorts[0];
    expect(c.size).toBe(2);
    expect(c.cells.map((x) => x.active)).toEqual([2, 1, 0, 0]); // wk0 both, wk1 only r1
    expect(c.cells[0].rate).toBe(1);
    expect(c.cells[1].rate).toBe(0.5);
  });
});
