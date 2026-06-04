-- 0032_funnel_daily_rollup.sql
-- Daily rollup of the signup→activation funnel (Phase 3, capability 13).
--
-- Why this exists:
--   The historical/trend funnel is a cohort join over funnel_events
--   (signup ⋈ activation on tenant). Correct and well-indexed, but at 100k–1M
--   events the operator dashboard — which polls every 15s — should not re-scan
--   the raw log on every paint. This table pre-aggregates the cohort funnel to
--   ONE ROW PER UTC SIGNUP-DAY so a trend query is O(days) instead of O(events).
--
-- Cohort-correctness under re-bucketing:
--   Each row holds, for a signup-day: how many tenants signed up that day
--   (`signups`, immutable once the day passes) and how many of THOSE tenants
--   have since activated (`cohort_activated`, mutable for recent days until
--   their cohort finishes activating). Because cohort membership is keyed by
--   signup-day, weekly/monthly buckets are exact SUMS of the daily rows — so
--   dailyFunnel() can serve day/week/month granularities from this one table
--   without losing cohort semantics.
--
-- Freshness:
--   `refreshed_at` lets readers decide whether the rollup is fresh enough to
--   serve or whether to fall back to the live event log. refreshFunnelDaily()
--   recomputes the table (idempotent upsert) and is meant to run on a schedule
--   / be triggered via POST /admin/funnel/rollup/refresh.

create table if not exists funnel_daily (
  day              date        primary key,
  signups          int         not null default 0,
  cohort_activated int         not null default 0,
  refreshed_at     timestamptz not null default now()
);
