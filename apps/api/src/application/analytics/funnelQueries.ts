/**
 * Historical funnel analytics — read side of the funnel event log.
 *
 * The v0 funnel is a single point-in-time aggregate. This module answers the
 * time-based questions that requires an event stream:
 *   "How did signup → activation conversion move week over week?"
 *
 * Cohort semantics (important): buckets are keyed by SIGNUP time. For each
 * bucket we count the tenants that signed up in it, and how many of those
 * tenants ever activated. So `activated` in the March bucket means "tenants who
 * signed up in March and have since activated" — NOT "activations that happened
 * in March". That is the honest, decision-useful definition of a funnel over
 * time (a naive activations-per-bucket / signups-per-bucket ratio mixes cohorts
 * and is misleading).
 *
 * Correctness rests on the dedupe guarantee from 0029: at most one 'signup' and
 * one 'activation' event per tenant, so the LEFT JOIN is strictly 1:≤1 and
 * counts can never be inflated.
 *
 * At Phase-1 data volumes this reads funnel_events directly. The Phase-3
 * performance work introduces a daily rollup to serve this without scanning raw
 * events; the API contract here does not change when that lands.
 */

import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";

export type FunnelGranularity = "day" | "week" | "month";

export interface FunnelHistoryBucket {
  /** Bucket start, ISO-8601 UTC (e.g. "2026-03-01T00:00:00.000Z"). */
  bucket: string;
  /** Tenants who signed up within this bucket. */
  signups: number;
  /** Of those, how many have ever activated. */
  activated: number;
  /** activated / signups (0 when signups === 0). */
  activationRate: number;
}

export interface FunnelHistory {
  from: string;
  to: string;
  granularity: FunnelGranularity;
  buckets: FunnelHistoryBucket[];
  totals: {
    signups: number;
    activated: number;
    activationRate: number;
  };
}

export interface HistoricalFunnelParams {
  /** Inclusive lower bound on signup time. */
  from: Date;
  /** Exclusive upper bound on signup time. */
  to: Date;
  granularity: FunnelGranularity;
}

const VALID_GRANULARITIES: ReadonlySet<string> = new Set(["day", "week", "month"]);

/** Narrow an arbitrary string to a FunnelGranularity, defaulting to "day". */
export function coerceGranularity(raw: string | undefined | null): FunnelGranularity {
  return raw && VALID_GRANULARITIES.has(raw) ? (raw as FunnelGranularity) : "day";
}

interface HistoryRow {
  bucket: Date | string;
  signups: number | string;
  activated: number | string;
}

function toIso(bucket: Date | string): string {
  return bucket instanceof Date ? bucket.toISOString() : new Date(bucket).toISOString();
}

/**
 * Compute the signup→activation funnel bucketed by signup time over [from, to).
 *
 * Returns zero buckets (not an error) for an empty range. A null db (MEMORY
 * mode) yields an empty, well-formed result so callers never branch on it.
 */
export async function historicalFunnel(
  db: PgClient | null,
  params: HistoricalFunnelParams
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

  // date_trunc's unit accepts a text parameter; granularity is validated to a
  // closed set by coerceGranularity before it reaches here.
  //
  // Timezone handling (critical): `occurred_at at time zone 'UTC'` yields the
  // UTC wall-clock as a `timestamp WITHOUT time zone`, which date_trunc then
  // truncates in UTC. We immediately re-apply `at time zone 'UTC'` to convert
  // that wall-clock back to a `timestamptz` anchored at UTC. Without the second
  // conversion node-pg would parse the bare timestamp in the server's LOCAL
  // timezone and shift the bucket date (e.g. UTC+5:30 would roll midnight back
  // a day). The double conversion makes buckets deterministic on any host.
  const { rows } = await db.query<HistoryRow>(
    `select (date_trunc($3, s.occurred_at at time zone 'UTC') at time zone 'UTC') as bucket,
            count(*)::int as signups,
            count(a.tenant_id)::int as activated
       from funnel_events s
       left join funnel_events a
         on a.tenant_id = s.tenant_id
        and a.event_type = 'activation'
      where s.event_type = 'signup'
        and s.occurred_at >= $1
        and s.occurred_at <  $2
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
    return {
      bucket: toIso(r.bucket),
      signups,
      activated,
      activationRate: signups > 0 ? activated / signups : 0
    };
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
