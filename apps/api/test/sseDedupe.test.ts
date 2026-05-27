/**
 * Sprint Hardening 3 — RecentSequenceTracker unit tests.
 *
 * The tracker is the SSE dedupe primitive. The full integration coverage
 * (real HTTP + Postgres) lives in test/integration/postgres/; these tests
 * pin the data-structure invariants in isolation so a regression in the
 * counter accounting or eviction order shows up before container startup.
 */
import { describe, expect, it } from "vitest";
import { RecentSequenceTracker } from "../src/events/sse-dedupe.js";

describe("RecentSequenceTracker", () => {
  it("accepts a novel sequence and suppresses an immediate duplicate", () => {
    const t = new RecentSequenceTracker(8);
    expect(t.observe(1)).toBe(true);
    expect(t.observe(1)).toBe(false);
    const snap = t.snapshot();
    expect(snap.emitted).toBe(1);
    expect(snap.duplicates).toBe(1);
    expect(snap.outOfOrder).toBe(0);
    expect(snap.highWaterMark).toBe(1);
  });

  it("accepts out-of-order sequences as long as they are not already in the window", () => {
    const t = new RecentSequenceTracker(8);
    // Simulate two appenders publishing concurrently. Bus order: 11, 10.
    expect(t.observe(11)).toBe(true);
    expect(t.observe(10)).toBe(true);
    // A later duplicate of either is still suppressed.
    expect(t.observe(11)).toBe(false);
    expect(t.observe(10)).toBe(false);
    const snap = t.snapshot();
    expect(snap.emitted).toBe(2);
    expect(snap.duplicates).toBe(2);
    expect(snap.outOfOrder).toBe(1);
    expect(snap.highWaterMark).toBe(11);
  });

  it("respects capacity: once full, the oldest sequence is evicted and can be re-emitted", () => {
    const t = new RecentSequenceTracker(4);
    for (let i = 1; i <= 4; i++) expect(t.observe(i)).toBe(true);
    expect(t.snapshot().size).toBe(4);

    // Push 5 — evicts 1.
    expect(t.observe(5)).toBe(true);
    expect(t.snapshot().size).toBe(4);
    expect(t.snapshot().evicted).toBe(1);

    // 1 is no longer in the window, so it would NOT be suppressed as a dup
    // (this is the bounded-memory tradeoff documented in the design).
    expect(t.has(1)).toBe(false);
    expect(t.observe(1)).toBe(true);
    expect(t.snapshot().evicted).toBe(2); // emitting 1 evicted 2
  });

  it("size is monotonically non-decreasing up to capacity", () => {
    const t = new RecentSequenceTracker(3);
    expect(t.snapshot().size).toBe(0);
    t.observe(1); expect(t.snapshot().size).toBe(1);
    t.observe(2); expect(t.snapshot().size).toBe(2);
    t.observe(3); expect(t.snapshot().size).toBe(3);
    t.observe(4); expect(t.snapshot().size).toBe(3); // capped
    t.observe(5); expect(t.snapshot().size).toBe(3); // capped
  });

  it("bypasses dedupe for non-positive / non-finite sequences", () => {
    const t = new RecentSequenceTracker(4);
    expect(t.observe(0)).toBe(true);
    expect(t.observe(0)).toBe(true); // no dedupe — counted as emitted twice
    expect(t.observe(-1)).toBe(true);
    expect(t.observe(Number.NaN)).toBe(true);
    expect(t.observe(Number.POSITIVE_INFINITY)).toBe(true);
    const snap = t.snapshot();
    expect(snap.duplicates).toBe(0);
    expect(snap.emitted).toBe(5);
    // None of these enter the window.
    expect(snap.size).toBe(0);
  });

  it("rejects invalid capacity", () => {
    expect(() => new RecentSequenceTracker(0)).toThrow(/positive integer/);
    expect(() => new RecentSequenceTracker(-5)).toThrow(/positive integer/);
    expect(() => new RecentSequenceTracker(1.5)).toThrow(/positive integer/);
  });

  it("produces a stable snapshot view (not a reference to internal state)", () => {
    const t = new RecentSequenceTracker(4);
    t.observe(7);
    const first = t.snapshot();
    t.observe(8);
    // Mutating later observations must not retroactively change the first
    // snapshot — snapshots are value objects.
    expect(first.emitted).toBe(1);
    expect(first.highWaterMark).toBe(7);
  });

  it("handles a realistic catch-up + live interleave", () => {
    // Simulate the SSE handler: 500 catch-up events, then 100 live events
    // arriving partially in flight (some with sequences already in the
    // catch-up page, others new), with publisher order interleaved.
    const t = new RecentSequenceTracker(1024);
    const seen: number[] = [];
    for (let seq = 1; seq <= 500; seq++) {
      if (t.observe(seq)) seen.push(seq);
    }
    // Live arrivals: half were already in the catch-up window, half are new.
    // Order on the bus is randomized to model the concurrent-appender bug.
    const live = [
      // Re-publish of catch-up sequences (the race the bug was about):
      495, 498, 499, 500,
      // New sequences out of order:
      503, 501, 505, 502, 504,
      // Far-future arrives early:
      600, 510, 511
    ];
    for (const seq of live) {
      if (t.observe(seq)) seen.push(seq);
    }

    // Every novel sequence delivered exactly once.
    expect(new Set(seen).size).toBe(seen.length);
    // The four catch-up dupes were suppressed.
    expect(t.snapshot().duplicates).toBe(4);
    // 501, 502, 504, 510 each arrived after a larger sibling — out-of-order.
    expect(t.snapshot().outOfOrder).toBeGreaterThanOrEqual(4);
    // High water mark advances to the largest seq seen.
    expect(t.snapshot().highWaterMark).toBe(600);
  });
});
