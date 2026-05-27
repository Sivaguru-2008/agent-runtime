/**
 * Per-iteration instrumentation primitives for the single-container stress
 * harness. Pure data collectors — never throw, never block. The harness
 * aggregates these into the JSON diagnostics and asserts invariants.
 *
 * Each detector is stateful for one iteration only. Construct a fresh
 * instance per iteration to keep the window deterministic.
 */
import { performance } from "node:perf_hooks";
import { getActiveResourcesInfo } from "node:process";

export interface OrderingReport {
  totalObserved: number;
  outOfOrder: number;
  firstOutOfOrderAt: number | null;
  exampleViolation?: { previous: number; next: number };
}

/**
 * Verifies that a stream of sequence numbers is monotonically non-decreasing
 * in arrival order. Sequence here is the persisted bigserial.
 */
export class OrderingDetector {
  private previous: number = -1;
  private outOfOrder = 0;
  private total = 0;
  private firstAt: number | null = null;
  private example: { previous: number; next: number } | undefined;

  observe(sequence: number): void {
    this.total += 1;
    if (sequence < this.previous) {
      this.outOfOrder += 1;
      if (this.firstAt === null) {
        this.firstAt = this.total;
        this.example = { previous: this.previous, next: sequence };
      }
    } else {
      this.previous = sequence;
    }
  }

  report(): OrderingReport {
    return {
      totalObserved: this.total,
      outOfOrder: this.outOfOrder,
      firstOutOfOrderAt: this.firstAt,
      exampleViolation: this.example
    };
  }
}

export interface DuplicateReport {
  uniqueIds: number;
  duplicateIds: number;
  examples: string[];
}

export class DuplicateIdDetector {
  private seen = new Set<string>();
  private duplicates = 0;
  private examples: string[] = [];

  observe(id: string): void {
    if (this.seen.has(id)) {
      this.duplicates += 1;
      if (this.examples.length < 5) this.examples.push(id);
      return;
    }
    this.seen.add(id);
  }

  report(): DuplicateReport {
    return {
      uniqueIds: this.seen.size,
      duplicateIds: this.duplicates,
      examples: this.examples
    };
  }
}

export interface DroppedFrameReport {
  expected: number;
  delivered: number;
  missing: number[];
  duplicates: number[];
}

/**
 * Compare a canonical set of sequences (what the store accepted) against
 * what arrived through a transport (e.g. SSE). Reports missing + duplicated.
 */
export function diffSequenceSets(
  canonical: readonly number[],
  delivered: readonly number[]
): DroppedFrameReport {
  const canonicalSet = new Set(canonical);
  const deliveredSet = new Set<number>();
  const duplicates: number[] = [];
  for (const seq of delivered) {
    if (deliveredSet.has(seq)) {
      if (duplicates.length < 32) duplicates.push(seq);
    } else {
      deliveredSet.add(seq);
    }
  }
  const missing: number[] = [];
  for (const seq of canonical) {
    if (!deliveredSet.has(seq)) {
      if (missing.length < 32) missing.push(seq);
    }
  }
  return {
    expected: canonicalSet.size,
    delivered: deliveredSet.size,
    missing,
    duplicates
  };
}

export interface DivergenceReport {
  runs: number;
  fingerprintsPerRun: number;
  divergedFrameIndices: number[];
}

/**
 * Compares N replay runs' frame fingerprints and reports any frame index
 * that diverges across runs. A pure-determinism contract: zero divergence.
 */
export function detectReplayDivergence(runs: readonly string[][]): DivergenceReport {
  if (runs.length < 2) {
    return { runs: runs.length, fingerprintsPerRun: runs[0]?.length ?? 0, divergedFrameIndices: [] };
  }
  const baseline = runs[0];
  const diverged = new Set<number>();
  for (let r = 1; r < runs.length; r++) {
    const current = runs[r];
    const lim = Math.max(baseline.length, current.length);
    for (let i = 0; i < lim; i++) {
      if (baseline[i] !== current[i]) diverged.add(i);
    }
  }
  return {
    runs: runs.length,
    fingerprintsPerRun: baseline.length,
    divergedFrameIndices: [...diverged].sort((a, b) => a - b)
  };
}

