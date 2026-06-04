-- 0022_outbox_dlq_recovery.sql
--
-- Automated recovery for dead-lettered outbox events.
--
-- Phase 2 (migration 0021) closed the *stranded PROCESSING* hole in the outbox
-- delivery guarantee. The remaining hole is the dead-letter sink itself: when
-- OutboxDispatcher exhausts MAX_RETRIES it moves a row into `event_outbox_dlq`
-- and deletes it from `event_outbox`. Nothing ever reads `event_outbox_dlq`
-- back out, so the outbox's core contract — "every committed outbox event is
-- eventually delivered" — was permanently violated for any event that hit a
-- transient-but-sustained bus outage long enough to exhaust retries.
--
-- This migration gives `event_outbox_dlq` the columns an out-of-band recovery
-- sweep needs to re-attempt delivery safely and boundedly:
--   • recovery_attempts     — durable attempt counter (crash-safe across
--                             process restarts, unlike an in-memory map).
--   • recovery_visible_after — SQS-style claim/backoff deadline; a row is only
--                             eligible for a recovery attempt once this elapses.
--   • last_recovery_error   — most recent redelivery error, for operator triage.
--   • quarantined           — terminal "do not auto-recover again" flag set once
--                             attempts are exhausted, so the sweep cannot thrash
--                             a genuinely poison event forever.
--   • original_timestamp    — producer-side timestamp so a redelivered event
--                             carries its original `timestamp` on the bus rather
--                             than the recovery wall-clock (mirrors the column
--                             added to event_outbox in migration 0011).
--
-- Idempotent: 'if not exists' on every statement; safe to re-run.

begin;

alter table event_outbox_dlq
  add column if not exists recovery_attempts integer not null default 0;

alter table event_outbox_dlq
  add column if not exists recovery_visible_after timestamptz not null default now();

alter table event_outbox_dlq
  add column if not exists last_recovery_error text null;

alter table event_outbox_dlq
  add column if not exists quarantined boolean not null default false;

alter table event_outbox_dlq
  add column if not exists original_timestamp timestamptz null;

-- Recovery-side index: locate live (non-quarantined) DLQ rows whose backoff
-- window has elapsed without scanning quarantined poison rows.
create index if not exists idx_event_outbox_dlq_recovery
  on event_outbox_dlq(recovery_visible_after)
  where quarantined = false;

comment on index idx_event_outbox_dlq_recovery is
  $cmt$Recovery-side index: locate non-quarantined DLQ rows eligible for an out-of-band redelivery attempt (OutboxDlqRecoveryService).$cmt$;

commit;
