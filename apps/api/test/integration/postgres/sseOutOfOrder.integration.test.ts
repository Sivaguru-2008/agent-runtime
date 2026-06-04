/**
 * Sprint Hardening 3 — SSE correctness under out-of-order live arrivals.
 *
 * The previous `seq <= cursor` watermark silently dropped any frame whose
 * sequence arrived AFTER a higher one was emitted. This is the exact
 * failure mode that occurs whenever two writers append concurrently — the
 * Postgres-assigned sequence is monotonic, but the in-memory EventBus
 * delivers in publish() call order, not sequence order.
 *
 * This suite proves the bug is fixed by:
 *   (A) Appending N events sequentially (so sequences are 1..N), then
 *       publishing them on the bus IN A SHUFFLED ORDER, and verifying the
 *       SSE consumer sees all N exactly once.
 *   (B) Publishing the SAME appended event twice (a publisher retry) and
 *       verifying the consumer sees it exactly once.
 *   (C) 50 concurrent appenders → all sequences delivered.
 *
 * The canonical-equivalence invariant: the multiset of sequences delivered
 * over SSE must equal the multiset of sequences in the event store.
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

function buildConfig(): AppConfig {
  return {
    NODE_ENV: "test",
    PORT: 0,
    DATABASE_URL: harness!.connectionString,
    EVENT_BUS_DRIVER: "memory",
    EVENT_STORE_DRIVER: "postgres",
    PERSISTENCE_DRIVER: "postgres",
    RECOVERY_LOOP_INTERVAL_MS: 3_600_000,
    OTEL_SERVICE_NAME: "sse-out-of-order",
    LOG_LEVEL: "silent",
    RUNTIME_MODE: "single",
    // events.aggregate_id is a UUID column; WORKER_ID is used as the
    // aggregate id of WORKER_REGISTERED events, so it must be a valid UUID.
    // Sprint Hardening 3's fail-fast registration now surfaces non-UUID
    // worker IDs that the prior fire-and-forget pattern silently swallowed.
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

// Fisher-Yates with a seeded RNG so the shuffle is deterministic.
function seededShuffle<T>(arr: T[], seed: number): T[] {
  let s = seed;
  const rng = () => {
    // xorshift32
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
  eventStore: { append(e: DomainEvent): Promise<DomainEvent> };
  eventBus: { publish(e: DomainEvent): Promise<void> };
}

function getContainer(app: import("fastify").FastifyInstance): ContainerHandle {
  return (app as unknown as { runtimeContainer: ContainerHandle }).runtimeContainer;
}

describe.skipIf(!harness)("/events/stream — out-of-order live arrivals", () => {
  it("delivers every sequence even when bus order reverses Postgres order", async () => {
    const seed = suiteSeed("sse-out-of-order");
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

      // Connect first — empty backlog, so subscriber attaches before any
      // sequenced live event arrives.
      const consumePromise = consumeSSE(`${baseUrl}/events/stream`, {
        expectedCount: 60, // 50 step events + lifecycle noise
        timeoutMs: 6_000
      });
      await sleep(75);

      // Append N events sequentially → Postgres assigns sequences 1..N
      // (relative to this test's truncated DB).
      const N = 50;
      const appended: DomainEvent[] = [];
      for (let i = 0; i < N; i++) {
        const ev = makeEvent({
          type: "EXECUTION_STEP_STARTED",
          executionId: exec, seed, step: i,
          payloadExtras: { step: { executionId: exec, sequence: i } }
        });
        appended.push(await container.eventStore.append(ev));
      }

      // Publish on the bus IN SHUFFLED ORDER. With the old watermark this
      // dropped every event whose sequence < a previously published one.
      // With the ring buffer, all N must be delivered exactly once.
      const shuffled = seededShuffle(appended, 0xdeadbeef);
      for (const ev of shuffled) {
        await container.eventBus.publish(ev);
      }

      const { frames } = await consumePromise;
      const stepFrames = frames.filter((f) => f.type === "EXECUTION_STEP_STARTED");
      const seqs = stepFrames.map((f) => f.id);

      // No duplicates anywhere.
      expect(new Set(seqs).size).toBe(seqs.length);
      // Every appended sequence is present.
      const appendedSeqs = appended.map((e) => e.sequence!);
      const got = new Set(seqs);
      for (const s of appendedSeqs) {
        expect(got.has(s)).toBe(true);
      }
    } finally {
      await app.close();
    }
  }, 30_000);

  it("suppresses a duplicate publish() of the same appended event", async () => {
    const seed = suiteSeed("sse-dup-publish");
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

      const consumePromise = consumeSSE(`${baseUrl}/events/stream`, {
        expectedCount: 30,
        timeoutMs: 4_000
      });
      await sleep(50);

      // Append once, publish twice — the second publish models a retry that
      // races the first delivery.
      const ev = makeEvent({
        type: "MODEL_COMPLETED",
        executionId: exec, seed, step: 0,
        payloadExtras: { executionId: exec, idx: 0 }
      });
      const appended = await container.eventStore.append(ev);
      await container.eventBus.publish(appended);
      await container.eventBus.publish(appended);
      await container.eventBus.publish(appended);

      const { frames } = await consumePromise;
      const matches = frames.filter(
        (f) => f.type === "MODEL_COMPLETED" && f.id === appended.sequence
      );
      // Exactly one — the two retries must be suppressed by the dedupe
      // window.
      expect(matches.length).toBe(1);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("delivers every sequence under 50 concurrent appenders", async () => {
    const seed = suiteSeed("sse-concurrent-appenders");
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

      const consumePromise = consumeSSE(`${baseUrl}/events/stream`, {
        expectedCount: 80,
        timeoutMs: 8_000
      });
      await sleep(75);

      // Fan out 50 parallel append+publish chains. The order in which
      // sequences arrive on the bus is dictated by Promise resolution
      // order, not by Postgres-assigned sequence.
      const N = 50;
      const work = Array.from({ length: N }, (_, i) => async () => {
        const ev = makeEvent({
          type: "EXECUTION_STEP_STARTED",
          executionId: exec, seed, step: i,
          payloadExtras: { step: { executionId: exec, sequence: i } }
        });
        const appended = await container.eventStore.append(ev);
        await container.eventBus.publish(appended);
        return appended.sequence!;
      });
      const appendedSeqs = await Promise.all(work.map((fn) => fn()));

      const { frames } = await consumePromise;
      const seqs = frames
        .filter((f) => f.type === "EXECUTION_STEP_STARTED")
        .map((f) => f.id);

      // No duplicates.
      expect(new Set(seqs).size).toBe(seqs.length);
      // Every appended sequence is delivered.
      const got = new Set(seqs);
      for (const s of appendedSeqs) {
        expect(got.has(s)).toBe(true);
      }
    } finally {
      await app.close();
    }
  }, 45_000);

  it("canonical equivalence: SSE-delivered sequences match the event-store sequences", async () => {
    // The strongest invariant: the multiset of sequences delivered on the
    // wire equals the multiset of sequences in the canonical event log.
    const seed = suiteSeed("sse-canonical");
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

      const consumePromise = consumeSSE(`${baseUrl}/events/stream`, {
        expectedCount: 60,
        timeoutMs: 6_000
      });
      await sleep(50);

      const N = 30;
      const seedShuffle = 0xfeedbeef;
      const events: DomainEvent[] = [];
      for (let i = 0; i < N; i++) {
        const ev = makeEvent({
          type: "EXECUTION_STEP_STARTED",
          executionId: exec, seed, step: i,
          payloadExtras: { step: { executionId: exec, sequence: i } }
        });
        events.push(await container.eventStore.append(ev));
      }
      const order = seededShuffle(events, seedShuffle);
      for (const e of order) {
        await container.eventBus.publish(e);
      }

      const { frames } = await consumePromise;
      const observed = frames
        .filter((f) => f.type === "EXECUTION_STEP_STARTED")
        .map((f) => f.id)
        .sort((a, b) => a - b);
      const canonical = events.map((e) => e.sequence!).sort((a, b) => a - b);
      expect(observed).toEqual(canonical);
    } finally {
      await app.close();
    }
  }, 30_000);
});
