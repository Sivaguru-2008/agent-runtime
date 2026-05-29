-- 0020_canonical_epoch_consistency.sql
--
-- Durable epoch-persistence guarantee for the canonical fencing-token model.
--
-- Migration 0019 *added* the canonical columns (lease_epoch, fencing_token,
-- ownership_version, worker_identity) and backfilled them, but left them
-- nullable and unconstrained — nothing at the database level stopped them from
-- drifting apart from the single source of truth (lease_attempt on fences,
-- attempt on leases). That drift is precisely the fail-open "ownership
-- resurrection" hole: an ownership predicate that consulted one drifted alias
-- could admit a holder another alias would reject.
--
-- This migration makes the canonical invariant (F7) durable and unforgeable:
--   1. Backfill any residual NULLs from the source-of-truth column.
--   2. Make every canonical column NOT NULL.
--   3. CHECK that every epoch alias equals the source-of-truth epoch and the
--      identity alias equals the owner — so even an out-of-band UPDATE cannot
--      put a row into a divergent state. The application CAS can then compare
--      every dimension with fail-closed AND semantics knowing they agree.
--
-- Safe to run on live data: by construction the lease store and fence store
-- have always written these columns equal to the source of truth, so the
-- backfill is a no-op on rows touched since 0019 and the CHECKs hold.

begin;

-- ── execution_fences: source of truth = lease_attempt / owner_worker_id ──────
update execution_fences
   set lease_epoch       = coalesce(lease_epoch, lease_attempt),
       fencing_token     = coalesce(fencing_token, lease_attempt),
       ownership_version = coalesce(ownership_version, lease_attempt),
       worker_identity   = coalesce(worker_identity, owner_worker_id)
 where lease_epoch is null
    or fencing_token is null
    or ownership_version is null
    or worker_identity is null;

alter table execution_fences alter column lease_epoch       set not null;
alter table execution_fences alter column fencing_token     set not null;
alter table execution_fences alter column ownership_version set not null;
alter table execution_fences alter column worker_identity   set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'execution_fences_canonical_consistency'
  ) then
    alter table execution_fences add constraint execution_fences_canonical_consistency
      check (lease_epoch = lease_attempt
         and fencing_token = lease_attempt
         and ownership_version = lease_attempt
         and worker_identity = owner_worker_id);
  end if;
end $$;

-- ── execution_leases: source of truth = attempt / worker_id ──────────────────
update execution_leases
   set lease_epoch       = coalesce(lease_epoch, attempt),
       fencing_token     = coalesce(fencing_token, attempt),
       ownership_version = coalesce(ownership_version, attempt),
       worker_identity   = coalesce(worker_identity, worker_id)
 where lease_epoch is null
    or fencing_token is null
    or ownership_version is null
    or worker_identity is null;

alter table execution_leases alter column lease_epoch       set not null;
alter table execution_leases alter column fencing_token     set not null;
alter table execution_leases alter column ownership_version set not null;
alter table execution_leases alter column worker_identity   set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'execution_leases_canonical_consistency'
  ) then
    alter table execution_leases add constraint execution_leases_canonical_consistency
      check (lease_epoch = attempt
         and fencing_token = attempt
         and ownership_version = attempt
         and worker_identity = worker_id);
  end if;
end $$;

comment on constraint execution_fences_canonical_consistency on execution_fences is
  'F7: canonical epoch aliases (lease_epoch, fencing_token, ownership_version) must equal lease_attempt and worker_identity must equal owner_worker_id. Forbids alias drift so the ownership CAS can use fail-closed AND semantics.';
comment on constraint execution_leases_canonical_consistency on execution_leases is
  'F7: canonical epoch aliases must equal attempt and worker_identity must equal worker_id. Forbids alias drift across (re-)acquire / recovery takeover.';

commit;
