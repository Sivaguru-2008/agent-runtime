/**
 * Sprint Hardening 3 — SSE concurrency stress.
 *
 * Re-runs the four sseOutOfOrder chaos scenarios 20 times each, inside a
 * SINGLE vitest invocation against a SINGLE Postgres container (the harness
 * truncates between iterations via afterEach). Goal: flush out non-
 * determinism that survives more than one shot — bus-handler ordering,
 * publish() interleaving, dedupe-window eviction, pg pool reuse.
 *
 * Invariants asserted per iteration:
 *   I1. Monotonic sequence ordering — every event in the canonical store
 *       carries a strictly-increasing `sequence`. (Trivially true by
 *       bigserial, but we assert observationally to detect any future
 *       gap-filling bug.)
 *   I2. No duplicate event IDs — UUIDs are assigned at event creation and
 *       must survive the round trip without collision or replay.
 *   I3. Replay/live parity — for the same execution, the multiset of
 *       sequences delivered on the SSE wire must equal the multiset of
 *       sequences in the canonical event store.
 *   I4. Deterministic canonical history — `listAfterSequence(0)` returns
 *       events ordered strictly by sequence, regardless of the bus
 *       publish order. (The bus shuffles; the store does not.)
 *
 * If 20 iterations of all four scenarios pass cleanly, the SSE substrate
 * is correct under the chaos signal we know to test for. Anything that
 * survives this is either (a) a deeper architectural concern, or (b) a
 * race we have not yet imagined.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../../src/app.js";
import type { AppConfig } from "../../../src/shared/config.js";
import { tryStartHarness } from "./harness.js";
import { sleep } from "./concurrency.js";
import { makeEvent, seedAgentAndExecution, suiteSeed, uuidFromHex } from "./factories.js";
import { deterministicId } from "../../../src/shared/determinism.js";
import type { DomainEvent } from "../../../src/domain/events.js";

const harness = await tryStartHarness();
const ITERATIONS = Number(process.env.SSE_STRESS_ITERATIONS ?? 20);

function buildConfig(): AppConfig {
  return {
    NODE_ENV: "test",
    PORT: 0,
    DATABASE_URL: harness!.connectionString,
    EVENT_BUS_DRIVER: "memory",
    EVENT_STORE_DRIVER: "postgres",
    PERSISTENCE_DRIVER: "postgres",
    RECOVERY_LOOP_INTERVAL_MS: 3_600_000,
    OTEL_SERVICE_NAME: "sse-stress",
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

afterEach(async () => {
  if (harness) await harness.reset();
});

afterAll(async () => {
  if (harness) await harness.stop();
});

interface ParsedFrame {
  id: number;
  type: string;
  data: { id: string };
}

async function consumeSSE(url: string, opts: {
  expectedCount?: number;
  timeoutMs?: number;
}): Promise<{ frames: ParsedFrame[] }> {
  const expected = opts.expectedCount ?? Infinity;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: "GET",
      headers: { accept: "text/event-stream" }
    }, (res) => {
      let buf = "";
      const frames: ParsedFrame[] = [];
      const done = () => {
        try { res.destroy(); } catch { /* swallow */ }
        try { req.destroy(); } catch { /* swallow */ }
        resolve({ frames });
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (block.startsWith(":")) continue;
          const lines = block.split("\n");
          let id = 0, type = "", data = "";
          for (const line of lines) {
            if (line.startsWith("id:")) id = Number(line.slice(3).trim());
            else if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (id || type) {
            let parsed: { id: string } = { id: "" };
            try { parsed = JSON.parse(data) as { id: string }; } catch { /* leave default */ }
            frames.push({ id, type, data: parsed });
          }
          if (frames.length >= expected) {
            clearTimeout(timer);
            done();
            return;
          }
        }
      });
      res.on("end", () => { clearTimeout(timer); done(); });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  let s = seed;
  const rng = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) / 0xffffffff);
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface ContainerHandle {
  eventStore: {
    append(e: DomainEvent): Promise<DomainEvent>;
    listAfterSequence(after: number, limit: number): Promise<DomainEvent[]>;
  };
  eventBus: { publish(e: DomainEvent): Promise<void> };
}

