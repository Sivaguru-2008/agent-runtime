-- 0009_replay_certifications.sql
--
-- Phase B (Operational Hardening) carry-over + Phase C (Snapshot Integrity).
--
-- Two structurally-related changes ride this single migration because both
-- pertain to the durability boundary for replay correctness:
--
--   1. `replay_certifications` — Postgres-backed adapter for the
--      ReplayCertificationStore port that previously had only an in-memory
--      implementation. Each row records the chain-hash fingerprint of an
--      execution's event log at a single moment in time. The port contract
--      is append-only per execution; we never overwrite a prior row. Listing
--      semantics: `listForExecution` returns oldest-first (chronological);
--      `latest` returns the most recent capture. The
--      (execution_id, captured_at desc) index covers both.
--
--   2. `replay_snapshots.integrity_hash` — Phase C snapshot integrity
--      validation. A snapshot stores the materialized graph at a frame
--      boundary; recovery hydrates that graph rather than full-replaying.
--      A silently-tampered snapshot would feed a corrupted starting state
--      into recovery and the operator would never know. The integrity hash
--      is sha256 over the canonical projection of { graph, eventSequence,
--      frameIndex }, computed at put() and verified at get()/nearest(). A
--      mismatch surfaces a typed SnapshotCorruptionError and emits
--      SNAPSHOT_INTEGRITY_VIOLATED on the event bus. The column is nullable
--      so legacy rows written before this migration remain readable — the
--      Postgres adapter treats absent-hash rows as legacy (no verification)
--      and stamps a hash on the next put().

begin;

-- ---------------------------------------------------------------------------
-- 1. replay_certifications
-- ---------------------------------------------------------------------------

create table if not exists replay_certifications (
  id bigserial primary key,
  execution_id text not null,
  workflow_version text not null,
  event_count integer not null,
  last_event_sequence bigint not null,
  -- frame_digests is an ordered array of per-frame deterministic digests.
  -- jsonb (not text[]) so the canonical representation matches the in-memory
  -- adapter — both round-trip the same JSON shape.
  frame_digests jsonb not null,
  chain_hash text not null,
  captured_at timestamptz not null
);

-- Listing semantics: `latest(executionId)` and `listForExecution(executionId)`
-- both seek by execution_id and order by captured_at desc. A single composite
-- index covers both — `latest` becomes a LIMIT 1 over the index, and
-- `listForExecution` becomes an index range scan.
create index if not exists idx_replay_certifications_exec_captured_desc
  on replay_certifications (execution_id, captured_at desc);

comment on table replay_certifications is
  'Append-only audit trail of execution replay fingerprints. Each row captures the chain-hash of an executions event log at a moment in time; ReplayDivergenceDetector.compare() reads `latest` to detect drift between replays. Never overwritten — operators reading the history can trace exactly when determinism broke.';

-- ---------------------------------------------------------------------------
-- 2. replay_snapshots.integrity_hash
-- ---------------------------------------------------------------------------

-- Nullable on purpose: snapshots persisted before this migration land have no
-- pre-computed hash. The Postgres adapter treats NULL as "legacy snapshot"
-- (no verification performed) and stamps a hash on the next put(). New
-- snapshots always carry the hash and are always verified on read.
alter table replay_snapshots
  add column if not exists integrity_hash text null;

comment on column replay_snapshots.integrity_hash is
  'sha256 over the canonical projection of { graph, eventSequence, frameIndex }. Computed at put(), verified at get()/nearest(). Mismatch raises SnapshotCorruptionError and emits SNAPSHOT_INTEGRITY_VIOLATED.';

commit;
