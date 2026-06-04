/**
 * Phase 2 funnel analytics — Postgres contract.
 *
 * Proves against REAL Postgres what the unit suites mock:
 *   • cohortFunnel computes cumulative activation by week offset (date_trunc +
 *     epoch-offset arithmetic).
 *   • segmentedFunnel slices by tenant plan via the signups⋈tenants join.
 *   • funnelHealth detects orphan activations and reversed timestamps.
 *   • evaluateFunnelAlerts fires, persists fired_at, and debounces (changed only
 *     on transition) via the ON CONFLICT upsert in funnel_alert_state.
 *
 * Skips cleanly when neither Docker nor INTEGRATION_DATABASE_URL is available.
 */
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { tryStartHarness, type PgHarness } from "./harness.js";
import { cohortFunnel, segmentedFunnel, funnelHealth } from "../../../src/application/analytics/funnelAnalytics.js";
import { evaluateFunnelAlerts, type FunnelAlertConfig } from "../../../src/application/analytics/funnelAlerts.js";

const harness = await tryStartHarness();
afterAll(async () => { if (harness) await harness.stop(); });

async function reset(h: PgHarness): Promise<void> {
  await h.pg.query("truncate funnel_events, signups, tenants cascade");
}
async function tenant(h: PgHarness, id: string, plan = "starter"): Promise<void> {
  await h.pg.query(
    `insert into tenants (id, name, plan, created_at, updated_at) values ($1,$1,$2,now(),now())
     on conflict (id) do update set plan = excluded.plan`,
    [id, plan]
  );
}
async function signupEvent(h: PgHarness, t: string, at: string, source = "direct"): Promise<void> {
  await h.pg.query(
    `insert into funnel_events (id, tenant_id, event_type, occurred_at, source, dedupe_key)
     values (gen_random_uuid()::text, $1, 'signup', $2, $3, 'signup:'||$1)`,
    [t, at, source]
  );
}
async function activationEvent(h: PgHarness, t: string, at: string): Promise<void> {
  await h.pg.query(
    `insert into funnel_events (id, tenant_id, event_type, occurred_at, dedupe_key)
     values (gen_random_uuid()::text, $1, 'activation', $2, 'activation:'||$1)`,
    [t, at]
  );
}
async function signupRow(h: PgHarness, t: string, activated: boolean): Promise<void> {
  await h.pg.query(
    `insert into api_keys (id, tenant_id, name, key_hash, key_prefix, role)
     values ('key-'||$1, $1, 'k', 'hash-'||$1, 'sk_live_test', 'developer') on conflict (id) do nothing`,
    [t]
  );
  await h.pg.query(
    `insert into signups (id, email, tenant_id, api_key_id, created_at, activated_at)
     values ('s-'||$1, $1||'@x.com', $1, 'key-'||$1, now(), $2)`,
    [t, activated ? new Date().toISOString() : null]
  );
}

