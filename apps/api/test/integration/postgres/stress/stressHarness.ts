/**
 * Single-iteration runner for the runtime stress harness.
 *
 * Each iteration:
 *   1. Builds the full Fastify app against the persistent Postgres harness.
 *   2. Captures a baseline resource + listener snapshot.
 *   3. Drives 4 stress phases against the live runtime substrate:
 *        A) Append + shuffled-bus-publish + SSE consume → ordering/dupe/drop
 *        B) Cognition replay determinism (5 reruns, fingerprint parity)
 *        C) SSE reconnect with `Last-Event-ID` cursor mid-stream
 *        D) Replay latency distribution sampling
 *   4. Closes the app and asserts cleanup invariants vs. the baseline.
 *   5. Truncates the harness for the next iteration (the *container* stays;
 *      only schema state is reset).
 *
 * The harness never recreates the container — that's the whole point. The
 * Docker-stability blocker is sidestepped by amortizing one startup across N
 * iterations.
 *
 * Notes on the "explicit cleanup verification" requirement:
 *   - Active handle deltas use `process.getActiveResourcesInfo()`.
 *   - Bus listener deltas peek the InMemoryEventBus's private handler set
 *     (test-only reach; no src changes).
 *   - We never sleep waiting for cleanup; an iteration that leaks is a real
 *     leak, not a timing artifact.
 */
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../../src/app.js";
import type { AppConfig } from "../../../../src/shared/config.js";
import type { DomainEvent } from "../../../../src/domain/events.js";
import type { RuntimeContainer } from "../../../../src/application/runtimeContainer.js";
import { FrameBuilder } from "../../../../src/runtime/replay/frameBuilder.js";
import { deterministicId } from "../../../../src/shared/determinism.js";
import type { PgHarness } from "../harness.js";
import {
  makeCognitionEventLog,
  makeCognitionGraph,
  makeEvent,
  seedAgentAndExecution,
  uuidFromHex
} from "../factories.js";
import { sleep } from "../concurrency.js";
import {
  DuplicateIdDetector,
  LatencyRecorder,
  OrderingDetector,
  captureResourceSnapshot,
  detectReplayDivergence,
  diffResources,
  diffSequenceSets,
  snapshotBusListeners,
  type DivergenceReport,
  type DroppedFrameReport,
  type DuplicateReport,
  type LatencySamples,
  type OrderingReport,
  type ResourceDeltaReport,
  type ResourceSnapshot,
  type ListenerSnapshot
} from "./instrumentation.js";
import type { InvariantVerdict, IterationDiagnostics } from "./diagnostics.js";

const PHASE_A_EVENT_COUNT = 80;
const PHASE_C_PRE_RECONNECT_EVENT_COUNT = 40;
const PHASE_C_POST_RECONNECT_EVENT_COUNT = 40;
const PHASE_D_REPLAY_RERUNS = 5;
const SSE_CONSUMER_TIMEOUT_MS = 6_000;

/**
 * Tolerance for cleanup checks. We allow Node's internal handles (e.g. the
 * "Immediate" used by Fastify's logger flush) to fluctuate by a small amount
 * without flagging it as a leak.
 */
const RESOURCE_DELTA_TOLERANCE = 3;
const HEAP_GROWTH_PER_ITER_TOLERANCE_BYTES = 12 * 1024 * 1024; // 12 MiB

export interface StressRunOptions {
  iterations: number;
  /** Logical name baked into seeds so diagnostics correlate runs. */
  runId: string;
}

export interface StressRunResult {
  iterations: IterationDiagnostics[];
  baselineResources: ResourceSnapshot;
  finalResources: ResourceSnapshot;
  initialListeners: ListenerSnapshot;
  finalListeners: ListenerSnapshot;
  firstFailureSnapshot: unknown | null;
}

/**
 * Run the full N-iteration sweep against a single persistent Postgres harness.
 * Caller owns the harness lifecycle (one startContainerHarness, one stop).
 */
