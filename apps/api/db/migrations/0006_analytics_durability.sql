-- 0006_analytics_durability.sql
-- D3: durable storage for the four remaining analytics aggregates. Before
-- this migration the platform held FailureSignatures, AnomalyIndexEntries,
-- HealthSnapshots, and ReplayOutcomes in process memory only. A worker
-- restart (kill -9, OOM, rolling deploy) wiped all four, so any operator
-- dashboard built on them silently reset and any baselines re-warmed from
-- empty. These tables move those aggregates onto Postgres so they survive
-- restart and replicate via PITR.
--
-- Notes on JSON columns:
--   We store `severity_distribution`, `examples`, `evidence`, and the
--   sub-score breakdowns as jsonb rather than normalising further. The
--   shapes are versioned in TypeScript (FailureSignature, FailureSignal,
--   ExecutionHealthSnapshot) and the query patterns are 1) point lookup by
--   id, 2) ORDER BY recency, 3) cluster aggregation. None of those benefit
--   from a deeper relational split, and the jsonb form lets the existing
--   in-memory tests round-trip through Postgres without a parser layer.
--
-- Indexes:
--   Each table indexes the (computedAt | lastSeenAt | indexedAt | recordedAt)
--   column the in-memory list*() methods sort by, so we keep the existing
--   O(n log n) listRecent semantics with bounded index scans.

begin;

-- ── Health snapshots ────────────────────────────────────────────────────────
create table if not exists execution_health_snapshots (
  execution_id   text primary key,
  cognition_id   text,
  agent_id       text,
  health_score   double precision not null,
  grade          text not null,
  confidence     jsonb not null,
  stability      jsonb not null,
  tool_reliability jsonb not null,
  consistency    jsonb not null,
  anomaly        jsonb not null,
  observed_signal_kinds text[] not null default '{}',
  computed_at    timestamptz not null,
  computation_duration_ms integer not null
);
create index if not exists ix_health_snapshots_agent_computed
  on execution_health_snapshots (agent_id, computed_at desc);
create index if not exists ix_health_snapshots_computed
  on execution_health_snapshots (computed_at desc);

-- ── Failure signatures + per-observation timeline ──────────────────────────
create table if not exists failure_signatures (
  id text primary key,
  kind text not null,
  role text,
  summary_template text not null,
  metric_keys text[] not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  occurrence_count integer not null,
  severity_distribution jsonb not null,
  examples jsonb not null,
  example_execution_ids text[] not null
);
create index if not exists ix_failure_signatures_last_seen
  on failure_signatures (last_seen_at desc);

-- Per-observation timeline supports the heat-score window without a jsonb
-- array scan. Cardinality is bounded by total signal volume; pruning is the
-- operator's responsibility (retention policy lives outside this migration).
create table if not exists failure_signature_observations (
  signature_id text not null references failure_signatures(id) on delete cascade,
  observed_at timestamptz not null,
  execution_id text not null
);
create index if not exists ix_signature_observations_sig_time
  on failure_signature_observations (signature_id, observed_at desc);

-- ── Anomaly index ──────────────────────────────────────────────────────────
create table if not exists anomaly_index (
  execution_id text primary key,
  agent_id text,
  anomaly_score double precision not null,
  top_dimension text not null,
  top_robust_z_score double precision not null,
  indexed_at timestamptz not null
);
create index if not exists ix_anomaly_index_score
  on anomaly_index (anomaly_score desc);
create index if not exists ix_anomaly_index_dimension_score
  on anomaly_index (top_dimension, anomaly_score desc);
create index if not exists ix_anomaly_index_agent_score
  on anomaly_index (agent_id, anomaly_score desc);
create index if not exists ix_anomaly_index_indexed_at
  on anomaly_index (indexed_at desc);

-- ── Replay outcomes ────────────────────────────────────────────────────────
create table if not exists replay_outcomes (
  execution_id text primary key,
  cognition_id text not null,
  kind text not null,
  source_cognition_id text,
  branch_override jsonb,
  succeeded boolean not null,
  health_score double precision not null,
  failure_signal_count integer not null,
  observed_signal_kinds text[] not null default '{}',
  total_tokens integer,
  duration_ms integer,
  recorded_at timestamptz not null
);
create index if not exists ix_replay_outcomes_source
  on replay_outcomes (source_cognition_id) where source_cognition_id is not null;
create index if not exists ix_replay_outcomes_recorded
  on replay_outcomes (recorded_at desc);

commit;
