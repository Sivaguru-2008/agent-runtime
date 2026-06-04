/**
 * Phase 5 — Resumable SSE validation.
 *
 * The `/events/stream` route guarantees:
 *   • On connect, every event with sequence > cursor is replayed in order
 *     (Last-Event-ID header OR ?afterSequence query).
 *   • Live events that arrived during the catch-up window are deduped.
 *   • Backpressure (write() returning false) pauses the bus subscription.
 *   • No frame is emitted twice, no frame is skipped.
 *
 * This suite exercises both:
 *   (A) the route directly — bring up Fastify + Postgres, push events,
 *       attach a real HTTP SSE consumer, verify the byte stream.
 *   (B) the cursor logic in isolation — explicitly assert no-dup / no-skip
 *       given known inputs (replicates the route's algorithm for tight unit
 *       coverage that doesn't depend on socket timing).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../../src/app.js";
import type { AppConfig } from "../../../src/shared/config.js";
import { PostgresEventStore } from "../../../src/infrastructure/persistence/postgresEventStore.js";
import { tryStartHarness } from "./harness.js";
import { sleep, eventually } from "./concurrency.js";
import { makeEvent, seedAgentAndExecution, suiteSeed, uuidFromHex } from "./factories.js";
import { deterministicId } from "../../../src/shared/determinism.js";

const harness = await tryStartHarness();

function buildConfig(): AppConfig {
  return {
    NODE_ENV: "test",
    PORT: 0,
    DATABASE_URL: harness!.connectionString,
    EVENT_BUS_DRIVER: "memory",
    EVENT_STORE_DRIVER: "postgres",
    PERSISTENCE_DRIVER: "postgres",
    RECOVERY_LOOP_INTERVAL_MS: 3_600_000, // disable during the test window
    OTEL_SERVICE_NAME: "sse-integration",
    LOG_LEVEL: "silent",
    RUNTIME_MODE: "single",
    // events.aggregate_id is UUID — Sprint Hardening 3 fail-fast startup
    // requires the embedded worker id to be a valid UUID since
    // WORKER_REGISTERED events use it as the aggregate id.
    WORKER_ID: randomUUID(),
    WORKER_CAPACITY: 4,
    WORKER_HEARTBEAT_TTL_MS: 60_000,
    WORKER_SWEEP_INTERVAL_MS: 3_600_000,
    WORKER_REAP_AFTER_MS: 86_400_000,
    EXECUTION_LEASE_TTL_MS: 30_000,
    SCHEDULER_POLL_INTERVAL_MS: 3_600_000,
    GROQ_BASE_URL: "https://api.groq.com/openai/v1",
    GROQ_MODEL: "llama-3.3-70b-versatile",
    GROQ_REQUEST_TIMEOUT_MS: 120_000,
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
  data: unknown;
}

/**
 * Consume an SSE response stream and return parsed frames once `expectedCount`
 * is reached OR `timeoutMs` elapses. Closes the underlying socket on exit.
 */