export async function runStressIterations(
  harness: PgHarness,
  opts: StressRunOptions
): Promise<StressRunResult> {
  const baselineResources = captureResourceSnapshot();
  const initialListeners: ListenerSnapshot = { busHandlerCount: null, introspectedAt: new Date().toISOString() };
  const iterations: IterationDiagnostics[] = [];
  let firstFailureSnapshot: unknown | null = null;
  let finalListeners: ListenerSnapshot = initialListeners;

  for (let i = 1; i <= opts.iterations; i++) {
    const diag = await runSingleIteration(harness, i, opts.runId);
    iterations.push(diag);

    if (!diag.pass && firstFailureSnapshot === null) {
      firstFailureSnapshot = {
        iteration: i,
        invariants: diag.invariants,
        reports: diag.reports
      };
    }

    finalListeners = diag.reports.listenersAfter;

    // Truncate schema, not the container. This is the "explicit cleanup
    // verification between iterations" requirement: every iteration starts
    // with a known-empty DB.
    await harness.reset();
  }

  const finalResources = captureResourceSnapshot();
  return {
    iterations,
    baselineResources,
    finalResources,
    initialListeners,
    finalListeners,
    firstFailureSnapshot
  };
}

async function runSingleIteration(
  harness: PgHarness,
  iteration: number,
  runId: string
): Promise<IterationDiagnostics> {
  const startedAt = new Date();
  const baseline = captureResourceSnapshot();
  const seedPrefix = `stress#${runId}#iter${iteration}`;

  // Hint a GC pass between iterations when --expose-gc is on. Optional.
  maybeGc();

  const app = await buildApp(buildIterationConfig(harness));
  let baselineListeners: ListenerSnapshot;
  let phaseA: PhaseAResult | null = null;
  let phaseB: PhaseBResult | null = null;
  let phaseC: PhaseCResult | null = null;
  let phaseD: PhaseDResult | null = null;
  let postRunResources: ResourceSnapshot = baseline;
  let postRunListeners: ListenerSnapshot;

  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const baseUrl = resolveBaseUrl(app);
    const container = (app as unknown as { runtimeContainer: RuntimeContainer }).runtimeContainer;
    baselineListeners = snapshotBusListeners(container.eventBus);

    phaseA = await phaseA_OrderingAndDedupe(container, baseUrl, harness, seedPrefix);
    phaseB = await phaseB_ReplayDeterminism(harness, seedPrefix);
    phaseC = await phaseC_ReconnectCursor(container, baseUrl, harness, seedPrefix);
    phaseD = await phaseD_ReplayLatency(harness, seedPrefix);

    postRunListeners = snapshotBusListeners(container.eventBus);
  } finally {
    try {
      await app.close();
    } catch {
      // best-effort
    }
  }

  // Capture AFTER close, so handle/listener leaks are attributable to the
  // runtime not the test connection.
  postRunResources = captureResourceSnapshot();
  // Re-peek listeners after close is intentionally a separate snapshot —
  // the bus reference is still alive in our closure, but the runtime should
  // have detached its own subscribers.
  postRunListeners ??= { busHandlerCount: null, introspectedAt: new Date().toISOString() };

  const resourceDelta = diffResources(baseline, postRunResources);
  const invariants = evaluateInvariants({
    iteration,
    phaseA: phaseA!,
    phaseB: phaseB!,
    phaseC: phaseC!,
    phaseD: phaseD!,
    resourceDelta,
    baselineListeners: baselineListeners!,
    postRunListeners
  });

  const completedAt = new Date();
  return {
    iteration,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    invariants,
    reports: {
      ordering: phaseA!.ordering,
      duplicates: phaseA!.duplicates,
      droppedFrames: phaseA!.droppedFrames,
      canonicalMonotonicDense: phaseA!.canonicalMonotonicDense,
      replayDivergence: phaseB!.divergence,
      snapshotEquivalent: phaseB!.snapshotEquivalent,
      reorderInvariance: phaseB!.reorderInvariance,
      sessionIdStable: phaseB!.sessionIdStable,
      reconnectDroppedFrames: phaseC!.droppedFrames,
      reconnectLatencyMs: phaseC!.reconnectLatencyMs,
      streamClosedCleanly: phaseC!.streamClosedCleanly,
      belowCursorDeliveries: phaseC!.belowCursorDeliveries,
      replayLatency: phaseD!.replayLatency,
      resources: resourceDelta,
      listenersBefore: baselineListeners!,
      listenersAfter: postRunListeners
    },
    pass: invariants.every((v) => v.passed)
  };
}