export interface LatencySamples {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  samplesMs: number[];
}

export class LatencyRecorder {
  private samples: number[] = [];

  time<T>(fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    return fn().finally(() => {
      this.samples.push(performance.now() - start);
    });
  }

  add(ms: number): void {
    this.samples.push(ms);
  }

  report(): LatencySamples {
    if (this.samples.length === 0) {
      return { count: 0, minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, samplesMs: [] };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pick = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: sorted.length,
      minMs: round(sorted[0]),
      maxMs: round(sorted[sorted.length - 1]),
      meanMs: round(sum / sorted.length),
      p50Ms: round(pick(50)),
      p95Ms: round(pick(95)),
      p99Ms: round(pick(99)),
      samplesMs: sorted.map(round)
    };
  }
}

export interface ResourceSnapshot {
  /** Node's reported active handle/request resources. */
  activeResources: Record<string, number>;
  /** Total active resource count. */
  activeResourceCount: number;
  /** Heap used in bytes. */
  heapUsedBytes: number;
  /** RSS in bytes. */
  rssBytes: number;
  /** External (off-heap allocated by V8). */
  externalBytes: number;
}

export function captureResourceSnapshot(): ResourceSnapshot {
  const resources = getActiveResourcesInfo();
  const tally: Record<string, number> = {};
  for (const name of resources) {
    tally[name] = (tally[name] ?? 0) + 1;
  }
  const mem = process.memoryUsage();
  return {
    activeResources: tally,
    activeResourceCount: resources.length,
    heapUsedBytes: mem.heapUsed,
    rssBytes: mem.rss,
    externalBytes: mem.external
  };
}

export interface ResourceDeltaReport {
  baseline: ResourceSnapshot;
  after: ResourceSnapshot;
  /** Handle types whose count grew (after - baseline). Negative entries omitted. */
  growthByResource: Record<string, number>;
  /** Net active-handle delta. */
  activeResourceDelta: number;
  /** Heap delta in bytes. */
  heapDeltaBytes: number;
  /** RSS delta in bytes. */
  rssDeltaBytes: number;
}

export function diffResources(
  baseline: ResourceSnapshot,
  after: ResourceSnapshot
): ResourceDeltaReport {
  const growth: Record<string, number> = {};
  const keys = new Set<string>([
    ...Object.keys(baseline.activeResources),
    ...Object.keys(after.activeResources)
  ]);
  for (const key of keys) {
    const delta = (after.activeResources[key] ?? 0) - (baseline.activeResources[key] ?? 0);
    if (delta > 0) growth[key] = delta;
  }
  return {
    baseline,
    after,
    growthByResource: growth,
    activeResourceDelta: after.activeResourceCount - baseline.activeResourceCount,
    heapDeltaBytes: after.heapUsedBytes - baseline.heapUsedBytes,
    rssDeltaBytes: after.rssBytes - baseline.rssBytes
  };
}

export interface ListenerSnapshot {
  /** Handler count on the in-memory EventBus, peeked via private field. */
  busHandlerCount: number | null;
  /** Total subscribers we could enumerate; null if introspection unavailable. */
  introspectedAt: string;
}

/**
 * Peek the handler set on InMemoryEventBus. The bus exposes `handlers` as a
 * private Set; this is a controlled test-only reach so we can detect orphaned
 * SSE subscribers without modifying production code.
 *
 * Returns null if the bus shape doesn't match (e.g. RedisEventBus is wired).
 */
export function snapshotBusListeners(bus: unknown): ListenerSnapshot {
  const peek = (bus as { handlers?: Set<unknown> } | undefined)?.handlers;
  const count = peek instanceof Set ? peek.size : null;
  return { busHandlerCount: count, introspectedAt: new Date().toISOString() };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
