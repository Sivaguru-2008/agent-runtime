/**
 * Phase C — recovery-path performance baseline.
 *
 * Gated by INTEGRATION_RUN_BENCH=1, same as benchmarks.integration.test.ts.
 * Default test runs skip this suite to keep regular CI snappy.
 *
 * The headline assertion: snapshot-driven recovery must be at least 5x
 * faster than full-event-log replay for a 500-event execution. This is the
 * justification for keeping snapshots in the recovery path at all — without
 * the speedup, the integrity-validation surface introduced in Phase C is
 * pure overhead. The 5x floor leaves substantial headroom over the
 * theoretical minimum (a snapshot lookup is O(1) vs a full replay's
 * O(N_events)) and accommodates host-hardware variance.
 *
 * Both numbers are printed via the same `BENCH <name> ...` convention used
 * elsewhere so they show up in the integration-benchmark-report.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { tryStartHarness } from "./harness.js";
import { PostgresEventStore } from "../../../src/infrastructure/persistence/postgresEventStore.js";
import { PostgresCognitionRepository } from "../../../src/infrastructure/persistence/postgres/postgresCognitionRepository.js";
import { PostgresSnapshotStore } from "../../../src/infrastructure/persistence/postgres/postgresSnapshotStore.js";
import { PostgresReplaySessionStore } from "../../../src/infrastructure/persistence/postgres/postgresReplaySessionStore.js";
import { PostgresBranchRegistry } from "../../../src/infrastructure/persistence/postgres/postgresBranchRegistry.js";
import { PersistedEventPublisher } from "../../../src/infrastructure/events/persistedEventPublisher.js";
import { InMemoryEventBus } from "../../../src/infrastructure/events/inMemoryEventBus.js";
import { EventFactory } from "../../../src/infrastructure/events/eventFactory.js";
import { ReplayEngine } from "../../../src/runtime/replay/replayEngine.js";
import { FrozenClock } from "../../../src/shared/clock.js";
import {
  makeCognitionGraph,
  makeEvent,
  seedAgentAndExecution,
  suiteSeed
} from "./factories.js";

const RUN = process.env.INTEGRATION_RUN_BENCH === "1";
const harness = RUN ? await tryStartHarness() : null;

afterEach(async () => {
  if (harness) await harness.reset();
});

afterAll(async () => {
  if (harness) await harness.stop();
});

interface BenchResult {
  name: string;
  durationMs: number;
}
const results: BenchResult[] = [];
function record(r: BenchResult): void {
  results.push(r);
  // eslint-disable-next-line no-console
  console.log(`BENCH ${r.name} ms=${r.durationMs.toFixed(2)}`);
}

describe.skipIf(!RUN || !harness)("ReplayEngine.hydrateForRecovery — snapshot vs full-replay perf", () => {
  it("snapshot recovery is at least 5x faster than full replay across 500 events", async () => {
    const seed = suiteSeed("recovery-bench");
    const graph = makeCognitionGraph({ seed });
    await seedAgentAndExecution(harness!.pg, { agentId: graph.agentId, executionId: graph.executionId });

    const events = new PostgresEventStore(harness!.connectionString);
    const cognitions = new PostgresCognitionRepository(harness!.pg);
    const snapshots = new PostgresSnapshotStore(harness!.pg);
    const sessions = new PostgresReplaySessionStore(harness!.pg);
    const branches = new PostgresBranchRegistry(harness!.pg);
    const clock = new FrozenClock(new Date("2026-05-27T00:00:00.000Z"));
    const factory = new EventFactory(clock, "recovery-bench");
    const publisher = new PersistedEventPublisher(events, new InMemoryEventBus());
    const engine = new ReplayEngine(events, cognitions, snapshots, sessions, branches, publisher, factory, clock);

    try {
      await cognitions.save(graph);

      // Seed a 500-event log on the same execution. We use a synthetic event
      // shape (the same one PostgresEventStore.append() in benchmarks.integration
      // uses) so we're measuring storage-bound replay, not orchestrator overhead.
      const N = 500;
      for (let i = 0; i < N; i++) {
        await events.append(
          makeEvent({
            type: "MODEL_COMPLETED",
            executionId: graph.executionId,
            seed,
            step: i,
            payloadExtras: { executionId: graph.executionId, idx: i }
          })
        );
      }

      // Capture ONE snapshot of the graph as it stands. Recovery will hydrate
      // from this row rather than re-folding 500 events.
      await engine.writeSnapshot(graph.id, 0);

      // Warm both code paths once so JIT/connection pool overhead doesn't
      // pollute the measurement.
      await engine.hydrateForRecovery(graph.executionId);
      await engine.hydrateForRecovery(graph.executionId, { forceFullReplay: true });

      // Average a few iterations to reduce variance from harness noise.
      const ITERS = 5;
      let snapTotal = 0;
      let fullTotal = 0;
      for (let i = 0; i < ITERS; i++) {
        const snapResult = await engine.hydrateForRecovery(graph.executionId);
        expect(snapResult).toBeDefined();
        expect(snapResult!.recoveredVia).toBe("SNAPSHOT");
        snapTotal += snapResult!.elapsedMs;

        const fullResult = await engine.hydrateForRecovery(graph.executionId, { forceFullReplay: true });
        expect(fullResult).toBeDefined();
        expect(fullResult!.recoveredVia).toBe("FULL_REPLAY");
        fullTotal += fullResult!.elapsedMs;
      }

      const snapAvg = snapTotal / ITERS;
      const fullAvg = fullTotal / ITERS;
      record({ name: "recovery-snapshot-avg-500-events", durationMs: snapAvg });
      record({ name: "recovery-full-replay-avg-500-events", durationMs: fullAvg });
      record({ name: "recovery-speedup-ratio", durationMs: fullAvg / Math.max(snapAvg, 0.0001) });

      // The headline assertion.
      expect(fullAvg / Math.max(snapAvg, 0.0001)).toBeGreaterThanOrEqual(5);
    } finally {
      await events.close();
    }
  }, 180_000);
});

afterAll(() => {
  if (!RUN || results.length === 0) return;
  // eslint-disable-next-line no-console
  console.log("\n--- RECOVERY BENCH SUMMARY ---");
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`  ${r.name}: ${r.durationMs.toFixed(2)}ms`);
  }
});

// Explanatory describe block surfaced when the suite is gated off, mirroring
// the convention from certification.integration.test.ts.
describe.skipIf(RUN || !harness)("ReplayEngine.hydrateForRecovery — benchmark (gated)", () => {
  it("skipped — set INTEGRATION_RUN_BENCH=1 to enable the recovery-perf benchmark", () => {
    expect(RUN).toBe(false);
  });
});
