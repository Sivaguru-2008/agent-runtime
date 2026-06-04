-- 0033_user_auth_analytics.sql
-- Human authentication, onboarding tracking, and the product-usage event log.
--
-- Why this exists:
--   Everything before this migration models *machine* identity: an API key maps
--   to a tenant, and the funnel is derived from `signups` (the developer who
--   minted a key) + `funnel_events`. There was no concept of a *human* who logs
--   into the dashboard with Google, completes onboarding, and is observed by the
--   founder. This migration adds that missing identity layer:
--
--     • users            — one row per human, keyed on their Google account.
--     • user_sessions     — issued login sessions (revocable, auditable: who is
--                           logged in right now, from where).
--     • user_events       — the append-only product-analytics stream (signup,
--                           login, logout, key/agent/task/replay milestones).
--                           This is the human analog of funnel_events and the
--                           spine of every founder metric.
--     • user_onboarding   — per-user onboarding funnel state (the five guided
--                           steps), so activation can be measured step by step.
--
-- Design notes / invariants:
--   • google_id and lower(email) are both unique — a returning Google user is
--     matched and logged in, never duplicated.
--   • A user may be linked to a tenant (tenant_id) once they mint a developer
--     key during onboarding; until then it is NULL. This is the join key that
--     lets the founder dashboard count a human's agents/tasks via the existing
--     tenant-scoped tables.
--   • user_events is append-only and carries a deterministic dedupe_key for the
--     milestone events that must fire at most once (signup, onboarding_complete,
--     each first_* milestone), mirroring funnel_events. Repeatable events
--     (login/logout/visit) use a unique-enough key (id) so they accumulate.
--   • Everything is additive and idempotent (create table/index if not exists),
--     consistent with the rest of db/migrations.

create table if not exists users (
  id              text primary key,
  google_id       text not null,
  email           text not null,
  name            text null,
  profile_picture text null,
  -- Set when the user provisions a developer key during onboarding. NULL until
  -- then. Links a human to the tenant-scoped agents/executions tables.
  tenant_id       text null references tenants(id) on delete set null,
  -- Founder/staff flag. Drives access to the founder dashboard + user directory.
  -- Set from FOUNDER_EMAILS at login time; never user-settable.
  is_founder      boolean not null default false,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz null,
  login_count     integer not null default 0
);

-- A returning Google account matches an existing row (login), never creates a
-- second user. Case-insensitive email uniqueness mirrors signups.
create unique index if not exists idx_users_google_id on users (google_id);
create unique index if not exists idx_users_email_lower on users (lower(email));
create index if not exists idx_users_created_at on users (created_at desc);
create index if not exists idx_users_last_login on users (last_login_at desc);
create index if not exists idx_users_tenant on users (tenant_id);

create table if not exists user_sessions (
  id          text primary key,
  user_id     text not null references users(id) on delete cascade,
  -- SHA-256 of the opaque session token. We persist only the hash so a DB leak
  -- never yields a usable session (mirrors api_keys.key_hash). The signed token
  -- carried in the cookie is verified statelessly by its HMAC; this row makes a
  -- session revocable and records the audit trail (who, when, from where).
  token_hash  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz null,
  last_seen_at timestamptz null,
  ip          text null,
  user_agent  text null
);

create unique index if not exists idx_user_sessions_token on user_sessions (token_hash);
create index if not exists idx_user_sessions_user on user_sessions (user_id, created_at desc);
create index if not exists idx_user_sessions_active on user_sessions (expires_at) where revoked_at is null;

create table if not exists user_events (
  id          text primary key,
  -- Nullable: pre-auth visitor events (a landing-page hit) have no user yet.
  user_id     text null references users(id) on delete cascade,
  -- 'visit' | 'signup' | 'login' | 'logout' | 'developer_key_created' |
  -- 'agent_created' | 'task_started' | 'task_completed' | 'replay_viewed' |
  -- 'onboarding_started' | 'onboarding_completed'. Free-text on purpose so new
  -- product events need no migration to start flowing.
  event_type  text not null,
  occurred_at timestamptz not null default now(),
  -- Deterministic idempotency key. UNIQUE — milestone events (signup, each
  -- first_* milestone) use a stable key so retries never double-count; repeatable
  -- events use the row id, which is always unique.
  dedupe_key  text not null,
  properties  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create unique index if not exists idx_user_events_dedupe on user_events (dedupe_key);
create index if not exists idx_user_events_type_time on user_events (event_type, occurred_at desc);
create index if not exists idx_user_events_user on user_events (user_id, occurred_at desc);
create index if not exists idx_user_events_time on user_events (occurred_at desc);

create table if not exists user_onboarding (
  user_id               text primary key references users(id) on delete cascade,
  onboarding_started    timestamptz null,
  onboarding_completed  timestamptz null,
  developer_key_created timestamptz null,
  first_agent_created   timestamptz null,
  first_task_executed   timestamptz null,
  first_replay_viewed   timestamptz null,
  updated_at            timestamptz not null default now()
);
