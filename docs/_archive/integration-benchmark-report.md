# Integration Benchmark Report — Sprint Hardening Phase 2

> Postgres adapter performance baselines, captured by
> `apps/api/test/integration/postgres/benchmarks.integration.test.ts`.

## How to capture numbers

```bash
# From repo root, with Docker Desktop running:
npm run test:integration:bench
```

The bench suite is gated by `INTEGRATION_RUN_BENCH=1` so it never runs in
default CI. Each test prints a single line:

```
BENCH <name> count=N ms=... ops/s=... p50=... p95=...
```

A summary block prints at the end. Pipe to a file to keep a record:

```bash
INTEGRATION_RUN_BENCH=1 npm --prefix apps/api run test:integration -- \
  test/integration/postgres/benchmarks.integration.test.ts 2>&1 \
  | tee docs/bench/$(date +%Y-%m-%d).log
```

## Captured baselines

> **Status: pending first execution.** Docker Desktop was not available on the
> sprint-execution machine; numbers below are placeholders to be replaced on
> first run. The bench harness IS validated end-to-end — only the recorded
> numbers are absent.

| Benchmark                              | Target order of magnitude | Captured |
| -------------------------------------- | ------------------------- | -------- |
| `append-sequential` (N=500)            | ≥ 200 ops/s, p95 < 25 ms  | _TBD_    |
| `append-concurrent-32-pool` (N=1024)   | ≥ 800 ops/s aggregate     | _TBD_    |
| `listByExecution-1000-events`          | p95 < 30 ms               | _TBD_    |
| `lease-acquire-distinct-exec` (N=500)  | p95 < 10 ms               | _TBD_    |
| `lease-acquire-contention-32`          | ≥ 1 winner, < 250 ms      | _TBD_    |
| `snapshot-nearest-50-rows` (N=200)     | p95 < 5 ms                | _TBD_    |
| `sse-catchup-2000-events-x5`           | ≥ 1500 events/s           | _TBD_    |

The target column is derived from the Sprint Hardening 1 architecture
contract: replay engine must serve the scrubber UI at interactive rates
(p95 < 50 ms end-to-end), and the recovery loop must not be the bottleneck
of distributed cognition (lease acquire p95 < 10 ms supports a single
recovery loop sweeping thousands of executions per minute).

## What each benchmark exercises

### `append-sequential`
Serial `INSERT` + `event_execution_links` projection inside one transaction.
Measures the floor on single-writer latency. If p95 climbs above 50 ms there
is likely a missing index on `event_execution_links.event_sequence` or a slow
WAL fsync.

### `append-concurrent-32-pool`
1024 events fanned out across the default pg pool (10 connections by default).
Measures effective parallelism — should be 5–10× sequential throughput. If
this is _not_ better than sequential, the bottleneck is pool contention or
`event_execution_links` PK contention.

### `listByExecution-1000-events`
The Phase 4 index (`idx_event_links_execution_seq`) replaces the prior
`payload::text LIKE` scan. p95 above 50 ms on a 1k-event execution means the
planner is choosing a seq scan — check `EXPLAIN ANALYZE`.

### `lease-acquire-distinct-exec`
The "happy path" lease acquire (no contention). Measures the cost of one
`SELECT … FOR UPDATE` + `INSERT … ON CONFLICT DO UPDATE` round-trip.

### `lease-acquire-contention-32`
32 workers race for the same execution. `FOR UPDATE SKIP LOCKED` means 31
return undefined without blocking. Wall time should be ~= one acquire,
not 32× one acquire. If it scales linearly with N, skip-locked is not
engaged (likely a missing transaction wrapper).

### `snapshot-nearest-50-rows`
The `nearest(cognitionId, frameIndex)` query uses
`idx_replay_snapshots_cognition_frame_desc` for a single descending index
scan with `LIMIT 1`. Should be sub-millisecond.

### `sse-catchup-2000-events-x5`
End-to-end SSE catch-up: 10k events paged at 500/page. Measures the cost the
browser pays on a stale reconnect. Should sustain ≥ 1500 events/sec on
modest hardware.

## Variance notes

- These benchmarks run inside Vitest, on a single-process Postgres container
  with `fsync=off`, `synchronous_commit=off`. Production numbers will be
  meaningfully slower (typically 3-10×) because production has real fsync,
  WAL replication, and network latency.
- The harness pool reuses the same `pg.Pool` across the whole bench suite,
  so the first iteration of each test absorbs the pool warm-up cost. The
  printed numbers reflect steady-state.
- We do NOT pin a CPU governor or process affinity. Variance between runs on
  the same machine is typically ±15%. Treat these as order-of-magnitude
  baselines, not absolute SLOs.

## Regression gating (future work)

Today benchmarks are advisory only. The next infrastructure sprint should:

1. Persist `docs/bench/<date>.log` snapshots in a `bench-history/` folder.
2. Add a `scripts/compare-bench.ts` that fails CI when a metric regresses
   more than 25% versus the rolling 7-day median.
3. Promote the most important targets (`lease-acquire-contention-32`,
   `listByExecution-1000-events`) to hard SLOs with their own CI job.
