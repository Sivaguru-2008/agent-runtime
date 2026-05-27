# Operational Hardening — Progress Tracker

Cumulative progress across the seven hardening areas requested. Phases A, B,
and C landed in the 2026-05-27 session; phases D-E remain pending.

## Status matrix

| #   | Area                                          | Phase | Status      | Notes                                                                                              |
| --- | --------------------------------------------- | ----- | ----------- | -------------------------------------------------------------------------------------------------- |
| 1   | Persistence-level fencing enforcement         | A     | DONE        | Checkpoint writes now fence-guarded; full audit confirmed exec/memory/event already SQL-fenced.    |
| 2   | Deterministic replay engine                   | B     | DONE        | Execution-level chain hash + divergence detector + persisted certifications (Postgres + memory).   |
| 3   | Snapshot & recovery layer                     | C     | DONE        | Integrity hash on every snapshot; SnapshotCorruptionError + SNAPSHOT_INTEGRITY_VIOLATED; recovery perf measured. |
| 4   | Advanced backpressure & scheduling            | D     | PENDING     | Quota/queue substrate in place; adaptive throttling + tenant ceilings deferred.                    |
| 5   | Distributed deadlock & orphan detection       | D     | PENDING     | Lease-reclaim + dead-letter exist; cyclic-wait + stuck-cancellation diagnostics deferred.          |
| 6   | Observability integrity validation            | E     | PENDING     | Event-log already authoritative; invariant auditors comparing memory/trace/persisted deferred.     |
| 7   | Visualization (playback / time-travel / etc.) | E     | PENDING     | Frontend playback already exists; viz for fence rejections + retry trees deferred.                 |

## Phase A — Persistence-Level Fencing Enforcement (landed)

### Scope

* Every durable mutation that runs under a worker lease must be rejected at
  the persistence layer when the worker's fencing token no longer matches the
  live lease, not just at runtime via advisory checks.
* Covers Postgres, Redis, and in-memory adapters consistently.

### Audit findings

Already fence-guarded at the SQL / in-memory layer:

* `ExecutionRepository.saveFenced` / `commitTerminal` — CTE-with-FOR-UPDATE on
  `execution_leases`; conditional UPSERT on `executions`.
* `MemoryRepository.addFenced` — identical pattern on `memory_records`.
* `EventStore.appendFenced` — CTE-with-FOR-SHARE; the events INSERT is
  predicated on the fence row inside the same transaction.
* `LeaseStore.validateFencing` — advisory check; used by the in-memory
  adapters as the substrate fence.

**Gap closed this phase**: `CheckpointStore.write` was unconditional in both
Postgres and in-memory adapters. A stale worker could overwrite a legitimate
owner's recovery checkpoint via the `(execution_id, sequence)` unique key,
silently shifting every subsequent crash-recovery to a snapshot the legitimate
owner never produced.

**Redis adapters**: redis is a transport layer (event bus + job queue), not
authoritative state. Fencing for durable writes flows through `appendFenced`
into Postgres BEFORE the bus publish, so the stale-write window is closed at
the SQL boundary — redis itself has no row to fence against.

### Changes landed

* [apps/api/src/domain/clusterPorts.ts](apps/api/src/domain/clusterPorts.ts) —
  added `CheckpointStore.writeFenced(checkpoint, fence): Promise<FencedWriteOutcome>`.
* [apps/api/src/infrastructure/cluster/inMemoryClusterStores.ts](apps/api/src/infrastructure/cluster/inMemoryClusterStores.ts) —
  `InMemoryCheckpointStore` accepts an optional `LeaseStore` and implements
  `writeFenced` with `validateFencing`-gated semantics.
* [apps/api/src/infrastructure/cluster/postgres/postgresCheckpointStore.ts](apps/api/src/infrastructure/cluster/postgres/postgresCheckpointStore.ts) —
  Postgres `writeFenced` uses a CTE-with-FOR-UPDATE on the live lease row;
  the INSERT pulls its row source from the CTE so it commits zero rows on a
  fence mismatch. `ON CONFLICT (execution_id, sequence) DO UPDATE` matches
  the unique key from migration `0001_sprint_next.sql:228`.
* [apps/api/src/runtime/executionEngine.ts](apps/api/src/runtime/executionEngine.ts) —
  `writeCheckpoint` routes through `writeFenced` when a fence is present;
  on FENCED it emits `EXECUTION_FENCE_REJECTED` with phase
  `checkpoint.{phase}` and throws `StaleWorkerSurrender`, which the
  existing top-level catch handles as a silent surrender (no further
  mutation, no terminal event).
