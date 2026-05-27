-- 0013_replay_snapshot_immutability.sql
--
-- TASK A1 — Eliminate deterministic replay corruption caused by mutable
-- snapshot hydration.
--
-- Background
-- ----------
-- Migration 0009 introduced replay_snapshots.integrity_hash to detect
-- tampering with persisted snapshots. The hash is sha256 over the canonical
-- projection of { graph, eventSequence, frameIndex } and is computed at
-- put() time. The Postgres adapter, however, persisted only a thin graph
-- projection (the "__thin" envelope: identity, phase, ownerWorkerId,
-- nodeIds[]) into the existing `graph` jsonb column. On read it hydrated
-- the full graph by joining cognition_nodes / cognition_handoffs and then
-- recomputed the integrity hash for verification.
--
-- The problem: cognition_nodes IS a mutable table in production. Recovery,
-- branch operations, retries, and replay-from-node all rewrite node rows
-- after the snapshot was captured. When the read path joins those mutated
-- rows it produces a graph that differs from the graph the snapshot was
-- taken from. Concrete failure modes observed:
--
--   1. Integrity hash poisoning — recompute-after-hydrate yields a hash that
--      no longer matches the stored hash. The store throws
--      SnapshotCorruptionError even though no corruption occurred — the
--      snapshot is fine; the live join is the source of mismatch.
--   2. Nondeterministic replay — when the mutation happens to produce a
--      graph whose canonical hash collides with the stored one (rare but
--      not impossible for trivial mutations like null-vs-undefined), the
--      check passes but the hydrated graph reflects NEWER state than the
--      snapshot represents. Replay then resumes from a starting graph the
--      original execution never observed.
--   3. False corruption mismatches in the operator timeline UI — every
--      listByCognition() against a cognition whose nodes have been touched
--      since snapshot capture shows the entire history as "corrupted".
--   4. Operator timeline corruption — branch-from-node operations that
--      rewrite node parents shift hydrated handoffs and silently change the
--      shape of historical snapshots.
--
-- Fix
-- ---
-- Persist the FULL immutable graph payload at put() time inside a new
-- `graph_full` jsonb column. The read path prefers this column. The thin
-- envelope + live cognition_nodes hydration is retained ONLY as a legacy
-- fallback for snapshots written before this migration landed. Once a
-- snapshot's graph_full is populated, the persisted payload and the hashed
-- payload are byte-for-byte the same JSON projection — there is no live
-- join between hash time and verify time, so replay reads cannot be
-- poisoned by post-capture mutations of cognition_nodes.
--
-- Why we do NOT backfill graph_full
-- ---------------------------------
-- The only available source for legacy rows is the live (mutable)
-- cognition_nodes table. Backfilling would capture the CURRENT state, not
-- the historical state the snapshot was taken from — that defeats the
-- entire point of the migration. Legacy rows therefore retain NULL in
-- graph_full and continue to read via the documented legacy hydration
-- path. The Postgres adapter logs each legacy read as a forensic event so
-- operators can quantify the remaining surface area.
--
-- Backward / forward compatibility
-- --------------------------------
-- • Column is nullable. Legacy rows (graph_full IS NULL) read via the
--   thin-hydration path, exactly as before this migration.
-- • New writes also continue to populate the existing `graph` jsonb column
--   with the thin envelope. An older API binary that downgrades after this
--   column exists still reads via `graph`, so a same-day rollback does
--   not lose the ability to read newly-written snapshots.
-- • The integrity_hash column (0009) is unchanged. The canonical
--   projection it covers is { graph, eventSequence, frameIndex } where
--   `graph` is the same full graph payload now persisted in graph_full —
--   so hashes written by 0009 callers remain valid once the adapter is
--   updated to compute over the FULL input (it already does; see
--   postgresSnapshotStore.ts comment block at the put() site).
--
-- Replay determinism impact: positive — reads are now closed over the
-- exact payload that was hashed at put(). No live joins on the normal path.
--
-- Concurrency impact: none. The migration is a pure additive nullable
-- column. Existing readers continue to use `graph`; the adapter selects
-- both columns and prefers graph_full when present, so the rollout order
-- is column-then-code, and either ordering is correct.
--
-- Recovery correctness impact: positive — recovery's nearest(cognitionId,
-- frameIndex) call now returns a graph that is provably identical to the
-- graph captured at put(), independent of whether cognition_nodes was
-- touched between snapshot and recovery.

begin;

alter table replay_snapshots
  add column if not exists graph_full jsonb null;

comment on column replay_snapshots.graph_full is
  'Immutable full graph payload captured at put(). Read path prefers this column; the legacy thin-envelope + live-hydration-from-cognition_nodes path is used ONLY when graph_full IS NULL (rows persisted before 0013_replay_snapshot_immutability landed). The integrity_hash column covers a canonical projection of { graph, eventSequence, frameIndex } where graph is exactly this payload — there is no live join on the normal read path.';

commit;
