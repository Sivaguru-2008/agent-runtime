-- 0017_lease_canonical_fields.sql
--
-- Hardening lease ownership semantics by introducing lease_id.
-- Enables MVCC atomic CAS fencing matching worker-scoped lease instances.
--

begin;

alter table execution_leases add column if not exists lease_id text;
alter table execution_fences add column if not exists lease_id text;

commit;
