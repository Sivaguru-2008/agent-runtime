/**
 * Backfill the append-only funnel event log (migration 0029_funnel_events)
 * from the existing `signups` table.
 *
 * Why:
 *   funnel_events is the source of truth for all historical / cohort / trend
 *   analytics. Tenants that signed up (and possibly activated) BEFORE the event
 *   log existed have no events, so the history endpoint would under-count them.
 *   This script projects every existing signups row into the event log so the
 *   funnel-from-events reproduces the legacy funnel-from-columns exactly.
 *
 * What it writes:
 *   • one 'signup' event per signups row      (occurred_at = signups.created_at)
 *   • one 'activation' event per activated row (occurred_at = signups.activated_at)
 *
 * Idempotent + re-runnable:
 *   Both inserts are `on conflict (dedupe_key) do nothing` with the same
 *   deterministic keys the live write path uses ('signup:<tenant>',
 *   'activation:<tenant>'). Running it twice — or alongside live traffic that
 *   already emitted some events — never duplicates a row.
 *
 * Usage:  node apps/api/scripts/backfill-funnel-events.mjs
 * Reads DATABASE_URL from the environment, falling back to apps/api/.env.
 * Requires migrations 0029 + 0030 to have been applied first.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pg = require("pg");
const here = dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: resolve(here, "..", ".env") });
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (env or apps/api/.env). Aborting.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  // Signup events: one per signups row. source prefers the normalized slug,
  // falling back to 'direct' so every event carries a concrete bucket (matches
  // the live write path, which normalizes a missing source to 'direct').
  const signupResult = await client.query(
    `insert into funnel_events
       (id, tenant_id, event_type, occurred_at,
        source, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
        referrer, landing_path, dedupe_key, properties)
     select gen_random_uuid()::text, s.tenant_id, 'signup', s.created_at,
            coalesce(s.source_norm, 'direct'),
            s.utm_source, s.utm_medium, s.utm_campaign, s.utm_term, s.utm_content,
            s.referrer, s.landing_path,
            'signup:' || s.tenant_id, '{}'::jsonb
       from signups s
       on conflict (dedupe_key) do nothing`
  );

  // Activation events: one per activated tenant, stamped at activated_at.
  const activationResult = await client.query(
    `insert into funnel_events
       (id, tenant_id, event_type, occurred_at, dedupe_key, properties)
     select gen_random_uuid()::text, s.tenant_id, 'activation', s.activated_at,
            'activation:' || s.tenant_id, '{}'::jsonb
       from signups s
      where s.activated_at is not null
       on conflict (dedupe_key) do nothing`
  );

  // Report: rows inserted this run vs. total now present (so re-runs read as 0
  // new / N total rather than looking like a no-op failure).
  const { rows: totals } = await client.query(
    `select event_type, count(*)::int as n
       from funnel_events
      where event_type in ('signup', 'activation')
      group by event_type`
  );
  const totalBy = Object.fromEntries(totals.map((r) => [r.event_type, r.n]));

  console.log("[backfill-funnel-events] done.");
  console.log(`  signup     events inserted this run: ${signupResult.rowCount ?? 0}` +
              `  (total now: ${totalBy.signup ?? 0})`);
  console.log(`  activation events inserted this run: ${activationResult.rowCount ?? 0}` +
              `  (total now: ${totalBy.activation ?? 0})`);
} catch (err) {
  console.error("[backfill-funnel-events] FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.end();
}
