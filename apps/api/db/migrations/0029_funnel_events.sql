-- 0029_funnel_events.sql
-- Append-only funnel event log — the spine of production funnel analytics.
--
-- Why this exists:
--   The v0 funnel is derived from two timestamp columns on `signups`
--   (created_at, activated_at) and a free-text `source`. That answers exactly
--   one question at one instant ("what fraction of all-time signups ever
--   activated?") and CANNOT answer anything time-based: conversion in March,
--   week-over-week trend, the April cohort's activation curve. None of those
--   are reconstructable from a row that only stores latest state.
--
--   `funnel_events` is the immutable, time-ordered source of truth every
--   historical / cohort / trend / retention metric derives from. Rows are
--   only ever inserted, never updated — the funnel at any past instant is a
--   pure function of the events that had occurred by then.
--
-- Idempotency / duplicate-event protection:
--   Every event carries a deterministic `dedupe_key` (e.g. 'signup:<tenant>',
--   'activation:<tenant>'). A UNIQUE index on it makes recording an event an
--   `insert ... on conflict (dedupe_key) do nothing`, so retries, double-fires
--   and the backfill re-running never double-count. This invariant also keeps
--   the cohort join (signup LEFT JOIN activation on tenant) strictly 1:≤1, so
--   conversion counts can never be inflated by a fan-out.
--
-- Relationship to `signups`:
--   `signups` remains the durable lead record (email, key pointer, first-touch
--   attribution). `funnel_events` is the analytics stream. The backfill script
--   (scripts/backfill-funnel-events.mjs) seeds one 'signup' event per existing
--   signups row and one 'activation' event per activated tenant, so the event
--   log reproduces the existing funnel exactly before any new events arrive.

create table if not exists funnel_events (
  id            text        primary key,
  -- The tenant the event belongs to. ON DELETE CASCADE mirrors `signups`: if a
  -- tenant is hard-deleted its analytics events go with it.
  tenant_id     text        not null references tenants(id) on delete cascade,
  -- 'signup' | 'activation' today; future funnel steps (retention_ping, custom
  -- steps) reuse this table without a schema change. Intentionally not a CHECK
  -- constraint so new step types never require a migration to start flowing.
  event_type    text        not null,
  -- When the modelled thing actually happened (signup time, first-task time) —
  -- NOT ingest time. Trend/cohort buckets are computed from this.
  occurred_at   timestamptz not null default now(),
  -- Attribution, captured at the event. `source` is the normalized slug
  -- (see normalizeSource); the raw UTM tuple is preserved verbatim for campaign
  -- analytics.
  source        text        null,
  utm_source    text        null,
  utm_medium    text        null,
  utm_campaign  text        null,
  utm_term      text        null,
  utm_content   text        null,
  referrer      text        null,
  landing_path  text        null,
  -- Deterministic idempotency key. UNIQUE — the duplicate-event guard.
  dedupe_key    text        not null,
  -- Open-ended structured payload for step-specific detail. Defaults to '{}'.
  properties    jsonb       not null default '{}'::jsonb,
  -- Ingest timestamp, distinct from occurred_at, for pipeline freshness/debug.
  created_at    timestamptz not null default now()
);

-- Duplicate-event protection: at most one event per dedupe_key.
create unique index if not exists idx_funnel_events_dedupe on funnel_events (dedupe_key);

-- Hot path for trend/history: scan one event_type ordered by time.
create index if not exists idx_funnel_events_type_time on funnel_events (event_type, occurred_at);

-- Cohort join (signup events LEFT JOIN activation events on tenant) and
-- per-tenant lookups.
create index if not exists idx_funnel_events_tenant on funnel_events (tenant_id, event_type);
