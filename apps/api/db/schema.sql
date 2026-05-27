create extension if not exists "uuid-ossp";

create table if not exists agents (
  id uuid primary key,
  name text not null,
  goal text not null,
  state text not null,
  runtime_status text not null,
  model_provider text not null,
  model_name text not null,
  -- Optional model.temperature from the TS ModelConfig. Nullable so callers
  -- that omit it (the common case for deterministic providers) do not have
  -- to synthesise a default at write time.
  model_temperature double precision null,
  tools jsonb not null default '[]'::jsonb,
  memory_policy jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists executions (
  id uuid primary key,
  agent_id uuid not null references agents(id),
  parent_execution_id uuid null references executions(id),
  status text not null,
  input jsonb not null,
  output jsonb null,
  failure jsonb null,
  token_usage jsonb not null default '{"prompt":0,"completion":0,"total":0}'::jsonb,
  started_at timestamptz not null,
  completed_at timestamptz null,
  updated_at timestamptz not null
);

create table if not exists events (
  id uuid primary key,
  type text not null,
  aggregate_id uuid not null,
  aggregate_type text not null,
  version integer not null,
  timestamp timestamptz not null,
  payload jsonb not null,
  metadata jsonb not null,
  sequence bigserial not null unique,
  -- idempotency_key is required by PostgresEventStore.append() ON CONFLICT
  -- semantics. Declared NOT NULL here for fresh installs; the 0004 migration
  -- backfills the column on databases provisioned before this declaration.
  idempotency_key text not null unique
);

create index if not exists idx_events_aggregate on events(aggregate_type, aggregate_id, sequence);
create index if not exists idx_events_type_timestamp on events(type, timestamp desc);
create index if not exists idx_events_trace on events((metadata->>'traceId'));

create table if not exists execution_steps (
  id uuid primary key,
  execution_id uuid not null references executions(id),
  agent_id uuid not null references agents(id),
  step_type text not null,
  status text not null,
  input jsonb null,
  output jsonb null,
  started_at timestamptz not null,
  completed_at timestamptz null,
  duration_ms integer null
);

create index if not exists idx_execution_steps_execution on execution_steps(execution_id, started_at);

create table if not exists tool_calls (
  id uuid primary key,
  execution_id uuid not null references executions(id),
  step_id uuid not null references execution_steps(id),
  tool_name text not null,
  input jsonb not null,
  output jsonb null,
  status text not null,
  duration_ms integer null,
  created_at timestamptz not null
);

-- tool_call_dedup is the fence protocol's recovery anchor — see
-- docs/specs/fence-protocol.md. The migrations in db/migrations/ (0010,
-- 0015) build this table incrementally; this declaration is the
-- fresh-install equivalent and MUST match the post-0015 state.
create table if not exists tool_call_dedup (
  idempotency_key text primary key,
  execution_id    text not null,
  agent_id        text not null,
  tool_name       text not null,
  attempt         integer not null,
  status          text not null check (status in ('IN_FLIGHT', 'RESERVED', 'COMPLETED', 'SUCCEEDED', 'FAILED')),
  output          jsonb null,
  last_error      text null,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz null,
  tenant_id       text not null,
  -- Canonical fence protocol columns (see migration 0015).
  fence_token_at_reserve bigint null,
  args_hash              text   null,
  step_seq               integer null
);

create index if not exists idx_tool_call_dedup_execution
  on tool_call_dedup(execution_id);
create index if not exists idx_tool_call_dedup_tenant_created
  on tool_call_dedup(tenant_id, created_at desc);
create index if not exists idx_tool_call_dedup_inflight_stale
  on tool_call_dedup(created_at)
  where status in ('IN_FLIGHT', 'RESERVED');
create index if not exists idx_tool_call_dedup_replay
  on tool_call_dedup(execution_id, step_seq)
  where step_seq is not null;

create table if not exists memory_records (
  id uuid primary key,
  agent_id uuid not null references agents(id),
  execution_id uuid null references executions(id),
  type text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  -- updated_at lets the durable adapter track edits/replacements without
  -- changing the domain shape (the TS MemoryRecord exposes createdAt only).
  updated_at timestamptz null
);

create index if not exists idx_memory_agent_created on memory_records(agent_id, created_at desc);
create index if not exists idx_memory_execution
  on memory_records(execution_id)
  where execution_id is not null;

create table if not exists replay_branches (
  id uuid primary key,
  parent_execution_id uuid not null references executions(id),
  replay_execution_id uuid not null references executions(id),
  requested_at timestamptz not null,
  diff jsonb not null default '{}'::jsonb
);

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

create index if not exists idx_event_outbox_poll 
  on event_outbox(status, visible_after) 
  where status = 'PENDING';

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

