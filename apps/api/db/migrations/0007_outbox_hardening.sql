-- 0007_outbox_hardening.sql
-- Outbox Hardening DDL: creates event_outbox and event_outbox_dlq tables
-- and their indexes to support database-backed, transactionally consistent
-- event dispatching with strict per-execution ordering.

begin;

create table if not exists event_outbox (
  id uuid primary key,
  event_id uuid not null unique,
  execution_id text not null,
  event_type text not null,
  payload jsonb not null,
  metadata jsonb not null,
  sequence bigint not null,
  idempotency_key text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING', 'PROCESSING', 'FAILED')),
  retry_count integer not null default 0,
  visible_after timestamptz not null default now(),
  last_error text null,
  created_at timestamptz not null default now()
);

-- Partial index for active outbox polling
create index if not exists idx_event_outbox_poll 
  on event_outbox(status, visible_after) 
  where status = 'PENDING';

-- Execution sequence index for per-execution causal ordering
create index if not exists idx_event_outbox_ordering 
  on event_outbox(execution_id, sequence);

create table if not exists event_outbox_dlq (
  id uuid primary key,
  event_id uuid not null unique,
  execution_id text not null,
  event_type text not null,
  payload jsonb not null,
  metadata jsonb not null,
  sequence bigint not null,
  idempotency_key text not null unique,
  failed_at timestamptz not null default now(),
  last_error text null
);

create index if not exists idx_event_outbox_dlq_execution 
  on event_outbox_dlq(execution_id);

commit;
