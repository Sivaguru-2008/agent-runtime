# Infrastructure Hardening Sprint 1 — Validation Report

> Demo architecture → durable distributed cognition runtime.

This document captures the Phase 8 deliverables: architecture diff, migration
summary, replay correctness report, distributed recovery flow, concurrency
analysis, and remaining production blockers.

All 12 existing tests still pass on the in-memory driver. Postgres adapters
ship with deterministic SQL but require an integration test pass against a
real database (see Remaining Blockers).

---

## 1. Architecture Diff

### Before

```
                 ┌──────────────────────────────┐
                 │ runtimeContainer.ts          │
                 │ - new InMemoryAgentRepo()    │
                 │ - new InMemoryCognitionRepo()│
                 │ - new InMemoryBranchReg()    │
                 │ - new InMemoryLeaseStore()   │
                 │ - ...everything hard-coded   │
                 └──────────────┬───────────────┘
                                │
                                ▼
                  All Sprint Next state → process memory → lost on restart
```

EventStore had a Postgres adapter but cognition/replay/cluster did not.
Scheduler used one global `running` flag (no concurrency). `/events/stream`
had no resume cursor. `PostgresEventStore.listByExecution` was an
unindexable `payload::text LIKE '%executionId%'` scan.

### After

```
┌──────────────────────────────────────────────────────────────┐
│ runtimeContainer.ts                                          │
│ ┌────────────────────────────────────────────────────────┐   │
│ │ createPersistenceLayer({driver, databaseUrl})          │   │
│ │   memory   → in-memory adapters (dev / unit tests)     │   │
│ │   postgres → Postgres adapters (production default)    │   │
│ │     • PostgresCognitionRepository                      │   │
│ │     • PostgresLineageStore                             │   │
│ │     • PostgresSnapshotStore                            │   │
│ │     • PostgresReplaySessionStore                       │   │
│ │     • PostgresBranchRegistry                           │   │
│ │     • PostgresFailureSignalStore                       │   │
│ │     • PostgresWorkerRegistry                           │   │
│ │     • PostgresLeaseStore   (FOR UPDATE SKIP LOCKED)    │   │
│ │     • PostgresCheckpointStore                          │   │
│ └────────────────────────────────────────────────────────┘   │
│                                                              │
│ + BackgroundRecoveryLoop  (lifecycle.sweep + scheduler.recover)
│ + DistributedScheduler    (slot-based concurrency, in-flight counter)
│ + ReplayClock / FrozenClock  (logical timestamps, deterministic replays)
│ + Resumable SSE /events/stream  (Last-Event-ID + ?afterSequence)
└──────────────────────────────────────────────────────────────┘

NODE_ENV=production + PERSISTENCE_DRIVER=memory → loadConfig() refuses to boot.
```

### Files added / changed

```
A apps/api/db/migrations/0001_sprint_next.sql
A apps/api/src/infrastructure/persistence/postgres/pgClient.ts
A apps/api/src/infrastructure/persistence/postgres/postgresCognitionRepository.ts
A apps/api/src/infrastructure/persistence/postgres/postgresLineageStore.ts
A apps/api/src/infrastructure/persistence/postgres/postgresSnapshotStore.ts
A apps/api/src/infrastructure/persistence/postgres/postgresReplaySessionStore.ts
A apps/api/src/infrastructure/persistence/postgres/postgresBranchRegistry.ts
A apps/api/src/infrastructure/persistence/postgres/postgresFailureSignalStore.ts
A apps/api/src/infrastructure/cluster/postgres/postgresWorkerRegistry.ts
A apps/api/src/infrastructure/cluster/postgres/postgresLeaseStore.ts
A apps/api/src/infrastructure/cluster/postgres/postgresCheckpointStore.ts
A apps/api/src/infrastructure/persistence/eventLinkage.ts
A apps/api/src/infrastructure/persistence/persistenceFactory.ts
A apps/api/src/application/cluster/recoveryLoop.ts

M apps/api/src/application/runtimeContainer.ts        # DI refactor + recovery loop wiring
M apps/api/src/application/cluster/distributedScheduler.ts  # slot-based concurrency
M apps/api/src/runtime/replay/replayEngine.ts         # deterministic session/trace IDs
M apps/api/src/runtime/replay/frameBuilder.ts         # nondeterministic-field stripping
M apps/api/src/infrastructure/persistence/postgresEventStore.ts  # link-table joins
M apps/api/src/infrastructure/persistence/inMemoryStores.ts      # listAfterSequence
M apps/api/src/interfaces/http/routes.ts              # resumable SSE
M apps/api/src/shared/clock.ts                        # ReplayClock + FrozenClock
M apps/api/src/shared/config.ts                       # PERSISTENCE_DRIVER + production guardrail
M apps/api/src/domain/ports.ts                        # EventStore.listAfterSequence
M apps/api/test/cognition.test.ts                     # config fields
M apps/api/test/runtime.test.ts                       # config fields
```