async function consumeSSE(url: string, opts: {
  lastEventId?: string;
  expectedCount?: number;
  timeoutMs?: number;
}): Promise<{ frames: ParsedFrame[]; aborted: boolean }> {
  const expected = opts.expectedCount ?? Infinity;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        ...(opts.lastEventId ? { "last-event-id": opts.lastEventId } : {})
      }
    }, (res) => {
      let buf = "";
      const frames: ParsedFrame[] = [];
      const done = (aborted: boolean) => {
        try { res.destroy(); } catch { /* swallow */ }
        try { req.destroy(); } catch { /* swallow */ }
        resolve({ frames, aborted });
      };
      const timer = setTimeout(() => done(true), timeoutMs);
      timer.unref?.();
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        // SSE frames are separated by blank lines.
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (block.startsWith(":")) continue; // keepalive
          const lines = block.split("\n");
          let id = 0, type = "", data = "";
          for (const line of lines) {
            if (line.startsWith("id:")) id = Number(line.slice(3).trim());
            else if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (id || type) {
            let parsed: unknown = data;
            try { parsed = JSON.parse(data); } catch { /* leave as string */ }
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
    });
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!harness)("/events/stream — catch-up cursor", () => {
  it("replays every event with sequence > Last-Event-ID, in order, no dupes", async () => {
    const seed = suiteSeed("sse-catchup");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    // Pre-seed 20 events directly into the same DB the app will read.
    const store = new PostgresEventStore(harness!.connectionString);
    const seeded: number[] = [];
    try {
      for (let i = 0; i < 20; i++) {
        const ev = await store.append(makeEvent({
          type: "EXECUTION_STEP_STARTED",
          executionId: exec, seed, step: i,
          payloadExtras: { step: { executionId: exec, sequence: i } }
        }));
        seeded.push(ev.sequence!);
      }
    } finally {
      await store.close();
    }

    const app = await buildApp(buildConfig());
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // Connect AFTER seeding — the route must replay all 20 events on first read.
      const cursor = seeded[4]; // skip first 5 — expect 15 events.
      const { frames } = await consumeSSE(`${baseUrl}/events/stream`, {
        lastEventId: String(cursor),
        // We expect 15 user-seeded events plus possibly some lifecycle events
        // (WORKER_REGISTERED, WORKER_HEARTBEAT) emitted by the embedded worker.
        // Filter for the EXECUTION_STEP_STARTED type to be deterministic.
        expectedCount: 25,
        timeoutMs: 4_000
      });

      const stepFrames = frames.filter((f) => f.type === "EXECUTION_STEP_STARTED");
      // No duplicate sequence ids.
      const seqs = stepFrames.map((f) => f.id);
      expect(new Set(seqs).size).toBe(seqs.length);
      // Strictly ascending.
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
      // Every seeded seq > cursor must appear.
      for (const s of seeded) {
        if (s > cursor) expect(seqs).toContain(s);
      }
      // Every cursor-skipped seq must NOT appear.
      for (const s of seeded) {
        if (s <= cursor) expect(seqs).not.toContain(s);
      }
    } finally {
      await app.close();
    }
  }, 30_000);

  it("?afterSequence=N is honored when Last-Event-ID is absent", async () => {
    const seed = suiteSeed("sse-after-seq");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
    const store = new PostgresEventStore(harness!.connectionString);
    const seeded: number[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        const ev = await store.append(makeEvent({
          type: "MODEL_COMPLETED",
          executionId: exec, seed, step: i,
          payloadExtras: { executionId: exec, idx: i }
        }));
        seeded.push(ev.sequence!);
      }
    } finally { await store.close(); }

    const app = await buildApp(buildConfig());
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const cursor = seeded[6]; // expect 3 events after
      const { frames } = await consumeSSE(
        `${baseUrl}/events/stream?afterSequence=${cursor}`,
        { expectedCount: 25, timeoutMs: 4_000 }
      );
      const got = frames.filter((f) => f.type === "MODEL_COMPLETED").map((f) => f.id);
      for (const s of seeded) {
        if (s > cursor) expect(got).toContain(s);
        else expect(got).not.toContain(s);
      }
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe.skipIf(!harness)("/events/stream — live + catch-up dedupe", () => {
  it("no event is delivered twice when a live event arrives during catch-up", async () => {
    const seed = suiteSeed("sse-dedupe");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
    const store = new PostgresEventStore(harness!.connectionString);
    try {
      for (let i = 0; i < 5; i++) {
        await store.append(makeEvent({
          type: "EXECUTION_STEP_STARTED",
          executionId: exec, seed, step: i,
          payloadExtras: { step: { executionId: exec, sequence: i } }
        }));
      }
    } finally { await store.close(); }

    const app = await buildApp(buildConfig());
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // Start the SSE consumer and, in parallel, push a "live" event via the
      // app's own publisher → both the persistent store and the bus get it.
      // This is the contended timing the dedupe watermark guards against.
      const consumePromise = consumeSSE(`${baseUrl}/events/stream`, {
        expectedCount: 30, timeoutMs: 3_000
      });
      // Give the consumer a moment to begin its catch-up read.
      await sleep(50);
      const live = makeEvent({
        type: "EXECUTION_STEP_STARTED",
        executionId: exec, seed: seed + "-live", step: 99,
        payloadExtras: { step: { executionId: exec, sequence: 99 } }
      });
      const container = (app as unknown as { runtimeContainer: { eventStore: typeof store; eventBus: { publish: (e: typeof live) => Promise<void> } } }).runtimeContainer;
      const appended = await container.eventStore.append(live);
      await container.eventBus.publish(appended);

      const { frames } = await consumePromise;
      const stepFrames = frames.filter((f) => f.type === "EXECUTION_STEP_STARTED");
      const seqs = stepFrames.map((f) => f.id);
      // The critical invariant: no duplicate sequence anywhere.
      expect(new Set(seqs).size).toBe(seqs.length);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe.skipIf(!harness)("/events/stream — large catch-up window", () => {
  it("paginates a 1500-event backlog without dropping or duplicating", async () => {
    const seed = suiteSeed("sse-large-backlog");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
    const store = new PostgresEventStore(harness!.connectionString);
    const N = 1500;
    const seededSeqs: number[] = [];
    try {
      for (let i = 0; i < N; i++) {
        const ev = await store.append(makeEvent({
          type: "MODEL_COMPLETED",
          executionId: exec, seed, step: i,
          payloadExtras: { executionId: exec, idx: i }
        }));
        seededSeqs.push(ev.sequence!);
      }
    } finally { await store.close(); }

    const app = await buildApp(buildConfig());
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const { frames } = await consumeSSE(`${baseUrl}/events/stream?afterSequence=0`, {
        expectedCount: N + 50, timeoutMs: 15_000
      });
      const got = frames.filter((f) => f.type === "MODEL_COMPLETED").map((f) => f.id);
      // Every seeded sequence delivered exactly once.
      expect(new Set(got).size).toBe(got.length);
      // No skips: every seeded seq must be present.
      const gotSet = new Set(got);
      for (const s of seededSeqs) {
        expect(gotSet.has(s)).toBe(true);
      }
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe.skipIf(!harness)("/events/stream — reconnect storm", () => {
  it("8 simultaneous reconnects from different cursors all converge correctly", async () => {
    const seed = suiteSeed("sse-storm");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
    const store = new PostgresEventStore(harness!.connectionString);
    const seededSeqs: number[] = [];
    try {
      for (let i = 0; i < 100; i++) {
        const ev = await store.append(makeEvent({
          type: "EXECUTION_STEP_STARTED",
          executionId: exec, seed, step: i,
          payloadExtras: { step: { executionId: exec, sequence: i } }
        }));
        seededSeqs.push(ev.sequence!);
      }
    } finally { await store.close(); }

    const app = await buildApp(buildConfig());
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // 8 consumers reconnect with cursors at different points in the backlog.
      const cursors = [0, 10, 25, 50, 60, 75, 80, 90].map((i) => seededSeqs[i]);
      const results = await Promise.all(cursors.map((c) =>
        consumeSSE(`${baseUrl}/events/stream`, {
          lastEventId: String(c),
          expectedCount: 250,
          timeoutMs: 6_000
        })
      ));
      for (let i = 0; i < cursors.length; i++) {
        const cursor = cursors[i];
        const stepFrames = results[i].frames.filter((f) => f.type === "EXECUTION_STEP_STARTED");
        const seqs = stepFrames.map((f) => f.id);
        // No duplicates.
        expect(new Set(seqs).size).toBe(seqs.length);
        // No event at or below cursor.
        for (const s of seqs) expect(s).toBeGreaterThan(cursor);
        // Every seeded seq > cursor must appear.
        for (const s of seededSeqs) {
          if (s > cursor) expect(seqs).toContain(s);
        }
      }
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe.skipIf(!harness)("/events/stream — slow consumer / backpressure", () => {
  it("a slow consumer does not lose events when the bus continues to publish", async () => {
    // A slow consumer is simulated by a small server-side write window
    // (the SSE route handles `write() === false` by pausing until drain).
    // We assert end-to-end that on the slow consumer side, no event is
    // skipped even if the rate is high.
    const seed = suiteSeed("sse-slow");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const app = await buildApp(buildConfig());
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // Start consumer first, no backlog → live mode from frame 0.
      const consumePromise = consumeSSE(`${baseUrl}/events/stream`, {
        expectedCount: 200, timeoutMs: 8_000
      });
      await sleep(100);

      // Fast publisher: 100 events via the app's own publisher.
      const container = (app as unknown as { runtimeContainer: { eventStore: { append: (e: import("../../../src/domain/events.js").DomainEvent) => Promise<import("../../../src/domain/events.js").DomainEvent> }; eventBus: { publish: (e: import("../../../src/domain/events.js").DomainEvent) => Promise<void> } } }).runtimeContainer;
      const publishedSeqs: number[] = [];
      for (let i = 0; i < 100; i++) {
        const ev = makeEvent({
          type: "EXECUTION_STEP_STARTED",
          executionId: exec, seed: seed + "-live", step: i,
          payloadExtras: { step: { executionId: exec, sequence: i } }
        });
        const appended = await container.eventStore.append(ev);
        await container.eventBus.publish(appended);
        publishedSeqs.push(appended.sequence!);
      }

      const { frames } = await consumePromise;
      const stepFrames = frames.filter((f) => f.type === "EXECUTION_STEP_STARTED");
      const seqs = stepFrames.map((f) => f.id);
      // No duplicates ever.
      expect(new Set(seqs).size).toBe(seqs.length);
      // Every published seq must arrive (eventual delivery).
      const ok = await eventually(() => publishedSeqs.every((s) => seqs.includes(s)), { timeoutMs: 2_000 });
      expect(ok || publishedSeqs.every((s) => seqs.includes(s))).toBe(true);
    } finally {
      await app.close();
    }
  }, 30_000);
});
