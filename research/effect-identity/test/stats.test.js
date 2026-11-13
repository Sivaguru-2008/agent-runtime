import { test } from "node:test";
import assert from "node:assert/strict";
import { wilson, rate, fmtRate, BASIS, zeroEventUpperBound95 } from "../src/stats.js";
import { stripReasoning, extractJson } from "../src/groq.js";
import { validParaphrase, FALLBACK_POOL } from "../src/experiments/wireParaphrases.js";

test("wilson interval brackets the point estimate", () => {
  const w = wilson(20, 100);
  assert.equal(w.point, 0.2);
  assert.ok(w.lo < 0.2 && 0.2 < w.hi, `expected ${w.lo} < 0.2 < ${w.hi}`);
  // Published Wilson 95% interval for 20/100 is ≈ [0.133, 0.290].
  assert.ok(Math.abs(w.lo - 0.1332) < 0.002, `lo=${w.lo}`);
  assert.ok(Math.abs(w.hi - 0.2900) < 0.002, `hi=${w.hi}`);
});

test("wilson does not collapse at zero observed events", () => {
  // The Wald interval degenerates to [0,0] here — exactly the case our
  // headline rates live in, and the reason Wilson is used instead.
  const w = wilson(0, 72);
  assert.equal(w.point, 0);
  assert.equal(w.lo, 0);
  assert.ok(w.hi > 0.03 && w.hi < 0.07, `0/72 upper bound should be ≈5%, got ${w.hi}`);
});

test("zero-event upper bound tightens as n grows", () => {
  const small = zeroEventUpperBound95(72);
  const large = zeroEventUpperBound95(206);
  assert.ok(small > large, "more DIFF pairs must tighten the safety bound");
  assert.ok(Math.abs(large - 3 / 206) < 1e-9);
});

test("wilson returns null for an empty sample", () => {
  assert.equal(wilson(0, 0), null);
  assert.equal(rate(0, 0).ci95, null);
});

test("rate records the basis that justifies a zero", () => {
  const measured = rate(0, 206);
  const provable = rate(0, 20, BASIS.PROVABLE_A5PRIME);
  assert.equal(measured.basis, BASIS.MEASURED);
  assert.equal(provable.basis, BASIS.PROVABLE_A5PRIME);
  // A provable zero is marked so a reader never mistakes it for an estimate.
  assert.ok(!fmtRate(measured).includes("†"));
  assert.ok(fmtRate(provable).includes("†"));
});

test("fmtRate reports the interval alongside the point estimate", () => {
  const s = fmtRate(rate(0, 206));
  assert.match(s, /^0\.0% \[0\.0–\d+\.\d\]$/u, `got ${s}`);
});

test("stripReasoning removes think blocks before JSON extraction", () => {
  // Qwen-family output: the scratchpad quotes a DIFFERENT array than the
  // answer. Extracting the first JSON from the raw text would return the
  // model's musing and silently corrupt every score in the batch.
  const raw = '<think>Maybe [{"i":0,"p_same":99}] is right?</think>\n[{"i":0,"p_same":3}]';
  assert.equal(stripReasoning(raw), '[{"i":0,"p_same":3}]');
  assert.deepEqual(extractJson(raw), [{ i: 0, p_same: 3 }]);
});

test("stripReasoning handles a scratchpad truncated by the token cap", () => {
  assert.equal(stripReasoning("<think>reasoning that never closed"), "");
});

test("paraphrase validator preserves the intended act", () => {
  for (const p of FALLBACK_POOL) {
    assert.ok(validParaphrase(p), `fallback pool member rejected: ${JSON.stringify(p)}`);
  }
});

test("paraphrase validator rejects act-changing rewrites", () => {
  const base = FALLBACK_POOL[0];
  // A changed amount is the error that would silently turn a correct
  // suppression into a wrong one and invalidate the crash/replay ground truth.
  assert.ok(!validParaphrase({ ...base, amount_text: "seven hundred ninety dollars" }));
  // A changed beneficiary is a different act.
  assert.ok(!validParaphrase({ ...base, beneficiary_text: "Acme Logistics" }));
  // A changed shipment reference is a different act.
  assert.ok(!validParaphrase({ ...base, reference: "shipment #88214" }));
  // An extra stray number makes the amount ambiguous.
  assert.ok(!validParaphrase({ ...base, amount_text: "780 or 800 dollars" }));
  assert.ok(!validParaphrase({ ...base, amount_text: "" }));
});
