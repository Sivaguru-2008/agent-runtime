-- 0021_outbox_processing_recovery.sql
--
-- Crash-recovery for stranded PROCESSING outbox rows.
--
-- The original outbox claim CTE only ever selected status='PENDING'. A row
-- flipped to PROCESSING by tickDatabase() before a worker crash was never
-- re-selected, regardless of how far in the past its visible_after had drifted.
-- Worse, the per-execution FIFO gate
--   not exists (... prev.status in ('PENDING','PROCESSING'))
-- meant the stranded row permanently stalled every later event for the same
-- execution.
--
-- The dispatcher claim CTE is being extended to also reclaim PROCESSING rows
-- whose visible_after has elapsed (a standard SQS-style visibility-timeout
-- reaper) and to ignore stale PROCESSING rows in the FIFO blocker check.
-- This index supports the recovery half of that query — finding expired
-- PROCESSING rows fast without scanning the whole outbox.
--
-- Idempotent: 'if not exists' on every statement.

begin;

create index if not exists idx_event_outbox_recovery
  on event_outbox(visible_after)
  where status = 'PROCESSING';

comment on index idx_event_outbox_recovery is
  $cmt$Recovery-side index: locate stranded PROCESSING rows whose visibility timeout has elapsed so the dispatcher can reclaim them (crash-recovery for stranded PROCESSING).$cmt$;

commit;
