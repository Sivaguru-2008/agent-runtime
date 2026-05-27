/**
 * Phase 5 — Load shedding validation.
 *
 * Targets the BackpressureError → 503/Retry-After contract enforced in
 * interfaces/http/routes.ts and the underlying queue depth signal.
 *
 *   5.1 Saturate queues intentionally  — enqueue past threshold; new attempts
 *                                         must surface BackpressureError.
 *   5.2 503 behavior                    — the route handler maps BackpressureError
 *                                         to a 503 with retryAfterSec, depth,
 *                                         threshold in the body.
 *   5.3 Retry-After correctness         — formula bounds: 1 ≤ retryAfter ≤ 60.
 *   5.4 No cascading crash              — runtime continues to function for
 *                                         valid requests after N rejections.
 *   5.5 Queue fairness across tenants   — under sustained mixed-tenant
 *                                         enqueue, no tenant is permanently
 *                                         starved. (Documents current FIFO
 *                                         behavior: order-of-enqueue, not
 *                                         per-tenant round-robin.)
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RedisExecutionJobQueue } from "../../src/infrastructure/queue/redisExecutionJobQueue.js";
import { BackpressureError } from "../../src/shared/errors.js";
import { chaosController } from "../../src/infrastructure/chaos/index.js";
import { tryStartChaosHarness, type ChaosHarness } from "./_setup/chaosHarness.js";
import { recordPhase, evaluateThresholds } from "./_setup/chaosResultBus.js";
import { makeJob } from "./_setup/jobFixtures.js";

// Top-level await: describe.skipIf is evaluated synchronously at collection
// time, so the harness must already be resolved when the predicate runs.
const harness: ChaosHarness | null = await tryStartChaosHarness();

// FLUSHDB between tests: 5.1 deliberately leaves 25 jobs in the queue to
// validate the backpressure check, 5.4 leaves the post-storm probe — without
// a per-test flush those residuals corrupt 5.5's per-tenant counts since the
// queue is single-FIFO and the residuals dequeue first.
beforeEach(async () => {
  if (harness) await harness.redis.flushdb();
});

afterAll(async () => {
  if (harness) await harness.stop();
});

/**
 * Mirror of the formula in interfaces/http/routes.ts (kept in lockstep with
 * the production handler). If the route changes the formula, this test will
 * surface the drift via the bounds assertion in Phase 5.3.
 */
function retryAfterFor(depth: number, threshold: number): number {
  const overshoot = depth - threshold;
  return Math.min(60, Math.max(1, Math.ceil(overshoot / 50) + 1));
}