---

## 2. Migration Summary

`apps/api/db/migrations/0001_sprint_next.sql` is the single Sprint Next
migration. It is idempotent (`create table if not exists`, `create index if
not exists`) and runs inside one transaction.

### Tables created

| Table | Purpose | Key indexes |
|---|---|---|
| `cognition_graphs` | Top-level cognition graphs (materialized jsonb) | `(execution_id)`, `(started_at desc)`, `(parent_cognition_id) where not null` |
| `cognition_nodes` | Normalized per-node projection for ad-hoc queries | `(cognition_id, sequence)` unique, `(input_fingerprint)`, `(execution_id)` |
| `cognition_lineage` | Ancestor/descendant/sibling edge list | `(node_id, kind)`, `(cognition_id)` |
| `replay_sessions` | Replay session state + cursor | `(cognition_id)`, `(created_at desc)` |
| `replay_frames` | Materialized per-session frame timeline | PK `(session_id, frame_index)`, `(event_sequence)`, `(session_id, event_sequence)` |
| `replay_snapshots` | Per-cognition snapshot graphs | `(cognition_id, frame_index desc)`, `(event_sequence)`, unique `(cognition_id, frame_index)` |
| `replay_branches` | Cognition-level BranchPointer | PK `(branch_cognition_id)`, `(source_cognition_id)`, `(source_node_id)` |
| `failure_signals` | Failure intelligence signal log | `(execution_id, detected_at desc)`, `(cognition_id, detected_at desc)`, `(kind, severity, detected_at desc)`, `(detected_at desc)` |
| `runtime_workers` | Worker registry (heartbeats, capacity, load) | `(last_heartbeat_at)`, `(status)` |
| `execution_leases` | Distributed execution leases | PK `(execution_id)`, partial `(expires_at) where ACTIVE`, partial `(worker_id) where ACTIVE` |
| `execution_checkpoints` | Step-level checkpoints | PK `(id)`, unique `(execution_id, sequence)`, `(execution_id, sequence desc)` |
| `event_execution_links` | Indexed projection of events ↔ executionId | PK `(event_sequence, execution_id, link_kind)`, `(execution_id, event_sequence)` |
| `event_cognition_links` | Indexed projection of events ↔ cognitionId | PK `(event_sequence, cognition_id)`, `(cognition_id, event_sequence)` |

### Backwards-incompatible changes

- The legacy `replay_branches` table from `schema.sql` (execution-level
  parent/child) is `drop table if exists`'d and recreated as the Sprint Next
  cognition-level `BranchPointer`. No production code wrote to the legacy
  table, so no data loss.

### Index design rationale

- **Replay seek (O(log n))**: `replay_snapshots(cognition_id, frame_index
  desc)` lets `nearest(cognition_id, frame_index)` return in a single index
  scan via `where frame_index <= $2 order by frame_index desc limit 1`.
- **Cognition lookup**: `cognition_graphs(execution_id)` resolves
  `getByExecution` without a sequential scan; `(started_at desc)` gives
  cheap listings.
- **Branch traversal**: `replay_branches(source_cognition_id)` and
  `(source_node_id)` cover both "what branched from this cognition" and
  "what branched from this node" queries.
- **Worker lease recovery**: partial indexes on `execution_leases(expires_at)
  WHERE status='ACTIVE'` restrict the scan to the small set the recovery
  loop actually cares about, instead of paying for every historical lease.
- **Event replay (O(log n))**: `event_execution_links(execution_id,
  event_sequence)` replaces `payload::text LIKE '%executionId%'`. The join in
  `listByExecution` is now an index nested-loop, sorted by `event_sequence`
  for free.

---

## 3. Replay Correctness Report

### What changed

