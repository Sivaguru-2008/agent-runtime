/**
 * Phase 7 — Performance baselines.
 *
 * Opt-in: run with `npm run test:integration:bench` (sets INTEGRATION_RUN_BENCH=1).
 * Otherwise the suite is skipped to keep regular CI snappy.
 *
 * Each benchmark prints a single line `BENCH <name> ...` that
 * docs/integration-benchmark-report.md captures during the sprint review.
 * Numbers are wall-time on the host hardware — variance is expected; the
 * point is to establish a baseline order of magnitude and detect regressions.
 */
import { afterAll, describe, expect, it } from "vitest";
import { PostgresEventStore } from "../../../src/infrastructure/persistence/postgresEventStore.js";
import { PostgresLeaseStore } from "../../../src/infrastructure/cluster/postgres/postgresLeaseStore.js";
import { PostgresSnapshotStore } from "../../../src/infrastructure/persistence/postgres/postgresSnapshotStore.js";
import { PostgresCognitionRepository } from "../../../src/infrastructure/persistence/postgres/postgresCognitionRepository.js";
import { tryStartHarness } from "./harness.js";
import { fanOut } from "./concurrency.js";
import {
  makeCognitionGraph,
  makeEvent,
  seedAgentAndExecution,
  suiteSeed,
  uuidFromHex,
  makeLeaseInput
} from "./factories.js";
import { deterministicId } from "../../../src/shared/determinism.js";

const RUN = process.env.INTEGRATION_RUN_BENCH === "1";

const harness = RUN ? await tryStartHarness() : null;

afterAll(async () => {
  if (harness) await harness.stop();
});

interface BenchResult {
  name: string;
  count: number;
  durationMs: number;
  opsPerSec: number;
  p50Ms?: number;
  p95Ms?: number;
}

const results: BenchResult[] = [];

function record(r: BenchResult): void {
  results.push(r);
  // Single-line emission so the report generator can grep it out of CI logs.
  // eslint-disable-next-line no-console
  console.log(`BENCH ${r.name} count=${r.count} ms=${r.durationMs.toFixed(1)} ops/s=${r.opsPerSec.toFixed(0)}${r.p50Ms !== undefined ? ` p50=${r.p50Ms.toFixed(2)}` : ""}${r.p95Ms !== undefined ? ` p95=${r.p95Ms.toFixed(2)}` : ""}`);
}

function percentile(samples: number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx];
}

