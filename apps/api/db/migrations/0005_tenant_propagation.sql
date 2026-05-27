-- 0005_tenant_propagation.sql
-- C-1 hardening: explicit tenant_id columns on cognition_graphs and
-- memory_records so live writes carry the originating tenant rather than
-- silently defaulting to 'system'. The agents and executions tables already
-- carry tenant_id from 0002_production_hardening.sql.
--
-- Backfill rules:
--   * memory_records.tenant_id is derived from the owning agent's tenant
--     where the agent row carries a non-default tenant; otherwise the row
--     keeps the 'system' default.
--   * cognition_graphs.tenant_id is derived from the owning execution's
--     tenant, walking executions.tenant_id at backfill time.
--
-- Compatibility:
--   * The columns default to 'system' so legacy code paths that have not
--     yet been updated do not violate the NOT NULL constraint. Application
--     code is updated in lockstep to ALWAYS pass an explicit tenant_id; the
--     defensive checks in the postgres adapters fail closed when missing
--     under an authenticated request.

begin;

alter table memory_records add column if not exists
  tenant_id text not null default 'system';

alter table cognition_graphs add column if not exists
  tenant_id text not null default 'system';

-- Best-effort backfill from owning aggregates. Skipped (no rows) on fresh
-- installs that ran 0002 before this migration was authored.
update memory_records m
   set tenant_id = a.tenant_id
  from agents a
 where m.agent_id = a.id
   and m.tenant_id = 'system'
   and a.tenant_id <> 'system';

update cognition_graphs cg
   set tenant_id = e.tenant_id
  from executions e
 where cg.execution_id::text = e.id::text
   and cg.tenant_id = 'system'
   and e.tenant_id <> 'system';

create index if not exists idx_memory_tenant
  on memory_records(tenant_id, created_at desc);
create index if not exists idx_cognition_graphs_tenant
  on cognition_graphs(tenant_id, started_at desc);

commit;