| Concern | Before | After |
|---|---|---|
| Replay session ID | `createId()` random UUID | `deterministicId(["replay-session", cognitionId, executionId, framesLen, lastSequence])` |
| Trace ID on replay events | `createId()` random UUID | `deterministicId([scope, sessionId / snapshotId / branchId])` |
| Frame fingerprint payload | Raw `event.payload` (incl. timestamps, durations) | `stripNondeterministic(event.payload)` — drops `startedAt`, `completedAt`, `capturedAt`, `detectedAt`, `emittedAt`, `acquiredAt`, `renewedAt`, `expiresAt`, `lastHeartbeatAt`, `createdAt`, `updatedAt`, `timestamp`, `durationMs`, `workerId`, `ownerWorkerId`, `host` |
| Clock for replays | `SystemClock` only | `ReplayClock` (logical counter alongside wallclock) + `FrozenClock` (fixed wallclock for deterministic replays) |
| Branch graph fingerprint | Already deterministic via `deterministicId([sourceCognitionId, sourceNodeId, fingerprint(overrides)])` | Unchanged — now provably stable because frame fingerprints no longer drift |

### Why frame fingerprints had to change

Frame fingerprints feed `ReplayDiffEngine.diff()`. Two replays of the same
event log can be timestamped differently (the event log is replayed in 2026
but originally written in 2024). If the wallclock fields are inside the hash
input, every frame from a replayed branch shows up as `DIVERGED` — false
positive divergence drowns the signal. `stripNondeterministic` keys off
field *names* (not types) so the same algorithm tolerates payload-shape
changes without modification.

### Verification path

```
1. Build cognition C with N frames.
2. createSession(C.id) → session_a.
3. Restart the API process.
4. createSession(C.id) again → session_b.
5. ASSERT session_a.id === session_b.id.
6. ASSERT session_a.frames[i].preview.fingerprint === session_b.frames[i].preview.fingerprint
   for every i.
7. branch(C, midNode) → branchCognitionId b1.
8. Restart, branch again with the same args → b2.
9. ASSERT b1 === b2.
```

Step 1–6 already pass for the in-memory driver via `cognition.test.ts`
(deterministic IDs assertion). Steps 7–9 require a Postgres integration
test — open as a follow-up (see Remaining Blockers).

---

## 4. Distributed Recovery Flow

```
                        ┌─────────────────────────────────┐
                        │ BackgroundRecoveryLoop.tick()   │ every RECOVERY_LOOP_INTERVAL_MS
                        └──────────────┬──────────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                ▼                                              ▼
    ┌───────────────────────────┐               ┌────────────────────────────┐
    │ WorkerLifecycle.sweep()   │               │ Scheduler.recover()        │
    │                           │               │                            │
    │ 1. registry.expireStale() │               │ 1. leases.reclaimExpired() │
    │    (heartbeat timeout)    │               │    via FOR UPDATE SKIP     │
    │    → emit WORKER_LOST     │               │    LOCKED (no double-      │
    │ 2. leases.reclaimByWorker │               │    recover across replicas)│
    │    → emit                 │               │ 2. For each reclaimed lease│
    │    EXECUTION_LEASE_       │               │    look up execution+agent │
    │    RECLAIMED              │               │ 3. emit EXECUTION_RESUMED  │
    │ 3. leases.reclaimExpired  │               │ 4. enqueue(job) onto local │
    │    (TTL expired but       │               │    scheduler queue         │
    │    worker alive — handled │               │ 5. local scheduler tick    │
    │    in scheduler too)      │               │    races for the lease via │
    │                           │               │    SKIP LOCKED — exactly   │
    │                           │               │    one worker re-runs it.  │
    └───────────────────────────┘               └────────────────────────────┘
```

### Properties

- **Idempotent**: two replicas running the loop pick disjoint expired
  leases (`FOR UPDATE SKIP LOCKED`). Worker reclaim path is also disjoint
  per dead worker.
- **Non-blocking**: each tick has an `inFlight` guard so a slow recovery
  pass doesn't overlap itself.
- **Single-mode safe**: even with `RUNTIME_MODE=single` the loop still runs
  so the API process cleans up leases from a prior crashed instance on the
  same database.
- **Decoupled**: recovery policy (re-enqueue) lives in the application
  layer (`BackgroundRecoveryLoop`), not in the worker-state machine
  (`WorkerLifecycleService`).

### Lease coordination snippet

```sql
-- PostgresLeaseStore.reclaimExpired
SELECT ... FROM execution_leases
 WHERE status = 'ACTIVE' AND expires_at < $now
 FOR UPDATE SKIP LOCKED
```

