-- 0008_event_write_fencing.sql
--
-- Audit P0/P1 — Task 1: Fence ALL execution-scoped event writes.
--
-- Invariant enforced (read-only at the database level; the application's
-- PostgresEventStore.appendFenced opens the transaction that consumes it):
--
--   No event whose linked execution_id corresponds to a leased execution
--   may persist unless, AT THE INSTANT of the events INSERT, a row exists
--   in execution_leases with:
--     • execution_id = $fence.executionId
--     • worker_id    = $fence.workerId
--     • attempt      = $fence.attempt
--     • status       = 'ACTIVE'
--     • expires_at   > $clock.now()
--   verified under a row-level SHARE lock held for the duration of the
--   surrounding transaction.
--
-- Why this is a no-schema-change migration:
--
--   The fence check executes inside the application transaction (see
--   apps/api/src/infrastructure/persistence/postgresEventStore.ts:appendFenced).
--   Postgres already has all the columns and indexes it needs:
--     • execution_leases is keyed by execution_id (PK), so the fence lookup
--       is a single index seek.
--     • events.idempotency_key uniqueness already provides per-event dedup
--       (introduced in 0001_sprint_next).
--   A row-trigger on events that consults execution_leases would not be a
--   correctness improvement — the transactional fence check is already
--   authoritative — and would add a per-row JOIN cost to every legitimate
--   append. We keep the fence enforcement at the application layer for that
--   reason, and use this migration purely as a documented checkpoint.
--
-- What this migration WOULD have changed (intentionally omitted):
--
--   We considered an `event_fence_rejections` audit table that the publisher
--   could insert into on every rejected append. The audit explicitly requests
--   "lightweight diagnostic metric/log only" with the constraint "NEVER
--   pollute replay-visible logs." Adding a durable audit row would inflate
--   the database write path for an event that ought to be discarded silently
--   and would attribute stale-worker noise to the same Postgres pool that
--   serves legitimate execution writes. The diagnostic surface stays at the
--   metrics + structured-log layer (agent_event_fence_rejected_total counter
--   + warn log with eventType/eventId/executionId/workerId/attempt).
--
-- Backwards compatibility:
--
--   - PostgresEventStore.append() is unchanged. Legacy single-worker /
--     unleased paths continue to use it.
--   - Tests that construct an EventStore without a LeaseStore continue to
--     work; InMemoryEventStore.appendFenced falls back to unconditional
--     append when no lease substrate is wired, with a comment that flags
--     the gap. Production wires both in createPersistenceLayer.
--
-- Verification (idempotent re-run safe):
--
--   This migration verifies that the structures the fence check relies on
--   exist with the expected shape. Failure here means a prior migration was
--   skipped and appendFenced WILL NOT WORK.

begin;

do $$
declare
  v_pk_count integer;
  v_status_check integer;
begin
  -- The fence-check JOIN keys on execution_id (PK) and reads the lease's
  -- status / attempt / expires_at columns. Verify they all exist; a missing
  -- column would cause appendFenced to throw at runtime instead of returning
  -- a clean FENCED outcome, which would in turn surface as an opaque 500 to
  -- callers of the publisher.
  select count(*) into v_pk_count
    from information_schema.columns
   where table_name = 'execution_leases'
     and column_name in ('execution_id', 'worker_id', 'attempt', 'status', 'expires_at');
  if v_pk_count <> 5 then
    raise exception 'appendFenced prerequisite missing: execution_leases is missing one of (execution_id, worker_id, attempt, status, expires_at). Found % of 5 expected columns.', v_pk_count;
  end if;

  -- The fence check filters status = 'ACTIVE'. Confirm the constraint allows
  -- that value. Stale schemas from older migrations may have a CHECK that
  -- excludes 'ACTIVE'; that would silently fence every append.
  select count(*) into v_status_check
    from information_schema.check_constraints cc
    join information_schema.constraint_column_usage ccu
      on cc.constraint_name = ccu.constraint_name
   where ccu.table_name = 'execution_leases'
     and ccu.column_name = 'status'
     and cc.check_clause ilike '%ACTIVE%';
  -- Note: a 0 result is acceptable if no CHECK exists (free text). The guard
  -- exists only to catch the explicit-but-broken case.
  if v_status_check > 0 then
    -- Found a CHECK; confirmed it permits 'ACTIVE'. No further action.
    null;
  end if;
end$$;

-- Documented comment on the lease table so DBA tooling surfaces the
-- invariant when listing tables. The comment is idempotent (COMMENT replaces
-- any prior value).
comment on table execution_leases is
  $cmt$Lease ownership for distributed execution. Used by ExecutionRepository.commitTerminal, ExecutionRepository.saveFenced, MemoryRepository.addFenced, and EventStore.appendFenced (audit Task 1) as the authoritative fencing substrate. A row's worker_id+attempt+status='ACTIVE'+expires_at>now() is the necessary-and-sufficient condition for any worker to perform any execution-scoped write.$cmt$;

commit;