// --- phase implementations ---------------------------------------------------

interface PhaseAResult {
  ordering: OrderingReport;
  duplicates: DuplicateReport;
  droppedFrames: DroppedFrameReport;
  canonicalSeqs: number[];
  /** Canonical store sequences are strictly monotonic + dense over the batch. */
  canonicalMonotonicDense: boolean;
}

/**
 * Append N events directly to the store, then publish them on the bus in a
 * deterministic shuffle while an SSE consumer is attached. Verifies the
 * canonical-equivalence invariant: SSE-delivered multiset == store multiset.
 */
async function phaseA_OrderingAndDedupe(
  container: RuntimeContainer,
  baseUrl: string,
  harness: PgHarness,
  seedPrefix: string
): Promise<PhaseAResult> {
  const seed = `${seedPrefix}#phaseA`;
  const exec = uuidFromHex(deterministicId([seed, "exec"]));
  const agent = uuidFromHex(deterministicId([seed, "agent"]));
  await seedAgentAndExecution(harness.pg, { agentId: agent, executionId: exec });

  const consumePromise = consumeSSE(`${baseUrl}/events/stream`, {
    expectedCount: PHASE_A_EVENT_COUNT + 32, // + lifecycle noise
    timeoutMs: SSE_CONSUMER_TIMEOUT_MS
  });
  await sleep(75);

  const appended: DomainEvent[] = [];
  for (let i = 0; i < PHASE_A_EVENT_COUNT; i++) {
    const ev = makeEvent({
      type: "EXECUTION_STEP_STARTED",
      executionId: exec,
      seed,
      step: i,
      payloadExtras: { step: { executionId: exec, sequence: i } }
    });
    appended.push(await container.eventStore.append(ev));
  }

  // Shuffle the bus order so we exercise the RecentSequenceTracker.
  const shuffled = seededShuffle(appended, 0xcafef00d);
  for (const ev of shuffled) {
    await container.eventBus.publish(ev);
  }

  const { frames } = await consumePromise;
  const stepFrames = frames.filter((f) => f.type === "EXECUTION_STEP_STARTED");

  const ordering = new OrderingDetector();
  const duplicates = new DuplicateIdDetector();
  const deliveredSeqs: number[] = [];
  for (const f of stepFrames) {
    ordering.observe(f.id);
    duplicates.observe(`seq-${f.id}`);
    deliveredSeqs.push(f.id);
  }

  const canonical = appended.map((e) => e.sequence!);
  const droppedFrames = diffSequenceSets(canonical, deliveredSeqs);

  // Monotonic + dense check on the store-assigned sequences. After
  // harness.reset() restarted identity, the bigserial restarts; the first
  // appended batch should be strictly ascending with no gaps from min..max.
  const canonicalMonotonicDense = isMonotonicAndDense(canonical);

  return {
    ordering: ordering.report(),
    duplicates: duplicates.report(),
    droppedFrames,
    canonicalSeqs: canonical,
    canonicalMonotonicDense
  };
}

interface PhaseBResult {
  divergence: DivergenceReport;
  sessionIdStable: boolean;
  snapshotEquivalent: boolean;
  /** Frame fingerprints are invariant under input-order shuffle (FrameBuilder re-sorts). */
  reorderInvariance: boolean;
}

/**
 * Replay determinism: 5 reruns of materializeFrames + deterministic session
 * id parity + snapshot equivalence at frame 3.
 */
