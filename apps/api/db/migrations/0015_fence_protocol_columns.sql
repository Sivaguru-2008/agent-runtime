-- 0015_fence_protocol_columns.sql
--
-- Canonical fence protocol per docs/specs/fence-protocol.md.
--
-- The 0010 dedup table got us 70% of the way: deterministic key, IN_FLIGHT
-- marker, COMPLETED/FAILED terminal status, polling for in-flight siblings.
-- The 30% gap the canonical spec closes:
--
--   1. `fence_token_at_reserve` — diagnostic record of the lease attempt
--      that opened the slot. The authoritative fence check still happens
--      live against execution_leases.attempt; this column is for forensics
--      and tests, NOT the correctness gate.
--
--   2. `args_hash` — sha256(canonical_json(args)) at reserve time. The
--      replay engine reads this on retry and refuses to silently re-invoke
--      a tool whose args have drifted (invariant I5 in the spec).
--
--   3. `step_seq` — the planner-assigned position for this call within the
--      execution. The new idempotency key formula is
--      sha256(execution_id || ':' || step_seq), which is stable across
--      arg drift (so the remote dedupes even if the LLM picks slightly
--      different wording on retry). Storing step_seq here gives the
--      replay engine a direct lookup path for "what happened at step N?".
--
-- Compatibility:
--
--   All three columns are nullable for backfill. New writes through the
--   DedupingToolExecutor populate them; legacy rows from 0010 keep NULL
--   and the engine treats NULL fence_token_at_reserve as "pre-fence" (no
--   stale-write protection — the same level as before this migration).
--   The protocol upgrade is enforced by application code; this migration
--   adds the storage surface only.
--
--   The CHECK on `status` is widened to permit 'RESERVED' as a synonym
--   for 'IN_FLIGHT'. New code writes RESERVED; reads accept both. A
--   follow-on migration in V2 will rename IN_FLIGHT → RESERVED via a
--   one-shot UPDATE once nothing reads the old value.

begin;

alter table tool_call_dedup
  add column if not exists fence_token_at_reserve bigint null,
  add column if not exists args_hash              text   null,
  add column if not exists step_seq               integer null;

-- Widen status check to accept the canonical name. Drop-and-recreate
-- because Postgres has no ALTER CONSTRAINT for CHECK.
do $$
declare
  v_constraint_name text;
begin
  select conname into v_constraint_name
    from pg_constraint
    where conrelid = 'tool_call_dedup'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%IN_FLIGHT%';
  if v_constraint_name is not null then
    execute format('alter table tool_call_dedup drop constraint %I', v_constraint_name);
  end if;
end$$;

alter table tool_call_dedup
  add constraint tool_call_dedup_status_check
  check (status in ('IN_FLIGHT', 'RESERVED', 'COMPLETED', 'SUCCEEDED', 'FAILED'));

-- Replay lookup: "what was the recorded outcome of (execution_id, step_seq)?"
-- The fence protocol's TX1 reads this to short-circuit on cached results
-- and to detect arg drift, so it's on the hot path.
create index if not exists idx_tool_call_dedup_replay
  on tool_call_dedup (execution_id, step_seq)
  where step_seq is not null;

comment on column tool_call_dedup.fence_token_at_reserve is
  'execution_leases.attempt observed when the slot was reserved. Diagnostic only; the authoritative fence check happens live in TX2 against the current attempt.';

comment on column tool_call_dedup.args_hash is
  'sha256(canonical_json(args)) at reserve time. Replay reads this to detect arg drift (invariant I5 in docs/specs/fence-protocol.md).';

comment on column tool_call_dedup.step_seq is
  'Planner-assigned step position. Stable across retries. Forms half of the idempotency key (executionId:stepSeq).';

commit;
