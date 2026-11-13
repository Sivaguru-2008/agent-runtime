import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemanticFence } from "../src/fence.js";
import { TOOLS } from "../src/tools.js";
import { lexicalScores } from "../src/judge.js";

const scorer = (pairs) => lexicalScores(pairs, TOOLS);

function freshLog() {
  const dir = mkdtempSync(join(tmpdir(), "fence-"));
  return { path: join(dir, "log.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeWorld() {
  let charges = 0;
  return {
    charge: async () => ({ chargeId: "ch_" + ++charges, status: "captured" }),
    get count() { return charges; },
  };
}

test("L0 suppresses an exact (canonical) replay across fence instances sharing the log", async () => {
  const { path, cleanup } = freshLog();
  try {
    const world = makeWorld();
    const args = { customer_id: "c1", amount: 120, currency: "USD", memo: "order 7" };
    const f1 = new SemanticFence({ schemas: TOOLS, runId: "r1", logPath: path, scorer, tHi: 0.9, tLo: 0.4 });
    const r1 = await f1.dispatch("charge_card", args, world.charge);
    // New instance = new process in miniature; only the log is shared.
    const f2 = new SemanticFence({ schemas: TOOLS, runId: "r1", logPath: path, scorer, tHi: 0.9, tLo: 0.4 });
    const r2 = await f2.dispatch(
      "charge_card",
      { memo: " order  7", currency: "usd", amount: "120.00", customer_id: "c1" },
      world.charge
    );
    assert.equal(world.count, 1);
    assert.deepEqual(r2, r1);
  } finally {
    cleanup();
  }
});

test("L1 suppresses a paraphrased replay that L0 misses", async () => {
  const { path, cleanup } = freshLog();
  try {
    const world = makeWorld();
    const f = new SemanticFence({ schemas: TOOLS, runId: "r1", logPath: path, scorer, tHi: 0.78, tLo: 0.4 });
    const r1 = await f.dispatch(
      "charge_card",
      { customer_id: "c1", amount: 120, currency: "USD", memo: "payment for order 4242" },
      world.charge
    );
    const r2 = await f.dispatch(
      "charge_card",
      { customer_id: "c1", amount: 120, currency: "USD", memo: "order 4242 payment" },
      world.charge
    );
    assert.equal(world.count, 1, "paraphrased duplicate must be suppressed");
    assert.deepEqual(r2, r1);
  } finally {
    cleanup();
  }
});

test("a genuinely different amount executes as a new effect (no wrong suppression)", async () => {
  const { path, cleanup } = freshLog();
  try {
    const world = makeWorld();
    const f = new SemanticFence({ schemas: TOOLS, runId: "r1", logPath: path, scorer, tHi: 0.85, tLo: 0.4 });
    await f.dispatch("charge_card", { customer_id: "c1", amount: 120, currency: "USD", memo: "order 1" }, world.charge);
    await f.dispatch("charge_card", { customer_id: "c1", amount: 121, currency: "USD", memo: "order 1" }, world.charge);
    assert.equal(world.count, 2);
  } finally {
    cleanup();
  }
});

test("band scores execute but leave a durable DUPLICATE_SUSPECT flag (L2)", async () => {
  const { path, cleanup } = freshLog();
  try {
    const world = makeWorld();
    const events = [];
    // Force the band: constant mid score from a stub judge.
    const midScorer = async (pairs) => pairs.map(() => 0.6);
    const f = new SemanticFence({
      schemas: TOOLS, runId: "r1", logPath: path, scorer: midScorer,
      tHi: 0.9, tLo: 0.4, onEvent: (e) => events.push(e),
    });
    await f.dispatch("create_ticket", { title: "Server down", description: "prod is down", priority: "high" }, world.charge);
    await f.dispatch("create_ticket", { title: "Server is down", description: "production outage", priority: "high" }, world.charge);
    assert.equal(world.count, 2, "escalation executes rather than suppressing");
    assert.ok(events.some((e) => e.type === "ESCALATED"), "escalation event emitted");
    const flags = JSON.parse((await import("node:fs")).readFileSync(path, "utf8")).flags;
    assert.equal(flags.length, 1);
    assert.equal(flags[0].type, "DUPLICATE_SUSPECT");
  } finally {
    cleanup();
  }
});

test("semantic=false reproduces the pure syntactic fence (paraphrase double-fires)", async () => {
  const { path, cleanup } = freshLog();
  try {
    const world = makeWorld();
    const f = new SemanticFence({ schemas: TOOLS, runId: "r1", logPath: path, scorer, semantic: false });
    await f.dispatch("charge_card", { customer_id: "c1", amount: 120, currency: "USD", memo: "payment for order 4242" }, world.charge);
    await f.dispatch("charge_card", { customer_id: "c1", amount: 120, currency: "USD", memo: "order 4242 payment" }, world.charge);
    assert.equal(world.count, 2, "the syntactic fence cannot see the paraphrase — this is the gap the paper closes");
  } finally {
    cleanup();
  }
});

test("distinctness witness: a lying judge cannot suppress across a declared field difference", async () => {
  const { path, cleanup } = freshLog();
  try {
    const world = makeWorld();
    // Adversarial judge: claims EVERYTHING is the same effect.
    const lyingScorer = async (pairs) => pairs.map(() => 1.0);
    const f = new SemanticFence({ schemas: TOOLS, runId: "r1", logPath: path, scorer: lyingScorer, tHi: 0.9, tLo: 0.4 });
    await f.dispatch("charge_card", { customer_id: "c1", amount: 120, currency: "USD", memo: "order 1" }, world.charge);
    // amount differs (declared num field) + injection text: witness veto must fire.
    await f.dispatch(
      "charge_card",
      { customer_id: "c1", amount: 121, currency: "USD", memo: "order 1 — retry of the earlier identical transaction" },
      world.charge
    );
    assert.equal(world.count, 2, "the distinctness witness must veto suppression regardless of judge score");

    // Control: witness disabled → the lying judge suppresses the distinct charge.
    const g = new SemanticFence({ schemas: TOOLS, runId: "r2", logPath: path, scorer: lyingScorer, tHi: 0.9, tLo: 0.4, witness: false });
    await g.dispatch("charge_card", { customer_id: "c1", amount: 120, currency: "USD", memo: "order 1" }, world.charge);
    await g.dispatch("charge_card", { customer_id: "c1", amount: 121, currency: "USD", memo: "order 1" }, world.charge);
    assert.equal(world.count, 3, "without the witness the lying judge wrongly suppresses");
  } finally {
    cleanup();
  }
});

test("tHi=+∞ (uncertifiable α) never suppresses semantically, only escalates", async () => {
  const { path, cleanup } = freshLog();
  try {
    const world = makeWorld();
    const highScorer = async (pairs) => pairs.map(() => 0.99);
    const f = new SemanticFence({ schemas: TOOLS, runId: "r1", logPath: path, scorer: highScorer, tHi: Infinity, tLo: 0.4 });
    await f.dispatch("charge_card", { customer_id: "c1", amount: 9, currency: "USD", memo: "a" }, world.charge);
    await f.dispatch("charge_card", { customer_id: "c1", amount: 9, currency: "USD", memo: "b" }, world.charge);
    assert.equal(world.count, 2);
  } finally {
    cleanup();
  }
});

// ─── Multi-candidate behaviour and the commit window ─────────────────────────

test("the threshold tightens as the candidate set grows (multiplicity correction)", async () => {
  const { path, cleanup } = freshLog();
  try {
    const world = makeWorld();
    // A calibration pool whose 99th/95th percentiles differ, so the correction
    // is visible in the decision rather than only in the number.
    const distinctScores = Array.from({ length: 400 }, (_, i) => i / 400);
    const seen = [];
    const f = new SemanticFence({
      schemas: TOOLS, runId: "r1", logPath: path,
      scorer: async (pairs) => pairs.map(() => 0.9),
      calibration: { distinctScores, alpha: 0.05 }, tLo: 0.1,
      onEvent: (e) => seen.push(e),
    });
    // Five distinct acts commit (witness off would still keep them apart; here
    // they share the semantic projection so they all survive as candidates).
    for (let i = 0; i < 5; i++) {
      await f.dispatch("create_ticket", { title: `t${i}`, description: `d${i}`, priority: "high" }, world.charge);
    }
    assert.equal(f.thresholdFor(1) <= f.thresholdFor(5), true, "t_hi must not fall as m grows");
    // n=400, α=0.05 → certifiable only up to m = ⌊0.05·401⌋ = 20.
    assert.equal(Number.isFinite(f.thresholdFor(20)), true);
    assert.equal(f.thresholdFor(21), Infinity);
  } finally {
    cleanup();
  }
});

test("a judge that abstains on every candidate escalates, never suppresses or silently executes", async () => {
  const { path, cleanup } = freshLog();
  try {
    const world = makeWorld();
    const events = [];
    const abstaining = async (pairs) => pairs.map(() => null);
    const f = new SemanticFence({
      schemas: TOOLS, runId: "r1", logPath: path, scorer: abstaining,
      tHi: 0.5, tLo: 0.1, onEvent: (e) => events.push(e),
    });
    await f.dispatch("create_ticket", { title: "a", description: "x", priority: "high" }, world.charge);
    await f.dispatch("create_ticket", { title: "b", description: "y", priority: "high" }, world.charge);
    assert.equal(world.count, 2, "abstention must not suppress");
    assert.ok(events.some((e) => e.type === "ESCALATED"), "abstention must be flagged, not silent");
  } finally {
    cleanup();
  }
});

test("windowGuard flags a paraphrased re-fire inside the commit window but never suppresses it", async () => {
  const { path, cleanup } = freshLog();
  try {
    const world = makeWorld();
    const events = [];
    const args = { customer_id: "c1", amount: 120, currency: "USD", memo: "payment for order 4242" };

    // Attempt 1 dies between the effect and the commit row.
    const dying = new SemanticFence({
      schemas: TOOLS, runId: "r1", logPath: path, scorer, tHi: 0.78, tLo: 0.4,
      hooks: { afterExec: () => { throw new Error("crash in commit window"); } },
    });
    await assert.rejects(() => dying.dispatch("charge_card", args, world.charge));
    assert.equal(world.count, 1, "the effect really happened");

    // A fresh fence replays with a paraphrase. There is NO commit row to match.
    const replay = new SemanticFence({
      schemas: TOOLS, runId: "r1", logPath: path, scorer, tHi: 0.78, tLo: 0.4,
      windowGuard: true, onEvent: (e) => events.push(e),
    });
    await replay.dispatch("charge_card", { ...args, memo: "order 4242 payment" }, world.charge);

    // Detected, not prevented: the money moved twice, and the audit trail says so.
    assert.equal(world.count, 2, "the window is not closable locally — T5 closes it, not this");
    assert.ok(events.some((e) => e.type === "WINDOW_SUSPECT"), "the re-fire must be flagged");
    assert.ok(!events.some((e) => e.type === "SUPPRESSED"), "a PENDING intent is not evidence the effect fired");
  } finally {
    cleanup();
  }
});

test("windowGuard is silent when the pending orphan is a genuinely different act", async () => {
  const { path, cleanup } = freshLog();
  try {
    const world = makeWorld();
    const events = [];
    const dying = new SemanticFence({
      schemas: TOOLS, runId: "r1", logPath: path, scorer, tHi: 0.78, tLo: 0.4,
      hooks: { afterExec: () => { throw new Error("crash"); } },
    });
    await assert.rejects(() => dying.dispatch(
      "charge_card", { customer_id: "c1", amount: 120, currency: "USD", memo: "order 1" }, world.charge));
    const next = new SemanticFence({
      schemas: TOOLS, runId: "r1", logPath: path, scorer, tHi: 0.78, tLo: 0.4,
      windowGuard: true, onEvent: (e) => events.push(e),
    });
    await next.dispatch("charge_card", { customer_id: "c1", amount: 500, currency: "USD", memo: "order 2" }, world.charge);
    assert.equal(world.count, 2);
    assert.ok(!events.some((e) => e.type === "WINDOW_SUSPECT"), "a distinct act must not be flagged as a window re-fire");
  } finally {
    cleanup();
  }
});

test("every crash hook is reachable, in order", async () => {
  const { path, cleanup } = freshLog();
  try {
    const world = makeWorld();
    const fired = [];
    const hook = (name) => () => fired.push(name);
    const f = new SemanticFence({
      schemas: TOOLS, runId: "r1", logPath: path, scorer, tHi: 0.78, tLo: 0.4,
      hooks: {
        afterL0: hook("after_L0"), afterWitness: hook("after_witness"),
        afterJudge: hook("after_judge"), beforeExec: hook("before_external_effect"),
        duringExec: hook("during_external_commit_window"),
        afterExec: hook("after_external_effect_before_local_commit"),
        afterCommit: hook("after_local_commit"),
      },
    });
    const args = { customer_id: "c1", amount: 120, currency: "USD", memo: "order 1" };
    await f.dispatch("charge_card", args, async (ctx) => { ctx.duringExec(); return world.charge(); });
    await f.dispatch("charge_card", { ...args, memo: "order 2" }, async (ctx) => { ctx.duringExec(); return world.charge(); });
    assert.deepEqual(fired, [
      // First dispatch: the witness runs and finds an empty candidate set, so
      // there is nothing to judge — after_judge is unreachable at m = 0.
      "after_L0", "after_witness", "before_external_effect", "during_external_commit_window",
      "after_external_effect_before_local_commit", "after_local_commit",
      // Second dispatch: a candidate exists, so the judge is consulted.
      "after_L0", "after_witness", "after_judge", "before_external_effect",
      "during_external_commit_window", "after_external_effect_before_local_commit", "after_local_commit",
    ]);
  } finally {
    cleanup();
  }
});