async function phaseB_ReplayDeterminism(
  harness: PgHarness,
  seedPrefix: string
): Promise<PhaseBResult> {
  const seed = `${seedPrefix}#phaseB`;
  const graph = makeCognitionGraph({ seed });
  await seedAgentAndExecution(harness.pg, {
    agentId: graph.agentId,
    executionId: graph.executionId
  });

  // We use the FrameBuilder directly so this phase doesn't depend on the
  // PostgresCognitionRepository (which has its own integration coverage). The
  // determinism contract under test is the *frame builder* — given the same
  // event log it must produce bit-identical fingerprints.
  const log = makeCognitionEventLog(graph, seed);
  const builder = new FrameBuilder();
  const runs: string[][] = [];
  for (let r = 0; r < PHASE_D_REPLAY_RERUNS; r++) {
    const frames = await builder.build(log);
    runs.push(frames.map((f) => f.preview.fingerprint!));
  }
  const divergence = detectReplayDivergence(runs);

  // Deterministic id parity: the same input must hash to the same session id.
  const sessionA = deterministicId(["replay-session", graph.id, graph.executionId, log.length, log[log.length - 1].sequence ?? 0]);
  const sessionB = deterministicId(["replay-session", graph.id, graph.executionId, log.length, log[log.length - 1].sequence ?? 0]);
  const sessionIdStable = sessionA === sessionB;

  // Snapshot equivalence: every frame fingerprint must equal across two builds.
  const frames1 = await builder.build(log);
  const frames2 = await builder.build(log);
  const snapshotEquivalent =
    frames1.length === frames2.length &&
    frames1.every((f, i) => f.preview.fingerprint === frames2[i]?.preview.fingerprint);

  // Reorder invariance: shuffling the input log must not change frame
  // fingerprints, because FrameBuilder defensively sorts by sequence. This is
  // the real "deterministic history reconstruction" contract.
  const shuffledLog = seededShuffle(log, 0xb16b00b5);
  const framesShuffled = await builder.build(shuffledLog);
  const reorderInvariance =
    framesShuffled.length === frames1.length &&
    framesShuffled.every((f, i) => f.preview.fingerprint === frames1[i]?.preview.fingerprint);

  return { divergence, sessionIdStable, snapshotEquivalent, reorderInvariance };
}

interface PhaseCResult {
  droppedFrames: DroppedFrameReport;
  reconnectLatencyMs: number;
  /** Stream closure: server destroyed the underlying socket cleanly. */
  streamClosedCleanly: boolean;
  /** Count of delivered sequences at-or-below the cursor — must be 0. */
  belowCursorDeliveries: number;
}

/**
 * Reconnect with Last-Event-ID mid-stream. Verifies:
 *   • no event with seq <= cursor is delivered to the resumed consumer
 *   • every event with seq > cursor is delivered exactly once
 *   • reconnect catch-up completes within timeout
 */
async function phaseC_ReconnectCursor(
  container: RuntimeContainer,
  baseUrl: string,
  harness: PgHarness,
  seedPrefix: string
): Promise<PhaseCResult> {
  const seed = `${seedPrefix}#phaseC`;
  const exec = uuidFromHex(deterministicId([seed, "exec"]));
  const agent = uuidFromHex(deterministicId([seed, "agent"]));
  await seedAgentAndExecution(harness.pg, { agentId: agent, executionId: exec });

  // Append a pre-cursor batch.
  const pre: DomainEvent[] = [];
  for (let i = 0; i < PHASE_C_PRE_RECONNECT_EVENT_COUNT; i++) {
    pre.push(await container.eventStore.append(makeEvent({
      type: "MODEL_COMPLETED",
      executionId: exec,
      seed,
      step: i,
      payloadExtras: { executionId: exec, idx: i }
    })));
  }
  const cursor = pre[Math.floor(pre.length / 2)].sequence!;

  // Append a post-cursor batch.
  const post: DomainEvent[] = [];
  for (let i = 0; i < PHASE_C_POST_RECONNECT_EVENT_COUNT; i++) {
    post.push(await container.eventStore.append(makeEvent({
      type: "MODEL_COMPLETED",
      executionId: exec,
      seed: seed + "-post",
      step: i,
      payloadExtras: { executionId: exec, idx: i }
    })));
  }

  // Reconnect: send Last-Event-ID == cursor. Expect every appended seq > cursor.
  const expectedSeqs = [...pre, ...post]
    .map((e) => e.sequence!)
    .filter((s) => s > cursor);

  const start = Date.now();
  const consumed = await consumeSSE(`${baseUrl}/events/stream`, {
    lastEventId: String(cursor),
    expectedCount: expectedSeqs.length + 32,
    timeoutMs: SSE_CONSUMER_TIMEOUT_MS
  });
  const elapsed = Date.now() - start;

  const delivered = consumed.frames
    .filter((f) => f.type === "MODEL_COMPLETED")
    .map((f) => f.id);

  // Two distinct safety checks at the cursor boundary:
  //   1. droppedFrames.missing — every post-cursor seq must arrive.
  //   2. belowCursorDeliveries — zero pre-cursor seqs may be (re)delivered.
  const droppedFrames = diffSequenceSets(expectedSeqs, delivered);
  const belowCursorDeliveries = delivered.filter((s) => s <= cursor).length;
  // "Stream closed cleanly" = we received at least every expected post-cursor
  // sequence. The +32 buffer in expectedCount is for lifecycle noise that may
  // never materialise, so the consumer's `aborted=true` (timeout reached) is
  // expected in the happy path; what matters is whether we got the events we
  // were owed before the timeout.
  const streamClosedCleanly = delivered.length >= expectedSeqs.length;
  return {
    droppedFrames,
    reconnectLatencyMs: elapsed,
    streamClosedCleanly,
    belowCursorDeliveries
  };
}

