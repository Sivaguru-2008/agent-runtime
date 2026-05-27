/**
 * Phase 2 — Postgres failure injection.
 *
 *   2.1 Transient disconnects             — driver surfaces FaultyDisconnectError;
 *                                            next query on the same client succeeds.
 *   2.2 Statement timeout exhaustion       — N queries trip the simulated timeout;
 *                                            the pool is NOT exhausted.
 *   2.3 Pool starvation under load         — fan-out > pool.max with holdMs delays
 *                                            ⇒ waitingCount > 0 observed; eventual
 *                                            success after release; no leaked clients.
 *   2.4 Connection recovery                — after the fault scenario clears, the
 *                                            same PgClient runs SELECT 1 cleanly.
 *   2.5 No leaked clients                  — pgClient.stats().outstanding == 0
 *                                            at end of every scenario.
 */

import { afterAll, describe, expect, it } from "vitest";
import { chaosController } from "../../src/infrastructure/chaos/index.js";
import { createPgClient } from "../../src/infrastructure/persistence/postgres/pgClient.js";
import { tryStartChaosHarness, type ChaosHarness } from "./_setup/chaosHarness.js";
import { recordPhase, evaluateThresholds } from "./_setup/chaosResultBus.js";

// Top-level await: describe.skipIf is evaluated synchronously at collection
// time, so the harness must already be resolved when the predicate runs.
const harness: ChaosHarness | null = await tryStartChaosHarness();

afterAll(async () => {
  if (harness) await harness.stop();
});

