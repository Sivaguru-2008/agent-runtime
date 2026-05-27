# Postgres Integration Hardening — Sprint Hardening Phase 2

> Eliminates the single largest production risk remaining after Sprint
> Hardening 1: the absence of any test pass against a real Postgres backend.

## 1. What this sprint did

Sprint Hardening 1 built every Postgres adapter (event store, cognition
repository, lineage, snapshots, replay sessions, branch registry, failure
signals, worker registry, lease store, checkpoint store) plus the
`0001_sprint_next.sql` migration. It closed by stating:

> _"All 12 existing tests still pass on the in-memory driver. Postgres
> adapters ship with deterministic SQL but require an integration test pass
> against a real database (see Remaining Blockers)."_

This sprint fills exactly that gap. **No domain contracts, ports, IDs,
fingerprints, or event semantics were changed.** Every file added is under
`apps/api/test/integration/postgres/` plus this doc and the benchmark report.

## 2. Architecture of the harness

```
test/integration/postgres/
├── harness.ts                         ← container/external bootstrap + schema
├── factories.ts                       ← deterministic event/graph/lease seeders
├── clocks.ts                          ← ManualClock + re-exported FrozenClock
├── concurrency.ts                     ← fanOut, parallelMap, eventually, shuffle
├── eventStore.integration.test.ts     ← Phase 2
├── leaseStore.integration.test.ts     ← Phase 3
├── replayDeterminism.integration.test.ts ← Phase 4
├── sseResume.integration.test.ts      ← Phase 5
├── chaos.integration.test.ts          ← Phase 6
└── benchmarks.integration.test.ts     ← Phase 7 (opt-in)
```

### 2.1 Database lifecycle (`harness.ts`)

`tryStartHarness()` resolves a Postgres in priority order:

1. **`SKIP_POSTGRES_INTEGRATION=1`** → returns `null`, suite skips. Used in
   environments where Docker is intentionally absent.
2. **`INTEGRATION_DATABASE_URL=postgres://…`** → connects to an externally
   provisioned Postgres, creates a *disposable database* named
   `agents_it_<timestamp>_<rand>`, runs schema + migrations, returns a
   harness whose `stop()` drops that database with `WITH (FORCE)`. This is
   the path CI runners use when Postgres is provided as a service.
3. **`@testcontainers/postgresql`** → ephemeral container, tuned for tests:
   `fsync=off`, `synchronous_commit=off`, `full_page_writes=off`,
   `max_connections=200`. `restart()` is wired through for chaos tests.
4. **None of the above reachable** → returns `null`. Every `describe.skipIf`
   in the suite respects this so the suite skips cleanly with a single
   readable line rather than N stack traces.

`reset()` truncates every project table with `RESTART IDENTITY CASCADE`.
Cheaper than DROP+CREATE between tests and keeps `events.sequence` reset to
1, which makes assertions about sequence values reproducible across runs.

### 2.2 Determinism (`factories.ts` + `clocks.ts`)

Every fixture takes an explicit `seed: string`. Two test runs with the same
seed produce bit-identical:

- Event ids (via `deterministicId(seed, type, step)` → uuid)
- Cognition graph ids (via `deterministicId(seed, "cognition")`)
- Node ids (via `deterministicId(cognitionId, sequence, role, inputFingerprint)`)
- Timestamps (anchored to `FIXED_EPOCH = 2026-01-01T00:00:00Z` + step offset)

`suiteSeed(suiteName)` adds a `pid + counter` suffix so two suites running
in the same vitest worker never collide. Two suites running in *parallel*
workers cannot collide because each worker gets its own database (see 2.1).

### 2.3 Concurrency primitives (`concurrency.ts`)

- `fanOut(N, fn)` — `Promise.allSettled` of N invocations, returns
  `{results, errors}` separately so a partial failure surfaces without
  cancelling the rest.
- `parallelMap(items, fn)` — `Promise.all` of an item-indexed parallel
  invocation. Used when every invocation MUST succeed (vs `fanOut` which
  expects some failures, e.g. lease contention).
- `eventually(predicate, opts)` — polls until a condition holds or times
  out. Used by chaos tests waiting for an async recovery to complete.
- `shuffleDeterministic(items, seed)` — Lehmer-PRNG seeded shuffle. Used to
  prove the FrameBuilder defensively re-sorts by `sequence`.

## 3. Concurrency validation strategy

The harness validates each adapter against the exact concurrency contract
the production runtime depends on.

### 3.1 Event store — bigserial monotonicity under N writers

`PostgresEventStore.append()` is a 3-statement transaction (INSERT events,
INSERT links). 1000 concurrent appends produce 1000 distinct
`sequence` values, max-min+1=N (gapless), with `event_execution_links`
referring only to existing event rows (no orphans).

