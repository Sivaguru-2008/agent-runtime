import { describe, expect, it } from "vitest";
import { InMemorySnapshotStore } from "../src/infrastructure/persistence/inMemoryCognitionStores.js";
import {
  SnapshotCorruptionError,
  computeSnapshotIntegrityHash,
  stampIntegrityHash,
  verifySnapshotIntegrity
} from "../src/runtime/replay/snapshotIntegrity.js";
import type { ReplaySnapshot } from "../src/domain/replay.js";
import type { CognitionGraph } from "../src/domain/cognition.js";

/**
 * Phase C — Snapshot integrity validation.
 *
 * The contract under test:
 *
 *   (a) Pure hash primitives:
 *       - computeSnapshotIntegrityHash is deterministic — same projection
 *         → same hash across calls.
 *       - It changes when any of { graph, eventSequence, frameIndex } changes.
 *       - It DOES NOT change when capturedAt, eventCount, or id change
 *         (those are excluded from the projection on purpose).
 *
 *   (b) InMemorySnapshotStore — happy path:
 *       - put() stamps a hash; get()/nearest() return the snapshot unmodified
 *         when the hash matches.
 *
 *   (c) InMemorySnapshotStore — corruption:
 *       - When a stored snapshot's graph is tampered with after persistence,
 *         get() and nearest() throw SnapshotCorruptionError and fire the
 *         integrity-violation reporter exactly once each.
 *
 *   (d) Legacy fallback:
 *       - verifySnapshotIntegrity treats a snapshot with no integrityHash
 *         as "legacy ok" by default; `requireHash: true` flips that to
 *         "legacy not ok".
 */

function makeGraph(seed: string): CognitionGraph {
  return {
    id: `cog-${seed}`,
    executionId: `exec-${seed}`,
    agentId: `agent-${seed}`,
    phase: "COMPLETE",
    startedAt: "2026-05-27T00:00:00.000Z",
    completedAt: "2026-05-27T00:00:10.000Z",
    nodes: [
      {
        id: `node-${seed}-0`,
        cognitionId: `cog-${seed}`,
        executionId: `exec-${seed}`,
        sequence: 0,
        role: "PLANNER",
        phase: "PLAN",
        status: "COMPLETED",
        inputFingerprint: "fp0",
        input: { role: "PLANNER" },
        output: { ok: true },
        startedAt: "2026-05-27T00:00:00.000Z",
        completedAt: "2026-05-27T00:00:01.000Z",
        durationMs: 1000
      }
    ],
    handoffs: [],
    output: { final: "ok" }
  };
}

function makeSnapshot(seed: string, overrides: Partial<ReplaySnapshot> = {}): ReplaySnapshot {
  const graph = makeGraph(seed);
  return {
    id: `snap-${seed}`,
    cognitionId: graph.id,
    executionId: graph.executionId,
    frameIndex: 3,
    eventSequence: 9,
    capturedAt: "2026-05-27T00:00:00.000Z",
    graph,
    eventCount: 4,
    ...overrides
  };
}

describe("snapshotIntegrity — pure hash primitives", () => {
  it("computes a deterministic hash for the same snapshot across calls", () => {
    const snap = makeSnapshot("det-A");
    const h1 = computeSnapshotIntegrityHash(snap);
    const h2 = computeSnapshotIntegrityHash(snap);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // sha256 hex
  });

  it("changes when the graph mutates", () => {
    const snap = makeSnapshot("mut-graph");
    const base = computeSnapshotIntegrityHash(snap);
    const tampered = {
      ...snap,
      graph: { ...snap.graph, phase: "FAILED" as const }
    };
    expect(computeSnapshotIntegrityHash(tampered)).not.toBe(base);
  });

  it("changes when eventSequence mutates", () => {
    const snap = makeSnapshot("mut-seq");
    const base = computeSnapshotIntegrityHash(snap);
    expect(computeSnapshotIntegrityHash({ ...snap, eventSequence: snap.eventSequence + 1 })).not.toBe(base);
  });

  it("changes when frameIndex mutates", () => {
    const snap = makeSnapshot("mut-frame");
    const base = computeSnapshotIntegrityHash(snap);
    expect(computeSnapshotIntegrityHash({ ...snap, frameIndex: snap.frameIndex + 1 })).not.toBe(base);
  });

  it("does NOT change when excluded fields mutate (capturedAt, eventCount, id, cognitionId, executionId)", () => {
    const snap = makeSnapshot("excl");
    const base = computeSnapshotIntegrityHash(snap);
    expect(computeSnapshotIntegrityHash({ ...snap, capturedAt: "2099-01-01T00:00:00.000Z" })).toBe(base);
    expect(computeSnapshotIntegrityHash({ ...snap, eventCount: 999 })).toBe(base);
    expect(computeSnapshotIntegrityHash({ ...snap, id: "snap-renamed" })).toBe(base);
    expect(computeSnapshotIntegrityHash({ ...snap, cognitionId: "cog-renamed" })).toBe(base);
    expect(computeSnapshotIntegrityHash({ ...snap, executionId: "exec-renamed" })).toBe(base);
  });

  it("stampIntegrityHash stamps the recomputed hash on a clone", () => {
    const snap = makeSnapshot("stamp");
    const stamped = stampIntegrityHash(snap);
    expect(stamped.integrityHash).toBe(computeSnapshotIntegrityHash(snap));
    expect(snap.integrityHash).toBeUndefined(); // input untouched
  });

  it("stampIntegrityHash overrides any caller-supplied hash (caller can't lie)", () => {
    const snap = makeSnapshot("stamp-lie", { integrityHash: "deadbeef" });
    const stamped = stampIntegrityHash(snap);
    expect(stamped.integrityHash).not.toBe("deadbeef");
    expect(stamped.integrityHash).toBe(computeSnapshotIntegrityHash(snap));
  });
});