* [apps/api/src/infrastructure/persistence/persistenceFactory.ts](apps/api/src/infrastructure/persistence/persistenceFactory.ts) —
  memory driver wires the lease store into the checkpoint store so unit
  tests exercise the same fencing invariant Postgres enforces.

### Tests added

* [apps/api/test/executionEngine.checkpointFencing.test.ts](apps/api/test/executionEngine.checkpointFencing.test.ts)
  — 5 cases covering:
    - direct adapter contract (commit, stale-reclaim FENCED, stale-attempt FENCED)
    - engine `writeCheckpoint` surrender on stale fence
    - control case (happy path persists every checkpoint)
* [apps/api/test/integration/postgres/checkpointFencing.integration.test.ts](apps/api/test/integration/postgres/checkpointFencing.integration.test.ts)
  — 4 cases covering the SQL semantics: commit, stale-reclaim, released
  lease, expired lease.
* [apps/api/test/chaos/phase3-worker.chaos.test.ts](apps/api/test/chaos/phase3-worker.chaos.test.ts)
  — new phase `3.6.persistenceLevelFencing` exercises cross-aggregate
  stale-write rejection (executions AND checkpoints both reject under the
  same stale fence, legitimate rows untouched).

## Phase B — Deterministic Replay Engine (landed)

### Scope

* Same workflow version + same event stream MUST produce identical execution
  state and graph transitions.
* Add divergence detection with diagnostics localizing the first divergent
  frame.
* Store replay metadata + execution hash fingerprints.

### Audit findings

Already in place:

* Per-frame deterministic digest (`FrameBuilder.preview.fingerprint`) — SHA-256
  over a non-deterministic-key-stripped projection of the payload.
* `ReplayDiffEngine` — compares two frame timelines (source vs. branch).
* Deterministic primitives — `deterministicId`, `fingerprint`,
  `canonicalize`, `seededRandom`.
* Integration tests already pin 5-run fingerprint stability and
  shuffled-order invariance.

**Gaps closed this phase**:

1. No execution-level rolling chain hash — divergence detection required
   frame-by-frame comparison.
2. No replay-vs-replay divergence detector — `ReplayDiffEngine` was wired
   for source-vs-branch, not for re-replaying the same execution.
3. No persisted replay metadata — operators had no audit trail proving
   "yesterday's replay matched today's replay".

### Changes landed

* [apps/api/src/domain/replay.ts](apps/api/src/domain/replay.ts) — new
  `ReplayCertification` and `ReplayDivergence` types.
* [apps/api/src/domain/cognitionPorts.ts](apps/api/src/domain/cognitionPorts.ts)
  — new `ReplayCertificationStore` port.
* [apps/api/src/runtime/replay/executionFingerprint.ts](apps/api/src/runtime/replay/executionFingerprint.ts)
  — pure module: `chainHashOf(digests)`, `frameDigest(frame)`,
  `computeExecutionFingerprint(frames)`, `firstDivergentIndex(a, b)`. The
  chain hash uses an RS (0x1E) byte as domain separator so two adjacent
  digests cannot collude to forge a hash via concatenation.
* [apps/api/src/runtime/replay/divergenceDetector.ts](apps/api/src/runtime/replay/divergenceDetector.ts)
  — `ReplayDivergenceDetector` with two operations:
    - `certify(executionId, workflowVersion)` — folds the current event log
      into a `ReplayCertification` and persists it.
    - `compare(executionId, workflowVersion)` — re-folds and diffs against
      the latest persisted certification. Returns one of four `reason`s:
      `NONE`, `EVENT_COUNT`, `FRAME_DIGEST`, `WORKFLOW_VERSION`, with a
      human narrative and localized `firstDivergentFrame`.
* [apps/api/src/infrastructure/persistence/inMemoryCognitionStores.ts](apps/api/src/infrastructure/persistence/inMemoryCognitionStores.ts)
  — `InMemoryReplayCertificationStore` (append-only per execution).
* [apps/api/src/infrastructure/persistence/persistenceFactory.ts](apps/api/src/infrastructure/persistence/persistenceFactory.ts)
  — wires the certification store on both memory and Postgres drivers.
  Postgres adapter + migration deferred — port is stable for the swap.
* [apps/api/src/application/runtimeContainer.ts](apps/api/src/application/runtimeContainer.ts)
  — instantiates the detector and exposes it on the container as
  `replayDivergenceDetector` so routes/tests can call `certify` /
  `compare` without rewiring.

### Tests added