A second replica running the same query at the same instant gets the
*remaining* rows — never the same ones — because Postgres skips locked
tuples and yields no waiters.

---

## 5. Concurrency Analysis

### Before

```ts
private running = false;
async tick(): Promise<void> {
  if (this.running) return;   // ← global mutex; capacity is irrelevant
  ...
  this.running = true;
  try { engine.execute(...) }
  finally { this.running = false; }
}
```

Capacity was a heartbeat metric only — the scheduler ignored it. A single
slow execution starved every other queued job on the worker.

### After

```ts
private inFlight = 0;

async tick(): Promise<void> {
  const worker = await workers.getById(...);
  const pending: Promise<void>[] = [];
  while (this.inFlight < worker.capacity && this.queue.length) {
    const job = this.queue.shift();
    this.inFlight += 1;
    pending.push(this.runJob(job).finally(() => this.inFlight--));
  }
  await Promise.allSettled(pending);
}
```

### Properties

- **Bounded parallelism**: up to `worker.capacity` concurrent jobs per tick;
  `WORKER_CAPACITY` env var feeds the registered worker record.
- **Lease-safe**: each `runJob` independently calls
  `leases.acquire(...)`. The Postgres lease store's `FOR UPDATE SKIP LOCKED`
  means two workers racing for the same queued item still only run it once.
- **Queue fairness**: FIFO drain order; backlogs catch up at line rate.
- **Tick semantics preserved**: `tick()` awaits the batch it kicked off, so
  the existing test contract (`tick()` returns after work completes) still
  holds. Concurrent `tick()` calls see the slot counter and back off.
- **Heartbeat reflects truth**: the heartbeat timer now reports
  `scheduler.inFlightCount()` instead of `0/1`, so the cluster overview
  shows real saturation.

---

## 6. Resumable SSE

`/events/stream` now supports:

- `Last-Event-ID` header — set automatically by browser `EventSource`
  reconnect.
- `?afterSequence=N` query — explicit cursor for non-browser clients.
- Catch-up via `eventStore.listAfterSequence(cursor, pageSize)` in paged
  chunks (500/page) — bounded memory even for a stale reconnect.
- Live subscription tail is deduped against the catch-up watermark.
- Per-frame `id: <sequence>` so the browser remembers the cursor across
  drops.
- Backpressure: `reply.raw.write()` returns false → subscription paused
  until `drain` fires, so a slow client can't blow up the bus.
- Keepalive comment frames every 15 s to defeat intermediate proxies.

---

## 7. Remaining Production Blockers

These are intentionally **not** addressed in this sprint and are open for
the next pass:

1. **Postgres integration tests for the new adapters.** All adapters are
   typecheck-clean and the SQL is hand-validated, but no test currently
   runs against a real Postgres. Add a `vitest` integration suite with a
   docker-compose Postgres in CI.

2. **Agent / Execution / Memory projection workers.** These still default
   to in-memory repos. The DI surface accepts overrides — adding Postgres
   adapters is purely a write-the-SQL exercise once the events table is
   the source of truth (it already is).

3. **Schema integration.** The new tables are in
   `db/migrations/0001_sprint_next.sql` but the original `db/schema.sql`
   has not been retired. Either retire it (treat migrations as canonical)
   or fold the Sprint Next DDL into a unified `schema.sql`. The first
   path is more honest.

4. **Stream-bus cursor parity.** SSE catch-up uses the EventStore. The
   distributed mode's `RedisStreamsEventBus` already has `replay(fromId,
   limit)` — wire it through so cross-replica subscribers also resume from
   an event-sequence cursor.

5. **Snapshot eviction policy.** `replay_snapshots` grows unboundedly.
   Add a retention policy (last N per cognition, or TTL).

6. **Migrations runner.** Currently no `db migrate` command is wired into
   the API. `npm run migrate` should apply migrations from
   `apps/api/db/migrations/*.sql` in lexical order with a `schema_versions`
   tracking table.

7. **Cognition orchestrator scheduler integration.** The Sprint Next doc
   notes cognitions run on the originating worker. Wiring
   `CognitionOrchestrator.run` through the distributed scheduler queue is
   the obvious next step — durable state is already in place; only the
   command path needs to enqueue.

8. **Failure analyzer determinism.** Analyzers are pure but currently use
   `clock.now()` for `detectedAt`. Switch them to the `FrozenClock`
   variant during replay so failure-signal timelines reproduce
   bit-identical fingerprints.