function getContainer(app: import("fastify").FastifyInstance): ContainerHandle {
  return (app as unknown as { runtimeContainer: ContainerHandle }).runtimeContainer;
}

/**
 * Core invariant battery — applied to every iteration of every scenario.
 *
 *  `delivered` is the list of SSE frames received (matching the test type).
 *  `appended`  is the canonical list of events from the event store
 *              (already filtered to the same type, ordered by sequence).
 *
 *  Returns an `{ok: true} | {ok: false, reason}` so the caller can build
 *  iteration-tagged assertion messages without losing the failing case.
 */
interface InvariantReport {
  ok: boolean;
  reason?: string;
  deliveredCount: number;
  canonicalCount: number;
  duplicates: number;
  missing: number[];
  unexpected: number[];
}

function checkInvariants(delivered: ParsedFrame[], canonical: DomainEvent[]): InvariantReport {
  const deliveredSeqs = delivered.map((f) => f.id);
  const canonicalSeqs = canonical.map((e) => e.sequence!).sort((a, b) => a - b);

  // I1. Canonical store is monotonic.
  for (let i = 1; i < canonicalSeqs.length; i++) {
    if (canonicalSeqs[i] <= canonicalSeqs[i - 1]) {
      return {
        ok: false,
        reason: `I1 monotonic store violated at canonical index ${i}: ${canonicalSeqs[i - 1]} -> ${canonicalSeqs[i]}`,
        deliveredCount: delivered.length,
        canonicalCount: canonical.length,
        duplicates: 0,
        missing: [],
        unexpected: []
      };
    }
  }

  // I2. No duplicate event UUIDs in the delivered stream.
  const deliveredIds = delivered.map((f) => f.data.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  const idSet = new Set(deliveredIds);
  const duplicateCount = deliveredIds.length - idSet.size;

  // I2b. No duplicate sequence ids in the delivered stream.
  const seqSet = new Set(deliveredSeqs);
  const duplicateSeq = deliveredSeqs.length - seqSet.size;

  // I3. Multiset parity: every canonical seq is delivered, every delivered
  // seq is canonical.
  const canonicalSet = new Set(canonicalSeqs);
  const missing = canonicalSeqs.filter((s) => !seqSet.has(s));
  const unexpected = deliveredSeqs.filter((s) => !canonicalSet.has(s));

  // I4. Re-check that the canonical sort equals the canonical's
  // sort-by-sequence — this is sanity that the store gave us back what we
  // think it did, regardless of how the bus shuffled the publish order.
  const sortedDelivered = deliveredSeqs.slice().sort((a, b) => a - b);
  const canonicalEquivalent =
    sortedDelivered.length === canonicalSeqs.length &&
    sortedDelivered.every((s, i) => s === canonicalSeqs[i]);

  if (duplicateCount !== 0 || duplicateSeq !== 0) {
    return {
      ok: false,
      reason: `I2 duplicates: ${duplicateCount} duplicate UUIDs, ${duplicateSeq} duplicate sequences`,
      deliveredCount: delivered.length,
      canonicalCount: canonical.length,
      duplicates: duplicateCount + duplicateSeq,
      missing,
      unexpected
    };
  }
  if (missing.length || unexpected.length) {
    return {
      ok: false,
      reason: `I3 parity: missing=${JSON.stringify(missing.slice(0, 10))}, unexpected=${JSON.stringify(unexpected.slice(0, 10))}`,
      deliveredCount: delivered.length,
      canonicalCount: canonical.length,
      duplicates: 0,
      missing,
      unexpected
    };
  }
  if (!canonicalEquivalent) {
    return {
      ok: false,
      reason: `I4 canonical-equivalence: sort(delivered) != canonical`,
      deliveredCount: delivered.length,
      canonicalCount: canonical.length,
      duplicates: 0,
      missing: [],
      unexpected: []
    };
  }
  return {
    ok: true,
    deliveredCount: delivered.length,
    canonicalCount: canonical.length,
    duplicates: 0,
    missing: [],
    unexpected: []
  };
}

async function runShuffledScenario(app: import("fastify").FastifyInstance, baseUrl: string, container: ContainerHandle, exec: string, seed: string, iter: number): Promise<InvariantReport> {
  const consumePromise = consumeSSE(`${baseUrl}/events/stream`, {
    expectedCount: 60,
    timeoutMs: 5_000
  });
  await sleep(40);
  const N = 30;
  const appended: DomainEvent[] = [];
  for (let i = 0; i < N; i++) {
    const ev = makeEvent({
      type: "EXECUTION_STEP_STARTED",
      executionId: exec, seed: `${seed}-iter${iter}`, step: i,
      payloadExtras: { step: { executionId: exec, sequence: i } }
    });
    appended.push(await container.eventStore.append(ev));
  }
  // Different shuffle seed per iteration so we sweep through orderings.
  const shuffled = seededShuffle(appended, 0xdeadbeef + iter * 7919);
  for (const ev of shuffled) {
    await container.eventBus.publish(ev);
  }
  const { frames } = await consumePromise;
  const delivered = frames.filter((f) => f.type === "EXECUTION_STEP_STARTED");
  return checkInvariants(delivered, appended);
}

async function runDuplicatePublishScenario(app: import("fastify").FastifyInstance, baseUrl: string, container: ContainerHandle, exec: string, seed: string, iter: number): Promise<InvariantReport> {
  const consumePromise = consumeSSE(`${baseUrl}/events/stream`, {
    expectedCount: 30,
    timeoutMs: 4_000
  });
  await sleep(30);
  const ev = makeEvent({
    type: "MODEL_COMPLETED",
    executionId: exec, seed: `${seed}-dup-iter${iter}`, step: 0,
    payloadExtras: { executionId: exec, idx: iter }
  });
  const appended = await container.eventStore.append(ev);
  // Publish the same event three times — simulates publisher retry.
  await container.eventBus.publish(appended);
  await container.eventBus.publish(appended);
  await container.eventBus.publish(appended);
  const { frames } = await consumePromise;
  const delivered = frames.filter(
    (f) => f.type === "MODEL_COMPLETED" && f.id === appended.sequence
  );
  return checkInvariants(delivered, [appended]);
}

async function runConcurrentAppendersScenario(app: import("fastify").FastifyInstance, baseUrl: string, container: ContainerHandle, exec: string, seed: string, iter: number): Promise<InvariantReport> {
  const consumePromise = consumeSSE(`${baseUrl}/events/stream`, {
    expectedCount: 80,
    timeoutMs: 7_000
  });
  await sleep(50);
  const N = 50;
  const tasks = Array.from({ length: N }, (_, i) => async () => {
    const ev = makeEvent({
      type: "EXECUTION_STEP_STARTED",
      executionId: exec, seed: `${seed}-conc-iter${iter}`, step: i,
      payloadExtras: { step: { executionId: exec, sequence: i } }
    });
    const appended = await container.eventStore.append(ev);
    await container.eventBus.publish(appended);
    return appended;
  });
  const appended = await Promise.all(tasks.map((fn) => fn()));
  const { frames } = await consumePromise;
  const delivered = frames.filter((f) => f.type === "EXECUTION_STEP_STARTED");
  return checkInvariants(delivered, appended);
}

async function runCanonicalEquivalenceScenario(app: import("fastify").FastifyInstance, baseUrl: string, container: ContainerHandle, exec: string, seed: string, iter: number): Promise<InvariantReport> {
  const consumePromise = consumeSSE(`${baseUrl}/events/stream`, {
    expectedCount: 50,
    timeoutMs: 5_000
  });
  await sleep(40);
  const N = 25;
  const appended: DomainEvent[] = [];
  for (let i = 0; i < N; i++) {
    const ev = makeEvent({
      type: "EXECUTION_STEP_STARTED",
      executionId: exec, seed: `${seed}-canon-iter${iter}`, step: i,
      payloadExtras: { step: { executionId: exec, sequence: i } }
    });
    appended.push(await container.eventStore.append(ev));
  }
  // Distinct shuffle seed than the "shuffled" scenario so we cover a
  // different ordering space.
  const shuffled = seededShuffle(appended, 0xfeedbeef ^ (iter * 104729));
  for (const ev of shuffled) {
    await container.eventBus.publish(ev);
  }
  const { frames } = await consumePromise;
  const delivered = frames.filter((f) => f.type === "EXECUTION_STEP_STARTED");

  // Additional I4 check on the canonical side itself: the store must give
  // us back the events strictly sorted by sequence, regardless of the bus
  // ordering. Fetch from the store and confirm.
  const fromStore = await container.eventStore.listAfterSequence(0, 1000);
  const storeSorted = [...fromStore].filter((e) => e.type === "EXECUTION_STEP_STARTED").map((e) => e.sequence!);
  for (let i = 1; i < storeSorted.length; i++) {
    if (storeSorted[i] <= storeSorted[i - 1]) {
      return {
        ok: false,
        reason: `I4 store ordering violated at index ${i}: ${storeSorted[i - 1]} -> ${storeSorted[i]}`,
        deliveredCount: delivered.length,
        canonicalCount: appended.length,
        duplicates: 0,
        missing: [],
        unexpected: []
      };
    }
  }
  return checkInvariants(delivered, appended);
}

describe.skipIf(!harness)(`/events/stream — ${ITERATIONS}x stress`, () => {
  for (let iter = 0; iter < ITERATIONS; iter++) {
    it(`iteration ${iter + 1}: shuffled bus order delivers all sequences`, async () => {
      const seed = suiteSeed(`stress-shuffled-${iter}`);
      const exec = uuidFromHex(deterministicId([seed, "exec"]));
      const agent = uuidFromHex(deterministicId([seed, "agent"]));
      await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
      const app = await buildApp(buildConfig());
      try {
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const container = getContainer(app);
        const report = await runShuffledScenario(app, baseUrl, container, exec, seed, iter);
        expect(report.ok, report.reason ?? "shuffle invariant violated").toBe(true);
      } finally {
        await app.close();
      }
    }, 30_000);

    it(`iteration ${iter + 1}: duplicate publish is suppressed`, async () => {
      const seed = suiteSeed(`stress-dup-${iter}`);
      const exec = uuidFromHex(deterministicId([seed, "exec"]));
      const agent = uuidFromHex(deterministicId([seed, "agent"]));
      await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
      const app = await buildApp(buildConfig());
      try {
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const container = getContainer(app);
        const report = await runDuplicatePublishScenario(app, baseUrl, container, exec, seed, iter);
        expect(report.ok, report.reason ?? "duplicate suppression invariant violated").toBe(true);
      } finally {
        await app.close();
      }
    }, 30_000);

    it(`iteration ${iter + 1}: 50 concurrent appenders delivered exactly once`, async () => {
      const seed = suiteSeed(`stress-concurrent-${iter}`);
      const exec = uuidFromHex(deterministicId([seed, "exec"]));
      const agent = uuidFromHex(deterministicId([seed, "agent"]));
      await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
      const app = await buildApp(buildConfig());
      try {
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const container = getContainer(app);
        const report = await runConcurrentAppendersScenario(app, baseUrl, container, exec, seed, iter);
        expect(report.ok, report.reason ?? "concurrent appender invariant violated").toBe(true);
      } finally {
        await app.close();
      }
    }, 45_000);

    it(`iteration ${iter + 1}: canonical equivalence holds`, async () => {
      const seed = suiteSeed(`stress-canonical-${iter}`);
      const exec = uuidFromHex(deterministicId([seed, "exec"]));
      const agent = uuidFromHex(deterministicId([seed, "agent"]));
      await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
      const app = await buildApp(buildConfig());
      try {
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const container = getContainer(app);
        const report = await runCanonicalEquivalenceScenario(app, baseUrl, container, exec, seed, iter);
        expect(report.ok, report.reason ?? "canonical equivalence invariant violated").toBe(true);
      } finally {
        await app.close();
      }
    }, 30_000);
  }
});
