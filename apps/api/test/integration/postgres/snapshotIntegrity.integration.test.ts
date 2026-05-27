/**
 * Phase C — Postgres snapshot integrity validation + Task A1/A2 hardening.
 *
 * Contract under test:
 *
 *   • put() persists the FULL graph payload to graph_full (A1) AND stamps
 *     the integrity_hash column. get()/nearest()/list() return the snapshot
 *     with that hash populated and a graph reconstructed from graph_full
 *     — NOT from live cognition_nodes.
 *
 *   • A snapshot whose graph_full jsonb is mutated post-write (simulating
 *     storage corruption or tampering) is rejected on get(), nearest(), and
 *     listByCognition() with SnapshotCorruptionError, and the integrity
 *     reporter fires with the corresponding operation tag.
 *
 *   • A legacy snapshot row (graph_full IS NULL) hydrates through the
 *     thin-envelope path. Tampering with the thin `graph` column on a
 *     legacy row is still detected.
 *
 *   • A1 anti-poisoning property: after put(), mutating cognition_nodes for
 *     the snapshot's cognition does NOT affect what the snapshot reads back
 *     (graph_full is closed over the original payload). Pre-A1 this caused
 *     false SnapshotCorruptionError throws on perfectly fine snapshots.
 *
 *   • A2 forensic bypass: listByCognition({ bypassIntegrityForForensics })
 *     returns corrupt rows WITHOUT throwing, but still fires the reporter
 *     so the SNAPSHOT_INTEGRITY_VIOLATED bus event reaches dashboards.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { tryStartHarness } from "./harness.js";
import { PostgresSnapshotStore } from "../../../src/infrastructure/persistence/postgres/postgresSnapshotStore.js";
import { PostgresCognitionRepository } from "../../../src/infrastructure/persistence/postgres/postgresCognitionRepository.js";
import { SnapshotCorruptionError } from "../../../src/runtime/replay/snapshotIntegrity.js";
import { makeCognitionGraph, seedAgentAndExecution, suiteSeed } from "./factories.js";
import { deterministicId } from "../../../src/shared/determinism.js";
import type { ReplaySnapshot } from "../../../src/domain/replay.js";

const harness = await tryStartHarness();

afterEach(async () => {
  if (harness) await harness.reset();
});

afterAll(async () => {
  if (harness) await harness.stop();
});

async function seedGraph(seed: string) {
  const graph = makeCognitionGraph({ seed });
  await seedAgentAndExecution(harness!.pg, { agentId: graph.agentId, executionId: graph.executionId });
  const cognitions = new PostgresCognitionRepository(harness!.pg);
  await cognitions.save(graph);
  return graph;
}

function snapshotFor(graph: ReturnType<typeof makeCognitionGraph>, frameIndex: number): ReplaySnapshot {
  return {
    id: deterministicId([graph.id, frameIndex, "snap-int"]),
    cognitionId: graph.id,
    executionId: graph.executionId,
    frameIndex,
    eventSequence: frameIndex,
    capturedAt: "2026-05-27T00:00:00.000Z",
    graph,
    eventCount: frameIndex + 1
  };
}

describe.skipIf(!harness)("PostgresSnapshotStore — integrity (happy path)", () => {
  it("put() persists graph_full + stamps integrity_hash; get() round-trips", async () => {
    const seed = suiteSeed("snap-int-happy");
    const graph = await seedGraph(seed);
    const store = new PostgresSnapshotStore(harness!.pg);
    const snap = snapshotFor(graph, 2);
    await store.put(snap);

    const got = await store.get(snap.id);
    expect(got).toBeDefined();
    expect(typeof got!.integrityHash).toBe("string");
    expect(got!.integrityHash).toHaveLength(64);

    // A1 — graph_full IS populated on new writes.
    const { rows } = await harness!.pg.query<{ graph_full: unknown }>(
      `select graph_full from replay_snapshots where id = $1`,
      [snap.id]
    );
    expect(rows[0]?.graph_full).not.toBeNull();
  });

  it("nearest() returns the closest snapshot with intact integrity hash", async () => {
    const seed = suiteSeed("snap-int-near");
    const graph = await seedGraph(seed);
    const store = new PostgresSnapshotStore(harness!.pg);
    for (const idx of [0, 3, 7]) await store.put(snapshotFor(graph, idx));

    const at5 = await store.nearest(graph.id, 5);
    expect(at5?.frameIndex).toBe(3);
    expect(at5?.integrityHash).toBeDefined();
  });
});

describe.skipIf(!harness)("PostgresSnapshotStore — A1 immutability (no live hydration)", () => {
  it("mutating cognition_nodes after put() does NOT change what the snapshot reads back", async () => {
    const seed = suiteSeed("snap-int-immutable");
    const graph = await seedGraph(seed);
    const store = new PostgresSnapshotStore(harness!.pg);
    const snap = snapshotFor(graph, 2);
    await store.put(snap);

    // Simulate a downstream mutation of cognition_nodes — exactly the kind
    // of write recovery / branch-from-node performs in production. Pre-A1
    // this poisoned the integrity recompute because the read path joined
    // these live rows; post-A1 the snapshot reads from graph_full and is
    // unaffected.
    await harness!.pg.query(
      `update cognition_nodes set phase = 'MUTATED' where cognition_id = $1`,
      [graph.id]
    );

    // get(), nearest(), and listByCognition() must all succeed without
    // raising SnapshotCorruptionError because the read no longer depends
    // on cognition_nodes for non-legacy rows.
    await expect(store.get(snap.id)).resolves.toBeDefined();
    await expect(store.nearest(graph.id, 10)).resolves.toBeDefined();
    await expect(store.listByCognition(graph.id)).resolves.toHaveLength(1);
  });
});

describe.skipIf(!harness)("PostgresSnapshotStore — integrity (corruption)", () => {
  it("get() throws SnapshotCorruptionError when graph_full is mutated post-write", async () => {
    const seed = suiteSeed("snap-int-tamper-get");
    const graph = await seedGraph(seed);
    const store = new PostgresSnapshotStore(harness!.pg);
    const reporterCalls: unknown[] = [];
    store.setIntegrityViolationReporter((v) => reporterCalls.push(v));
    const snap = snapshotFor(graph, 1);
    await store.put(snap);

    // A1: tampering vector moved from the thin `graph` column to graph_full
    // because the read path now prefers graph_full. Mutating graph_full
    // without recomputing integrity_hash MUST fail-closed.
    await harness!.pg.query(
      `update replay_snapshots
          set graph_full = jsonb_set(graph_full, '{phase}', '"TAMPERED"'::jsonb)
        where id = $1`,
      [snap.id]
    );

    await expect(store.get(snap.id)).rejects.toBeInstanceOf(SnapshotCorruptionError);
    expect(reporterCalls).toHaveLength(1);
    expect(reporterCalls[0]).toMatchObject({
      snapshotId: snap.id,
      cognitionId: snap.cognitionId,
      operation: "get"
    });
  });

  it("nearest() throws SnapshotCorruptionError when the resolved candidate is corrupt", async () => {
    const seed = suiteSeed("snap-int-tamper-near");
    const graph = await seedGraph(seed);
    const store = new PostgresSnapshotStore(harness!.pg);
    const reporterCalls: unknown[] = [];
    store.setIntegrityViolationReporter((v) => reporterCalls.push(v));
    const snap = snapshotFor(graph, 2);
    await store.put(snap);

    // Mutate the hash directly — graph stays the same but stored hash is wrong.
    await harness!.pg.query(
      `update replay_snapshots set integrity_hash = $1 where id = $2`,
      ["00".repeat(32), snap.id]
    );

    await expect(store.nearest(graph.id, 10)).rejects.toBeInstanceOf(SnapshotCorruptionError);
    expect(reporterCalls[0]).toMatchObject({ operation: "nearest", snapshotId: snap.id });
  });

  it("listByCognition() throws SnapshotCorruptionError on any corrupt row by default", async () => {
    const seed = suiteSeed("snap-int-tamper-list");
    const graph = await seedGraph(seed);
    const store = new PostgresSnapshotStore(harness!.pg);
    const reporterCalls: unknown[] = [];
    store.setIntegrityViolationReporter((v) => reporterCalls.push(v));
    const snap = snapshotFor(graph, 4);
    await store.put(snap);

    await harness!.pg.query(
      `update replay_snapshots set integrity_hash = $1 where id = $2`,
      ["ff".repeat(32), snap.id]
    );

    // A2 — listByCognition is fail-closed by default. The operator
    // timeline view must NOT render corrupted history silently.
    await expect(store.listByCognition(graph.id)).rejects.toBeInstanceOf(SnapshotCorruptionError);
    expect(reporterCalls[0]).toMatchObject({ operation: "list", snapshotId: snap.id });
  });

  it("listByCognition({ bypassIntegrityForForensics }) returns corrupt rows but still fires the reporter", async () => {
    const seed = suiteSeed("snap-int-forensic-list");
    const graph = await seedGraph(seed);
    const store = new PostgresSnapshotStore(harness!.pg);
    const reporterCalls: unknown[] = [];
    store.setIntegrityViolationReporter((v) => reporterCalls.push(v));
    const snap = snapshotFor(graph, 4);
    await store.put(snap);

    await harness!.pg.query(
      `update replay_snapshots set integrity_hash = $1 where id = $2`,
      ["ff".repeat(32), snap.id]
    );

    // A2 — forensic bypass: do not throw, but DO fire the reporter so the
    // SNAPSHOT_INTEGRITY_VIOLATED event reaches the bus.
    const rows = await store.listByCognition(graph.id, { bypassIntegrityForForensics: true });
    expect(rows).toHaveLength(1);
    expect(reporterCalls).toHaveLength(1);
    expect(reporterCalls[0]).toMatchObject({ operation: "list", snapshotId: snap.id });
  });
});

describe.skipIf(!harness)("PostgresSnapshotStore — legacy rows (graph_full IS NULL)", () => {
  it("a row with integrity_hash NULL is readable; next put() stamps a hash", async () => {
    const seed = suiteSeed("snap-int-legacy");
    const graph = await seedGraph(seed);
    const store = new PostgresSnapshotStore(harness!.pg);
    const snap = snapshotFor(graph, 1);
    await store.put(snap);

    // Simulate a legacy row: clear the integrity_hash column.
    await harness!.pg.query(
      `update replay_snapshots set integrity_hash = null where id = $1`,
      [snap.id]
    );

    // Legacy reads do NOT throw — the hash is absent, not wrong.
    const got = await store.get(snap.id);
    expect(got).toBeDefined();
    expect(got!.integrityHash).toBeUndefined();

    // Re-putting the same snapshot stamps a fresh hash.
    await store.put(snap);
    const rePulled = await store.get(snap.id);
    expect(rePulled!.integrityHash).toBeDefined();
    expect(rePulled!.integrityHash).toHaveLength(64);
  });

  it("a pre-A1 row (graph_full NULL) hydrates from cognition_nodes and fires the legacy reporter", async () => {
    const seed = suiteSeed("snap-int-legacy-hydrate");
    const graph = await seedGraph(seed);
    const store = new PostgresSnapshotStore(harness!.pg);
    const legacyCalls: unknown[] = [];
    store.setLegacyHydrationReporter((info) => legacyCalls.push(info));
    const snap = snapshotFor(graph, 1);
    await store.put(snap);

    // Simulate a row written before migration 0013 landed: clear graph_full.
    // The thin envelope in `graph` and the integrity_hash already correspond
    // to the original full payload (because put() computed the hash over the
    // full graph), so a legacy read that re-hydrates the same un-mutated
    // cognition_nodes rows must verify cleanly.
    await harness!.pg.query(
      `update replay_snapshots set graph_full = null where id = $1`,
      [snap.id]
    );

    const got = await store.get(snap.id);
    expect(got).toBeDefined();
    expect(legacyCalls).toHaveLength(1);
    expect(legacyCalls[0]).toMatchObject({
      snapshotId: snap.id,
      cognitionId: snap.cognitionId
    });
  });
});