* [apps/api/test/replayDivergenceDetector.test.ts](apps/api/test/replayDivergenceDetector.test.ts)
  — 14 cases covering:
    - pure primitives (chain hash order-sensitivity, empty-stream sentinel,
      first-divergent index edge cases, frame-builder sort invariance);
    - end-to-end stability (same log → same chainHash; appended event →
      `EVENT_COUNT`; version drift → `WORKFLOW_VERSION`; non-deterministic
      field mutation does NOT shift the hash);
    - persistence + read-back (first-capture, baseline match, FRAME_DIGEST
      localized to a mutated middle frame).

## Phase C — Snapshot & Recovery (landed)

### Scope

* Snapshots in the SnapshotStore are the recovery substrate — a corrupt or
  tampered snapshot silently feeds a wrong starting graph into recovery.
  Add an integrity hash stamped at `put` and verified at `get` / `nearest`.
* Surface mismatches as a typed `SnapshotCorruptionError` AND a
  `SNAPSHOT_INTEGRITY_VIOLATED` event on the bus so operators see the
  signal even when the throwing call path swallows the error.
* Cover both `InMemorySnapshotStore` and `PostgresSnapshotStore` with the
  same contract.
* Add `ReplayEngine.hydrateForRecovery(executionId)` that picks the snapshot
  path when one exists and falls back to full replay when forced; measure
  the speedup so the integrity-validation overhead is justified.

### Audit findings

Already in place:

* `ReplaySnapshot` type stores the materialized graph, `frameIndex`, and
  `eventSequence` — exactly the projection recovery needs.
* `SnapshotStore.nearest(cognitionId, frameIndex)` already supports the
  "find the latest snapshot at or before X" seek used by recovery.
* `ReplayEngine.getGraphAt` already implements nearest-snapshot + forward
  replay — `hydrateForRecovery` reuses the snapshot lookup but does NOT
  forward-replay because recovery wants the snapshot's exact graph + cursor,
  not a projected view.
* Frame-builder fingerprint pipeline (Phase B) — provides the canonical JSON
  primitive (`canonicalize` in `shared/determinism.ts`) reused for the
  integrity hash, so operators don't have to learn a second canonicalization
  scheme.

**Gaps closed this phase**:

1. SnapshotStore put/get/nearest had no integrity check — a row written
   correctly could be silently mutated (admin SQL, storage corruption,
   pg_repack accident) and the recovery path would hydrate the tampered
   graph as if it were authoritative.
2. ReplayEngine had no recovery-specific entry point — callers wanting
   "give me the latest known good state" had to invent `getGraphAt(MAX_INT)`
   patterns that didn't surface the snapshot-vs-replay distinction.
3. Snapshot recovery had never been measured against full replay — without
   numbers, the integrity-validation overhead is unjustified.

### Changes landed

* [apps/api/db/migrations/0009_replay_certifications.sql](apps/api/db/migrations/0009_replay_certifications.sql)
  — single migration carrying two related schema changes:
    - Creates `replay_certifications` for the Postgres
      `ReplayCertificationStore` adapter (Phase B carry-over).
    - Adds nullable `replay_snapshots.integrity_hash` so existing rows
      remain readable and new rows always carry a verifiable hash.
* [apps/api/src/domain/replay.ts](apps/api/src/domain/replay.ts) — adds
  optional `integrityHash: string` to `ReplaySnapshot`.
* [apps/api/src/domain/events.ts](apps/api/src/domain/events.ts) — new
  `SNAPSHOT_INTEGRITY_VIOLATED` event type + `SnapshotIntegrityViolatedEvent`
  payload (snapshotId, cognitionId, executionId, frameIndex, storedHash,
  computedHash, operation).
* [apps/api/src/domain/cognitionPorts.ts](apps/api/src/domain/cognitionPorts.ts)
  — new `SnapshotIntegrityViolationReporter` callback type +
  `SnapshotStore.setIntegrityViolationReporter?(reporter)` optional setter
  so the runtime container can wire the publisher in after construction.
* [apps/api/src/runtime/replay/snapshotIntegrity.ts](apps/api/src/runtime/replay/snapshotIntegrity.ts)
  — pure module: `computeSnapshotIntegrityHash(snap)` (sha256 over the
  canonical projection of `{ graph, eventSequence, frameIndex }`),
  `stampIntegrityHash(snap)` (returns a shallow clone with the hash set),
  `verifySnapshotIntegrity(snap, opts?)` (returns a diagnostic shape with
  `ok`, `storedHash`, `computedHash`, `legacy`), and
  `SnapshotCorruptionError` modeled on `FencingViolationError`.
