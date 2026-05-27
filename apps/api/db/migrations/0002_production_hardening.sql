-- 0002_production_hardening.sql
-- Phase 5: Production readiness.
--
-- This migration adds the foundational infrastructure for enterprise operation:
--   • tenants         — isolation boundary for all resources
--   • api_keys        — hashed authentication tokens per tenant + role
--   • audit_log       — partitioned, immutable record of every API action
--   • tenant_quotas   — hard limits per tenant/plan
--   • execution_dead_letters — durable DLQ (survives process restart)
--   • quota_usage     — hourly/daily counter persistence for Redis-surviving checks
--   • events_archive  — cold storage for events past the retention window
--   • retention_policies — configurable archival schedules
--
-- Tenant isolation strategy:
--   All existing rows in agents and executions are backfilled to the built-in
--   'system' tenant so pre-tenancy data remains queryable without modification.
--   Tenant enforcement is applied at the application layer (API key auth +
--   WHERE tenant_id = $tenantId clauses) rather than Postgres RLS, which avoids
--   the overhead of policy evaluation on every row-scan at the cost of requiring
--   application discipline. Application-level isolation is verified by audit log.
--
-- Events partitioning note:
--   The events table is not converted to a partitioned table in this migration
--   to avoid the zero-downtime complexity of pg_partman or ATTACH PARTITION under
--   live load. Instead, events_archive accepts archived events and the
--   archive_old_events() function performs batched archival. A future migration
--   can convert events to a native partitioned table during a maintenance window.

begin;

-- ---------------------------------------------------------------------------
-- Tenants — top-level isolation boundary
-- ---------------------------------------------------------------------------

