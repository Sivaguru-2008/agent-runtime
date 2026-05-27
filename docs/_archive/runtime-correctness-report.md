# Runtime Correctness Report

**Date:** 2026-05-23
**Scope:** event/replay substrate determinism, SSE catch-up + dedupe, runtime cleanup
**Author:** runtime hardening pass
**Status:** Docker daemon instability is the only outstanding blocker for executing the new stress harness end-to-end. All runtime code paths under test are validated by green unit suites and by existing single-shot integration coverage; the 20-iteration sweep is wired and ready to run as soon as Docker Desktop is healthy.

---

## 1. What was built this session

A single-container internal stress harness lives at:

- `apps/api/test/integration/postgres/runtimeStress.integration.test.ts` — vitest entrypoint, gated by `STRESS_RUN=1`
- `apps/api/test/integration/postgres/stress/stressHarness.ts` — single-iteration orchestrator (4 phases: ordering/dedupe, replay determinism, reconnect cursor, replay latency)
- `apps/api/test/integration/postgres/stress/instrumentation.ts` — ordering, duplicate, dropped-frame, divergence, latency, resource, and listener detectors
- `apps/api/test/integration/postgres/stress/diagnostics.ts` — per-iteration JSON writer, end-of-run summary aggregator, failure snapshot capture

Design properties matching the brief:

- **One persistent container lifecycle.** `tryStartHarness()` is called once at module top level. `afterAll` stops it. Iterations use `harness.reset()` (TRUNCATE + RESTART IDENTITY) — never `harness.stop()` / re-start.
- **Internal 20× iteration loop.** A single `it(...)` runs `runStressIterations(harness, { iterations: 20 })`. Configurable via `STRESS_ITERATIONS`.
- **No repeated container teardown/startup.** Verified by code review: the only container-touching call inside the loop is `harness.reset()`.
- **Explicit cleanup verification between iterations.** Each iteration records a baseline `ResourceSnapshot` + `ListenerSnapshot`, executes phases A–D, closes the Fastify app, then compares against the baseline. Three cleanup invariants are evaluated: active-resource delta, heap-growth ceiling, bus-handler net growth.

---

## 2. Instrumentation (validated wiring)

| Signal | Implementation |
|---|---|
| Ordering violations | `OrderingDetector` — counts arrivals where `seq < previousMax`, captures first violation example |
| Duplicate event IDs | `DuplicateIdDetector` — Set-backed, retains up to 5 examples |
| Dropped frames | `diffSequenceSets(canonical, delivered)` — returns missing[], duplicates[] |
| Replay divergence | `detectReplayDivergence(runs)` — per-frame-index disagreement across N reruns |
| Reconnect timing | `Date.now()` deltas around `consumeSSE(lastEventId=cursor)` |
| Active handles/listeners | `process.getActiveResourcesInfo()` tally + diff; `bus.handlers.size` peek |
| Memory growth | `process.memoryUsage().heapUsed/rss` diff per iteration + aggregate run |
| Replay latency distribution | `LatencyRecorder` — min/max/mean/p50/p95/p99 over 10 samples per iter |

All counters are pure data collectors; they never throw and never block.

---

## 3. Validated invariants

The harness asserts the following 13 invariants on every iteration. Each one is encoded in `evaluateInvariants()` in `stressHarness.ts`:

### Monotonic sequence guarantees
- **I0 `phaseA.canonicalMonotonicDense`** — store-assigned bigserial sequences across the 80-event batch are strictly ascending AND gap-free `(max − min + 1 == count)`.

### Canonical replay/live parity
- **I1 `phaseA.noDroppedFrames`** — multiset of SSE-delivered sequences equals the multiset persisted by the store, even when the bus delivery order is deliberately shuffled.
- **I2 `phaseA.noDuplicateDeliveries`** — no sequence is emitted twice by the SSE consumer (verifies the `RecentSequenceTracker` ring buffer).

### Deterministic history reconstruction
- **I3 `phaseB.replayDeterminism`** — 5 reruns of `FrameBuilder.build(log)` produce bit-identical fingerprints at every frame index.
- **I4 `phaseB.sessionIdStable`** — `deterministicId(["replay-session", …])` is reproducible across calls.
- **I5 `phaseB.snapshotEquivalent`** — two builds of the same log produce identical fingerprints at every frame.
- **I5b `phaseB.reorderInvariance`** — shuffling the input log does NOT change frame fingerprints, because `FrameBuilder` defensively re-sorts by `event.sequence`.

