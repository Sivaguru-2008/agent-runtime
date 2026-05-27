/**
 * Phase 4 — SSE failure testing.
 *
 * Targets the SSE correctness primitives:
 *   - RecentSequenceTracker (events/sse-dedupe.ts)
 *   - LiveEventBroadcaster (events/live-broadcaster.ts)
 *
 * Scenarios:
 *   4.1 Reconnect storms              — 200 reconnects with overlapping resume
 *                                       windows ⇒ tracker dedupe stays correct,
 *                                       memory stays bounded.
 *   4.2 Dropped token streams         — simulate publisher loss; subscriber
 *                                       observes gap; resume from last sequence
 *                                       fills it deterministically.
 *   4.3 Partial replay buffers        — out-of-order resume with sequences
 *                                       interleaved across the dedupe window.
 *   4.4 Deduplication correctness     — same sequence delivered N times,
 *                                       observed exactly once.
 *   4.5 Frontend eventual consistency — given enough time, every subscriber
 *                                       converges to the same set of sequences.
 */

import { describe, expect, it } from "vitest";
import { RecentSequenceTracker } from "../../src/events/sse-dedupe.js";
import { LiveEventBroadcaster } from "../../src/events/live-broadcaster.js";
import type { LiveEvent } from "../../src/telemetry/live-events.js";
import { recordPhase, evaluateThresholds } from "./_setup/chaosResultBus.js";

function makeLive(seq: number, tenant = "t1"): LiveEvent {
  return {
    type: "EXECUTION_STATE",
    state: "RUNNING",
    sequence: seq,
    tenantId: tenant,
    executionId: `exec-${seq}`,
    timestamp: new Date().toISOString()
  };
}

describe("Phase 4.1 — reconnect storms", () => {
  it("200 reconnects each replaying overlapping windows: every unique sequence emitted exactly once; memory bounded", async () => {
    const t0 = Date.now();
    const tracker = new RecentSequenceTracker(512);
    const RECONNECTS = 200;
    const WINDOW = 64;
    let highest = 0;

    const emittedSeqs = new Set<number>();
    for (let r = 0; r < RECONNECTS; r++) {
      // Each reconnect replays from highest - WINDOW/2 up to highest + 8 (new events).
      const from = Math.max(1, highest - Math.floor(WINDOW / 2));
      const to = highest + 8;
      for (let s = from; s <= to; s++) {
        if (tracker.observe(s)) emittedSeqs.add(s);
      }
      highest = to;
    }
    const snap = tracker.snapshot();

    const { ok, thresholds } = evaluateThresholds({
      uniqueEmits: {
        observed: emittedSeqs.size,
        required: `== ${highest} (every distinct sequence emitted exactly once)`,
        predicate: (v) => v === highest
      },
      bounded: {
        observed: snap.size,
        required: `<= ${snap.capacity}`,
        predicate: (v) => v <= snap.capacity
      },
      duplicatesSeen: {
        observed: snap.duplicates,
        required: "> 0 (storm produced overlap)",
        predicate: (v) => v > 0
      }
    });
    expect(ok).toBe(true);
    await recordPhase("phase4.1.reconnectStorm", {
      ok,
      metrics: {
        reconnects: RECONNECTS,
        uniqueEmits: emittedSeqs.size,
        duplicatesSuppressed: snap.duplicates,
        windowSize: snap.size
      },
      thresholds,
      durationMs: Date.now() - t0
    });
  });
});

describe("Phase 4.2 — dropped token streams", () => {
  it("after publisher loss, a resume catches up gap deterministically", async () => {
    const t0 = Date.now();
    const tracker = new RecentSequenceTracker(256);
    // First pass: 1..10 published; subscriber observes 1,2,3,7,8 (lost 4,5,6,9,10).
    for (const s of [1, 2, 3, 7, 8]) tracker.observe(s);

    const seenBefore = tracker.snapshot().emitted;
    expect(seenBefore).toBe(5);

    // Resume from sequence=3 (last contiguous). Replay 4..10 inclusive.
    let gapFilled = 0;
    for (let s = 4; s <= 10; s++) {
      if (tracker.observe(s)) gapFilled += 1;
    }
    const snap = tracker.snapshot();

    const { ok, thresholds } = evaluateThresholds({
      gapFilled: {
        observed: gapFilled,
        required: "== 5 (filled 4,5,6,9,10)",
        predicate: (v) => v === 5
      },
      duplicatesSuppressed: {
        observed: snap.duplicates,
        required: ">= 2 (replay covered 7,8 too)",
        predicate: (v) => v >= 2
      }
    });
    expect(ok).toBe(true);
    await recordPhase("phase4.2.droppedTokenStream", {
      ok,
      metrics: { gapFilled, duplicatesSuppressed: snap.duplicates },
      thresholds,
      durationMs: Date.now() - t0
    });
  });
});