describe("verifySnapshotIntegrity — legacy fallback", () => {
  it("returns ok=true and legacy=true for a snapshot with no stored hash", () => {
    const snap = makeSnapshot("legacy");
    const result = verifySnapshotIntegrity(snap);
    expect(result.ok).toBe(true);
    expect(result.legacy).toBe(true);
    expect(result.storedHash).toBeNull();
  });

  it("returns ok=false on a legacy snapshot when requireHash: true", () => {
    const snap = makeSnapshot("legacy-strict");
    const result = verifySnapshotIntegrity(snap, { requireHash: true });
    expect(result.ok).toBe(false);
    expect(result.legacy).toBe(true);
  });

  it("returns ok=false when stored hash does not match recompute", () => {
    const snap = makeSnapshot("mismatch", { integrityHash: "0".repeat(64) });
    const result = verifySnapshotIntegrity(snap);
    expect(result.ok).toBe(false);
    expect(result.legacy).toBe(false);
    expect(result.storedHash).toBe("0".repeat(64));
    expect(result.computedHash).toBe(computeSnapshotIntegrityHash(snap));
  });
});

describe("InMemorySnapshotStore — integrity (happy path)", () => {
  it("put() stamps a hash; get() returns the snapshot with that hash", async () => {
    const store = new InMemorySnapshotStore();
    const snap = makeSnapshot("happy-get");
    await store.put(snap);
    const got = await store.get(snap.id);
    expect(got).toBeDefined();
    expect(got!.integrityHash).toBe(computeSnapshotIntegrityHash(snap));
  });

  it("nearest() returns the snapshot at or before frameIndex with intact hash", async () => {
    const store = new InMemorySnapshotStore();
    const cogId = "cog-near";
    await store.put(makeSnapshot("near-3", { id: "s3", cognitionId: cogId, frameIndex: 3 }));
    await store.put(makeSnapshot("near-7", { id: "s7", cognitionId: cogId, frameIndex: 7 }));
    await store.put(makeSnapshot("near-12", { id: "s12", cognitionId: cogId, frameIndex: 12 }));

    const at5 = await store.nearest(cogId, 5);
    expect(at5?.id).toBe("s3");
    expect(at5?.integrityHash).toBeDefined();

    const at12 = await store.nearest(cogId, 12);
    expect(at12?.id).toBe("s12");
  });
});

describe("InMemorySnapshotStore — integrity (corruption)", () => {
  it("get() throws SnapshotCorruptionError when the stored graph is tampered with post-put", async () => {
    const store = new InMemorySnapshotStore();
    const reporterCalls: unknown[] = [];
    store.setIntegrityViolationReporter((v) => reporterCalls.push(v));

    // Insert a snapshot whose stored hash does NOT match its graph — simulates
    // tampering between the put() commit and the next read.
    const tampered = makeSnapshot("tamper-get", { integrityHash: "00".repeat(32) });
    store.injectRawForTest(tampered);

    await expect(store.get(tampered.id)).rejects.toBeInstanceOf(SnapshotCorruptionError);
    expect(reporterCalls).toHaveLength(1);
    expect(reporterCalls[0]).toMatchObject({
      snapshotId: tampered.id,
      cognitionId: tampered.cognitionId,
      executionId: tampered.executionId,
      frameIndex: tampered.frameIndex,
      storedHash: "00".repeat(32),
      operation: "get"
    });
  });

  it("nearest() throws SnapshotCorruptionError when the candidate row is corrupt", async () => {
    const store = new InMemorySnapshotStore();
    const reporterCalls: unknown[] = [];
    store.setIntegrityViolationReporter((v) => reporterCalls.push(v));

    const cogId = "cog-tamper-near";
    const tampered = makeSnapshot("tamper-near", {
      id: "s-corrupt",
      cognitionId: cogId,
      frameIndex: 4,
      integrityHash: "ff".repeat(32)
    });
    store.injectRawForTest(tampered);

    await expect(store.nearest(cogId, 10)).rejects.toBeInstanceOf(SnapshotCorruptionError);
    expect(reporterCalls).toHaveLength(1);
    expect(reporterCalls[0]).toMatchObject({ operation: "nearest", snapshotId: "s-corrupt" });
  });

  it("reporter failures do not mask the underlying corruption error", async () => {
    const store = new InMemorySnapshotStore();
    store.setIntegrityViolationReporter(() => {
      throw new Error("reporter blew up");
    });

    const tampered = makeSnapshot("tamper-reporter-fail", { integrityHash: "aa".repeat(32) });
    store.injectRawForTest(tampered);

    await expect(store.get(tampered.id)).rejects.toBeInstanceOf(SnapshotCorruptionError);
  });

  it("the SnapshotCorruptionError carries the diagnostic payload (storedHash, computedHash, ids)", async () => {
    const store = new InMemorySnapshotStore();
    const tampered = makeSnapshot("tamper-payload", { integrityHash: "11".repeat(32) });
    store.injectRawForTest(tampered);

    try {
      await store.get(tampered.id);
      expect.fail("Expected SnapshotCorruptionError");
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotCorruptionError);
      const e = err as SnapshotCorruptionError;
      expect(e.name).toBe("SnapshotCorruptionError");
      expect(e.snapshotId).toBe(tampered.id);
      expect(e.cognitionId).toBe(tampered.cognitionId);
      expect(e.executionId).toBe(tampered.executionId);
      expect(e.frameIndex).toBe(tampered.frameIndex);
      expect(e.storedHash).toBe("11".repeat(32));
      expect(e.computedHash).toBe(computeSnapshotIntegrityHash(tampered));
    }
  });
});
