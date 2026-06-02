-- 0026_rbac_roles.sql
-- Production RBAC: expand the API-key role model from the legacy 4-role weight
-- ladder (admin | operator | developer | readonly) to the canonical 6-role
-- permission model:
--
--   owner | admin | operator | developer | auditor | viewer
--
-- and publish the role → permission capability matrix into a queryable
-- reference table so audit/BI tooling can join authorization decisions
-- (audit_log.metadata->'authz') against the grants that were in force.
--
-- Source of truth: the application matrix in
--   apps/api/src/infrastructure/security/permissions.ts
-- This table is a DB-side SNAPSHOT of that matrix, kept in sync by migration.
-- The application never reads it for live enforcement (enforcement is O(1)
-- in-memory) — it exists for forensics, dashboards, and access reviews.
--
-- Backward compatibility:
--   • Existing 'readonly' keys are rewritten to 'viewer' (the equivalent floor
--     role) BEFORE the CHECK constraint is tightened, so no row is orphaned.
--   • apiKeyAuth.normalizeRole() also maps any straggler 'readonly' at runtime,
--     so the system is correct even if this migration races a cached key.

begin;

-- ---------------------------------------------------------------------------
-- 1. Migrate legacy role labels, then tighten the CHECK constraint.
-- ---------------------------------------------------------------------------

update api_keys set role = 'viewer' where role = 'readonly';

-- Drop the inline constraint created by 0002 (auto-named api_keys_role_check)
-- and replace it with the explicit 6-role allow-list.
alter table api_keys drop constraint if exists api_keys_role_check;
alter table api_keys
  add constraint api_keys_role_check
  check (role in ('owner', 'admin', 'operator', 'developer', 'auditor', 'viewer'));

-- Least privilege: a key created without an explicit role now defaults to the
-- read-only floor, not 'developer'. Callers that need more grant it explicitly.
alter table api_keys alter column role set default 'viewer';

-- ---------------------------------------------------------------------------
-- 2. Role → permission reference matrix (snapshot of permissions.ts).
-- ---------------------------------------------------------------------------

create table if not exists role_permissions (
  role        text not null,
  permission  text not null,
  primary key (role, permission)
);

create index if not exists idx_role_permissions_permission
  on role_permissions(permission);

-- Rebuild idempotently so re-running the migration reflects matrix edits.
truncate table role_permissions;

-- viewer — the read-only floor (own tenant product surfaces).
insert into role_permissions (role, permission) values
  ('viewer', 'agent:read'),
  ('viewer', 'execution:read'),
  ('viewer', 'replay:read')
on conflict do nothing;

-- auditor — viewer floor + read-only compliance (NO writes, by construction).
insert into role_permissions (role, permission)
  select 'auditor', permission from role_permissions where role = 'viewer'
on conflict do nothing;
insert into role_permissions (role, permission) values
  ('auditor', 'audit:read'),
  ('auditor', 'certification:read'),
  ('auditor', 'observability:read'),
  ('auditor', 'tenant:read')
on conflict do nothing;

-- developer — viewer floor + write/execute capabilities.
insert into role_permissions (role, permission)
  select 'developer', permission from role_permissions where role = 'viewer'
on conflict do nothing;
insert into role_permissions (role, permission) values
  ('developer', 'agent:write'),
  ('developer', 'execution:write'),
  ('developer', 'replay:write'),
  ('developer', 'tool:execute'),
  ('developer', 'certification:read')
on conflict do nothing;

-- operator — developer + platform/recovery/certification-capture controls.
insert into role_permissions (role, permission)
  select 'operator', permission from role_permissions where role = 'developer'
on conflict do nothing;
insert into role_permissions (role, permission) values
  ('operator', 'recovery:execute'),
  ('operator', 'observability:read'),
  ('operator', 'certification:write'),
  ('operator', 'tenant:read')
on conflict do nothing;

-- admin — operator + tenant configuration + key management + audit read.
insert into role_permissions (role, permission)
  select 'admin', permission from role_permissions where role = 'operator'
on conflict do nothing;
insert into role_permissions (role, permission) values
  ('admin', 'tenant:configure'),
  ('admin', 'apikey:manage'),
  ('admin', 'audit:read')
on conflict do nothing;

-- owner — superuser: admin + tenant lifecycle (every permission).
insert into role_permissions (role, permission)
  select 'owner', permission from role_permissions where role = 'admin'
on conflict do nothing;
insert into role_permissions (role, permission) values
  ('owner', 'tenant:admin')
on conflict do nothing;

commit;
