/**
 * Phase 4 — Deterministic replay validation.
 *
 * The contract under test:
 *   "Given the same persisted event log, the ReplayEngine must produce
 *   bit-identical session IDs, trace IDs, frame fingerprints, and snapshot
 *   graphs across reruns — independent of wall time, retrieval order, or
 *   concurrent replay sessions."
 *
 * Any failure here is a determinism regression — strict fail.
 *
 * Coverage:
 *   • identical fingerprints across N reruns (N = 5)
 *   • stable replay session IDs (deterministicId)
 *   • stable trace IDs on REPLAY_SESSION_CREATED events
 *   • stripped-nondeterministic-fields proof: payload mutation on a single
 *     timestamp must NOT change the frame fingerprint
 *   • branch replay consistency: branching at the same node twice produces
 *     the same branchCognitionId
 *   • snapshot equivalence: `getGraphAt(N)` for the same N is identical across runs
 *   • shuffled DB retrieval order — Postgres ORDER BY sequence MUST be the
 *     ordering source of truth (we cannot insert in shuffled order because
 *     bigserial is monotonic, but we can verify the engine's frame builder
 *     re-sorts defensively).
 *   • concurrent replay sessions on the same cognition don't corrupt each other
 *   • interrupted replay: a partially-persisted session reloads consistently
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PostgresEventStore } from "../../../src/infrastructure/persistence/postgresEventStore.js";
import { PostgresCognitionRepository } from "../../../src/infrastructure/persistence/postgres/postgresCognitionRepository.js";
import { PostgresSnapshotStore } from "../../../src/infrastructure/persistence/postgres/postgresSnapshotStore.js";
import { PostgresReplaySessionStore } from "../../../src/infrastructure/persistence/postgres/postgresReplaySessionStore.js";
import { PostgresBranchRegistry } from "../../../src/infrastructure/persistence/postgres/postgresBranchRegistry.js";
import { PersistedEventPublisher } from "../../../src/infrastructure/events/persistedEventPublisher.js";
import { InMemoryEventBus } from "../../../src/infrastructure/events/inMemoryEventBus.js";
import { EventFactory } from "../../../src/infrastructure/events/eventFactory.js";
import { ReplayEngine } from "../../../src/runtime/replay/replayEngine.js";
import { FrameBuilder } from "../../../src/runtime/replay/frameBuilder.js";
import { FrozenClock } from "../../../src/shared/clock.js";
import { tryStartHarness } from "./harness.js";
import {
  makeCognitionEventLog,
  makeCognitionGraph,
  seedAgentAndExecution,
  suiteSeed
} from "./factories.js";
import { shuffleDeterministic } from "./concurrency.js";

const harness = await tryStartHarness();

interface ReplayStack {
  events: PostgresEventStore;
  cognitions: PostgresCognitionRepository;
  snapshots: PostgresSnapshotStore;
  sessions: PostgresReplaySessionStore;
  branches: PostgresBranchRegistry;
  engine: ReplayEngine;
}

function buildStack(): ReplayStack {
  const events = new PostgresEventStore(harness!.connectionString);
  const cognitions = new PostgresCognitionRepository(harness!.pg);
  const snapshots = new PostgresSnapshotStore(harness!.pg);
  const sessions = new PostgresReplaySessionStore(harness!.pg);
  const branches = new PostgresBranchRegistry(harness!.pg);
  const clock = new FrozenClock(new Date("2026-05-22T00:00:00.000Z"));
  const factory = new EventFactory(clock, "integration-replay");
  const publisher = new PersistedEventPublisher(events, new InMemoryEventBus());
  const engine = new ReplayEngine(events, cognitions, snapshots, sessions, branches, publisher, factory, clock);
  return { events, cognitions, snapshots, sessions, branches, engine };
}

async function seedFixture(seed: string) {
  const graph = makeCognitionGraph({ seed });
  await seedAgentAndExecution(harness!.pg, { agentId: graph.agentId, executionId: graph.executionId });
  const stack = buildStack();
  await stack.cognitions.save(graph);
  const log = makeCognitionEventLog(graph, seed);
  for (const e of log) await stack.events.append(e);
  return { graph, stack, log };
}

afterEach(async () => {
  if (harness) await harness.reset();
});

afterAll(async () => {
  if (harness) await harness.stop();
});

describe.skipIf(!harness)("ReplayEngine — fingerprint determinism", () => {
  it("produces bit-identical frame fingerprints across 5 reruns", async () => {
    const seed = suiteSeed("fp-rerun");
    const { graph, stack } = await seedFixture(seed);

    const runs: string[][] = [];
    for (let i = 0; i < 5; i++) {
      const frames = await stack.engine.materializeFrames(graph);
      runs.push(frames.map((f) => f.preview.fingerprint!));
    }
    // All 5 runs must be identical.
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]).toEqual(runs[0]);
    }
  });

  it("strips nondeterministic fields — wallclock noise does not change fingerprints", async () => {
    const seed = suiteSeed("fp-strip");
    const { graph, log } = await seedFixture(seed);
    // Build frames from the original log.
    const builder = new FrameBuilder();
    const original = await builder.build(log);

    // Mutate every nondeterministic field on a clone of the log; fingerprints
    // must remain unchanged.
    const mutated = log.map((e) => ({
      ...e,
      timestamp: "2099-12-31T00:00:00.000Z",
      payload: {
        ...e.payload,
        // Inject keys the stripper should drop.
        startedAt: "noise",
        completedAt: "noise",
        durationMs: 999_999,
        workerId: "rogue-worker",
        capturedAt: "noise"
      }
    }));
    const mutatedFrames = await builder.build(mutated);

    expect(mutatedFrames.map((f) => f.preview.fingerprint)).toEqual(
      original.map((f) => f.preview.fingerprint)
    );
    // Sanity: the graph still has the expected node count, so the test is
    // actually comparing the right thing.
    expect(graph.nodes).toHaveLength(4);
  });

  it("frame ordering survives shuffled DB retrieval — engine re-sorts by sequence", async () => {
    const seed = suiteSeed("fp-shuffle");
    const { log } = await seedFixture(seed);
    // Simulate a degenerate retrieval where Postgres returns rows out of order
    // (it doesn't — but the engine's defensive sort guards against rogue
    // ORDER BY removals or driver-level reordering). FrameBuilder is the
    // ordering source of truth; we test its invariance directly.
    const builder = new FrameBuilder();
    const expected = (await builder.build(log)).map((f) => f.eventSequence);
    const shuffled = shuffleDeterministic(log, "shuffle-seed-A");
    const reordered = (await builder.build(shuffled)).map((f) => f.eventSequence);
    expect(reordered).toEqual(expected);
  });
});

describe.skipIf(!harness)("ReplayEngine — stable identifiers", () => {
  it("produces the same session ID across two engine instances", async () => {
    const seed = suiteSeed("id-session");
    const { graph } = await seedFixture(seed);

    // Two independent stacks (separate pools, separate engines) — same DB,
    // same event log, same cognition. The deterministic-ID derivation must
    // yield the same session id.
    const a = buildStack();
    const b = buildStack();
    try {
      const sessA = await a.engine.createSession(graph.id);
      const sessB = await b.engine.createSession(graph.id);
      expect(sessA.id).toBe(sessB.id);
      expect(sessA.frames.length).toBe(sessB.frames.length);
    } finally {
      await a.events.close();
      await b.events.close();
    }
  });

  it("REPLAY_SESSION_CREATED carries a deterministic traceId", async () => {
    const seed = suiteSeed("id-trace");
    const { graph, stack } = await seedFixture(seed);
    const sessA = await stack.engine.createSession(graph.id);
    // Re-run: the deterministic trace id depends only on (sessionId), so
    // it's stable across createSession invocations on the same graph.
    const sessB = await stack.engine.createSession(graph.id);
    const events = await stack.events.listByCognition(graph.id);
    const replayCreations = events.filter((e) => e.type === "REPLAY_SESSION_CREATED");
    expect(replayCreations.length).toBeGreaterThanOrEqual(2);
    // Both REPLAY_SESSION_CREATED events share a traceId because their
    // sessionId is the same → traceId = deterministicId(["replay-trace", id]).
    expect(replayCreations[0].metadata.traceId).toBe(replayCreations[1].metadata.traceId);
    expect(sessA.id).toBe(sessB.id);
  });
});

describe.skipIf(!harness)("ReplayEngine — snapshot equivalence", () => {
  it("getGraphAt(N) is identical across reruns", async () => {
    const seed = suiteSeed("graph-at");
    const { graph, stack } = await seedFixture(seed);
    await stack.engine.createSession(graph.id);

    const target = 3;
    const g1 = await stack.engine.getGraphAt(graph.id, target);
    const g2 = await stack.engine.getGraphAt(graph.id, target);
    expect(g1).toBeDefined();
    // Same shape, same node ids, same handoffs.
    expect(g2!.id).toBe(g1!.id);
    expect(g2!.nodes.map((n) => n.id)).toEqual(g1!.nodes.map((n) => n.id));
    expect(g2!.handoffs).toEqual(g1!.handoffs);
  });

  it("a written snapshot's graph matches a freshly-computed getGraphAt", async () => {
    const seed = suiteSeed("snap-equiv");
    const { graph, stack } = await seedFixture(seed);
    await stack.engine.createSession(graph.id);
    const snap = await stack.engine.writeSnapshot(graph.id, 2);

    const recomputed = await stack.engine.getGraphAt(graph.id, snap.frameIndex);
    expect(recomputed).toBeDefined();
    expect(recomputed!.nodes.map((n) => n.id)).toEqual(snap.graph.nodes.map((n) => n.id));
  });
});

describe.skipIf(!harness)("ReplayEngine — branch consistency", () => {
  it("branching at the same node twice produces the same branchCognitionId", async () => {
    const seed = suiteSeed("branch-same");
    const { graph, stack } = await seedFixture(seed);
    const sourceNode = graph.nodes[1];

    const p1 = await stack.engine.branch({
      sourceCognitionId: graph.id,
      sourceNodeId: sourceNode.id,
      overrides: { seed: "rerun-A" },
      reason: "test"
    });
    const p2 = await stack.engine.branch({
      sourceCognitionId: graph.id,
      sourceNodeId: sourceNode.id,
      overrides: { seed: "rerun-A" },
      reason: "test-different-reason"
    });
    // Identical overrides → identical branch id (reason is not part of the id).
    expect(p2.branchCognitionId).toBe(p1.branchCognitionId);
  });

  it("different overrides produce different branchCognitionIds", async () => {
    const seed = suiteSeed("branch-diff");
    const { graph, stack } = await seedFixture(seed);
    const sourceNode = graph.nodes[1];

    const p1 = await stack.engine.branch({
      sourceCognitionId: graph.id,
      sourceNodeId: sourceNode.id,
      overrides: { seed: "alpha" }
    });
    const p2 = await stack.engine.branch({
      sourceCognitionId: graph.id,
      sourceNodeId: sourceNode.id,
      overrides: { seed: "beta" }
    });
    expect(p2.branchCognitionId).not.toBe(p1.branchCognitionId);
  });

  it("branched cognition's ancestor frames are bit-identical to source frames up to branch point", async () => {
    const seed = suiteSeed("branch-frames");
    const { graph, stack } = await seedFixture(seed);
    const sourceNode = graph.nodes[2];
    const pointer = await stack.engine.branch({
      sourceCognitionId: graph.id,
      sourceNodeId: sourceNode.id
    });
    const branch = await stack.cognitions.getById(pointer.branchCognitionId);
    expect(branch).toBeDefined();
    // Every ancestor node in the branch points back to the source node it was
    // replayed from — verifies the lineage projection.
    const replayed = branch!.nodes.filter((n) => n.replayedFromNodeId);
    expect(replayed.length).toBeGreaterThan(0);
    for (const r of replayed) {
      const source = graph.nodes.find((n) => n.id === r.replayedFromNodeId);
      expect(source).toBeDefined();
      expect(r.inputFingerprint).toBe(source!.inputFingerprint);
    }
  });
});

describe.skipIf(!harness)("ReplayEngine — concurrent sessions don't corrupt", () => {
  it("two parallel createSession calls leave a coherent session row", async () => {
    const seed = suiteSeed("concurrent-sessions");
    const { graph, stack } = await seedFixture(seed);

    const [a, b] = await Promise.all([
      stack.engine.createSession(graph.id),
      stack.engine.createSession(graph.id)
    ]);
    // Deterministic IDs → both calls target the SAME session row. The store's
    // `on conflict ... do update` makes the last write win, but frames table
    // is rewritten transactionally so we never see a torn frame set.
    expect(a.id).toBe(b.id);
    const reloaded = await stack.sessions.get(a.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.frames.length).toBe(a.frames.length);
    // Frame indices are contiguous 0..n-1.
    for (let i = 0; i < reloaded!.frames.length; i++) {
      expect(reloaded!.frames[i].index).toBe(i);
    }
  });
});

describe.skipIf(!harness)("ReplayEngine — interrupted replay recovery", () => {
  it("a partially-written session reload returns the same frame set as the in-memory session", async () => {
    const seed = suiteSeed("interrupt");
    const { graph, stack } = await seedFixture(seed);
    const session = await stack.engine.createSession(graph.id);
    // Simulate interrupted replay: seek halfway and reload from store.
    await stack.engine.seek(session.id, 5);
    const reloaded = await stack.sessions.get(session.id);
    expect(reloaded?.cursor.frameIndex).toBe(Math.min(5, session.frames.length - 1));
    // Frame timeline unchanged.
    expect(reloaded!.frames.map((f) => f.eventSequence))
      .toEqual(session.frames.map((f) => f.eventSequence));
  });
});
