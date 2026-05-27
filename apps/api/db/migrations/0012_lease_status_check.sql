-- 0012_lease_status_check.sql
--
-- Audit finding CRITICAL-6 — `execution_leases.status` was declared as
-- `text not null` (migrations/0001_sprint_next.sql) with NO CHECK constraint.
-- Every fence path keys on `status = 'ACTIVE'`. A row whose status is silently
-- corrupted to `'BUSY'` / `'ZOMBIE'` / `''` would:
--   • bypass the fence check in PostgresEventStore.appendFenced
--     (returns FENCED because the WHERE fails — but appears as an opaque
--     "lost lease" rather than a corrupt row);
--   • pass the reclaimByWorker WHERE clause unevenly depending on case;
--   • make the heartbeat renewal silently no-op.
--
-- The 0008_event_write_fencing.sql verification DO block already checks for
-- the existence of a status CHECK constraint — but it ACCEPTS the absence
-- ("0 result is acceptable if no CHECK exists"). This migration enforces the
-- check so the 0008 invariant is real.
--
-- Pre-flight: refuse to add the constraint if any rows would violate it.
-- Operators see the exact bad rows in the error and can fix them by hand
-- (DELETE for orphans, UPDATE to a real status) before re-running.
--
-- Rollout / backward compatibility:
--   • If the existing data already conforms (it should — the LeaseStore only
--     ever writes ACTIVE / EXPIRED / RELEASED / RECLAIMED), the constraint
--     adds in milliseconds with a brief ACCESS EXCLUSIVE lock during ATTACH.
--   • Idempotent: re-running the migration is a no-op once the constraint
--     exists.
--   • The constraint is named so a future migration that needs to widen
--     the value set (e.g. add 'TRANSFERRED') can DROP and re-add cleanly.

begin;

do $$
declare
  v_bad_count integer;
  v_existing_constraint integer;
begin
  -- Pre-flight: count rows that would violate the new constraint.
  select count(*) into v_bad_count
    from execution_leases
   where status is null
      or status not in ('ACTIVE', 'EXPIRED', 'RELEASED', 'RECLAIMED');

  if v_bad_count > 0 then
    raise exception
      'execution_leases has % rows with status outside (ACTIVE, EXPIRED, RELEASED, RECLAIMED). Inspect with: SELECT execution_id, worker_id, status FROM execution_leases WHERE status IS NULL OR status NOT IN (''ACTIVE'',''EXPIRED'',''RELEASED'',''RECLAIMED''); — fix the rows before re-running this migration.',
      v_bad_count;
  end if;

  -- Idempotency: skip if a constraint with the same name already exists.
  select count(*) into v_existing_constraint
    from pg_constraint
   where conname = 'chk_execution_leases_status';

  if v_existing_constraint = 0 then
    alter table execution_leases
      add constraint chk_execution_leases_status
      check (status in ('ACTIVE', 'EXPIRED', 'RELEASED', 'RECLAIMED'));
  end if;
end$$;

comment on constraint chk_execution_leases_status on execution_leases is
  $cmt$Fencing invariant — only these four statuses are recognized by appendFenced / saveFenced / writeFenced / reclaim paths. A status outside this set silently disables fencing (audit CRITICAL-6).$cmt$;

commit;
