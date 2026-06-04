-- 0027_lease_status_legacy_reconciliation.sql
--
-- Defensive reconciliation of any legacy execution_leases.status values to the
-- redesigned 7-state ownership model introduced by 0018.
--
-- Why this is a NEW migration (and not an edit to 0018):
--   0018 has already been applied to live databases; its bytes are fingerprinted
--   in schema_migrations and MUST NOT change (editing it trips
--   MigrationChecksumError and crashes startup). The reconciliation logic that
--   was mistakenly added to 0018's working copy belongs here instead — a new,
--   forward-only migration, per the runner's contract.
--
-- What it does:
--   Databases originally migrated under 0012 carry the legacy status set
--   (ACTIVE, EXPIRED, RELEASED, RECLAIMED). If any such rows survive, the 0018
--   CHECK constraint would reject them. We drop the constraint, map every legacy
--   value onto its redesigned equivalent, then re-add the identical constraint:
--     ACTIVE    -> LEASED       (held by a live worker)
--     RECLAIMED -> EXPIRED      (taken from a dead owner; reclaimable terminal)
--     RELEASED  -> INVALIDATED  (deliberately given up; no longer valid/held)
--   EXPIRED maps to itself. Any other unexpected value collapses to INVALIDATED
--   (a terminal, non-acquirable state) so the constraint can never be blocked.
--
-- Idempotent & safe to re-run: the constraint is dropped with IF EXISTS and the
-- UPDATEs touch zero rows on databases already on the new model (the common
-- case, including fresh installs and every DB where 0018 already succeeded).

begin;

alter table execution_leases drop constraint if exists chk_execution_leases_status;

update execution_leases set status = 'LEASED'      where status = 'ACTIVE';
update execution_leases set status = 'EXPIRED'     where status = 'RECLAIMED';
update execution_leases set status = 'INVALIDATED' where status = 'RELEASED';
update execution_leases
   set status = 'INVALIDATED'
 where status is null
    or status not in ('LEASE_PENDING', 'LEASED', 'RENEWING', 'EXPIRED', 'INVALIDATED', 'TRANSFERRED', 'RECOVERY_OWNED');

alter table execution_leases
  add constraint chk_execution_leases_status
  check (status in ('LEASE_PENDING', 'LEASED', 'RENEWING', 'EXPIRED', 'INVALIDATED', 'TRANSFERRED', 'RECOVERY_OWNED'));

commit;