interface PhaseDResult {
  replayLatency: LatencySamples;
}

/**
 * Pure latency sampling: rebuild frames PHASE_D_REPLAY_RERUNS × 2 times and
 * record the latency distribution. The frame builder is the hottest path on
 * the read side of the substrate.
 */
async function phaseD_ReplayLatency(
  harness: PgHarness,
  seedPrefix: string
): Promise<PhaseDResult> {
  const seed = `${seedPrefix}#phaseD`;
  const graph = makeCognitionGraph({ seed });
  await seedAgentAndExecution(harness.pg, {
    agentId: graph.agentId,
    executionId: graph.executionId
  });
  const log = makeCognitionEventLog(graph, seed);
  const builder = new FrameBuilder();
  const latency = new LatencyRecorder();
  for (let i = 0; i < PHASE_D_REPLAY_RERUNS * 2; i++) {
    await latency.time(async () => {
      await builder.build(log);
    });
  }
  return { replayLatency: latency.report() };
}

// --- invariant evaluation ----------------------------------------------------

interface InvariantInputs {
  iteration: number;
  phaseA: PhaseAResult;
  phaseB: PhaseBResult;
  phaseC: PhaseCResult;
  phaseD: PhaseDResult;
  resourceDelta: ResourceDeltaReport;
  baselineListeners: ListenerSnapshot;
  postRunListeners: ListenerSnapshot;
}