describe.skipIf(!RUN || !harness)("benchmarks", () => {
  it("append throughput — sequential", async () => {
    const store = new PostgresEventStore(harness!.connectionString);
    const seed = suiteSeed("bench-append-seq");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
    const N = 500;
    const samples: number[] = [];
    const start = performance.now();
    try {
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        await store.append(makeEvent({
          type: "MODEL_COMPLETED",
          executionId: exec, seed, step: i,
          payloadExtras: { executionId: exec, idx: i }
        }));
        samples.push(performance.now() - t0);
      }
    } finally { await store.close(); }
    const ms = performance.now() - start;
    record({
      name: "append-sequential",
      count: N,
      durationMs: ms,
      opsPerSec: (N / ms) * 1000,
      p50Ms: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95)
    });
    expect(samples.length).toBe(N);
    await harness!.reset();
  }, 120_000);

  it("append throughput — 32-way concurrent", async () => {
    const store = new PostgresEventStore(harness!.connectionString);
    const seed = suiteSeed("bench-append-conc");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
    const N = 1024;
    const start = performance.now();
    try {
      await fanOut(N, (i) =>
        store.append(makeEvent({
          type: "MODEL_COMPLETED",
          executionId: exec, seed, step: i,
          payloadExtras: { executionId: exec, idx: i }
        }))
      );
    } finally { await store.close(); }
    const ms = performance.now() - start;
    record({
      name: "append-concurrent-32-pool",
      count: N,
      durationMs: ms,
      opsPerSec: (N / ms) * 1000
    });
    await harness!.reset();
  }, 120_000);

  it("listByExecution throughput (indexed join)", async () => {
    const store = new PostgresEventStore(harness!.connectionString);
    const seed = suiteSeed("bench-list-exec");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
    const SEED_COUNT = 1000;
    try {
      for (let i = 0; i < SEED_COUNT; i++) {
        await store.append(makeEvent({
          type: "MODEL_COMPLETED",
          executionId: exec, seed, step: i,
          payloadExtras: { executionId: exec, idx: i }
        }));
      }
      const QUERIES = 200;
      const samples: number[] = [];
      const start = performance.now();
      for (let i = 0; i < QUERIES; i++) {
        const t0 = performance.now();
        await store.listByExecution(exec);
        samples.push(performance.now() - t0);
      }
      const ms = performance.now() - start;
      record({
        name: "listByExecution-1000-events",
        count: QUERIES,
        durationMs: ms,
        opsPerSec: (QUERIES / ms) * 1000,
        p50Ms: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95)
      });
    } finally { await store.close(); }
    await harness!.reset();
  }, 120_000);

  it("lease acquire latency", async () => {
    const leases = new PostgresLeaseStore(harness!.pg);
    const now = new Date();
    const N = 500;
    const samples: number[] = [];
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await leases.acquire(makeLeaseInput({
        executionId: `bench-lease-${i}`,
        workerId: `w-${i}`,
        ttlMs: 60_000,
        now
      }));
      samples.push(performance.now() - t0);
    }
    const ms = performance.now() - start;
    record({
      name: "lease-acquire-distinct-exec",
      count: N,
      durationMs: ms,
      opsPerSec: (N / ms) * 1000,
      p50Ms: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95)
    });
    await harness!.reset();
  }, 60_000);

  it("lease acquire contention (32 workers, same execution)", async () => {
    const leases = new PostgresLeaseStore(harness!.pg);
    const now = new Date();
    const start = performance.now();
    const { results: outcomes } = await fanOut(32, (i) =>
      leases.acquire(makeLeaseInput({
        executionId: "bench-contend",
        workerId: `w-${i}`,
        ttlMs: 60_000,
        now
      }))
    );
    const ms = performance.now() - start;
    const wins = outcomes.filter((r) => r !== undefined).length;
    record({
      name: "lease-acquire-contention-32",
      count: 32,
      durationMs: ms,
      opsPerSec: (32 / ms) * 1000
    });
    expect(wins).toBe(1);
    await harness!.reset();
  }, 60_000);

  it("snapshot restore latency", async () => {
    const cognitions = new PostgresCognitionRepository(harness!.pg);
    const snapshots = new PostgresSnapshotStore(harness!.pg);
    const seed = suiteSeed("bench-snap");
    const graph = makeCognitionGraph({ seed });
    await seedAgentAndExecution(harness!.pg, { agentId: graph.agentId, executionId: graph.executionId });
    await cognitions.save(graph);
    // Build a chain of snapshots so nearest() has rows to scan past.
    for (let i = 0; i < 50; i++) {
      await snapshots.put({
        id: deterministicId([graph.id, i, "bench-snap"]),
        cognitionId: graph.id,
        executionId: graph.executionId,
        frameIndex: i,
        eventSequence: i,
        capturedAt: "2026-05-22T00:00:00.000Z",
        graph,
        eventCount: i + 1
      });
    }
    const N = 200;
    const samples: number[] = [];
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await snapshots.nearest(graph.id, 49);
      samples.push(performance.now() - t0);
    }
    const ms = performance.now() - start;
    record({
      name: "snapshot-nearest-50-rows",
      count: N,
      durationMs: ms,
      opsPerSec: (N / ms) * 1000,
      p50Ms: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95)
    });
    await harness!.reset();
  }, 60_000);

  it("SSE catch-up paging (listAfterSequence)", async () => {
    const store = new PostgresEventStore(harness!.connectionString);
    const seed = suiteSeed("bench-sse-paging");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
    const SEED = 2000;
    try {
      for (let i = 0; i < SEED; i++) {
        await store.append(makeEvent({
          type: "MODEL_COMPLETED",
          executionId: exec, seed, step: i,
          payloadExtras: { executionId: exec, idx: i }
        }));
      }
      // Page 500-at-a-time through the full backlog 5×.
      const ITER = 5;
      const start = performance.now();
      for (let r = 0; r < ITER; r++) {
        let cursor = 0;
        for (;;) {
          const page = await store.listAfterSequence(cursor, 500);
          if (!page.length) break;
          cursor = page[page.length - 1].sequence!;
        }
      }
      const ms = performance.now() - start;
      record({
        name: "sse-catchup-2000-events-x5",
        count: SEED * ITER,
        durationMs: ms,
        opsPerSec: (SEED * ITER / ms) * 1000
      });
    } finally { await store.close(); }
    await harness!.reset();
  }, 180_000);
});

afterAll(() => {
  if (!RUN || results.length === 0) return;
  // eslint-disable-next-line no-console
  console.log("\n--- BENCH SUMMARY ---");
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`  ${r.name}: ${r.opsPerSec.toFixed(0)} ops/s${r.p50Ms !== undefined ? ` p50=${r.p50Ms.toFixed(2)}ms` : ""}${r.p95Ms !== undefined ? ` p95=${r.p95Ms.toFixed(2)}ms` : ""}`);
  }
});
