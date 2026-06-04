-- ──────────────────────────────────────────────────────────────────────────────
-- 0023_trace_id_columns
--
-- Persist the distributed trace correlation id on `executions` and
-- `cognition_graphs` so the UI / operator surfaces can read it in a single
-- column instead of resolving it from the event log on every request.
--
-- Background
--   The orchestrator and AgentRuntime already stamp `traceId` onto every
--   event's `metadata.traceId`, and the domain types Execution + CognitionGraph
--   already declare an optional `traceId` field. Until now the Postgres
--   repositories silently dropped it on write because no column existed —
--   downstream readers had to scan the events table to recover the value.
--   This migration adds the column to both tables and an index on cognition's
--   trace_id for the common "find a run by trace id" pivot.
--
-- Backward compatibility
--   • Nullable, no default — existing rows keep NULL and the repository read
--     path still falls back to undefined. No backfill required.
--   • Writers may continue to omit traceId on rows that don't have one (in-
--     memory test fixtures, the older replay path) — only an explicit value
--     gets stored.
--   • An `events(metadata->>'traceId')` index already exists for the legacy
--     resolution path; that index stays in place as a safety net.
-- ──────────────────────────────────────────────────────────────────────────────

alter table executions
  add column if not exists trace_id text null;

alter table cognition_graphs
  add column if not exists trace_id text null;

create index if not exists idx_executions_trace
  on executions(trace_id)
  where trace_id is not null;

create index if not exists idx_cognition_graphs_trace
  on cognition_graphs(trace_id)
  where trace_id is not null;
