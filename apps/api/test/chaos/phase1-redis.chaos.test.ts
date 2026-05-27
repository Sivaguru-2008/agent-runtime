/**
 * Phase 1 — Redis failure injection.
 *
 * Five scenarios, each driving the REAL RedisExecutionJobQueue against a real
 * Redis (testcontainer or external), with the chaos proxy injecting faults:
 *
 *   1.1 Latency spikes              — enqueue/depth p99 must recover post-fault
 *   1.2 Disconnect storms           — N forced disconnects ⇒ queue still drains
 *   1.3 Partial pub/sub failure     — drop publish() ⇒ subscriber observes loss
 *   1.4 Delayed job acknowledgements — ack-path slowdown ⇒ no double-ack, no leak
 *   1.5 Queue recovery after reconnect — full drain + reconnect, no orphaned jobs
 *
 * All metrics are written to chaos-results.json under "phase1.*" keys for
 * Phase 6 aggregation.
 */

import { afterAll, describe, expect, it } from "vitest";
import { RedisExecutionJobQueue } from "../../src/infrastructure/queue/redisExecutionJobQueue.js";
import { RedisEventBus } from "../../src/infrastructure/events/redisEventBus.js";
import { chaosController } from "../../src/infrastructure/chaos/index.js";
import { tryStartChaosHarness, type ChaosHarness } from "./_setup/chaosHarness.js";
import { recordPhase, evaluateThresholds } from "./_setup/chaosResultBus.js";
import { makeJob } from "./_setup/jobFixtures.js";

// Top-level await: describe.skipIf is evaluated synchronously at collection
// time, so the harness must already be resolved when the predicate runs.
// Using beforeAll here would leave skipIf seeing `null` and skipping every test.
const harness: ChaosHarness | null = await tryStartChaosHarness();

afterAll(async () => {
  if (harness) await harness.stop();
});