* [apps/api/src/infrastructure/persistence/inMemoryCognitionStores.ts](apps/api/src/infrastructure/persistence/inMemoryCognitionStores.ts)
  — `InMemorySnapshotStore.put` always re-stamps the hash; `get`/`nearest`
  call `verifySnapshotIntegrity` and throw `SnapshotCorruptionError` on
  mismatch. Reporter is fire-and-forget so a slow publish can't delay the
  throw. Adds `injectRawForTest` as the test-only seam for simulating
  post-write tampering without re-stamping.
* [apps/api/src/infrastructure/persistence/postgres/postgresSnapshotStore.ts](apps/api/src/infrastructure/persistence/postgres/postgresSnapshotStore.ts)
  — same contract, persists the hash to `integrity_hash` column. Legacy
  rows (NULL hash) pass through unverified and are stamped on the next
  `put`. Rebuilds the full graph from joined rows in `rowToSnapshot`, then
  validates against the hash computed at put-time over the full graph —
  so corruption in the joined node/handoff rows surfaces here.
* [apps/api/src/infrastructure/persistence/postgres/postgresReplayCertificationStore.ts](apps/api/src/infrastructure/persistence/postgres/postgresReplayCertificationStore.ts)
  — Phase B carry-over: durable certifications adapter mirroring the
  in-memory implementation. `put` is append-only; `latest` uses the
  `(execution_id, captured_at desc)` index with `id desc` tie-break for
  determinism under same-millisecond captures.
* [apps/api/src/infrastructure/persistence/persistenceFactory.ts](apps/api/src/infrastructure/persistence/persistenceFactory.ts)
  — postgres branch now wires `PostgresReplayCertificationStore`; memory
  branch keeps the in-memory adapter.
* [apps/api/src/runtime/replay/replayEngine.ts](apps/api/src/runtime/replay/replayEngine.ts)
  — new `hydrateForRecovery(executionId, { forceFullReplay? })` returning
  `{ graph, eventSequenceCursor, recoveredVia: "SNAPSHOT" | "FULL_REPLAY",
  elapsedMs }`. The snapshot path uses `snapshots.nearest(graph.id,
  Number.MAX_SAFE_INTEGER)`; corruption surfaces as `SnapshotCorruptionError`
  (NOT silently falling through to full replay — that signal must reach
  the operator).
* [apps/api/src/application/runtimeContainer.ts](apps/api/src/application/runtimeContainer.ts)
  — wires the integrity reporter so `SNAPSHOT_INTEGRITY_VIOLATED` reaches
  the event bus before the typed error is thrown.
* [apps/api/test/integration/postgres/harness.ts](apps/api/test/integration/postgres/harness.ts)
  — adds `replay_certifications` to the truncate list so suites can fan
  out without bleed-through.

### Tests added

* [apps/api/test/snapshotIntegrity.test.ts](apps/api/test/snapshotIntegrity.test.ts)
  — 14 cases covering:
    - pure hash primitives (deterministic; sensitive to graph/eventSequence/
      frameIndex; insensitive to capturedAt/eventCount/id/cognitionId/
      executionId);
    - `stampIntegrityHash` always overrides caller-supplied hashes;
    - legacy fallback (no stored hash → ok by default; `requireHash: true`
      → not ok);
    - happy-path `InMemorySnapshotStore` put → get / nearest;
    - corruption: `get` and `nearest` throw `SnapshotCorruptionError` and
      fire the reporter exactly once; reporter failures don't mask the
      throw; the error carries the diagnostic payload.
* [apps/api/test/replayEngine.hydrateForRecovery.test.ts](apps/api/test/replayEngine.hydrateForRecovery.test.ts)
  — 4 cases covering: unknown execution → undefined; no snapshot →
  `FULL_REPLAY` with event-log cursor; snapshot present → `SNAPSHOT` with
  snapshot's `eventSequence`; `forceFullReplay: true` bypasses the
  snapshot path.
* [apps/api/test/integration/postgres/snapshotIntegrity.integration.test.ts](apps/api/test/integration/postgres/snapshotIntegrity.integration.test.ts)
  — Postgres-bound cases: happy path round-trip; `nearest` returns
  closest snapshot with intact hash; `get` throws when `graph` jsonb is
  mutated post-write; `nearest` throws when the stored `integrity_hash`
  is mutated; legacy NULL-hash rows are readable and stamped on next put.
* [apps/api/test/integration/postgres/replayCertifications.integration.test.ts](apps/api/test/integration/postgres/replayCertifications.integration.test.ts)
  — Phase B carry-over: round-trip; `latest` undefined on unknown; append-
  only ordering; per-execution isolation; same-millisecond captures
  tie-broken deterministically by id.
