-- 0025_tenant_scope_replay_sideeffects.sql
-- ============================================================================
-- Multi-tenant denormalization for the replay, side-effect, certification, and
-- failure-intelligence tables that migration 0024 explicitly deferred.
-- ============================================================================
--
-- WHY
--   0024_tenant_rls.sql installed Row-Level Security on the directly-columned
--   tenant tables (agents, executions, cognition_graphs, memory_records,
--   execution_dead_letters) but called out a follow-up:
--
--     "Migrating the join-only tables (replay_sessions, replay_branches,
--      failure_signals, execution_checkpoints) to RLS requires either
--      denormalised tenant_id columns or subquery policies; tracked as
--      follow-up."  — docs/specs/multi-tenant-rls.md §Caveats
--
--   This migration closes that follow-up for ALL remaining tenant-scoped
--   resource tables and extends side-effect + certification scoping:
--     • replay data        — replay_sessions, replay_snapshots, replay_branches
--     • recovery checkpoints— execution_checkpoints
--     • failure signals     — failure_signals
--     • certifications      — replay_certifications
--     • side effects        — event_outbox, event_outbox_dlq
--
--   We denormalize a `tenant_id` column (rather than subquery RLS policies) for
--   three reasons: (1) it matches the established pattern on agents/executions/
--   cognition_graphs/memory_records; (2) subquery policies on hot paths like
--   event_outbox claim CTEs would add per-row joins to the dispatcher's
--   FOR UPDATE SKIP LOCKED query; (3) a literal column lets the existing
--   idx_*_tenant index strategy carry over unchanged.
--
-- DESIGN — additive + non-breaking (mirrors 0002 / 0005 / 0024)
--   • Every column is `not null default 'system'`, so existing INSERTs that do
--     NOT yet pass tenant_id still succeed and land under the 'system' tenant —
--     identical to the choice 0002/0005 made for agents/executions/
--     cognition_graphs/memory_records. Application writes are updated in
--     lockstep (postgres adapters coalesce the value from the owning execution),
--     but this migration never *requires* that to be deployed first.
--   • RLS is extended in the SAME "transparent when unset" mode as 0024: a
--     connection that has not set app.current_tenant sees/writes every row, so
--     background workers, the recovery loop, the outbox dispatcher, and the
--     migration runner keep working the instant this lands. Enforcement only
--     activates for connections that opt in via withTenantRlsScope().
--   • Idempotent: `add column if not exists`, `create index if not exists`,
--     and a re-runnable RLS DO block guarded on column existence — safe to
--     re-apply on a partially-migrated database.
--
-- BACKFILL (best-effort, mirrors 0005)
--   Existing rows are backfilled from their owning aggregate. As in 0005 this
--   is best-effort: it is skipped (no rows) on fresh installs, and any row that
--   cannot be resolved keeps the 'system' default. New-row correctness is the
--   responsibility of the application adapters (coalesce-from-execution at
--   write time), NOT the backfill.

begin;

-- ── 1. Columns ──────────────────────────────────────────────────────────────
-- All default 'system' so legacy writers remain valid (NOT NULL satisfied).

alter table replay_sessions        add column if not exists tenant_id text not null default 'system';
alter table replay_snapshots       add column if not exists tenant_id text not null default 'system';
alter table replay_branches        add column if not exists tenant_id text not null default 'system';
alter table failure_signals        add column if not exists tenant_id text not null default 'system';
alter table execution_checkpoints  add column if not exists tenant_id text not null default 'system';
alter table replay_certifications  add column if not exists tenant_id text not null default 'system';
alter table event_outbox           add column if not exists tenant_id text not null default 'system';
alter table event_outbox_dlq       add column if not exists tenant_id text not null default 'system';

-- ── 2. Backfill from owning aggregate (best-effort; mirrors 0005) ────────────
-- Tables carrying execution_id resolve directly through executions.tenant_id.
-- The `::text` cast on both sides mirrors 0005_tenant_propagation.sql so the
-- deterministic-hex / uuid representations compare on equal footing.

update replay_sessions rs
   set tenant_id = e.tenant_id
  from executions e
 where rs.execution_id::text = e.id::text
   and rs.tenant_id = 'system'
   and e.tenant_id <> 'system';

update replay_snapshots rsn
   set tenant_id = e.tenant_id
  from executions e
 where rsn.execution_id::text = e.id::text
   and rsn.tenant_id = 'system'
   and e.tenant_id <> 'system';