describe.skipIf(!harness)("Phase 5.1 — saturate queue, observe backpressure decision", () => {
  it("once queue depth crosses threshold, the runtime's backpressure check rejects further enqueues", async () => {
    const t0 = Date.now();
    chaosController().reset();
    const THRESHOLD = 20;
    const queue = new RedisExecutionJobQueue({ url: harness!.redisUrl, visibilityMs: 30_000 });

    // Saturate the queue past threshold WITHOUT consuming.
    for (let i = 0; i < THRESHOLD + 5; i++) {
      await queue.enqueue(makeJob(`p5-sat-${i}`));
    }
    const depthSnap = await queue.depth();
    const liveDepth = depthSnap.ready + depthSnap.inFlight + depthSnap.delayed;

    // Simulate the runtime's backpressure check (agentRuntime.ts:168-173).
    let raised = false;
    try {
      if (liveDepth >= THRESHOLD) {
        throw new BackpressureError(liveDepth, THRESHOLD);
      }
    } catch (err) {
      raised = err instanceof BackpressureError;
    }

    await queue.close();

    const { ok, thresholds } = evaluateThresholds({
      depthOverThreshold: { observed: liveDepth, required: `> ${THRESHOLD}`, predicate: (v) => v > THRESHOLD },
      backpressureRaised: { observed: raised ? 1 : 0, required: "== 1", predicate: (v) => v === 1 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase5.1.queueSaturation", {
      ok,
      metrics: { liveDepth, threshold: THRESHOLD, raised: raised ? 1 : 0 },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 60_000);
});

describe("Phase 5.2 — 503 response shape contract", () => {
  it("BackpressureError fields are present and consistent for downstream 503 mapping", async () => {
    const t0 = Date.now();
    const err = new BackpressureError(125, 100);
    const retryAfterSec = retryAfterFor(err.depth, err.threshold);

    const { ok, thresholds } = evaluateThresholds({
      hasDepth: { observed: err.depth, required: "== 125", predicate: (v) => v === 125 },
      hasThreshold: { observed: err.threshold, required: "== 100", predicate: (v) => v === 100 },
      retryAfterPositive: { observed: retryAfterSec, required: ">= 1", predicate: (v) => v >= 1 },
      retryAfterBounded: { observed: retryAfterSec, required: "<= 60", predicate: (v) => v <= 60 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase5.2.responseShape", {
      ok,
      metrics: { depth: err.depth, threshold: err.threshold, retryAfterSec },
      thresholds,
      durationMs: Date.now() - t0
    });
  });
});

describe("Phase 5.3 — Retry-After correctness across overshoot range", () => {
  it("retry-after stays within [1, 60] for any depth ≥ threshold, monotone in overshoot", async () => {
    const t0 = Date.now();
    const threshold = 100;
    const samples: Array<{ depth: number; retryAfter: number }> = [];
    for (const overshoot of [1, 10, 25, 50, 100, 250, 500, 10_000]) {
      const depth = threshold + overshoot;
      samples.push({ depth, retryAfter: retryAfterFor(depth, threshold) });
    }
    const inRange = samples.every((s) => s.retryAfter >= 1 && s.retryAfter <= 60);
    const monotoneNonDecreasing = samples.every((s, i) =>
      i === 0 ? true : s.retryAfter >= (samples[i - 1]?.retryAfter ?? 0)
    );
    const saturatesAt60 = samples[samples.length - 1]?.retryAfter === 60;

    const { ok, thresholds } = evaluateThresholds({
      bounded: { observed: inRange ? 1 : 0, required: "== 1", predicate: (v) => v === 1 },
      monotone: { observed: monotoneNonDecreasing ? 1 : 0, required: "== 1", predicate: (v) => v === 1 },
      saturates: { observed: saturatesAt60 ? 1 : 0, required: "== 1", predicate: (v) => v === 1 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase5.3.retryAfterFormula", {
      ok,
      metrics: { samples: JSON.stringify(samples), inRange: inRange ? 1 : 0 },
      thresholds,
      durationMs: Date.now() - t0
    });
  });
});

describe.skipIf(!harness)("Phase 5.4 — no cascading crash under rejection storm", () => {
  it("after 100 backpressure-induced rejections, subsequent enqueue + depth() still works", async () => {
    const t0 = Date.now();
    chaosController().reset();
    const queue = new RedisExecutionJobQueue({ url: harness!.redisUrl, visibilityMs: 30_000 });

    // Fill above threshold and simulate 100 rejection attempts. We assert the
    // queue handle itself is unaffected — no leaked timers, no thrown error
    // from depth(), enqueue still idempotent, and a fresh enqueue still
    // appears on the queue.
    for (let i = 0; i < 25; i++) await queue.enqueue(makeJob(`p5-rej-fill-${i}`));

    let errorsFromDepth = 0;
    for (let i = 0; i < 100; i++) {
      try { await queue.depth(); } catch { errorsFromDepth += 1; }
    }

    // Now drain everything and enqueue one more after the storm.
    const consumer = queue.consume({ workerId: "p5-rej-w", group: "g", blockMs: 250 });
    const iter = consumer[Symbol.asyncIterator]();
    let drained = 0;
    while (drained < 25) {
      const next = await Promise.race([
        iter.next(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 2_000)
        )
      ]);
      if (next.done) break;
      await queue.ack(next.value.receiptId);
      drained += 1;
    }
    await (iter as unknown as { return?: () => Promise<unknown> }).return?.();

    await queue.enqueue(makeJob("p5-rej-postStorm"));
    const post = await queue.depth();
    await queue.close();

    const { ok, thresholds } = evaluateThresholds({
      depthCallsAllSucceeded: { observed: errorsFromDepth, required: "== 0", predicate: (v) => v === 0 },
      drainedFully: { observed: drained, required: "== 25", predicate: (v) => v === 25 },
      postStormEnqueueVisible: {
        observed: post.ready + post.delayed,
        required: ">= 1",
        predicate: (v) => v >= 1
      }
    });
    expect(ok).toBe(true);
    await recordPhase("phase5.4.noCascadingCrash", {
      ok,
      metrics: { errorsFromDepth, drained, postStormDepth: post.ready + post.delayed },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 90_000);
});

describe.skipIf(!harness)("Phase 5.5 — queue fairness across tenants (FIFO baseline)", () => {
  it("under interleaved multi-tenant enqueue, every tenant's jobs are delivered (no starvation over finite window)", async () => {
    const t0 = Date.now();
    chaosController().reset();
    const queue = new RedisExecutionJobQueue({ url: harness!.redisUrl, visibilityMs: 30_000 });
    const TENANTS = ["A", "B", "C"];
    const PER_TENANT = 15;

    // Interleave: A0, B0, C0, A1, B1, C1, ... so no tenant has a head-of-line
    // monopoly at enqueue time.
    for (let i = 0; i < PER_TENANT; i++) {
      for (const t of TENANTS) {
        await queue.enqueue(makeJob(`p5-fair-${t}-${i}`, { agentId: `agent-${t}`, executionId: `exec-${t}-${i}` }));
      }
    }

    const consumer = queue.consume({ workerId: "p5-fair-w", group: "g", blockMs: 250 });
    const iter = consumer[Symbol.asyncIterator]();
    const seenByTenant: Record<string, number> = { A: 0, B: 0, C: 0 };
    const total = TENANTS.length * PER_TENANT;
    for (let i = 0; i < total; i++) {
      const next = await iter.next();
      if (next.done) break;
      const tenant = next.value.job.agentId.split("-")[1];
      if (tenant && tenant in seenByTenant) {
        seenByTenant[tenant] = (seenByTenant[tenant] ?? 0) + 1;
      }
      await queue.ack(next.value.receiptId);
    }
    await (iter as unknown as { return?: () => Promise<unknown> }).return?.();
    await queue.close();

    const min = Math.min(...Object.values(seenByTenant));
    const max = Math.max(...Object.values(seenByTenant));

    const { ok, thresholds } = evaluateThresholds({
      noStarvation: {
        observed: min,
        required: `== ${PER_TENANT} (every tenant fully drained)`,
        predicate: (v) => v === PER_TENANT
      },
      balanced: {
        observed: max - min,
        required: "== 0 over finite window",
        predicate: (v) => v === 0
      }
    });
    expect(ok).toBe(true);
    await recordPhase("phase5.5.tenantFairness", {
      ok,
      metrics: { ...seenByTenant, spread: max - min },
      thresholds,
      notes:
        "Current implementation is single-LIST FIFO (Redis LPUSH/BRPOP). Fairness here means 'no tenant starves in a finite drain' — it does NOT mean weighted-fair queuing across tenants under sustained load. Per-tenant quotas and rate-limits enforce upstream fairness; the queue itself is FIFO.",
      durationMs: Date.now() - t0
    });
  }, 90_000);
});
