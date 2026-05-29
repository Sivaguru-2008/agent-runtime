-- 0018_lease_ownership_states.sql
--
-- Redesigning distributed lease protocol status constraints to enforce 7 explicit states:
-- LEASE_PENDING, LEASED, RENEWING, EXPIRED, INVALIDATED, TRANSFERRED, RECOVERY_OWNED.
--

begin;

-- Drop legacy check constraint if exists
alter table execution_leases drop constraint if exists chk_execution_leases_status;

-- Add updated check constraint enforcing the redesigned ownership states
alter table execution_leases
  add constraint chk_execution_leases_status
  check (status in ('LEASE_PENDING', 'LEASED', 'RENEWING', 'EXPIRED', 'INVALIDATED', 'TRANSFERRED', 'RECOVERY_OWNED'));

commit;