update failure_signals fs
   set tenant_id = e.tenant_id
  from executions e
 where fs.execution_id::text = e.id::text
   and fs.tenant_id = 'system'
   and e.tenant_id <> 'system';

update execution_checkpoints ec
   set tenant_id = e.tenant_id
  from executions e
 where ec.execution_id::text = e.id::text
   and ec.tenant_id = 'system'
   and e.tenant_id <> 'system';

update replay_certifications rc
   set tenant_id = e.tenant_id
  from executions e
 where rc.execution_id::text = e.id::text
   and rc.tenant_id = 'system'
   and e.tenant_id <> 'system';

update event_outbox eo
   set tenant_id = e.tenant_id
  from executions e
 where eo.execution_id::text = e.id::text
   and eo.tenant_id = 'system'
   and e.tenant_id <> 'system';

update event_outbox_dlq eod
   set tenant_id = e.tenant_id
  from executions e
 where eod.execution_id::text = e.id::text
   and eod.tenant_id = 'system'
   and e.tenant_id <> 'system';

-- replay_branches has no execution_id (0001 re-created it cognition-keyed). It
-- resolves through cognition_graphs, which already carries tenant_id from 0005.
update replay_branches rb
   set tenant_id = cg.tenant_id
  from cognition_graphs cg
 where cg.id = rb.source_cognition_id
   and rb.tenant_id = 'system'
   and cg.tenant_id <> 'system';

-- ── 3. Tenant-scoped indexes ─────────────────────────────────────────────────
-- (tenant_id, <time desc>) mirrors idx_memory_tenant / idx_cognition_graphs_tenant
-- so per-tenant listing scans stay index-only.

create index if not exists idx_replay_sessions_tenant
  on replay_sessions(tenant_id, created_at desc);
create index if not exists idx_replay_snapshots_tenant
  on replay_snapshots(tenant_id, captured_at desc);
create index if not exists idx_replay_branches_tenant
  on replay_branches(tenant_id, created_at desc);
create index if not exists idx_failure_signals_tenant
  on failure_signals(tenant_id, detected_at desc);
create index if not exists idx_execution_checkpoints_tenant
  on execution_checkpoints(tenant_id, created_at desc);
create index if not exists idx_replay_certifications_tenant
  on replay_certifications(tenant_id, captured_at desc);
create index if not exists idx_event_outbox_tenant
  on event_outbox(tenant_id, created_at desc);
create index if not exists idx_event_outbox_dlq_tenant
  on event_outbox_dlq(tenant_id, failed_at desc);

-- ── 4. Extend RLS to the newly-columned tables ──────────────────────────────
-- Same transparent-when-unset predicate and helper functions installed by
-- 0024_tenant_rls.sql (app_current_tenant() / app_rls_bypassed()). A row is
-- visible/writable when bypass is on, OR no tenant context is set, OR the row's
-- tenant matches the session tenant. Guarded on tenant_id existence so the
-- block is safe to re-run on a partial schema.

do $$
declare
  t text;
  scoped_tables text[] := array[
    'replay_sessions',
    'replay_snapshots',
    'replay_branches',
    'failure_signals',
    'execution_checkpoints',
    'replay_certifications',
    'event_outbox',
    'event_outbox_dlq'
  ];
begin
  foreach t in array scoped_tables loop
    if exists (
      select 1 from information_schema.columns
      where table_name = t and column_name = 'tenant_id'
    ) then
      execute format('alter table %I enable row level security', t);
      execute format('alter table %I force row level security', t);
      execute format('drop policy if exists tenant_isolation on %I', t);
      execute format($f$
        create policy tenant_isolation on %I
          using (
            app_rls_bypassed()
            or app_current_tenant() is null
            or tenant_id = app_current_tenant()
          )
          with check (
            app_rls_bypassed()
            or app_current_tenant() is null
            or tenant_id = app_current_tenant()
          )
      $f$, t);
    end if;
  end loop;
end $$;

commit;

-- ============================================================================
-- STRICT MODE — see migration plan in docs/specs/multi-tenant-rls.md and
-- docs/specs/tenant-scope-rollout.md. The deny-by-default flip for these tables
-- ships there as a documented manual step (NOT an auto-running migration),
-- because flipping strict before every background path sets app.current_tenant
-- (request paths) or app.bypass_rls (system paths) would make the recovery
-- loop, outbox dispatcher, and workers see/write NOTHING. Apply only after
-- withTenantRlsScope()/withSystemRlsScope() are wired through every path and
-- verified against a real Postgres (integration suite).
-- ============================================================================
