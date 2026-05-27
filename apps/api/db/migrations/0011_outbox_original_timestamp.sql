-- 0011_outbox_original_timestamp.sql
--
-- Audit finding CRITICAL-3 — the outbox dispatcher rebuilds the DomainEvent
-- it broadcasts using `new Date()` captured at tick start (see
-- apps/api/src/infrastructure/events/outboxDispatcher.ts line 61 / 108-118).
-- The outbox row does not carry the original event timestamp, so consumers
-- of the bus see a DIFFERENT timestamp than the one stored in the events
-- table. Any replay vs. live comparison silently lies; latency histograms
-- compute the time between dispatch and dispatch (≈ 0), not the actual
-- producer-to-consumer latency.
--
-- This migration adds an `original_timestamp` column to both `event_outbox`
-- and `event_outbox_dlq` and backfills it from the events table via the
-- shared `idempotency_key`. After this lands, the dispatcher and DLQ-replay
-- routines must read `original_timestamp` and fall back to `created_at`
-- only for rows that pre-date this migration AND whose source events were
-- already archived (the backfill cannot recover those).
--
-- Rollout / backward compatibility:
--   • Additive column on both tables — no constraint changes.
--   • Backfill uses idempotency_key, which IS the shared identity between
--     events and event_outbox. Rows whose source event was archived before
--     this migration ran cannot be backfilled — they remain NULL and the
--     dispatcher falls back to `created_at` for them.
--   • The migration is idempotent (`if not exists` everywhere); re-running
--     against an already-backfilled database is a no-op.

begin;

alter table event_outbox
  add column if not exists original_timestamp timestamptz null;

alter table event_outbox_dlq
  add column if not exists original_timestamp timestamptz null;

-- Backfill from events via the shared idempotency_key. We tolerate misses
-- (events older than the retention window were already archived) — the
-- dispatcher's fallback covers them.
update event_outbox o
   set original_timestamp = e.timestamp
  from events e
 where e.idempotency_key = o.idempotency_key
   and o.original_timestamp is null;

update event_outbox_dlq o
   set original_timestamp = e.timestamp
  from events e
 where e.idempotency_key = o.idempotency_key
   and o.original_timestamp is null;

-- Index supports DLQ-side analytics on event recency. Outbox rows are
-- short-lived (drained then deleted) so they don't need an index on this
-- column.
create index if not exists idx_event_outbox_dlq_original_timestamp
  on event_outbox_dlq(original_timestamp);

comment on column event_outbox.original_timestamp is
  $cmt$Producer-side timestamp of the source DomainEvent. Set on insert from event.timestamp; the dispatcher rebroadcasts using THIS value, not now(), to keep bus consumers and the events table in agreement (audit CRITICAL-3).$cmt$;

comment on column event_outbox_dlq.original_timestamp is
  $cmt$Producer-side timestamp of the source DomainEvent at the time it was first sent to the outbox. Preserved when promoted to the DLQ so post-mortem analysis sees the original wall time, not the DLQ-write time.$cmt$;

commit;
