/**
 * Phase 2 funnel analytics — cohorts, segmentation, period-over-period,
 * data-quality validation, and pipeline health.
 *
 * All reads derive from the append-only funnel_events log (migration 0029) and,
 * for segmentation, the durable signups/tenants records. Two cross-cutting
 * rules carried over from Phase 1:
 *   • TIMEZONE: bucket/cohort truncation is done in UTC and re-anchored to a
 *     UTC timestamptz (`date_trunc(...) at time zone 'UTC'`) so node-pg never
 *     reinterprets a bare timestamp in the host's local zone and shifts a date.
 *   • DEDUPE-BACKED JOINS: at most one signup and one activation event per
 *     tenant (0029 unique dedupe_key), so every signup⋈activation join is 1:≤1
 *     and counts can never be inflated by a fan-out.
 *
 * Every function degrades to a well-formed empty result for a null db (MEMORY
 * mode) so route handlers never branch on it.
 */

import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";

// ── Cohort analysis ─────────────────────────────────────────────────────────

export type CohortGranularity = "week" | "month";

export interface CohortCell {
  /** Periods elapsed since the cohort's signup period (0 = signup period). */
  period: number;
  /** Cumulative tenants in the cohort activated by the end of this period. */
  activated: number;
  /** activated / cohort size (0 when the cohort is empty). */
  rate: number;
}

export interface Cohort {
  /** Cohort start (signup period), ISO-8601 UTC. */
  cohort: string;
  /** Tenants that signed up in this period. */
  size: number;
  /** Cumulative activation by period offset, index 0..periods. */
  cells: CohortCell[];
}

export interface CohortReport {
  cohortBy: CohortGranularity;
  /** Number of trailing offset columns (0..periods inclusive). */
  periods: number;
  cohorts: Cohort[];
}

export interface CohortParams {
  cohortBy: CohortGranularity;
  /** Trailing offset columns to compute (default 8). */
  periods: number;
  /** Inclusive lower bound on signup time. */
  from: Date;
}