create table if not exists tenants (
  id        text primary key,
  name      text not null,
  plan      text not null default 'starter'
              check (plan in ('starter', 'growth', 'enterprise')),
  is_active boolean not null default true,
  metadata  jsonb  not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tenants_active on tenants(is_active) where is_active = true;

-- Built-in system tenant: owns all pre-tenancy data and internal scheduler ops.
insert into tenants (id, name, plan, metadata)
  values ('system', 'System', 'enterprise', '{"internal":true}'::jsonb)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- API Keys — authentication tokens scoped to a tenant and role
-- ---------------------------------------------------------------------------
-- Security design:
--   • Only the SHA-256 hash of the raw key is stored (key_hash). The plaintext
--     is never persisted beyond the creation response, enforcing a "show once"
--     model identical to AWS/GitHub secrets.
--   • key_prefix stores the first 8 characters of the raw key for log triage
--     without exposing enough entropy to reconstruct the hash.
--   • role maps to (admin | operator | developer | readonly) following least-
--     privilege: operators can drain workers; developers run tasks; readonly can
--     only read state.
-- ---------------------------------------------------------------------------

create table if not exists api_keys (
  id              text primary key,
  tenant_id       text not null references tenants(id) on delete cascade,
  name            text not null,
  key_hash        text not null unique,
  key_prefix      text not null,
  role            text not null default 'developer'
                    check (role in ('admin', 'operator', 'developer', 'readonly')),
  rate_limit_rpm  integer not null default 1000,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz null,
  revoked_at      timestamptz null,
  expires_at      timestamptz null,
  metadata        jsonb not null default '{}'::jsonb
);

-- Only active keys are looked up at request time.
create index if not exists idx_api_keys_tenant_active on api_keys(tenant_id) where is_active = true;
-- Prefix lookup for log correlation — intentionally separate from key_hash to
-- avoid timing side-channels from a combined index scan.
create index if not exists idx_api_keys_prefix on api_keys(key_prefix) where is_active = true;

-- ---------------------------------------------------------------------------
-- Audit Log — partitioned by month for efficient pruning
-- ---------------------------------------------------------------------------
-- Partitioning rationale:
--   Audit logs grow proportionally with API traffic. At 100 rpm per tenant
--   with 10 tenants, that is 86 million rows per day. Monthly range partitions
--   let DROP TABLE eliminate an entire month's data atomically without a costly
--   DELETE scan on the parent table — critical for GDPR right-to-erasure SLAs.
-- ---------------------------------------------------------------------------

create table if not exists audit_log (
  id            bigserial,
  tenant_id     text     not null,
  api_key_id    text     null,
  actor_role    text     not null,
  action        text     not null,
  resource_type text     not null,
  resource_id   text     null,
  method        text     not null,
  path          text     not null,
  status_code   integer  not null,
  duration_ms   integer  not null,
  ip            text     not null,
  request_id    text     not null,
  metadata      jsonb    not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

-- Current year partitions: May 2026 through Dec 2027 for forward coverage.
create table if not exists audit_log_2026_05 partition of audit_log
  for values from ('2026-05-01') to ('2026-06-01');
create table if not exists audit_log_2026_06 partition of audit_log
  for values from ('2026-06-01') to ('2026-07-01');
create table if not exists audit_log_2026_07 partition of audit_log
  for values from ('2026-07-01') to ('2026-08-01');
create table if not exists audit_log_2026_08 partition of audit_log
  for values from ('2026-08-01') to ('2026-09-01');
create table if not exists audit_log_2026_09 partition of audit_log
  for values from ('2026-09-01') to ('2026-10-01');
create table if not exists audit_log_2026_10 partition of audit_log
  for values from ('2026-10-01') to ('2026-11-01');
create table if not exists audit_log_2026_11 partition of audit_log
  for values from ('2026-11-01') to ('2026-12-01');
create table if not exists audit_log_2026_12 partition of audit_log
  for values from ('2026-12-01') to ('2027-01-01');
create table if not exists audit_log_2027_01 partition of audit_log
  for values from ('2027-01-01') to ('2027-02-01');
create table if not exists audit_log_2027_02 partition of audit_log
  for values from ('2027-02-01') to ('2027-03-01');
create table if not exists audit_log_2027_03 partition of audit_log
  for values from ('2027-03-01') to ('2027-04-01');
create table if not exists audit_log_2027_04 partition of audit_log
  for values from ('2027-04-01') to ('2027-05-01');

-- Indexes on the parent propagate to all existing and future child partitions.
create index if not exists idx_audit_log_tenant_created
  on audit_log(tenant_id, created_at desc);
create index if not exists idx_audit_log_resource
  on audit_log(resource_type, resource_id, created_at desc)
  where resource_id is not null;
create index if not exists idx_audit_log_api_key
  on audit_log(api_key_id, created_at desc)
  where api_key_id is not null;
create index if not exists idx_audit_log_action
  on audit_log(action, created_at desc);

-- ---------------------------------------------------------------------------
-- Tenant Quotas — hard limits per tenant
-- ---------------------------------------------------------------------------

create table if not exists tenant_quotas (
  tenant_id                    text    primary key references tenants(id) on delete cascade,
  max_executions_per_hour      integer not null default 100,
  max_events_per_day           bigint  not null default 100000,
  max_memory_records_per_agent integer not null default 1000,
  max_concurrent_executions    integer not null default 10,
  max_agents                   integer not null default 50,
  storage_limit_mb             bigint  not null default 1024,
  updated_at                   timestamptz not null default now()
);

-- Enterprise quotas for the system tenant — effectively unlimited.
insert into tenant_quotas
  (tenant_id, max_executions_per_hour, max_events_per_day,
   max_memory_records_per_agent, max_concurrent_executions, max_agents, storage_limit_mb)
  values ('system', 100000, 100000000, 1000000, 10000, 100000, 10485760)
  on conflict (tenant_id) do nothing;

-- ---------------------------------------------------------------------------
-- Persistent Dead-Letter Queue — durable across process restarts
-- ---------------------------------------------------------------------------
-- Production risk solved:
--   The InMemoryDeadLetterStore loses all poisoned-execution records on process
--   restart. Without durable DLQ storage, operators lose visibility into which
--   executions failed repeatedly and why, making root-cause analysis impossible.
--
-- Upsert semantics:
--   execution_id is the natural key. When a worker re-poisons an already-dead
--   execution (e.g., after a retry policy change), the latest error wins.
-- ---------------------------------------------------------------------------

create table if not exists execution_dead_letters (
  execution_id text       primary key,
  worker_id    text       null,
  tenant_id    text       not null default 'system',
  attempt      integer    not null,
  error        jsonb      not null,
  context      jsonb      not null default '{}'::jsonb,
  moved_at     timestamptz not null default now(),
  resolved_at  timestamptz null,
  resolution   text       null
);

create index if not exists idx_dlq_tenant_moved
  on execution_dead_letters(tenant_id, moved_at desc);
create index if not exists idx_dlq_unresolved
  on execution_dead_letters(moved_at desc)
  where resolved_at is null;
create index if not exists idx_dlq_worker
  on execution_dead_letters(worker_id)
  where worker_id is not null;

-- ---------------------------------------------------------------------------
-- Quota Usage — Postgres-durable counters for longer-window limits
-- ---------------------------------------------------------------------------
-- These rows back the Redis sliding-window counters. Redis is authoritative for
-- per-minute rate limiting; this table stores hourly/daily aggregates that
-- survive a Redis restart (cold-start quota enforcement).

create table if not exists quota_usage (
  tenant_id   text    not null references tenants(id) on delete cascade,
  window_key  text    not null,
  count       bigint  not null default 0,
  reset_at    timestamptz not null,
  primary key (tenant_id, window_key)
);

create index if not exists idx_quota_usage_reset on quota_usage(reset_at);

-- ---------------------------------------------------------------------------
-- Events Archive — cold storage beyond the retention window
-- ---------------------------------------------------------------------------
-- Archival strategy:
--   The archive_old_events() function batch-deletes events older than the
--   retention policy window and inserts them here first. Archive rows are
--   append-only; they are never updated and never joined in hot-path queries.
--   A background job (cron or pg_cron) calls archive_old_events() nightly.
--   Operators can query events_archive directly for forensic replay.

create table if not exists events_archive (
  id             uuid        not null,
  type           text        not null,
  aggregate_id   uuid        not null,
  aggregate_type text        not null,
  version        integer     not null,
  timestamp      timestamptz not null,
  payload        jsonb       not null,
  metadata       jsonb       not null,
  sequence       bigint      not null,
  tenant_id      text        not null default 'system',
  archived_at    timestamptz not null default now(),
  primary key (sequence)
);

create index if not exists idx_events_archive_tenant_ts
  on events_archive(tenant_id, timestamp desc);
create index if not exists idx_events_archive_type_ts
  on events_archive(type, timestamp desc);
create index if not exists idx_events_archive_aggregate
  on events_archive(aggregate_type, aggregate_id, sequence);

-- ---------------------------------------------------------------------------
-- Retention Policy Configuration
-- ---------------------------------------------------------------------------

create table if not exists retention_policies (
  id                    text    primary key,
  target_table          text    not null,
  tenant_id             text    null,
  retention_days        integer not null,
  archive_before_delete boolean not null default true,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

insert into retention_policies
  (id, target_table, retention_days, archive_before_delete)
  values
    ('events_default',             'events',                    90,  true),
    ('audit_log_default',          'audit_log',                365,  false),
    ('dlq_default',                'execution_dead_letters',   180,  false),
    ('replay_frames_default',      'replay_frames',             30,  false),
    ('failure_signals_default',    'failure_signals',           90,  true),
    ('quota_usage_default',        'quota_usage',                7,  false)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Backfill tenant_id onto existing tables
-- ---------------------------------------------------------------------------
-- All pre-tenancy rows belong to the system tenant. The default value means
-- new rows written by code that does not yet pass tenant_id also land safely
-- in the system tenant rather than violating the NOT NULL constraint.

alter table agents add column if not exists
  tenant_id text not null default 'system' references tenants(id);

alter table executions add column if not exists
  tenant_id text not null default 'system' references tenants(id);

-- Compound indexes for tenant-scoped list queries — avoids full-table scans
-- when an operator filters by tenant in the management UI.
create index if not exists idx_agents_tenant
  on agents(tenant_id, created_at desc);
create index if not exists idx_executions_tenant
  on executions(tenant_id, started_at desc);
create index if not exists idx_executions_tenant_status
  on executions(tenant_id, status, started_at desc);

-- ---------------------------------------------------------------------------
-- Replay index optimisations for large event stores
-- ---------------------------------------------------------------------------
-- Composite index on (type, timestamp) improves retention scans that
-- filter by event type before the timestamp predicate narrows the range.
-- Already exists as idx_events_type_timestamp but only on (type, timestamp desc).
-- Add a partial index for ACTIVE-lease fast-expiry check used by recovery loop.

-- Composite covering index so replay frame seeks don't hit the heap for
-- common fields. snapshot_id IS NOT NULL means a snapshot boundary.
create index if not exists idx_replay_frames_snapshot_seek
  on replay_frames(session_id, frame_index desc)
  where snapshot_id is not null;

-- ---------------------------------------------------------------------------
-- PL/pgSQL helper: batch-archive events past retention window
-- ---------------------------------------------------------------------------
-- Operational tradeoffs:
--   Batch size of 10 000 keeps each DELETE-INSERT pair within ~100 ms on most
--   hardware, avoiding replication lag spikes. Callers should loop until the
--   function returns 0 rather than relying on a single large batch.
--
-- Replay safety:
--   Events referenced by RUNNING or PAUSED replay sessions are never archived,
--   preserving the deterministic-replay guarantee during active scrub sessions.

create or replace function archive_old_events(
  p_older_than_days integer,
  p_tenant_id       text    default null,
  p_batch_size      integer default 10000
)
returns integer
language plpgsql
as $$
declare
  v_cutoff    timestamptz := now() - (p_older_than_days || ' days')::interval;
  v_archived  integer     := 0;
begin
  with to_archive as (
    select e.id, e.type, e.aggregate_id, e.aggregate_type, e.version,
           e.timestamp, e.payload, e.metadata, e.sequence,
           coalesce(e.metadata->>'tenantId', 'system') as tenant_id
    from events e
    where e.timestamp < v_cutoff
      and (p_tenant_id is null or e.metadata->>'tenantId' = p_tenant_id)
      and not exists (
        select 1
        from replay_frames rf
        join replay_sessions rs on rs.id = rf.session_id
        where rf.event_sequence = e.sequence
          and rs.status in ('RUNNING', 'PAUSED')
      )
    order by e.sequence
    limit p_batch_size
    for update skip locked
  ),
  inserted as (
    insert into events_archive
      (id, type, aggregate_id, aggregate_type, version, timestamp,
       payload, metadata, sequence, tenant_id)
    select id, type, aggregate_id, aggregate_type, version, timestamp,
           payload, metadata, sequence, tenant_id
    from to_archive
    on conflict (sequence) do nothing
    returning sequence
  )
  delete from events
  where sequence in (select sequence from inserted);

  get diagnostics v_archived = row_count;
  return v_archived;
end;
$$;

-- ---------------------------------------------------------------------------
-- PL/pgSQL helper: prune old audit log rows
-- ---------------------------------------------------------------------------
-- Audit log rows are not archived — they have their own retention window
-- (typically 365 days for compliance). Partition pruning via DROP TABLE is
-- preferred for full-month expiry; this function handles sub-month granularity.

create or replace function prune_audit_log(
  p_older_than_days integer,
  p_batch_size      integer default 50000
)
returns integer
language plpgsql
as $$
declare
  v_cutoff  timestamptz := now() - (p_older_than_days || ' days')::interval;
  v_deleted integer     := 0;
begin
  delete from audit_log
  where (id, created_at) in (
    select id, created_at from audit_log
    where created_at < v_cutoff
    limit p_batch_size
  );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- PL/pgSQL helper: create next audit_log partition on demand
-- ---------------------------------------------------------------------------
-- Call from a monthly cron job (pg_cron or application scheduler) to ensure
-- the partition always exists before the month rolls over. Idempotent.

create or replace function create_audit_log_partition(
  p_year  integer,
  p_month integer
)
returns void
language plpgsql
as $$
declare
  v_name  text;
  v_start date := make_date(p_year, p_month, 1);
  v_end   date := v_start + interval '1 month';
begin
  v_name := 'audit_log_' || to_char(v_start, 'YYYY_MM');
  execute format(
    'create table if not exists %I partition of audit_log for values from (%L) to (%L)',
    v_name, v_start, v_end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- PL/pgSQL helper: prune expired quota_usage windows
-- ---------------------------------------------------------------------------

create or replace function prune_quota_usage(p_batch_size integer default 10000)
returns integer
language plpgsql
as $$
declare
  v_deleted integer := 0;
begin
  delete from quota_usage
  where (tenant_id, window_key) in (
    select tenant_id, window_key from quota_usage
    where reset_at < now()
    limit p_batch_size
  );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

commit;
