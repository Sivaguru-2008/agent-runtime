/**
 * Per-iteration diagnostics writer + end-of-run summary aggregator.
 *
 * Outputs go to `<repo>/.logs/runtime-stress/<runId>/`:
 *   - iteration-NN.json       (one per iteration; includes invariant verdicts)
 *   - failure-snapshot.json   (deep snapshot of first failing iteration)
 *   - summary.json            (aggregate trends + per-invariant verdict matrix)
 *
 * All writes are best-effort: a failure here must not break the test run.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  DivergenceReport,
  DroppedFrameReport,
  DuplicateReport,
  LatencySamples,
  ListenerSnapshot,
  OrderingReport,
  ResourceDeltaReport,
  ResourceSnapshot
} from "./instrumentation.js";

export interface InvariantVerdict {
  name: string;
  passed: boolean;
  detail: string;
}

export interface IterationDiagnostics {
  iteration: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  invariants: InvariantVerdict[];
  reports: {
    ordering: OrderingReport;
    duplicates: DuplicateReport;
    droppedFrames: DroppedFrameReport;
    canonicalMonotonicDense: boolean;
    replayDivergence: DivergenceReport;
    snapshotEquivalent: boolean;
    reorderInvariance: boolean;
    sessionIdStable: boolean;
    reconnectDroppedFrames: DroppedFrameReport;
    reconnectLatencyMs: number;
    streamClosedCleanly: boolean;
    belowCursorDeliveries: number;
    replayLatency: LatencySamples;
    resources: ResourceDeltaReport;
    listenersBefore: ListenerSnapshot;
    listenersAfter: ListenerSnapshot;
  };
  /** True if every invariant passed for this iteration. */
  pass: boolean;
}

export interface RunSummary {
  runId: string;
  iterations: number;
  passedIterations: number;
  failedIterations: number;
  firstFailingIteration: number | null;
  /** Aggregate per-invariant pass count. */
  invariantPassRate: Record<string, { passed: number; failed: number }>;
  /** Memory + handle trend across iterations. */
  trends: {
    heapUsedBytesPerIter: number[];
    rssBytesPerIter: number[];
    activeResourceCountPerIter: number[];
    busHandlerCountAfterPerIter: Array<number | null>;
    replayLatencyP95PerIter: number[];
    reconnectLatencyMsPerIter: number[];
  };
  /** Detected leak: net growth across the run. */
  leakIndicators: {
    heapGrowthBytes: number;
    rssGrowthBytes: number;
    activeResourceGrowth: number;
    busHandlerNetGrowth: number | null;
  };
}

export interface DiagnosticsWriter {
  runDir: string;
  runId: string;
  writeIteration(diag: IterationDiagnostics): Promise<void>;
  writeFailureSnapshot(snapshot: unknown): Promise<void>;
  writeSummary(summary: RunSummary): Promise<void>;
}

export async function createDiagnosticsWriter(rootLogsDir: string): Promise<DiagnosticsWriter> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const runDir = resolve(rootLogsDir, "runtime-stress", runId);
  await mkdir(runDir, { recursive: true });

  return {
    runDir,
    runId,
    async writeIteration(diag) {
      const file = resolve(runDir, `iteration-${String(diag.iteration).padStart(2, "0")}.json`);
      await safeWrite(file, diag);
    },
    async writeFailureSnapshot(snapshot) {
      const file = resolve(runDir, `failure-snapshot.json`);
      await safeWrite(file, snapshot);
    },
    async writeSummary(summary) {
      const file = resolve(runDir, `summary.json`);
      await safeWrite(file, summary);
    }
  };
}

async function safeWrite(path: string, payload: unknown): Promise<void> {
  try {
    await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[stress] failed to write ${path}:`, (err as Error).message);
  }
}

/**
 * Aggregate per-iteration diagnostics into the run-level summary. Pure —
 * does not touch the filesystem.
 */
export function aggregateSummary(
  runId: string,
  iters: readonly IterationDiagnostics[],
  baselineResources: ResourceSnapshot,
  finalResources: ResourceSnapshot,
  finalListeners: ListenerSnapshot,
  initialListeners: ListenerSnapshot
): RunSummary {
  const invariantPassRate: Record<string, { passed: number; failed: number }> = {};
  for (const iter of iters) {
    for (const v of iter.invariants) {
      const bucket = (invariantPassRate[v.name] ??= { passed: 0, failed: 0 });
      if (v.passed) bucket.passed += 1;
      else bucket.failed += 1;
    }
  }

  const firstFailing = iters.find((i) => !i.pass)?.iteration ?? null;
  const initialBusCount = initialListeners.busHandlerCount;
  const finalBusCount = finalListeners.busHandlerCount;
  const busNet =
    initialBusCount === null || finalBusCount === null ? null : finalBusCount - initialBusCount;

  return {
    runId,
    iterations: iters.length,
    passedIterations: iters.filter((i) => i.pass).length,
    failedIterations: iters.filter((i) => !i.pass).length,
    firstFailingIteration: firstFailing,
    invariantPassRate,
    trends: {
      heapUsedBytesPerIter: iters.map((i) => i.reports.resources.after.heapUsedBytes),
      rssBytesPerIter: iters.map((i) => i.reports.resources.after.rssBytes),
      activeResourceCountPerIter: iters.map((i) => i.reports.resources.after.activeResourceCount),
      busHandlerCountAfterPerIter: iters.map((i) => i.reports.listenersAfter.busHandlerCount),
      replayLatencyP95PerIter: iters.map((i) => i.reports.replayLatency.p95Ms),
      reconnectLatencyMsPerIter: iters.map((i) => i.reports.reconnectLatencyMs)
    },
    leakIndicators: {
      heapGrowthBytes: finalResources.heapUsedBytes - baselineResources.heapUsedBytes,
      rssGrowthBytes: finalResources.rssBytes - baselineResources.rssBytes,
      activeResourceGrowth:
        finalResources.activeResourceCount - baselineResources.activeResourceCount,
      busHandlerNetGrowth: busNet
    }
  };
}