const COHORT_GRANULARITIES: ReadonlySet<string> = new Set(["week", "month"]);
export function coerceCohortGranularity(raw: string | undefined | null): CohortGranularity {
  return raw && COHORT_GRANULARITIES.has(raw) ? (raw as CohortGranularity) : "week";
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/**
 * Cohort activation triangle: tenants grouped by signup period, measured by how
 * many had activated within N periods of signing up. A cell is CUMULATIVE — the
 * "period 2" cell counts everyone activated by the end of period 2, so each
 * cohort's row is monotonically non-decreasing.
 */
export async function cohortFunnel(db: PgClient | null, params: CohortParams): Promise<CohortReport> {
  const periods = Math.max(0, Math.min(52, Math.trunc(params.periods)));
  const empty: CohortReport = { cohortBy: params.cohortBy, periods, cohorts: [] };
  if (!db) return empty;

  // Cohort sizes (signups per period).
  const { rows: sizeRows } = await db.query<{ cohort: Date | string; size: number | string }>(
    `select (date_trunc($1, s.occurred_at at time zone 'UTC') at time zone 'UTC') as cohort,
            count(*)::int as size
       from funnel_events s
      where s.event_type = 'signup'
        and s.occurred_at >= $2
      group by 1
      order by 1`,
    [params.cohortBy, params.from]
  );

  // Activation offsets: how many periods after its signup did each activated
  // tenant activate. Week offsets use elapsed seconds / 1 week; month offsets
  // use calendar-month age so irregular month lengths don't drift the column.
  const offsetExpr =
    params.cohortBy === "month"
      ? `(extract(year from age(a.occurred_at, s.occurred_at)) * 12
          + extract(month from age(a.occurred_at, s.occurred_at)))::int`
      : `floor(extract(epoch from (a.occurred_at - s.occurred_at)) / 604800)::int`;

  const { rows: offsetRows } = await db.query<{
    cohort: Date | string;
    period_offset: number | string;
    n: number | string;
  }>(
    `select (date_trunc($1, s.occurred_at at time zone 'UTC') at time zone 'UTC') as cohort,
            ${offsetExpr} as period_offset,
            count(*)::int as n
       from funnel_events s
       join funnel_events a
         on a.tenant_id = s.tenant_id
        and a.event_type = 'activation'
      where s.event_type = 'signup'
        and s.occurred_at >= $2
      group by 1, 2`,
    [params.cohortBy, params.from]
  );

  // Index activation counts by cohort → offset → n.
  const byCohort = new Map<string, Map<number, number>>();
  for (const r of offsetRows) {
    const key = toIso(r.cohort);
    // Clamp negative offsets (activation before signup = a data error, surfaced
    // separately by data-quality) into period 0 so they never vanish.
    const offset = Math.max(0, Number(r.period_offset));
    const inner = byCohort.get(key) ?? new Map<number, number>();
    inner.set(offset, (inner.get(offset) ?? 0) + Number(r.n));
    byCohort.set(key, inner);
  }

  const cohorts: Cohort[] = sizeRows.map((sr) => {
    const cohortKey = toIso(sr.cohort);
    const size = Number(sr.size);
    const offsets = byCohort.get(cohortKey) ?? new Map<number, number>();
    let cumulative = 0;
    const cells: CohortCell[] = [];
    for (let p = 0; p <= periods; p++) {
      cumulative += offsets.get(p) ?? 0;
      cells.push({ period: p, activated: cumulative, rate: size > 0 ? cumulative / size : 0 });
    }
    return { cohort: cohortKey, size, cells };
  });

  return { cohortBy: params.cohortBy, periods, cohorts };
}

// ── Segmentation ──────────────────────────────────────────────────────────

export type SegmentDimension = "source" | "plan" | "invite" | "campaign";

export interface FunnelSegment {
  key: string;
  signups: number;
  activated: number;
  activationRate: number;
}

export interface SegmentedFunnel {
  segmentBy: SegmentDimension;
  segments: FunnelSegment[];
  totals: { signups: number; activated: number; activationRate: number };
}

export const SEGMENT_DIMENSIONS: ReadonlySet<string> = new Set([
  "source",
  "plan",
  "invite",
  "campaign"
]);

export function isSegmentDimension(raw: string | undefined | null): raw is SegmentDimension {
  return !!raw && SEGMENT_DIMENSIONS.has(raw);
}

/**
 * All-time signup→activation funnel sliced by a dimension. Reads the durable
 * signups record (joined to tenants for plan) rather than the event log so it
 * matches the point-in-time /admin/funnel number exactly. Each dimension is a
 * fixed, validated SQL fragment — `segmentBy` is never interpolated as raw
 * user input.
 */
export async function segmentedFunnel(
  db: PgClient | null,
  segmentBy: SegmentDimension
): Promise<SegmentedFunnel> {
  const empty: SegmentedFunnel = {
    segmentBy,
    segments: [],
    totals: { signups: 0, activated: 0, activationRate: 0 }
  };
  if (!db) return empty;

  // Each dimension maps to a safe, fixed key expression.
  const keyExpr: Record<SegmentDimension, string> = {
    source: `coalesce(s.source_norm, 'direct')`,
    plan: `coalesce(t.plan, 'unknown')`,
    invite: `case when s.invite_code is null then 'open' else 'invited' end`,
    campaign: `coalesce(s.utm_campaign, '(none)')`
  };

  const { rows } = await db.query<{ key: string; signups: number; activated: number }>(
    `select ${keyExpr[segmentBy]} as key,
            count(*)::int as signups,
            count(s.activated_at)::int as activated
       from signups s
       join tenants t on t.id = s.tenant_id
      group by 1
      order by signups desc, key asc`
  );

  let totalSignups = 0;
  let totalActivated = 0;
  const segments: FunnelSegment[] = rows.map((r) => {
    const signups = Number(r.signups);
    const activated = Number(r.activated);
    totalSignups += signups;
    totalActivated += activated;
    return { key: r.key, signups, activated, activationRate: signups > 0 ? activated / signups : 0 };
  });

  return {
    segmentBy,
    segments,
    totals: {
      signups: totalSignups,
      activated: totalActivated,
      activationRate: totalSignups > 0 ? totalActivated / totalSignups : 0
    }
  };
}

// ── Period-over-period comparison ───────────────────────────────────────────

export interface PeriodCounts {
  from: string;
  to: string;
  signups: number;
  activated: number;
  activationRate: number;
}

export interface PeriodComparison {
  granularity: CohortGranularity;
  current: PeriodCounts;
  previous: PeriodCounts;
  delta: {
    /** Relative change in signups, e.g. 0.25 = +25%. null when previous == 0. */
    signupsPct: number | null;
    /** Activation-rate change in percentage POINTS (current.rate - previous.rate). */
    activationRatePoints: number;
  };
}

/** Start of the UTC period (week = ISO Monday, month = 1st) containing `d`. */
export function startOfUtcPeriod(d: Date, granularity: CohortGranularity): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (granularity === "month") {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
  // Week: roll back to Monday. getUTCDay: 0=Sun..6=Sat → Monday offset.
  const dow = x.getUTCDay();
  const backToMonday = (dow + 6) % 7;
  x.setUTCDate(x.getUTCDate() - backToMonday);
  return x;
}

/** Cohort signup→activation counts for a single [from, to) window. */
async function windowCounts(db: PgClient, from: Date, to: Date): Promise<{ signups: number; activated: number }> {
  const { rows } = await db.query<{ signups: number | string; activated: number | string }>(
    `select count(*)::int as signups,
            count(a.tenant_id)::int as activated
       from funnel_events s
       left join funnel_events a
         on a.tenant_id = s.tenant_id
        and a.event_type = 'activation'
      where s.event_type = 'signup'
        and s.occurred_at >= $1
        and s.occurred_at <  $2`,
    [from, to]
  );
  const row = rows[0];
  return { signups: Number(row?.signups ?? 0), activated: Number(row?.activated ?? 0) };
}

/**
 * Compare the current (in-progress) period against the previous (complete)
 * period at the requested granularity. `now` is injectable for deterministic
 * tests. Buckets by SIGNUP cohort, consistent with the historical funnel.
 */
export async function periodComparison(
  db: PgClient | null,
  granularity: CohortGranularity,
  now: Date = new Date()
): Promise<PeriodComparison> {
  const currentStart = startOfUtcPeriod(now, granularity);
  const previousStart = startOfUtcPeriod(new Date(currentStart.getTime() - 1), granularity);

  const mk = (from: Date, to: Date, c: { signups: number; activated: number }): PeriodCounts => ({
    from: from.toISOString(),
    to: to.toISOString(),
    signups: c.signups,
    activated: c.activated,
    activationRate: c.signups > 0 ? c.activated / c.signups : 0
  });

  if (!db) {
    const zero = { signups: 0, activated: 0 };
    return {
      granularity,
      current: mk(currentStart, now, zero),
      previous: mk(previousStart, currentStart, zero),
      delta: { signupsPct: null, activationRatePoints: 0 }
    };
  }

  const [cur, prev] = await Promise.all([
    windowCounts(db, currentStart, now),
    windowCounts(db, previousStart, currentStart)
  ]);
  const current = mk(currentStart, now, cur);
  const previous = mk(previousStart, currentStart, prev);

  return {
    granularity,
    current,
    previous,
    delta: {
      signupsPct: previous.signups > 0 ? (current.signups - previous.signups) / previous.signups : null,
      activationRatePoints: current.activationRate - previous.activationRate
    }
  };
}

// ── Data quality + pipeline health ──────────────────────────────────────────

export type HealthStatus = "ok" | "warn" | "error" | "empty";

export interface DataQualityCheck {
  id: string;
  description: string;
  count: number;
  severity: "warn" | "error";
  ok: boolean;
}

export interface FunnelHealth {
  generatedAt: string;
  pipeline: {
    status: HealthStatus;
    totalEvents: number;
    signupEvents: number;
    activationEvents: number;
    lastEventAt: string | null;
    /** Milliseconds since the most recent event was ingested (null when empty). */
    freshnessMs: number | null;
  };
  dataQuality: {
    status: HealthStatus;
    checks: DataQualityCheck[];
  };
}

/**
 * Pipeline freshness + data-quality invariants, in two round-trips. `now` is
 * injectable for deterministic freshness assertions in tests.
 *
 * Quality invariants:
 *   • orphan_activations  (error) — activation event with no signup event.
 *   • reversed_timestamps (error) — activation recorded before its signup.
 *   • activation_drift    (warn)  — signups.activated_at set but no activation
 *                                    event (backfill not run / event lost).
 *   • signup_event_drift  (warn)  — signups row with no signup event.
 */
export async function funnelHealth(db: PgClient | null, now: Date = new Date()): Promise<FunnelHealth> {
  const generatedAt = now.toISOString();
  if (!db) {
    return {
      generatedAt,
      pipeline: { status: "empty", totalEvents: 0, signupEvents: 0, activationEvents: 0, lastEventAt: null, freshnessMs: null },
      dataQuality: { status: "empty", checks: [] }
    };
  }

  const { rows: pRows } = await db.query<{
    total: number | string;
    signups: number | string;
    activations: number | string;
    last_event_at: Date | string | null;
  }>(
    `select count(*)::int as total,
            count(*) filter (where event_type = 'signup')::int as signups,
            count(*) filter (where event_type = 'activation')::int as activations,
            max(created_at) as last_event_at
       from funnel_events`
  );
  const p = pRows[0];
  const totalEvents = Number(p?.total ?? 0);
  const lastEventAt = p?.last_event_at ? toIso(p.last_event_at) : null;
  const freshnessMs = lastEventAt ? now.getTime() - new Date(lastEventAt).getTime() : null;

  const { rows: qRows } = await db.query<{
    orphan_activations: number | string;
    reversed_timestamps: number | string;
    activation_drift: number | string;
    signup_event_drift: number | string;
  }>(
    `select
       (select count(*) from funnel_events a
          where a.event_type = 'activation'
            and not exists (select 1 from funnel_events s
                             where s.tenant_id = a.tenant_id and s.event_type = 'signup'))::int
         as orphan_activations,
       (select count(*) from funnel_events s
          join funnel_events a on a.tenant_id = s.tenant_id and a.event_type = 'activation'
          where s.event_type = 'signup' and a.occurred_at < s.occurred_at)::int
         as reversed_timestamps,
       (select count(*) from signups s
          where s.activated_at is not null
            and not exists (select 1 from funnel_events a
                             where a.tenant_id = s.tenant_id and a.event_type = 'activation'))::int
         as activation_drift,
       (select count(*) from signups s
          where not exists (select 1 from funnel_events e
                             where e.tenant_id = s.tenant_id and e.event_type = 'signup'))::int
         as signup_event_drift`
  );
  const q = qRows[0];
  const rawChecks: Array<Omit<DataQualityCheck, "ok">> = [
    { id: "orphan_activations", description: "Activation events with no matching signup event", count: Number(q?.orphan_activations ?? 0), severity: "error" },
    { id: "reversed_timestamps", description: "Activations recorded before their signup", count: Number(q?.reversed_timestamps ?? 0), severity: "error" },
    { id: "activation_drift", description: "Activated signups with no activation event (run backfill)", count: Number(q?.activation_drift ?? 0), severity: "warn" },
    { id: "signup_event_drift", description: "Signups with no signup event (run backfill)", count: Number(q?.signup_event_drift ?? 0), severity: "warn" }
  ];
  const checks: DataQualityCheck[] = rawChecks.map((c) => ({ ...c, ok: c.count === 0 }));

  const hasError = checks.some((c) => !c.ok && c.severity === "error");
  const hasWarn = checks.some((c) => !c.ok && c.severity === "warn");
  const qualityStatus: HealthStatus = hasError ? "error" : hasWarn ? "warn" : "ok";
  const pipelineStatus: HealthStatus = totalEvents === 0 ? "empty" : "ok";

  return {
    generatedAt,
    pipeline: {
      status: pipelineStatus,
      totalEvents,
      signupEvents: Number(p?.signups ?? 0),
      activationEvents: Number(p?.activations ?? 0),
      lastEventAt,
      freshnessMs
    },
    dataQuality: { status: qualityStatus, checks }
  };
}

// ── Retention ─────────────────────────────────────────────────────────────

export interface RetentionCell {
  /** Periods since signup (0 = signup period). */
  period: number;
  /** Distinct tenants in the cohort active during this period. */
  active: number;
  /** active / cohort size. */
  rate: number;
}

export interface RetentionCohort {
  cohort: string;
  size: number;
  cells: RetentionCell[];
}

export interface RetentionReport {
  cohortBy: CohortGranularity;
  periods: number;
  cohorts: RetentionCohort[];
}

/**
 * Retention curve: of each signup cohort, the fraction still ACTIVE (>=1
 * retention_ping) in each subsequent period. Unlike the cohort activation
 * triangle, cells are NON-cumulative — period p counts tenants active *during*
 * period p, the classic retention shape that decays as cohorts churn.
 *
 * Distinct-tenant counting collapses a cohort member's multiple same-period
 * pings to one. Period offset uses elapsed weeks (week cohorts) or calendar
 * months (month cohorts), matching cohortFunnel.
 */
export async function retentionCurve(db: PgClient | null, params: CohortParams): Promise<RetentionReport> {
  const periods = Math.max(0, Math.min(52, Math.trunc(params.periods)));
  const empty: RetentionReport = { cohortBy: params.cohortBy, periods, cohorts: [] };
  if (!db) return empty;

  const { rows: sizeRows } = await db.query<{ cohort: Date | string; size: number | string }>(
    `select (date_trunc($1, s.occurred_at at time zone 'UTC') at time zone 'UTC') as cohort,
            count(*)::int as size
       from funnel_events s
      where s.event_type = 'signup'
        and s.occurred_at >= $2
      group by 1
      order by 1`,
    [params.cohortBy, params.from]
  );

  const offsetExpr =
    params.cohortBy === "month"
      ? `(extract(year from age(r.occurred_at, s.occurred_at)) * 12
          + extract(month from age(r.occurred_at, s.occurred_at)))::int`
      : `floor(extract(epoch from (r.occurred_at - s.occurred_at)) / 604800)::int`;

  const { rows: offsetRows } = await db.query<{
    cohort: Date | string;
    period_offset: number | string;
    n: number | string;
  }>(
    `select (date_trunc($1, s.occurred_at at time zone 'UTC') at time zone 'UTC') as cohort,
            ${offsetExpr} as period_offset,
            count(distinct s.tenant_id)::int as n
       from funnel_events s
       join funnel_events r
         on r.tenant_id = s.tenant_id
        and r.event_type = 'retention_ping'
      where s.event_type = 'signup'
        and s.occurred_at >= $2
      group by 1, 2`,
    [params.cohortBy, params.from]
  );

  const byCohort = new Map<string, Map<number, number>>();
  for (const r of offsetRows) {
    const key = toIso(r.cohort);
    const offset = Math.max(0, Number(r.period_offset));
    const inner = byCohort.get(key) ?? new Map<number, number>();
    inner.set(offset, (inner.get(offset) ?? 0) + Number(r.n));
    byCohort.set(key, inner);
  }

  const cohorts: RetentionCohort[] = sizeRows.map((sr) => {
    const cohortKey = toIso(sr.cohort);
    const size = Number(sr.size);
    const offsets = byCohort.get(cohortKey) ?? new Map<number, number>();
    const cells: RetentionCell[] = [];
    for (let pd = 0; pd <= periods; pd++) {
      const active = offsets.get(pd) ?? 0;
      cells.push({ period: pd, active, rate: size > 0 ? active / size : 0 });
    }
    return { cohort: cohortKey, size, cells };
  });

  return { cohortBy: params.cohortBy, periods, cohorts };
}