describe.skipIf(!harness)("Phase 2 funnel analytics — Postgres contract", () => {
  beforeEach(async () => { await reset(harness!); });

  it("cohortFunnel computes cumulative weekly activation", async () => {
    const h = harness!;
    for (const id of ["w1a", "w1b", "w1c"]) await tenant(h, id);
    // Cohort week of 2026-03-02 (Monday): 3 signups.
    await signupEvent(h, "w1a", "2026-03-02T10:00:00Z");
    await signupEvent(h, "w1b", "2026-03-02T11:00:00Z");
    await signupEvent(h, "w1c", "2026-03-02T12:00:00Z");
    await activationEvent(h, "w1a", "2026-03-03T10:00:00Z"); // offset 0
    await activationEvent(h, "w1b", "2026-03-11T10:00:00Z"); // 9 days → offset 1
    // w1c never activates.

    const report = await cohortFunnel(h.pg, { cohortBy: "week", periods: 3, from: new Date("2026-01-01T00:00:00Z") });
    expect(report.cohorts).toHaveLength(1);
    const c = report.cohorts[0];
    expect(c.cohort.slice(0, 10)).toBe("2026-03-02");
    expect(c.size).toBe(3);
    expect(c.cells.map((x) => x.activated)).toEqual([1, 2, 2, 2]);
    expect(c.cells[0].rate).toBeCloseTo(1 / 3, 6);
    expect(c.cells[1].rate).toBeCloseTo(2 / 3, 6);
  });

  it("segmentedFunnel slices by plan", async () => {
    const h = harness!;
    await tenant(h, "p1", "starter");
    await tenant(h, "p2", "starter");
    await tenant(h, "p3", "growth");
    await signupRow(h, "p1", true);
    await signupRow(h, "p2", false);
    await signupRow(h, "p3", true);

    const r = await segmentedFunnel(h.pg, "plan");
    const byKey = Object.fromEntries(r.segments.map((s) => [s.key, s]));
    expect(byKey.starter).toMatchObject({ signups: 2, activated: 1 });
    expect(byKey.growth).toMatchObject({ signups: 1, activated: 1 });
    expect(r.totals).toMatchObject({ signups: 3, activated: 2 });
  });

  it("funnelHealth detects orphan activations and reversed timestamps", async () => {
    const h = harness!;
    await tenant(h, "good");
    await tenant(h, "orphan");
    await tenant(h, "reversed");
    // Clean pair.
    await signupEvent(h, "good", "2026-03-02T10:00:00Z");
    await activationEvent(h, "good", "2026-03-03T10:00:00Z");
    // Orphan: activation with no signup.
    await activationEvent(h, "orphan", "2026-03-04T10:00:00Z");
    // Reversed: activation before signup.
    await signupEvent(h, "reversed", "2026-03-10T10:00:00Z");
    await activationEvent(h, "reversed", "2026-03-05T10:00:00Z");

    const health = await funnelHealth(h.pg);
    expect(health.pipeline.status).toBe("ok");
    expect(health.pipeline.totalEvents).toBe(5);
    const byId = Object.fromEntries(health.dataQuality.checks.map((c) => [c.id, c]));
    expect(byId.orphan_activations.count).toBe(1);
    expect(byId.reversed_timestamps.count).toBe(1);
    expect(health.dataQuality.status).toBe("error");
  });

  it("evaluateFunnelAlerts fires on low rate and debounces across evaluations", async () => {
    const h = harness!;
    const config: FunnelAlertConfig = {
      enabled: true, minActivationRate: 0.2, activationWindowDays: 7, minSample: 10, maxSignupGapHours: 48
    };
    // 12 recent signups, 1 activation → ~8% rate, below the 20% floor.
    for (let i = 0; i < 12; i++) {
      await tenant(h, `a${i}`);
      await signupEvent(h, `a${i}`, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    }
    await activationEvent(h, "a0", new Date().toISOString());

    const first = await evaluateFunnelAlerts(h.pg, config);
    const r1 = first.alerts.find((a) => a.ruleId === "low_activation_rate")!;
    expect(r1.status).toBe("firing");
    expect(r1.changed).toBe(true);
    expect(r1.firedAt).not.toBeNull();

    const second = await evaluateFunnelAlerts(h.pg, config);
    const r2 = second.alerts.find((a) => a.ruleId === "low_activation_rate")!;
    expect(r2.status).toBe("firing");
    expect(r2.changed).toBe(false); // debounced — same fired_at preserved
    expect(r2.firedAt).toBe(r1.firedAt);

    // Persisted state row exists and is firing.
    const { rows } = await h.pg.query<{ status: string; fired_at: Date | null }>(
      "select status, fired_at from funnel_alert_state where rule_id = 'low_activation_rate'"
    );
    expect(rows[0].status).toBe("firing");
    expect(rows[0].fired_at).not.toBeNull();
  });
});