The "no duplicate sequence emission" test is the gating assertion. If it
ever fails, either:
- a parallel commit raced a sequence assignment (impossible with
  `bigserial`, but theoretically possible with a custom counter),
- or the `event_execution_links` projection introduced a unique-constraint
  violation that rolled back an event whose link rows had already
  committed (the in-transaction insert order makes this impossible —
  links are written AFTER the event row, in the same tx).

### 3.2 Lease store — `FOR UPDATE SKIP LOCKED` proof

The acquire flow:

```sql
BEGIN;
  SELECT … FROM execution_leases WHERE execution_id = $1
    FOR UPDATE SKIP LOCKED;
  -- if no row or expired, INSERT or UPDATE
COMMIT;
```

The harness fires 16 concurrent `acquire()` calls against the same
execution. Exactly 1 returns a lease; 15 return `undefined`. None throw.
This is the production contract for distributed lease coordination — if
even one extra worker got a lease, the runtime would double-execute the
task.

For `reclaimExpired()`, the harness fires two concurrent reclaim loops on
the same 20 expired leases and asserts:
- the union of their reclaimed sets equals 20 (no missed reclaims),
- the intersection is empty (no phantom double-reclaim).

### 3.3 Replay determinism — bit-identical fingerprints over N reruns

`ReplayEngine.materializeFrames(graph)` is supposed to be a pure function of
the event log. The harness reads the event log, builds frames, repeats 5×,
and asserts every fingerprint vector is identical.

A separate test mutates every nondeterministic field on a payload clone
(`startedAt`, `completedAt`, `durationMs`, `workerId`, `capturedAt`,
`timestamp`) and confirms frame fingerprints do NOT change — this proves
the `stripNondeterministic` whitelist in `frameBuilder.ts` is doing its
job.

Session ID and trace ID stability: two engine instances (separate pools)
running on the same DB produce the same session id. This is the contract
that lets a re-connecting SSE client resume a replay session by id without
coordination.

### 3.4 SSE resumption — no-dup / no-skip under reconnect storms

The `/events/stream` route is exercised end-to-end via a real Fastify
listener:

- catch-up: seed N events, connect with `Last-Event-ID=cursor`, assert
  every seq > cursor arrives in ascending order with no duplicates.
- ?afterSequence: same shape, alternate cursor source.
- 8-way reconnect storm: 8 consumers reconnect simultaneously from
  different cursors. Each sees only events strictly greater than its own
  cursor, in order, no duplicates.
- 1500-event large catch-up: paged via `listAfterSequence(c, 500)`,
  asserts every seeded sequence arrives exactly once.

## 4. Deterministic replay guarantees

After this sprint, the following are tested against real Postgres:

| Guarantee                                          | Test                                          |
| -------------------------------------------------- | --------------------------------------------- |
| Same event log → identical frame fingerprints      | `fingerprint determinism` × 5 reruns          |
| Same cognition → identical replay session id       | two engines, same DB                          |
| Replay traceId is stable across calls              | two `createSession` calls share traceId       |
| Nondeterministic payload fields don't leak         | mutate timestamps/durations, fingerprint==    |
| Same branch input → identical `branchCognitionId`  | `branch()` twice with same overrides          |
| Different overrides → different branch ids         | branch with seed=A vs seed=B                  |
| Snapshot graph == recomputed `getGraphAt(N)`       | `snap-equiv` test                             |
| Frame ordering survives shuffled input             | `FrameBuilder.build(shuffle(log))` invariant  |
| Interrupted replay reloads coherently              | `interrupt` test reloads via `sessions.get()` |

## 5. Known edge cases & remaining production risks

The integration suite passes, but the following risks remain — they need
explicit follow-up work, not blanket "should work in production":

### 5.1 SSE live-stream out-of-order under concurrent appends (LATENT BUG)

`/events/stream` lines 258-264:

```js
const unsubscribe = container.eventBus.subscribe((event) => {
  const seq = event.sequence ?? 0;
  if (seq && seq <= cursor) return;       // ← drops 9 if 10 arrived first
  if (seq) cursor = seq;
  writeEvent(seq, event.type, event);
});
```

When two appends commit concurrently and arrive on the bus in
non-monotonic order (e.g. seq=10 reaches the bus subscriber before
seq=9), the watermark dedupe drops the later-arriving lower sequence.
Symptom: SSE consumers occasionally miss a frame, but `listByExecution`
still shows it — so the bug is invisible unless you compare the live
stream against the persistent log.

**Status:** not fixed in this sprint (out of scope per "Do NOT change
domain contracts unless a real defect is discovered" — this is a
behavioral defect in routing, not a contract violation, but the fix
needs design thought: a small ring buffer of seen sequences vs. a
re-sort window are both acceptable, with different latency profiles).

