-- 0001_sprint_next.sql
-- Persistence parity for Sprint Next: cognition graphs, replay, branches,
-- failure intelligence, cluster (workers/leases/checkpoints), and the
-- event_execution_links projection that replaces payload::text LIKE scans.
--
-- ID conventions:
--   • Sprint Next IDs are 32-char hex from deterministicId(); stored as text.
--   • Legacy executions/agents/events ids stay uuid (Postgres uuid accepts
--     hyphenless 32-char hex too, so deterministic IDs round-trip on the
--     events table).
--
-- All tables are idempotent (`if not exists`) so this can run on a partially
-- migrated database. Indexes are designed for:
--   • replay seek (cognition_id, frame_index)
--   • cognition lookup (execution_id, started_at desc)
--   • branch traversal (source_cognition_id, source_node_id)
--   • worker lease recovery (expires_at where ACTIVE)
--   • event replay (execution_id, event_sequence)

begin;

-- ---------------------------------------------------------------------------
-- Cognition graphs + nodes + lineage
-- ---------------------------------------------------------------------------

create table if not exists cognition_graphs (
  id text primary key,
  execution_id text not null,
  agent_id text not null,
  parent_cognition_id text null references cognition_graphs(id) on delete set null,
  parent_node_id text null,
  phase text not null,
  started_at timestamptz not null,
  completed_at timestamptz null,
  output jsonb null,
  owner_worker_id text null,
  uncertainty jsonb null,
  -- Materialized graph snapshot (nodes + handoffs) is denormalized to jsonb so
  -- replay engine reads do not require N joins. The cognition_nodes table is
  -- the *normalized* projection for ad-hoc queries and lineage joins.
  graph jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_cognition_graphs_execution on cognition_graphs(execution_id);
create index if not exists idx_cognition_graphs_started_desc on cognition_graphs(started_at desc);
create index if not exists idx_cognition_graphs_parent on cognition_graphs(parent_cognition_id) where parent_cognition_id is not null;
create index if not exists idx_cognition_graphs_agent on cognition_graphs(agent_id);

create table if not exists cognition_nodes (
  id text primary key,
  cognition_id text not null references cognition_graphs(id) on delete cascade,
  execution_id text not null,
  parent_node_id text null,
  sequence integer not null,
  role text not null,
  phase text not null,
  status text not null,
  input_fingerprint text not null,
  input jsonb not null,
  output jsonb null,
  token_stream jsonb null,
  uncertainty jsonb null,
  memory_influence jsonb null,
  started_at timestamptz not null,
  completed_at timestamptz null,
  duration_ms integer null,
  worker_id text null,
  replayed_from_node_id text null,
  unique (cognition_id, sequence)
);

create index if not exists idx_cognition_nodes_cognition_seq on cognition_nodes(cognition_id, sequence);
create index if not exists idx_cognition_nodes_execution on cognition_nodes(execution_id);
create index if not exists idx_cognition_nodes_fingerprint on cognition_nodes(input_fingerprint);
create index if not exists idx_cognition_nodes_role on cognition_nodes(role);

create table if not exists cognition_lineage (
  node_id text not null,
  related_node_id text not null,
  kind text not null check (kind in ('ANCESTOR','DESCENDANT','SIBLING')),
  cognition_id text not null,
  primary key (node_id, related_node_id, kind)
);

create index if not exists idx_lineage_node_kind on cognition_lineage(node_id, kind);
create index if not exists idx_lineage_cognition on cognition_lineage(cognition_id);

-- ---------------------------------------------------------------------------
-- Replay sessions / frames / snapshots / branches
-- ---------------------------------------------------------------------------

create table if not exists replay_sessions (
  id text primary key,
  cognition_id text not null references cognition_graphs(id) on delete cascade,
  execution_id text not null,
  status text not null,
  cursor_frame_index integer not null,
  cursor_event_sequence bigint not null,
  cursor_speed real not null,
  forked_from_session_id text null,
  forked_from_frame_index integer null,
  created_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_replay_sessions_cognition on replay_sessions(cognition_id);
create index if not exists idx_replay_sessions_created_desc on replay_sessions(created_at desc);

-- Materialized replay frames: (session_id, frame_index) is the primary seek
-- index. (cognition_id, event_sequence) supports forward replay from a
-- snapshot's eventSequence boundary in O(log n).
create table if not exists replay_frames (
  session_id text not null references replay_sessions(id) on delete cascade,
  frame_index integer not null,
  kind text not null,
  ts timestamptz not null,
  event_sequence bigint not null,
  event_type text not null,
  preview jsonb not null,
  snapshot_id text null,
  primary key (session_id, frame_index)
);

create index if not exists idx_replay_frames_event_sequence on replay_frames(event_sequence);
create index if not exists idx_replay_frames_session_event on replay_frames(session_id, event_sequence);

create table if not exists replay_snapshots (
  id text primary key,
  cognition_id text not null references cognition_graphs(id) on delete cascade,
  execution_id text not null,
  frame_index integer not null,
  event_sequence bigint not null,
  captured_at timestamptz not null,
  graph jsonb not null,
  event_count integer not null,
  unique (cognition_id, frame_index)
);

-- Descending frame_index lets `nearest(cognition_id, frame_index)` use a
-- single index scan with `where frame_index <= $2 order by frame_index desc limit 1`.
create index if not exists idx_replay_snapshots_cognition_frame_desc on replay_snapshots(cognition_id, frame_index desc);
create index if not exists idx_replay_snapshots_event_sequence on replay_snapshots(event_sequence);

-- Sprint Next cognition-level branch pointers. The legacy execution-level
-- table (apps/api/db/schema.sql) had no writers; we drop it here and re-create
-- with the BranchPointer shape.
drop table if exists replay_branches;

create table if not exists replay_branches (
  branch_cognition_id text primary key references cognition_graphs(id) on delete cascade,
  source_cognition_id text not null,
  source_node_id text not null,
  branch_point_frame_index integer not null,
  reason text null,
  created_at timestamptz not null
);

create index if not exists idx_replay_branches_source on replay_branches(source_cognition_id);
create index if not exists idx_replay_branches_source_node on replay_branches(source_node_id);

-- ---------------------------------------------------------------------------
-- Failure intelligence
-- ---------------------------------------------------------------------------

create table if not exists failure_signals (
  id text primary key,
  cognition_id text null,
  execution_id text not null,
  node_id text null,
  kind text not null,
  severity text not null,
  score real not null,
  summary text not null,
  evidence jsonb not null,
  detected_at timestamptz not null,
  detected_by text not null
);

create index if not exists idx_failure_signals_execution on failure_signals(execution_id, detected_at desc);
create index if not exists idx_failure_signals_cognition on failure_signals(cognition_id, detected_at desc) where cognition_id is not null;
create index if not exists idx_failure_signals_kind_severity on failure_signals(kind, severity, detected_at desc);
create index if not exists idx_failure_signals_recent on failure_signals(detected_at desc);

-- ---------------------------------------------------------------------------
-- Cluster: workers, leases, checkpoints
-- ---------------------------------------------------------------------------

create table if not exists runtime_workers (
  id text primary key,
  host text not null,
  region text null,
  version text not null,
  capacity integer not null,
  status text not null,
  load jsonb not null,
  started_at timestamptz not null,
  last_heartbeat_at timestamptz not null,
  metadata jsonb null
);

create index if not exists idx_runtime_workers_last_heartbeat on runtime_workers(last_heartbeat_at);
create index if not exists idx_runtime_workers_status on runtime_workers(status);

create table if not exists execution_leases (
  execution_id text primary key,
  worker_id text not null,
  acquired_at timestamptz not null,
  renewed_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null,
  attempt integer not null
);

-- Partial indexes restrict scan to ACTIVE rows, which is the only set the
-- scheduler needs during lease acquisition / reclamation.
create index if not exists idx_execution_leases_expires_active on execution_leases(expires_at) where status = 'ACTIVE';
create index if not exists idx_execution_leases_worker_active on execution_leases(worker_id) where status = 'ACTIVE';

create table if not exists execution_checkpoints (
  id text primary key,
  execution_id text not null,
  worker_id text not null,
  sequence bigint not null,
  phase text not null,
  state jsonb not null,
  created_at timestamptz not null,
  unique (execution_id, sequence)
);

create index if not exists idx_execution_checkpoints_exec_seq_desc on execution_checkpoints(execution_id, sequence desc);

-- ---------------------------------------------------------------------------
-- Event execution linkage (Phase 4) — replaces payload::text LIKE scan
-- ---------------------------------------------------------------------------

-- One row per (event, executionId) the event is associated with. Populated on
-- append by collecting all execution-bearing fields from the payload. This
-- turns listByExecution from O(n_events) → O(log n) + result size.
create table if not exists event_execution_links (
  event_sequence bigint not null references events(sequence) on delete cascade,
  execution_id text not null,
  link_kind text not null check (link_kind in ('AGGREGATE','EXECUTION','COGNITION','BRANCH','CHECKPOINT','LEASE','RESUME')),
  primary key (event_sequence, execution_id, link_kind)
);

create index if not exists idx_event_links_execution_seq on event_execution_links(execution_id, event_sequence);
create index if not exists idx_event_links_event on event_execution_links(event_sequence);

-- Cognition-level event linkage for fast "events for cognition X" queries
-- without scanning payloads.
create table if not exists event_cognition_links (
  event_sequence bigint not null references events(sequence) on delete cascade,
  cognition_id text not null,
  primary key (event_sequence, cognition_id)
);

create index if not exists idx_event_cognition_links on event_cognition_links(cognition_id, event_sequence);

commit;