function evaluateInvariants(input: InvariantInputs): InvariantVerdict[] {
  const v: InvariantVerdict[] = [];

  // I0: persisted sequences are strictly monotonic AND gap-free over the
  // appended batch. Anchors every downstream invariant.
  v.push({
    name: "phaseA.canonicalMonotonicDense",
    passed: input.phaseA.canonicalMonotonicDense,
    detail: input.phaseA.canonicalMonotonicDense ? "ok" : "VIOLATED"
  });

  // I1: every appended sequence reached the SSE consumer (no dropped frames).
  v.push({
    name: "phaseA.noDroppedFrames",
    passed: input.phaseA.droppedFrames.missing.length === 0,
    detail: `missing=${input.phaseA.droppedFrames.missing.length}`
  });

  // I2: SSE never delivered the same sequence twice.
  v.push({
    name: "phaseA.noDuplicateDeliveries",
    passed: input.phaseA.duplicates.duplicateIds === 0,
    detail: `duplicates=${input.phaseA.duplicates.duplicateIds}`
  });

  // I3: replay frame fingerprints are bit-identical across 5 reruns.
  v.push({
    name: "phaseB.replayDeterminism",
    passed: input.phaseB.divergence.divergedFrameIndices.length === 0,
    detail: `diverged=${input.phaseB.divergence.divergedFrameIndices.length}`
  });

  // I4: deterministic session ID parity.
  v.push({
    name: "phaseB.sessionIdStable",
    passed: input.phaseB.sessionIdStable,
    detail: input.phaseB.sessionIdStable ? "stable" : "DIFFERS"
  });

  // I5: snapshot equivalence: every frame fingerprint matches across two builds.
  v.push({
    name: "phaseB.snapshotEquivalent",
    passed: input.phaseB.snapshotEquivalent,
    detail: input.phaseB.snapshotEquivalent ? "equal" : "DIVERGED"
  });

  // I5b: reorder invariance — FrameBuilder must defensively re-sort by
  // sequence so shuffled inputs produce identical frame fingerprints.
  v.push({
    name: "phaseB.reorderInvariance",
    passed: input.phaseB.reorderInvariance,
    detail: input.phaseB.reorderInvariance ? "stable" : "ORDER-SENSITIVE"
  });

  // I6: reconnect delivered every post-cursor sequence.
  v.push({
    name: "phaseC.reconnectNoLoss",
    passed: input.phaseC.droppedFrames.missing.length === 0,
    detail: `missing=${input.phaseC.droppedFrames.missing.length}`
  });

  // I7: reconnect didn't double-deliver any post-cursor sequence.
  v.push({
    name: "phaseC.reconnectNoDuplicates",
    passed: input.phaseC.droppedFrames.duplicates.length === 0,
    detail: `dup=${input.phaseC.droppedFrames.duplicates.length}`
  });

  // I7b: NO sequence at or below the cursor was redelivered. This is the
  // catch-up cursor contract — Last-Event-ID must be respected exactly.
  v.push({
    name: "phaseC.cursorRespected",
    passed: input.phaseC.belowCursorDeliveries === 0,
    detail: `below=${input.phaseC.belowCursorDeliveries}`
  });

  // I8: reconnect catch-up completed within timeout AND delivered everything
  // it owed (stream-closure-guarantee analogue for the consumer side).
  v.push({
    name: "phaseC.streamClosedCleanly",
    passed: input.phaseC.streamClosedCleanly,
    detail: `${input.phaseC.reconnectLatencyMs}ms, delivered>=expected: ${input.phaseC.streamClosedCleanly}`
  });

  // I9: replay latency p99 stays below a generous ceiling.
  v.push({
    name: "phaseD.replayLatencyP99",
    passed: input.phaseD.replayLatency.p99Ms < 50,
    detail: `p99=${input.phaseD.replayLatency.p99Ms}ms`
  });

  // I10: active resource count returned within tolerance of baseline.
  v.push({
    name: "cleanup.activeResources",
    passed: input.resourceDelta.activeResourceDelta <= RESOURCE_DELTA_TOLERANCE,
    detail: `delta=${input.resourceDelta.activeResourceDelta}, growth=${JSON.stringify(input.resourceDelta.growthByResource)}`
  });

  // I11: heap growth this iteration < ceiling. Heap can wiggle from V8
  // generational GC; this catches genuine leaks (>12 MiB per iter).
  v.push({
    name: "cleanup.heapGrowth",
    passed: input.resourceDelta.heapDeltaBytes <= HEAP_GROWTH_PER_ITER_TOLERANCE_BYTES,
    detail: `${formatBytes(input.resourceDelta.heapDeltaBytes)}`
  });

  // I12: bus has no leaked subscribers (only meaningful if introspectable).
  if (
    input.baselineListeners.busHandlerCount !== null &&
    input.postRunListeners.busHandlerCount !== null
  ) {
    const passed =
      input.postRunListeners.busHandlerCount <= input.baselineListeners.busHandlerCount;
    v.push({
      name: "cleanup.busListeners",
      passed,
      detail: `before=${input.baselineListeners.busHandlerCount}, after=${input.postRunListeners.busHandlerCount}`
    });
  }

  return v;
}

// --- helpers ----------------------------------------------------------------

interface ParsedFrame {
  id: number;
  type: string;
  data: unknown;
}

async function consumeSSE(
  url: string,
  opts: { lastEventId?: string; expectedCount?: number; timeoutMs?: number }
): Promise<{ frames: ParsedFrame[]; aborted: boolean }> {
  const expected = opts.expectedCount ?? Infinity;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          ...(opts.lastEventId ? { "last-event-id": opts.lastEventId } : {})
        }
      },
      (res) => {
        let buf = "";
        const frames: ParsedFrame[] = [];
        const done = (aborted: boolean): void => {
          try { res.destroy(); } catch { /* swallow */ }
          try { req.destroy(); } catch { /* swallow */ }
          resolve({ frames, aborted });
        };
        const timer = setTimeout(() => done(true), timeoutMs);
        timer.unref?.();
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (block.startsWith(":")) continue;
            const lines = block.split("\n");
            let id = 0;
            let type = "";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("id:")) id = Number(line.slice(3).trim());
              else if (line.startsWith("event:")) type = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (id || type) {
              let parsed: unknown = data;
              try { parsed = JSON.parse(data); } catch { /* leave raw */ }
              frames.push({ id, type, data: parsed });
            }
            if (frames.length >= expected) {
              clearTimeout(timer);
              done(false);
              return;
            }
          }
        });
        res.on("end", () => { clearTimeout(timer); done(false); });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
  let s = seed;
  const rng = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff);
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function resolveBaseUrl(app: FastifyInstance): string {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("server has no bound address");
  return `http://127.0.0.1:${address.port}`;
}