**Test coverage:** the "no duplicates" assertions in
`sseResume.integration.test.ts` do not catch this — they only assert
absence of duplicates, not absence of skips on the live path. A
regression test that forces interleaved appends from two pools is
needed to lock the fix in.

### 5.2 Embedded worker registration is fire-and-forget

`runtimeContainer.ts` registers the embedded worker inside
`void (async () => { … })()` with no error path. If the registration
fails (e.g. Postgres temporarily unreachable on boot), the worker is
silently never registered and `/cluster/overview` shows zero workers
indefinitely.

**Recommendation:** await registration during `buildApp`; degrade to a
clear startup error rather than silent absence.

### 5.3 Dual connection pools when both drivers are postgres

When `EVENT_STORE_DRIVER=postgres` AND `PERSISTENCE_DRIVER=postgres`,
the runtime opens TWO `pg.Pool`s to the same DB — one inside
`PostgresEventStore`, one inside `createPersistenceLayer`. Production
config will hit `max_connections` ~2× faster than necessary.

**Recommendation:** make `PostgresEventStore` accept a `PgClient` like
the other adapters; let the factory pass the shared pool when both
drivers are postgres.

### 5.4 Recovery loop has no jittered backoff

`BackgroundRecoveryLoop` fires every `RECOVERY_LOOP_INTERVAL_MS` exactly.
With multiple workers, all loops fire on the same edge — exactly the
"thundering herd" of reclaim queries that `FOR UPDATE SKIP LOCKED` is
designed to handle gracefully, BUT each worker still issues a
transaction every cycle. At scale this is unnecessary load.

**Recommendation:** add jitter (`interval ± 20%`) and consider a
leader-elected recovery to reduce the polling rate.

### 5.5 Snapshot graph stored as full jsonb

`replay_snapshots.graph` is the entire materialized `CognitionGraph` as
jsonb. For graphs with thousands of nodes (e.g. a long-running cognition)
this is fine for read but the on-disk size grows quadratically if a
snapshot is taken every K frames (each snapshot copies the whole graph).

**Recommendation:** snapshot the *delta* from the previous snapshot, not
the full graph. Out of scope for this sprint; flagged for the next.

### 5.6 No EXPLAIN regression gate

The integration suite measures latency but does not lock in query plans.
A future schema migration that accidentally drops an index would slip
through if it didn't push p95 over the soft threshold.

**Recommendation:** capture `EXPLAIN (FORMAT JSON)` for the 5 hottest
queries in CI and diff plan shapes (not costs).

## 6. CI execution strategy

### 6.1 Local development

```bash
# Default (no Docker, no integration) — exactly the current `npm test`:
npm test

# With Docker Desktop running:
npm run test:integration

# Benchmarks (opt-in, slow):
npm run test:integration:bench
```

The integration suite skips with a single line when Docker is
unreachable. Developers without Docker are not blocked.

### 6.2 CI pipeline (recommended)

Two separate workflows:

**`ci.yml`** — every PR, no Docker dependency.
- `npm run typecheck`
- `npm test`  (≈ 12 unit tests, ~5 s)

**`ci-integration.yml`** — every PR + nightly, Docker available.
- Uses `services: postgres:16` in GitHub Actions; expose
  `INTEGRATION_DATABASE_URL` to the runner.
- `npm run test:integration`  (≈ 60–90 s including container start)
- On nightly: `npm run test:integration:bench`, archive output to
  `bench-history/<date>.log`.

If `@testcontainers/postgresql` is desired in CI instead of a service,
ensure the runner has the `DOCKER_HOST` env so the SDK can find the
daemon (GitHub-hosted runners do; self-hosted runners may need
`docker-in-docker`).

### 6.3 Triage policy

- **Red unit suite** → blocks merge.
- **Red integration suite** → blocks merge.
- **Red benchmark suite** → does NOT block (advisory until 25%-regression
  gating is wired up, per the benchmark report).

## 7. Reproducing the sprint locally

```bash
# 1. Install (one time)
npm install                # picks up the new testcontainers devDeps

# 2. Make sure Docker Desktop is running

# 3. Full integration pass
npm run test:integration

# 4. Benchmarks (optional, ~3-5 min)
npm run test:integration:bench
```

If you'd rather use docker-compose (already in `docker-compose.yml`):

```bash
docker compose up -d postgres
INTEGRATION_DATABASE_URL=postgres://agents:agents@localhost:5432/postgres \
  npm run test:integration
docker compose down -v   # clean up
```

The harness creates a disposable database per suite so the
`agents_runtime` schema in your dev compose is not touched.