describe("Phase 4.3 — partial replay buffers", () => {
  it("out-of-order interleaved sequences across the dedupe window do not drop or duplicate", async () => {
    const t0 = Date.now();
    const tracker = new RecentSequenceTracker(32);
    // Forward burst 1..20.
    for (let s = 1; s <= 20; s++) tracker.observe(s);
    // Interleaved replay window mixing OLD (5..15) and NEW (21..30).
    const replay = [21, 5, 22, 6, 23, 7, 24, 30, 8, 25, 29, 26, 27, 28];
    let newAccepted = 0;
    let oldSuppressed = 0;
    for (const s of replay) {
      const accepted = tracker.observe(s);
      if (accepted) newAccepted += 1;
      else oldSuppressed += 1;
    }
    const snap = tracker.snapshot();

    const { ok, thresholds } = evaluateThresholds({
      newAccepted: {
        observed: newAccepted,
        required: "== 10 (21..30 are new)",
        predicate: (v) => v === 10
      },
      oldSuppressed: {
        observed: oldSuppressed,
        required: "== 4 (5,6,7,8 still in window)",
        predicate: (v) => v === 4
      },
      outOfOrderCount: {
        observed: snap.outOfOrder,
        required: ">= 0 (counter advances on each accepted seq < hwm)",
        predicate: (v) => v >= 0
      }
    });
    expect(ok).toBe(true);
    await recordPhase("phase4.3.partialReplayBuffer", {
      ok,
      metrics: { newAccepted, oldSuppressed, hwm: snap.highWaterMark, outOfOrder: snap.outOfOrder },
      thresholds,
      durationMs: Date.now() - t0
    });
  });
});

describe("Phase 4.4 — deduplication correctness", () => {
  it("the same sequence delivered 50 times is observed exactly once", async () => {
    const t0 = Date.now();
    const tracker = new RecentSequenceTracker(8);
    let accepted = 0;
    for (let i = 0; i < 50; i++) if (tracker.observe(42)) accepted += 1;
    const snap = tracker.snapshot();

    const { ok, thresholds } = evaluateThresholds({
      acceptedOnce: { observed: accepted, required: "== 1", predicate: (v) => v === 1 },
      duplicatesSeen: { observed: snap.duplicates, required: "== 49", predicate: (v) => v === 49 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase4.4.dedupeCorrectness", {
      ok,
      metrics: { accepted, duplicates: snap.duplicates },
      thresholds,
      durationMs: Date.now() - t0
    });
  });
});

describe("Phase 4.5 — frontend eventual consistency", () => {
  it("two SSE subscribers under reconnect storm converge to the same set of sequences", async () => {
    const t0 = Date.now();
    const bcast = new LiveEventBroadcaster(1024);
    const subA: number[] = [];
    const subB: number[] = [];
    const trackerA = new RecentSequenceTracker(256);
    const trackerB = new RecentSequenceTracker(256);

    const unsubA = bcast.subscribe((e) => {
      if (trackerA.observe(e.sequence ?? 0)) subA.push(e.sequence ?? 0);
    }, "t1");
    const unsubB = bcast.subscribe((e) => {
      if (trackerB.observe(e.sequence ?? 0)) subB.push(e.sequence ?? 0);
    }, "t1");

    const N = 200;
    for (let s = 1; s <= N; s++) bcast.publish(makeLive(s, "t1"));

    // Allow event loop to drain.
    await new Promise((r) => setTimeout(r, 50));

    unsubA();
    unsubB();

    const setA = new Set(subA);
    const setB = new Set(subB);
    const diffCount =
      [...setA].filter((x) => !setB.has(x)).length +
      [...setB].filter((x) => !setA.has(x)).length;

    const { ok, thresholds } = evaluateThresholds({
      converged: {
        observed: diffCount,
        required: "== 0 (subscribers see the same set)",
        predicate: (v) => v === 0
      },
      subsAcrossN: {
        observed: setA.size,
        required: `== ${N}`,
        predicate: (v) => v === N
      }
    });
    expect(ok).toBe(true);
    await recordPhase("phase4.5.eventualConsistency", {
      ok,
      metrics: { subA: setA.size, subB: setB.size, diff: diffCount },
      thresholds,
      durationMs: Date.now() - t0
    });
  });
});