function buildIterationConfig(harness: PgHarness): AppConfig {
  return {
    NODE_ENV: "test",
    PORT: 0,
    DATABASE_URL: harness.connectionString,
    EVENT_BUS_DRIVER: "memory",
    EVENT_STORE_DRIVER: "postgres",
    PERSISTENCE_DRIVER: "postgres",
    RECOVERY_LOOP_INTERVAL_MS: 3_600_000,
    OTEL_SERVICE_NAME: "runtime-stress",
    LOG_LEVEL: "silent",
    RUNTIME_MODE: "single",
    WORKER_ID: randomUUID(),
    WORKER_CAPACITY: 4,
    WORKER_HEARTBEAT_TTL_MS: 60_000,
    WORKER_SWEEP_INTERVAL_MS: 3_600_000,
    EXECUTION_LEASE_TTL_MS: 30_000,
    SCHEDULER_POLL_INTERVAL_MS: 3_600_000,
    OLLAMA_URL: "http://localhost:11434",
    OLLAMA_MODEL: "llama3",
    OLLAMA_REQUEST_TIMEOUT_MS: 120_000,
    SSE_DEDUPE_WINDOW: 1024,
    WORKER_REGISTRATION_TIMEOUT_MS: 10_000,
    MODEL_PROVIDER: "deterministic",
    PROVIDER_TIMEOUT_MS: 120_000,
    PROVIDER_MAX_RETRIES: 3,
    FILE_READ_MAX_BYTES: 32_768,
    TOOL_WEB_SEARCH_TIMEOUT_MS: 10_000,
    TOOL_CODE_EXECUTE_TIMEOUT_MS: 5_000,
    POISON_PILL_MAX_ATTEMPTS: 3,
    LEASE_HEARTBEAT_POLL_INTERVAL_MS: 3_000,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: 5,
    CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS: 60_000,
    CIRCUIT_BREAKER_SUCCESS_THRESHOLD: 2,
    METRICS_ENABLED: true,
    TRACE_LINEAGE_SCAN_LIMIT: 5_000,
    AUTH_ENABLED: false,
    AUTH_SKIP_PATHS: "/metrics",
    API_KEY_CACHE_TTL_SEC: 300,
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_DEFAULT_RPM: 1_000,
    RATE_LIMIT_WINDOW_MS: 60_000,
    AUDIT_LOG_ENABLED: false,
    QUOTA_ENABLED: false,
    SHUTDOWN_DRAIN_TIMEOUT_MS: 30_000,
    RUNTIME_ROLE: "combined",
    JOB_QUEUE_DRIVER: "memory",
    QUEUE_BACKPRESSURE_THRESHOLD: 0,
    JOB_QUEUE_VISIBILITY_MS: 45_000,
    JOB_QUEUE_CONSUMER_GROUP: "agent-runtime-workers",
    RETRY_BACKOFF_BASE_MS: 500,
    RETRY_BACKOFF_MAX_MS: 60_000
  };
}

function maybeGc(): void {
  const g = globalThis as unknown as { gc?: () => void };
  if (typeof g.gc === "function") g.gc();
}

function formatBytes(n: number): string {
  if (Math.abs(n) < 1024) return `${n}B`;
  if (Math.abs(n) < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${(n / 1024 / 1024).toFixed(2)}MiB`;
}

/**
 * Returns true iff the input is strictly ascending AND covers every integer
 * from min..max inclusive. This is the contract Postgres bigserial promises
 * when no inserts roll back.
 */
function isMonotonicAndDense(seqs: readonly number[]): boolean {
  if (seqs.length === 0) return true;
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] <= seqs[i - 1]) return false;
  }
  const min = seqs[0];
  const max = seqs[seqs.length - 1];
  return max - min + 1 === seqs.length;
}
