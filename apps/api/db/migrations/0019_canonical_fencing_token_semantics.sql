-- 0019_canonical_fencing_token_semantics.sql
--
-- Hardening execution leases, fences, and dedup tables with first-class
-- canonical fencing token semantics to guarantee strict epoch monotonicity.
--

begin;

-- Add canonical columns to execution_leases
alter table execution_leases add column if not exists lease_epoch bigint;
alter table execution_leases add column if not exists fencing_token bigint;
alter table execution_leases add column if not exists ownership_version bigint;
alter table execution_leases add column if not exists worker_identity text;

-- Backfill execution_leases
update execution_leases
   set lease_epoch = coalesce(lease_epoch, attempt, 1),
       fencing_token = coalesce(fencing_token, attempt, 1),
       ownership_version = coalesce(ownership_version, attempt, 1),
       worker_identity = coalesce(worker_identity, worker_id);

-- Add canonical columns to execution_fences
alter table execution_fences add column if not exists lease_epoch bigint;
alter table execution_fences add column if not exists fencing_token bigint;
alter table execution_fences add column if not exists ownership_version bigint;
alter table execution_fences add column if not exists worker_identity text;

-- Backfill execution_fences
update execution_fences
   set lease_epoch = coalesce(lease_epoch, lease_attempt, 1),
       fencing_token = coalesce(fencing_token, lease_attempt, 1),
       ownership_version = coalesce(ownership_version, lease_attempt, 1),
       worker_identity = coalesce(worker_identity, owner_worker_id);

-- Add canonical columns to tool_call_dedup
alter table tool_call_dedup add column if not exists lease_epoch bigint;
alter table tool_call_dedup add column if not exists fencing_token bigint;
alter table tool_call_dedup add column if not exists ownership_version bigint;
alter table tool_call_dedup add column if not exists worker_identity text;

-- Backfill tool_call_dedup
update tool_call_dedup
   set lease_epoch = coalesce(lease_epoch, fence_token_at_reserve, attempt, 1),
       fencing_token = coalesce(fencing_token, fence_token_at_reserve, attempt, 1),
       ownership_version = coalesce(ownership_version, fence_token_at_reserve, attempt, 1),
       worker_identity = coalesce(worker_identity, 'unknown');

commit;
