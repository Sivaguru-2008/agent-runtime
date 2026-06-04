/**
 * Funnel daily rollup — the scale path for the historical/trend funnel
 * (Phase 3, capability 13).
 *
 * refreshFunnelDaily() pre-aggregates the cohort funnel (signup ⋈ activation)
 * into funnel_daily (migration 0032), one row per UTC signup-day. dailyFunnel()
 * then serves day/week/month trend queries from that small table instead of
 * re-scanning funnel_events on every dashboard poll. Because cohort membership
 * is keyed by signup-day, weekly/monthly buckets are exact sums of daily rows,
 * so the rollup is cohort-correct under re-bucketing.
 *
 * Same UTC truncation idiom as the rest of the analytics layer: truncate in UTC
 * and re-anchor to a UTC timestamptz so node-pg never reinterprets a bare
 * timestamp in the host's local zone.
 */

import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";
import type { FunnelGranularity, FunnelHistory, FunnelHistoryBucket } from "./funnelQueries.js";

export interface RefreshResult {
  /** Number of signup-day rows in the rollup after the refresh. */
  days: number;
  refreshedAt: string;
}

/**
 * Recompute the entire funnel_daily rollup from funnel_events (idempotent
 * upsert). A full recompute is the simplest correct strategy; it is a batch job
 * off the hot path, not a per-request cost. Returns the row count for logging.
 * No-op (days: 0) when db is null.
 */
export async function refreshFunnelDaily(db: PgClient | null): Promise<RefreshResult> {
  const refreshedAt = new Date().toISOString();
  if (!db) return { days: 0, refreshedAt };

  await db.query(
    `insert into funnel_daily (day, signups, cohort_activated, refreshed_at)
     select (date_trunc('day', s.occurred_at at time zone 'UTC') at time zone 'UTC')::date as day,
            count(*)::int as signups,
            count(a.tenant_id)::int as cohort_activated,
            now()
       from funnel_events s
       left join funnel_events a
         on a.tenant_id = s.tenant_id and a.event_type = 'activation'
      where s.event_type = 'signup'
      group by 1
     on conflict (day) do update set
       signups = excluded.signups,
       cohort_activated = excluded.cohort_activated,
       refreshed_at = now()`
  );

  const { rows } = await db.query<{ n: number | string }>(`select count(*)::int as n from funnel_daily`);
  return { days: Number(rows[0]?.n ?? 0), refreshedAt };
}

/**
 * Serve the historical funnel from the daily rollup, re-bucketed to the
 * requested granularity. Returns the identical FunnelHistory shape as
 * historicalFunnel() so the route + UI are source-agnostic. A null db (or an
 * unpopulated rollup) yields a well-formed empty window.
 */
export async function dailyFunnel(
  db: PgClient | null,
  params: { from: Date; to: Date; granularity: FunnelGranularity }
): Promise<FunnelHistory> {
  const { from, to, granularity } = params;
  const empty: FunnelHistory = {
    from: from.toISOString(),
    to: to.toISOString(),
    granularity,
    buckets: [],
    totals: { signups: 0, activated: 0, activationRate: 0 }
  };
  if (!db) return empty;

  // `day` is a pure date. Cast to a NAIVE timestamp (no tz) and date_trunc that
  // directly — truncating a timestamptz would run in the session timezone and
  // shift the bucket. The single trailing `at time zone 'UTC'` anchors the naive
  // wall-clock to a UTC timestamptz so node-pg parses it unambiguously.
  const { rows } = await db.query<{ bucket: Date | string; signups: number | string; activated: number | string }>(
    `select (date_trunc($3, day::timestamp) at time zone 'UTC') as bucket,
            sum(signups)::int as signups,
            sum(cohort_activated)::int as activated
       from funnel_daily
      where day >= $1::date
        and day <  $2::date
      group by 1
      order by 1`,
    [from, to, granularity]
  );

  let totalSignups = 0;
  let totalActivated = 0;
  const buckets: FunnelHistoryBucket[] = rows.map((r) => {
    const signups = Number(r.signups);
    const activated = Number(r.activated);
    totalSignups += signups;
    totalActivated += activated;
    const bucket = r.bucket instanceof Date ? r.bucket.toISOString() : new Date(r.bucket).toISOString();
    return { bucket, signups, activated, activationRate: signups > 0 ? activated / signups : 0 };
  });

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    granularity,
    buckets,
    totals: {
      signups: totalSignups,
      activated: totalActivated,
      activationRate: totalSignups > 0 ? totalActivated / totalSignups : 0
    }
  };
}