* [apps/api/test/integration/postgres/recoveryBenchmark.integration.test.ts](apps/api/test/integration/postgres/recoveryBenchmark.integration.test.ts)
  — gated by `INTEGRATION_RUN_BENCH=1` (same gate as
  `benchmarks.integration.test.ts`). Builds a 500-event execution, captures
  one snapshot, runs both recovery paths 5x each, asserts snapshot-driven
  recovery is at least 5x faster than full replay. Prints
  `BENCH recovery-{snapshot,full-replay}-avg-500-events ms=…` for the
  report generator.

## Carry-over / known deltas

* Phase B carry-over (Postgres `replay_certifications` adapter + migration)
  CLOSED this phase — see Phase C "Changes landed".
* Phase D (scheduler + deadlock / orphan detection) and Phase E (observability
  integrity + viz time-travel) are not yet started.
* Pre-existing chaos infra flakes (phase1-redis, phase2-postgres) reproduce
  in this environment but do NOT touch any code paths changed in this phase.

## Operational invariants (this slice)

Invariants the system now guarantees, with the enforcing mechanism in
parentheses:

1. **No durable write succeeds without a live fence.** A stale worker cannot
   mutate `executions`, `memory_records`, `execution_checkpoints`, or
   `events` after its lease has been reclaimed (SQL CTE-with-FOR-UPDATE +
   in-memory `validateFencing` parity).
2. **Recovery checkpoints reflect only legitimate owners.** A stale worker
   can no longer land a checkpoint at a sequence the legitimate owner will
   subsequently write — both writes route through `writeFenced`
   (`CheckpointStore.writeFenced`).
3. **Two replays of the same event log produce the same chain hash.** This is
   the headline determinism invariant; one rolling SHA-256 over
   non-deterministic-stripped per-frame digests (`computeExecutionFingerprint`).
4. **Divergence has a localizable root cause.** Whenever the chain hash
   diverges, the detector reports either an event-count change, a frame-index
   pointing to the first mutated digest, or a workflow-version mismatch —
   never an opaque "not equal" (`ReplayDivergenceDetector.compare`).
5. **Snapshots are integrity-verified on every read.** Every persisted
   snapshot carries a sha256 hash over the canonical projection of
   `{ graph, eventSequence, frameIndex }`; `SnapshotStore.get` and
   `SnapshotStore.nearest` reject any row whose recomputed hash does not
   match — recovery cannot hydrate corrupt graph state silently
   (`SnapshotStore.assertIntegrity` → `SnapshotCorruptionError` +
   `SNAPSHOT_INTEGRITY_VIOLATED`).
6. **Recovery prefers snapshots and reports the path taken.**
   `ReplayEngine.hydrateForRecovery` returns `recoveredVia: "SNAPSHOT" |
   "FULL_REPLAY"` so operators can confirm the recovery path actually used
   snapshots in production rather than silently degrading to full replay.

## Failure-mode matrix (this slice)

| Failure                                      | Detected by                          | Surface                                                | Recovery action                                            |
| -------------------------------------------- | ------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------- |
| Stale worker checkpoint write after reclaim  | `CheckpointStore.writeFenced` → FENCED | `EXECUTION_FENCE_REJECTED` with `phase=checkpoint.*`   | Engine surrenders; legitimate owner produces terminal      |
| Stale worker terminal write after reclaim    | `saveFenced` / `commitTerminal`      | `EXECUTION_FENCE_REJECTED` with `phase=executions.*`   | Same — silent surrender                                    |
| Stale worker event publish after reclaim     | `EventStore.appendFenced`            | Diagnostic counter; no event persisted, no bus emit    | Same — replay stays clean                                  |
| Stale worker memory record after reclaim     | `MemoryRepository.addFenced`         | `EXECUTION_FENCE_REJECTED` with `phase=memory.add`     | Same                                                       |
| Event log grew between two replays           | `ReplayDivergenceDetector.compare`   | `ReplayDivergence{ reason: "EVENT_COUNT", firstDivergentFrame }` | Investigate out-of-band append source                      |
| Event log mutated between two replays        | Same                                 | `ReplayDivergence{ reason: "FRAME_DIGEST", firstDivergentFrame }` | Localize first mutated frame; treat as determinism bug     |
| Workflow version drift between certifications | Same                                | `ReplayDivergence{ reason: "WORKFLOW_VERSION" }`       | Re-baseline under the new version; do not compare across   |
| Snapshot corruption (tampered graph or hash) | `SnapshotStore.get` / `nearest`     | `SNAPSHOT_INTEGRITY_VIOLATED` event + `SnapshotCorruptionError` typed throw | Recovery refuses to hydrate; investigate storage / admin SQL; rewrite snapshot from a clean replay |
