-- 0024_tenant_rls.sql
-- ============================================================================
-- Multi-tenant defense-in-depth: PostgreSQL Row-Level Security (RLS).
-- ============================================================================
--
-- WHY
--   Migration 0002 deliberately chose application-layer isolation ("WHERE
--   tenant_id = $tenantId" + the TenantGuard resolver) "rather than Postgres
--   RLS". That works only as long as EVERY query path remembers to scope by
--   tenant and EVERY route runs the guard. A single missed guard, a raw query,
--   a future repository method, or a developer mistake re-opens the IDOR hole
--   (OWASP API1:2023). RLS moves the final isolation boundary into the
--   database, where it holds even when the application forgets.
--
-- DESIGN — non-breaking, staged rollout
--   This migration ENABLES + FORCEs RLS on the tenant-scoped tables and installs
--   a policy that is:
--     • ENFORCING for any connection that has set the session tenant
--       (`SET LOCAL app.current_tenant = '<tenant>'`): rows of other tenants are
--       invisible and cross-tenant writes are rejected.
--     • TRANSPARENT for connections that have NOT set it (the current app code,
--       background workers, the migration runner): the policy permits the row so
--       nothing breaks the moment this migration lands.
--     • BYPASSED for explicitly-elevated connections that set
--       `SET LOCAL app.bypass_rls = 'on'` (admin/operator cross-tenant tooling,
--       system maintenance) — mirrors the TenantGuard admin bypass.
--
--   To reach FULL enforcement (deny when no tenant context is set), wire the
--   PgClient to issue `SELECT set_config('app.current_tenant', $tenantId, true)`
--   at the start of every tenant-scoped transaction, then apply the STRICT
--   policy block documented at the bottom of this file. See
--   docs/specs/multi-tenant-rls.md for the rollout plan.
--
-- IMPORTANT
--   • RLS is bypassed for PostgreSQL SUPERUSERS and roles with BYPASSRLS. The
--     application MUST connect as an ordinary (non-superuser, non-BYPASSRLS)
--     role for these policies to take effect. FORCE ROW LEVEL SECURITY makes
--     even the table OWNER subject to the policy.
--   • current_setting(..., true) returns NULL instead of erroring when the GUC
--     is unset — this is what makes the "transparent when unset" behaviour work.

begin;

-- ── Reusable predicate helpers ──────────────────────────────────────────────
-- Marked STABLE (not VOLATILE) so the planner can cache within a statement.
create or replace function app_current_tenant() returns text
  language sql stable as $$
    select nullif(current_setting('app.current_tenant', true), '')
$$;

create or replace function app_rls_bypassed() returns boolean
  language sql stable as $$
    select coalesce(current_setting('app.bypass_rls', true), 'off') = 'on'
$$;

-- The shared USING/CHECK predicate, expressed once per table below. A row is
-- visible/writable when:
--   bypass is on, OR no tenant context is set (transparent), OR the row's
--   tenant matches the session tenant.
--   tenant_isolation: app_rls_bypassed()
--                     OR app_current_tenant() IS NULL
--                     OR tenant_id = app_current_tenant()

do $$
declare
  t text;
  scoped_tables text[] := array[
    'agents',
    'executions',
    'cognition_graphs',
    'memory_records',
    'execution_dead_letters'
  ];
begin
  foreach t in array scoped_tables loop
    -- Only act on tables that actually exist and carry tenant_id (defensive:
    -- fresh installs apply schema.sql + every migration in order, but guard
    -- against partial schemas so the migration is safe to re-run).
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
-- STRICT MODE (apply only AFTER the PgClient sets app.current_tenant on every
-- tenant-scoped transaction — see docs/specs/multi-tenant-rls.md). Replaces the
-- "transparent when unset" policy with a deny-by-default policy: a connection
-- with no tenant context (and no explicit bypass) sees and writes NOTHING.
--
--   begin;
--   do $$
--   declare t text;
--     scoped_tables text[] := array[
--       'agents','executions','cognition_graphs','memory_records','execution_dead_letters'];
--   begin
--     foreach t in array scoped_tables loop
--       execute format('drop policy if exists tenant_isolation on %I', t);
--       execute format($f$
--         create policy tenant_isolation on %I
--           using (app_rls_bypassed() or tenant_id = app_current_tenant())
--           with check (app_rls_bypassed() or tenant_id = app_current_tenant())
--       $f$, t);
--     end loop;
--   end $$;
--   commit;
-- ============================================================================