describe.skipIf(!harness)("Phase 1.1 — Redis latency spikes", () => {
  it("queue continues to drain through a 500ms latency spike; depth converges to 0", async () => {
    const t0 = Date.now();
    chaosController().reset();
    const queue = new RedisExecutionJobQueue({ url: harness!.redisUrl, visibilityMs: 5_000 });

    // Inject 500ms latency on every command, only for the next 20 fires.
    chaosController().register({
      kind: "redis.latency",
      probability: 1,
      times: 20,
      payload: { ms: 500 }
    });

    const N = 30;
    const enqueueLatencies: number[] = [];
    for (let i = 0; i < N; i++) {
      const t = Date.now();
      await queue.enqueue(makeJob(`p1-latency-${i}`));
      enqueueLatencies.push(Date.now() - t);
    }

    // Drain.
    const consumer = queue.consume({ workerId: "p1-w", group: "g", blockMs: 250 });
    const iter = consumer[Symbol.asyncIterator]();
    const drained: string[] = [];
    for (let i = 0; i < N; i++) {
      const next = await iter.next();
      if (next.done) break;
      drained.push(next.value.job.jobId);
      await queue.ack(next.value.receiptId);
    }
    await (iter as unknown as { return?: () => Promise<unknown> }).return?.();

    const depth = await queue.depth();
    const sorted = [...enqueueLatencies].sort((a, b) => a - b);
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
    const fired = chaosController().metrics().byKind["redis.latency"];

    await queue.close();

    const { ok, thresholds } = evaluateThresholds({
      drainComplete: { observed: drained.length, required: `== ${N}`, predicate: (v) => v === N },
      depthZero: { observed: depth.ready + depth.inFlight + depth.delayed, required: "== 0", predicate: (v) => v === 0 },
      faultsFired: { observed: fired, required: "> 0", predicate: (v) => v > 0 }
    });

    expect(ok).toBe(true);
    await recordPhase("phase1.1.latencySpikes", {
      ok,
      metrics: { enqueueP99Ms: p99, drained: drained.length, faultsFired: fired },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 60_000);
});

describe.skipIf(!harness)("Phase 1.2 — Redis disconnect storms", () => {
  it("queue survives 10 forced disconnects and still delivers every job", async () => {
    const t0 = Date.now();
    chaosController().reset();
    const queue = new RedisExecutionJobQueue({ url: harness!.redisUrl, visibilityMs: 5_000 });

    const N = 20;
    for (let i = 0; i < N; i++) await queue.enqueue(makeJob(`p1-disc-${i}`));

    // Force disconnects on the next 10 random commands.
    chaosController().register({
      kind: "redis.disconnect",
      probability: 0.5,
      times: 10
    });

    const consumer = queue.consume({ workerId: "p1-disc-w", group: "g", blockMs: 250 });
    const iter = consumer[Symbol.asyncIterator]();
    const delivered = new Set<string>();
    const deadline = Date.now() + 30_000;
    while (delivered.size < N && Date.now() < deadline) {
      const next = await Promise.race([
        iter.next(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 2_000)
        )
      ]);
      if (next.done) {
        // BRPOP timed out — keep looping until the deadline or all jobs in.
        continue;
      }
      delivered.add(next.value.job.jobId);
      await queue.ack(next.value.receiptId);
    }
    await (iter as unknown as { return?: () => Promise<unknown> }).return?.();

    const depth = await queue.depth();
    const fired = chaosController().metrics().byKind["redis.disconnect"];
    await queue.close();

    const { ok, thresholds } = evaluateThresholds({
      deliveredAll: { observed: delivered.size, required: `== ${N}`, predicate: (v) => v === N },
      depthZero: { observed: depth.ready + depth.inFlight + depth.delayed, required: "== 0", predicate: (v) => v === 0 },
      faultsFired: { observed: fired, required: "> 0", predicate: (v) => v > 0 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase1.2.disconnectStorm", {
      ok,
      metrics: { delivered: delivered.size, faultsFired: fired },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 60_000);
});

describe.skipIf(!harness)("Phase 1.3 — partial pub/sub failure", () => {
  it("dropped publishes are observed as zero subscribers received; bus continues to function for non-dropped messages", async () => {
    const t0 = Date.now();
    chaosController().reset();
    const bus = new RedisEventBus(harness!.redisUrl);

    const received: string[] = [];
    const unsub = bus.subscribe(async (e) => {
      received.push(e.id);
    });

    // Wait briefly for the subscriber to be ready (subscribe() above is fire-and-forget).
    await new Promise((r) => setTimeout(r, 300));

    // Drop 50% of publishes for the next 20 attempts.
    chaosController().register({
      kind: "redis.pubsubDrop",
      probability: 0.5,
      times: 20
    });

    const N = 20;
    const sentIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = `evt-${i}`;
      sentIds.push(id);
      await bus.publish({
        id,
        type: "EXECUTION_STARTED",
        aggregateId: `exec-${i}`,
        aggregateType: "EXECUTION",
        version: 1,
        timestamp: new Date().toISOString(),
        payload: {} as unknown as Record<string, unknown>,
        metadata: { idempotencyKey: id }
      } as unknown as Parameters<typeof bus.publish>[0]);
    }

    // Allow time for delivery of the messages that did get through.
    await new Promise((r) => setTimeout(r, 750));
    unsub();

    const dropped = chaosController().metrics().byKind["redis.pubsubDrop"];
    await bus.close();

    const observedLoss = sentIds.length - received.length;
    const { ok, thresholds } = evaluateThresholds({
      lossMatchesDrops: {
        observed: observedLoss,
        required: ">= dropped (publisher loss visible to subscriber)",
        predicate: (v) => Number(v) >= dropped
      },
      atLeastSomeDelivered: {
        observed: received.length,
        required: "> 0",
        predicate: (v) => v > 0
      },
      atLeastOneDropped: { observed: dropped, required: "> 0", predicate: (v) => v > 0 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase1.3.pubsubDrop", {
      ok,
      metrics: { sent: N, received: received.length, dropped },
      thresholds,
      notes:
        "Validates the visibility of partial pub/sub failure. Production must compensate via the persisted event store; the bus is best-effort.",
      durationMs: Date.now() - t0
    });
  }, 30_000);
});

describe.skipIf(!harness)("Phase 1.4 — delayed job acknowledgements", () => {
  it("ack-path latency does not cause duplicate delivery or receipt leak", async () => {
    const t0 = Date.now();
    chaosController().reset();
    const queue = new RedisExecutionJobQueue({ url: harness!.redisUrl, visibilityMs: 5_000 });

    const N = 10;
    for (let i = 0; i < N; i++) await queue.enqueue(makeJob(`p1-ack-${i}`));

    // Delay ack-path commands (MULTI/EXEC/SET) by 200ms with probability 0.7
    // for the next 100 fires.
    chaosController().register({
      kind: "redis.ackDelay",
      probability: 0.7,
      times: 100,
      payload: { ms: 200 }
    });

    const consumer = queue.consume({ workerId: "p1-ack-w", group: "g", blockMs: 250 });
    const iter = consumer[Symbol.asyncIterator]();
    const seenIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const next = await iter.next();
      if (next.done) break;
      seenIds.push(next.value.job.jobId);
      await queue.ack(next.value.receiptId);
    }
    await (iter as unknown as { return?: () => Promise<unknown> }).return?.();

    const depth = await queue.depth();
    await queue.close();

    const duplicates = seenIds.length - new Set(seenIds).size;
    const { ok, thresholds } = evaluateThresholds({
      noDuplicateDelivery: { observed: duplicates, required: "== 0", predicate: (v) => v === 0 },
      noReceiptLeak: {
        observed: depth.inFlight,
        required: "== 0 (every ack removed its inflight entry)",
        predicate: (v) => v === 0
      }
    });
    expect(ok).toBe(true);
    await recordPhase("phase1.4.delayedAck", {
      ok,
      metrics: { delivered: seenIds.length, duplicates, residualInflight: depth.inFlight },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 60_000);
});

describe.skipIf(!harness)("Phase 1.5 — queue recovery after reconnect", () => {
  it("after producer client disconnects and reconnects, all pre-disconnect jobs are still delivered", async () => {
    const t0 = Date.now();
    chaosController().reset();
    const queue = new RedisExecutionJobQueue({ url: harness!.redisUrl, visibilityMs: 5_000 });
    const N = 15;
    for (let i = 0; i < N; i++) await queue.enqueue(makeJob(`p1-rec-${i}`));

    // Force a single disconnect; the next command will trigger ioredis reconnect.
    chaosController().register({
      kind: "redis.disconnect",
      probability: 1,
      times: 1
    });

    // Allow reconnect to land.
    await new Promise((r) => setTimeout(r, 250));

    const consumer = queue.consume({ workerId: "p1-rec-w", group: "g", blockMs: 250 });
    const iter = consumer[Symbol.asyncIterator]();
    const delivered: string[] = [];
    for (let i = 0; i < N; i++) {
      const next = await Promise.race([
        iter.next(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 4_000)
        )
      ]);
      if (next.done) break;
      delivered.push(next.value.job.jobId);
      await queue.ack(next.value.receiptId);
    }
    await (iter as unknown as { return?: () => Promise<unknown> }).return?.();
    const depth = await queue.depth();
    await queue.close();

    const { ok, thresholds } = evaluateThresholds({
      deliveredAll: { observed: delivered.length, required: `== ${N}`, predicate: (v) => v === N },
      depthZero: { observed: depth.ready + depth.inFlight + depth.delayed, required: "== 0", predicate: (v) => v === 0 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase1.5.recoveryAfterReconnect", {
      ok,
      metrics: { delivered: delivered.length, depthAfter: depth.ready + depth.inFlight + depth.delayed },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 60_000);
});