describe.skipIf(!harness)("Phase 2.1 — transient PG disconnects", () => {
  it("a disconnect fault surfaces as an error; the client recovers on the next query", async () => {
    const t0 = Date.now();
    chaosController().reset();

    // Independent PgClient so we measure recovery in isolation.
    const client = createPgClient(harness!.databaseUrl);

    // Inject one disconnect with probability 1; clears itself after one fire.
    chaosController().register({
      kind: "pg.disconnect",
      probability: 1,
      times: 1
    });

    let firstError: string | null = null;
    try {
      await client.query("select 1");
    } catch (err) {
      firstError = (err as Error).message;
    }
    // Recovery
    const recovery = await client.query<{ ok: number }>("select 1 as ok");
    const stats = client.stats();
    await client.close();

    // Encode "fault observed" as numeric (length of error message) so the
    // evaluateThresholds generic stays homogeneous across observations.
    const { ok, thresholds } = evaluateThresholds({
      faultObservedChars: {
        observed: (firstError ?? "").length,
        required: "> 0 (disconnect surfaced as non-empty error message)",
        predicate: (v) => v > 0
      },
      recovery: {
        observed: Number(recovery.rows[0]?.ok ?? 0),
        required: "== 1",
        predicate: (v) => v === 1
      },
      noLeak: { observed: stats.outstanding, required: "== 0", predicate: (v) => v === 0 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase2.1.transientDisconnect", {
      ok,
      metrics: {
        firstError: firstError ?? "",
        recovered: recovery.rows[0]?.ok ?? 0,
        outstanding: stats.outstanding
      },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 30_000);
});

describe.skipIf(!harness)("Phase 2.2 — statement timeout exhaustion", () => {
  it("repeated simulated statement_timeout failures do not exhaust the pool", async () => {
    const t0 = Date.now();
    chaosController().reset();
    const client = createPgClient({ connectionString: harness!.databaseUrl, max: 5 });

    chaosController().register({
      kind: "pg.statementTimeout",
      probability: 1,
      times: 8,
      payload: { afterMs: 25 }
    });

    let trips = 0;
    for (let i = 0; i < 8; i++) {
      try {
        await client.query("select pg_sleep(0)");
      } catch (err) {
        if ((err as { code?: string }).code === "57014") trips += 1;
      }
    }

    // Pool must still serve a fresh request.
    const recovery = await client.query<{ ok: number }>("select 1 as ok");
    const stats = client.stats();
    await client.close();

    const { ok, thresholds } = evaluateThresholds({
      tripsHit: { observed: trips, required: ">= 5", predicate: (v) => v >= 5 },
      recovers: { observed: recovery.rows[0]?.ok ?? 0, required: "== 1", predicate: (v) => Number(v) === 1 },
      noLeak: { observed: stats.outstanding, required: "== 0", predicate: (v) => v === 0 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase2.2.statementTimeoutExhaustion", {
      ok,
      metrics: { trips, outstanding: stats.outstanding, max: stats.max },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 30_000);
});

describe.skipIf(!harness)("Phase 2.3 — pool starvation under load", () => {
  it("fan-out > pool.max with holdMs delays surfaces waitingCount > 0 and eventually drains", async () => {
    const t0 = Date.now();
    chaosController().reset();
    const POOL_MAX = 3;
    const FANOUT = 12;
    const client = createPgClient({ connectionString: harness!.databaseUrl, max: POOL_MAX });

    chaosController().register({
      kind: "pg.poolStarvation",
      probability: 1,
      times: FANOUT,
      payload: { holdMs: 150 }
    });

    let maxWaiting = 0;
    const waitObserver = setInterval(() => {
      const s = client.stats();
      if (s.waitingCount > maxWaiting) maxWaiting = s.waitingCount;
    }, 10);

    const results = await Promise.allSettled(
      Array.from({ length: FANOUT }, async (_, i) => {
        const c = await client.acquire(`p2.3-${i}`);
        try {
          const r = await c.query<{ ok: number }>("select 1 as ok");
          return r.rows[0]?.ok;
        } finally {
          c.release();
        }
      })
    );
    clearInterval(waitObserver);

    const ok_count = results.filter((r) => r.status === "fulfilled" && r.value === 1).length;
    const stats = client.stats();
    await client.close();

    const { ok, thresholds } = evaluateThresholds({
      allFulfilled: { observed: ok_count, required: `== ${FANOUT}`, predicate: (v) => v === FANOUT },
      waitingObserved: {
        observed: maxWaiting,
        required: "> 0 (saturated pool produced a queue)",
        predicate: (v) => v > 0
      },
      noLeak: { observed: stats.outstanding, required: "== 0", predicate: (v) => v === 0 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase2.3.poolStarvation", {
      ok,
      metrics: { fulfilled: ok_count, maxWaiting, outstanding: stats.outstanding, poolMax: POOL_MAX },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 30_000);
});

describe.skipIf(!harness)("Phase 2.4 — recovery after fault scenario clears", () => {
  it("after scenario clears, queries succeed without retry", async () => {
    const t0 = Date.now();
    chaosController().reset();
    const client = createPgClient(harness!.databaseUrl);

    // Burn through 2 forced disconnects, then expect clean steady state.
    chaosController().register({ kind: "pg.disconnect", probability: 1, times: 2 });
    for (let i = 0; i < 2; i++) {
      try { await client.query("select 1"); } catch { /* expected */ }
    }
    chaosController().clear("pg.disconnect");

    let successes = 0;
    for (let i = 0; i < 5; i++) {
      const r = await client.query<{ ok: number }>("select 1 as ok");
      if (r.rows[0]?.ok === 1) successes += 1;
    }
    const stats = client.stats();
    await client.close();

    const { ok, thresholds } = evaluateThresholds({
      cleanSteadyState: { observed: successes, required: "== 5", predicate: (v) => v === 5 },
      noLeak: { observed: stats.outstanding, required: "== 0", predicate: (v) => v === 0 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase2.4.recoveryAfterClear", {
      ok,
      metrics: { steadyStateSuccesses: successes, outstanding: stats.outstanding },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 30_000);
});

describe.skipIf(!harness)("Phase 2.5 — no leaked clients after compound failure burst", () => {
  it("a mix of disconnect + statement-timeout + starvation leaves outstanding == 0", async () => {
    const t0 = Date.now();
    chaosController().reset();
    const client = createPgClient({ connectionString: harness!.databaseUrl, max: 4 });

    chaosController().register({ kind: "pg.disconnect", probability: 0.3, times: 50 });
    chaosController().register({ kind: "pg.statementTimeout", probability: 0.3, times: 50, payload: { afterMs: 10 } });
    chaosController().register({ kind: "pg.poolStarvation", probability: 0.3, times: 50, payload: { holdMs: 50 } });

    await Promise.allSettled(
      Array.from({ length: 60 }, async (_, i) => {
        try {
          if (i % 2 === 0) {
            await client.query("select 1");
          } else {
            const c = await client.acquire(`p2.5-${i}`);
            try { await c.query("select 1"); } finally { c.release(); }
          }
        } catch { /* expected for injected faults */ }
      })
    );

    // Allow any lingering acquire timers to settle.
    await new Promise((r) => setTimeout(r, 50));
    const stats = client.stats();
    await client.close();

    const { ok, thresholds } = evaluateThresholds({
      noLeak: { observed: stats.outstanding, required: "== 0", predicate: (v) => v === 0 }
    });
    expect(ok).toBe(true);
    await recordPhase("phase2.5.noLeakedClients", {
      ok,
      metrics: { outstanding: stats.outstanding, totalFaults: chaosController().metrics().totalFired },
      thresholds,
      durationMs: Date.now() - t0
    });
  }, 30_000);
});