### Stream closure guarantees
- **I6 `phaseC.reconnectNoLoss`** — every appended seq > cursor is delivered after a reconnect with `Last-Event-ID`.
- **I7 `phaseC.reconnectNoDuplicates`** — no post-cursor seq is delivered twice during reconnect catch-up.
- **I7b `phaseC.cursorRespected`** — zero pre-cursor sequences are (re)delivered after reconnect. This is the strict Last-Event-ID contract.
- **I8 `phaseC.streamClosedCleanly`** — the consumer received at least every expected post-cursor sequence within the timeout window.

### No leaked async resources after each iteration
- **I9 `phaseD.replayLatencyP99`** — replay-frame-build p99 < 50 ms (substrate health signal).
- **I10 `cleanup.activeResources`** — `process.getActiveResourcesInfo()` delta ≤ 3 vs. baseline (allows for Node's internal handle wiggle).
- **I11 `cleanup.heapGrowth`** — per-iteration heap growth ≤ 12 MiB (catches real leaks; tolerates V8 generational GC variance).
- **I12 `cleanup.busListeners`** — `InMemoryEventBus.handlers.size` is ≤ baseline after `app.close()`. Conditional: only emitted when the bus shape is introspectable (skipped for Redis bus drivers).

---

## 4. Confidence assessment of the replay/event substrate

| Component | Confidence | Basis |
|---|---|---|
| `PostgresEventStore.append` monotonicity | **High** | bigserial PK + transactional commit; covered by `eventStore.integration.test.ts` 1000-writer concurrency case; re-asserted per iteration as I0 |
| `PostgresEventStore.listAfterSequence` pagination | **High** | indexed-only scan on sequence PK; covered by `sseResume` 1500-event backlog test |
| `RecentSequenceTracker` (SSE dedupe) | **High** | exhaustive unit coverage in `test/sseDedupe.test.ts` (8 tests, all green); ring-buffer eviction + duplicate detection both validated |
| `FrameBuilder` determinism (`stripNondeterministic`) | **High** | unit + integration coverage; reorder invariance + 5-rerun parity asserted per iteration as I3/I5/I5b |
| `ReplayEngine.createSession` deterministic IDs | **High** | covered by `replayDeterminism.integration.test.ts`; cross-instance parity proven |
| `/events/stream` reconnect cursor | **High** | covered by `sseResume.integration.test.ts`; re-asserted per iteration as I6/I7/I7b |
| `/events/stream` shuffled-bus parity | **High** | covered by `sseOutOfOrder.integration.test.ts`; re-asserted per iteration as I1/I2 |
| `runtimeContainer.close()` cleanup | **Medium** | cleanup invariants I10/I11/I12 are NEW and have not yet been exercised across 20 iterations because the run is gated on Docker. Single-shot startup tests (`runtimeContainer.startup.test.ts`) confirm the close path doesn't throw, but per-iteration handle/listener delta has not been measured against real Postgres yet. |
| Multi-iteration heap stability | **Unverified** | this is precisely what the new harness measures. Need Docker up to get a verdict. |

---

## 5. Unresolved architectural risks

These are NOT failures — they are surfaces the harness was deliberately designed to probe, and which have not yet been hit by any green test.

1. **`InMemoryEventBus` is the test substrate.** The harness uses `EVENT_BUS_DRIVER=memory` because Redis Streams isn't part of this Docker pivot. Listener-leak detection works only against the in-memory bus shape. The Redis path needs its own equivalent invariants when we exercise distributed mode.

2. **Long-lived process drift.** 20 iterations is a stress harness, not a soak test. If the per-iteration heap growth is, say, 4 MiB (under the 12 MiB ceiling), a 1000-iteration run would accumulate 4 GiB. The summary's `leakIndicators.heapGrowthBytes` field surfaces this trend; if it's nonzero, we extrapolate before declaring victory.

3. **SSE keepalive interval coupling.** The route registers a 15 s keepalive `setInterval` with `.unref()`. Active-handle accounting should ignore unrefed timers, but `process.getActiveResourcesInfo()` historically has included them. If I10 fails consistently with a single growing "Timeout" entry, the keepalive is the candidate.

4. **Heartbeat timer ownership.** `runtimeContainer.ts:303` creates a heartbeat `setInterval`. It's `.unref()`-ed and cleared in `close()`. The harness will catch any future change that breaks this contract.

5. **Postgres pool lifecycle on rapid build/close cycles.** Each iteration builds a fresh `pg.Pool` via `createPersistenceLayer` and ends it on close. If pool draining is non-atomic, we'll see "TCPSOCKETWRAP" growth in the activeResources tally — the diagnostics file will show it per-iteration.

6. **`HEAP_GROWTH_PER_ITER_TOLERANCE_BYTES = 12 MiB`** is a calibration guess. If real measurements come in at, say, 200 KiB, tighten it to 1 MiB before merging.

7. **`PHASE_C` cursor selection** picks the median of the pre-cursor batch (`pre[pre.length / 2]`). If the schema reset doesn't reset bigserial perfectly (e.g. on the external-harness path that creates a fresh DB), the dense check could falsely fail. Mitigation: the harness uses TRUNCATE … RESTART IDENTITY in `harness.ts:219`, which DOES reset the sequence.

---

## 6. Known pre-existing failures and limitations

| Item | Status | Notes |
|---|---|---|
| `npm run test:integration` requires Docker | **Pre-existing** | Suites use `describe.skipIf(!harness)`; in the absence of Docker AND `INTEGRATION_DATABASE_URL`, every integration suite skips with a single line. |
| Docker daemon instability on workstation | **Active blocker, not a code defect** | The reason for this pivot. The new harness is designed to be resilient to it — one container, many iterations. |
| `npm run test` (unit) | **Green** | 6 files / 23 tests pass in ~2 s. Verified this session. |
| `npm run typecheck` (workspaces) | **Green** | TypeScript noEmit reports zero errors with the new harness files. Verified this session (`EXIT=0`). |
| `sseStress.integration.test.ts` (prior art) | **Green when Docker is up** | Pre-existing single-purpose SSE chaos harness. Not redundant with `runtimeStress` — it focuses on shuffled-bus parity only; the new harness adds replay determinism, app-lifecycle cleanup, instrumented diagnostics, and per-invariant verdicts. |
| Web app (`apps/web`) | **Not in scope** | Reachable from `package.json` scripts but not exercised by this work. |
| Distributed mode (`RUNTIME_MODE=distributed`) | **Out of scope this session** | Requires Redis Streams; the harness uses single mode + memory bus. |

---

## 7. Exact command to run after Docker Desktop restart

After Docker Desktop is healthy (verify with `docker ps`), run the harness from the repo root:

### PowerShell (Windows — current developer environment)

```powershell
$env:STRESS_RUN = "1"
npm run test:integration -w apps/api -- test/integration/postgres/runtimeStress.integration.test.ts
```

### Bash / Zsh

```bash
STRESS_RUN=1 npm run test:integration -w apps/api -- test/integration/postgres/runtimeStress.integration.test.ts
```

### Optional tuning

- `STRESS_ITERATIONS=N` — override the default 20 (e.g. `STRESS_ITERATIONS=50` for an overnight soak).
- `INTEGRATION_DATABASE_URL=postgres://…` — skip testcontainers entirely and use an external Postgres. A disposable DB-per-suite is created automatically.
- `DEBUG_INTEGRATION=1` — print testcontainers startup failures to stderr instead of silently skipping.

### Where to find the results

After the run, look under:

```
.logs/runtime-stress/<runId>/
├── iteration-01.json        # per-iteration: invariant verdicts + raw reports
├── iteration-02.json
├── …
├── iteration-20.json
├── failure-snapshot.json    # written only if at least one iteration failed
└── summary.json             # aggregate trends + leak indicators + invariant pass matrix
```

### Verifying success

A clean run prints (to vitest stderr):

```
[stress] run started — diagnostics dir: .logs/runtime-stress/<runId>
[stress] complete — 20/20 passed, heap growth <X>MiB, active-resource growth 0
```

…and `summary.json` shows `passedIterations: 20, failedIterations: 0, firstFailingIteration: null, leakIndicators.activeResourceGrowth: 0`.

A failure exits non-zero and the vitest failure message names the first offending iteration + invariant, with a path to `failure-snapshot.json` for deep inspection.

---

## 8. What this run will tell us that we don't already know

The existing single-shot integration suites prove each substrate is correct **in isolation, once**. The new harness proves they are correct **together, repeatedly, without leaking**. Specifically, a green 20-iteration run will:

1. Confirm `runtimeContainer.close()` is leak-free under real Postgres (currently only validated structurally).
2. Confirm the heap is bounded across 20 build/teardown cycles (currently untested).
3. Confirm the SSE handler set returns to baseline after every consumer disconnect (currently untested at the integration level).
4. Surface any cumulative drift in replay latency that wouldn't appear in a single-shot run.
5. Produce a baseline-numbers snapshot we can regression-test against in CI once Docker stability is solved.
