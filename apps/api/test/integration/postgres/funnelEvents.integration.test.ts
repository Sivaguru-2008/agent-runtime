/**
 * Funnel event log — Postgres contract.
 *
 * Proves against a REAL Postgres (testcontainer or external) what the unit
 * suites mock:
 *   1. The backfill projects every signups row into funnel_events exactly once
 *      (one signup event per row, one activation event per activated tenant).
 *   2. The dedupe_key UNIQUE index makes recording idempotent — re-running the
 *      backfill, and re-recording a live event, never duplicates a row.
 *   3. historicalFunnel computed from the event log reproduces the cohort
 *      counts (signups-by-signup-day, with activations attributed to the
 *      signup cohort).
 *
 * Skips cleanly (single line) when neither Docker nor INTEGRATION_DATABASE_URL
 * is available — same contract as the other *.integration.test.ts here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryStartHarness, type PgHarness } from "./harness.js";
import { historicalFunnel } from "../../../src/application/analytics/funnelQueries.js";
import { recordFunnelEvent, funnelDedupe } from "../../../src/application/analytics/funnelEvents.js";

const harness = await tryStartHarness();

afterAll(async () => {
  if (harness) await harness.stop();
});

// Inline the backfill's two inserts (the .mjs script connects on its own; here
// we drive the same SQL through the harness client).
async function runBackfill(h: PgHarness): Promise<void> {
  await h.pg.query(
    `insert into funnel_events
       (id, tenant_id, event_type, occurred_at, source, dedupe_key, properties)
     select gen_random_uuid()::text, s.tenant_id, 'signup', s.created_at,
            coalesce(s.source_norm, 'direct'), 'signup:' || s.tenant_id, '{}'::jsonb
       from signups s
       on conflict (dedupe_key) do nothing`
  );
  await h.pg.query(
    `insert into funnel_events
       (id, tenant_id, event_type, occurred_at, dedupe_key, properties)
     select gen_random_uuid()::text, s.tenant_id, 'activation', s.activated_at,
            'activation:' || s.tenant_id, '{}'::jsonb
       from signups s
      where s.activated_at is not null
       on conflict (dedupe_key) do nothing`
  );
}

async function seedSignup(
  h: PgHarness,
  id: string,
  source: string | null,
  createdAt: string,
  activatedAt: string | null
): Promise<void> {
  await h.pg.query(
    `insert into tenants (id, name, plan, created_at, updated_at)
     values ($1, $1, 'starter', now(), now()) on conflict (id) do nothing`,
    [id]
  );
  await h.pg.query(
    `insert into api_keys (id, tenant_id, name, key_hash, key_prefix, role)
     values ($1, $2, 'k', $3, 'sk_live_test', 'developer') on conflict (id) do nothing`,
    [`key-${id}`, id, `hash-${id}`]
  );
  await h.pg.query(
    `insert into signups (id, email, tenant_id, api_key_id, source, source_norm, created_at, activated_at)
     values ($1, $2, $3, $4, $5, $5, $6, $7)`,
    [`signup-${id}`, `${id}@x.com`, id, `key-${id}`, source, createdAt, activatedAt]
  );
}

describe.skipIf(!harness)("funnel_events — Postgres contract", () => {
  beforeAll(async () => {
    const h = harness!;
    // Cohort on 2026-03-01: 3 signups, 2 activated. Cohort on 2026-03-10: 1/1.
    await seedSignup(h, "alpha", "direct", "2026-03-01T09:00:00Z", "2026-03-02T10:00:00Z");
    await seedSignup(h, "bravo", "direct", "2026-03-01T11:00:00Z", "2026-03-05T10:00:00Z");
    await seedSignup(h, "gamma", "direct", "2026-03-01T13:00:00Z", null);
    await seedSignup(h, "delta", "docs", "2026-03-10T08:00:00Z", "2026-03-11T08:00:00Z");
    await runBackfill(h);
  });

  it("backfills one signup event per row and one activation per activated tenant", async () => {
    const { rows } = await harness!.pg.query<{ event_type: string; n: number }>(
      `select event_type, count(*)::int as n from funnel_events group by event_type`
    );
    const by = Object.fromEntries(rows.map((r) => [r.event_type, r.n]));
    expect(by.signup).toBe(4);
    expect(by.activation).toBe(3);
  });

  it("is idempotent: re-running the backfill inserts nothing new", async () => {
    await runBackfill(harness!);
    const { rows } = await harness!.pg.query<{ n: number }>(
      `select count(*)::int as n from funnel_events`
    );
    expect(rows[0].n).toBe(7); // 4 signup + 3 activation, unchanged
  });

  it("dedupe_key blocks a duplicate live event for an already-recorded tenant", async () => {
    recordFunnelEvent(harness!.pg, {
      tenantId: "alpha",
      eventType: "signup",
      dedupeKey: funnelDedupe.signup("alpha")
    });
    // Let the fire-and-forget insert settle.
    await new Promise((r) => setTimeout(r, 100));
    const { rows } = await harness!.pg.query<{ n: number }>(
      `select count(*)::int as n from funnel_events where dedupe_key = 'signup:alpha'`
    );
    expect(rows[0].n).toBe(1);
  });

  it("historicalFunnel reproduces cohort counts from the event log", async () => {
    const result = await historicalFunnel(harness!.pg, {
      from: new Date("2026-02-01T00:00:00Z"),
      to: new Date("2026-04-01T00:00:00Z"),
      granularity: "day"
    });
    // Two non-empty signup days.
    const byDay = Object.fromEntries(
      result.buckets.map((b) => [b.bucket.slice(0, 10), b])
    );
    expect(byDay["2026-03-01"]).toMatchObject({ signups: 3, activated: 2 });
    expect(byDay["2026-03-10"]).toMatchObject({ signups: 1, activated: 1 });
    expect(result.totals.signups).toBe(4);
    expect(result.totals.activated).toBe(3);
  });
});
