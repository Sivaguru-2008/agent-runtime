#!/usr/bin/env node
/**
 * Two validity analyses the interval-per-rate reporting does not cover.
 *
 * (1) LABEL SENSITIVITY. Every label is assigned by construction, so the ground
 *     truth is the authors' operationalisation of "the same action". An
 *     independent annotation study is the right control and we have not run
 *     one. What we can do instead is identify the categories on which a careful
 *     reader could reasonably disagree with us, flip them, and report how far
 *     the conclusions move. A conclusion that survives the flip does not depend
 *     on our definition; one that does not, does.
 *
 * (2) PAIRED TESTS. Configurations are evaluated on identical test items, so
 *     comparing them through overlapping Wilson intervals is needlessly weak
 *     and slightly wrong: the intervals ignore the pairing. McNemar's exact
 *     test uses it. We apply it to the comparisons the paper actually draws
 *     conclusions from, and state how many comparisons that is.
 *
 *   node src/experiments/sensitivity.js
 *
 * Offline: reads persisted scores, makes no model calls.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { suppressionThreshold, escalationFloor, decide } from "../conformal.js";
import { rate, fmtRate } from "../stats.js";
import { TOOLS } from "../tools.js";
import { canonicalize, canonicalString, semanticProjection } from "../canonicalize.js";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALPHA = 0.05, GAMMA = 0.05;
const PRIMARY = "openai_gpt_oss_120b";

const pairs = readFileSync(resolve(base, "corpus", "pairs.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rows = new Map(readFileSync(resolve(base, "corpus", "scores.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.id, r]; }));
const scoreOf = (id, j) => rows.get(id)?.judges?.[j] ?? null;

for (const p of pairs) {
  const s = TOOLS[p.tool];
  p.l0Equal = canonicalString(canonicalize(p.a, s)) === canonicalString(canonicalize(p.b, s));
  p.witnessVeto = semanticProjection(p.a, s) !== semanticProjection(p.b, s);
  p.residual = !p.l0Equal && !p.witnessVeto;
}
const cal = pairs.filter((p) => p.split === "cal");
const test = pairs.filter((p) => p.split === "test");

/** Hardened decision, calibrated on its own jurisdiction, under a labelling. */
function run(judge, labelOf) {
  const calDiff = cal.filter((p) => labelOf(p) === "DIFF" && p.residual && scoreOf(p.id, judge) !== null)
    .map((p) => scoreOf(p.id, judge));
  const calSame = cal.filter((p) => labelOf(p) === "SAME" && p.residual && scoreOf(p.id, judge) !== null)
    .map((p) => scoreOf(p.id, judge));
  const tHi = suppressionThreshold(calDiff, ALPHA);
  const tLo = Math.min(escalationFloor(calSame.length ? calSame : [0.5], GAMMA), tHi === Infinity ? Infinity : tHi);
  const dec = (p) => {
    if (p.l0Equal) return "SUPPRESS";
    if (p.witnessVeto) return "EXECUTE";
    const s = scoreOf(p.id, judge);
    if (s === null) return "ESCALATE";
    return decide(s, tHi, tLo);
  };
  const same = test.filter((p) => labelOf(p) === "SAME");
  const diff = test.filter((p) => labelOf(p) === "DIFF");
  return {
    tHi, nCalDiff: calDiff.length, nSame: same.length, nDiff: diff.length,
    wrongSuppression: rate(diff.filter((p) => dec(p) === "SUPPRESS").length, diff.length),
    dedup: rate(same.filter((p) => dec(p) === "SUPPRESS").length, same.length),
    silentEscape: rate(same.filter((p) => dec(p) === "EXECUTE").length, same.length),
    friction: rate(diff.filter((p) => dec(p) === "ESCALATE").length, diff.length),
    decide: dec,
  };
}

// ── (1) label sensitivity ───────────────────────────────────────────────────
/**
 * Which categories are genuinely contestable?
 *
 * D1 mutates a declared field (amount, id), and D3 is hand-built to differ in
 * intent: calling those SAME would be an error, not a disagreement. S1 is
 * whitespace and case. S2/S3 preserve every pinned value under a validator.
 * That leaves D2 — "installment 1 of 2" against "installment 2 of 2" — where a
 * reader who holds that a repeat of the same amount to the same payee under the
 * same reference is one act would label the pair SAME. We think it is DIFF; we
 * do not think the alternative is unreasonable, and D2 carries most of the
 * mechanism's wrong suppressions, so the choice is load-bearing.
 */
const LABELLINGS = {
  asConstructed: (p) => p.label,
  d2AsSame: (p) => (p.category === "D2_legit_repeat" ? "SAME" : p.label),
  // A third, stricter reading: adversarial paraphrase (S4) was generated to be
  // maximally surface-different, and a reader could hold that some of those
  // rewrites no longer denote the same act. Treating S4 as DIFF is the most
  // hostile reading of our own corpus.
  s4AsDiff: (p) => (p.category === "S4_adversarial" ? "DIFF" : p.label),
};

const labelSensitivity = {};
for (const [name, fn] of Object.entries(LABELLINGS)) {
  const r = run(PRIMARY, fn);
  const { decide: _d, ...rest } = r;
  labelSensitivity[name] = rest;
}

// Where do the wrong suppressions actually fall?
const baseRun = run(PRIMARY, LABELLINGS.asConstructed);
const wsByCategory = {};
for (const p of test.filter((q) => q.label === "DIFF")) {
  if (baseRun.decide(p) !== "SUPPRESS") continue;
  wsByCategory[p.category] = (wsByCategory[p.category] ?? 0) + 1;
}

// ── (2) paired tests ────────────────────────────────────────────────────────
/** Exact two-sided McNemar over discordant pairs. */
function mcnemar(b, c) {
  const n = b + c;
  if (n === 0) return { b, c, n, p: 1 };
  const lo = Math.min(b, c);
  let tail = 0;
  for (let r = 0; r <= lo; r++) {
    let ch = 1;
    for (let i = 0; i < r; i++) ch = ch * (n - i) / (i + 1);
    tail += ch;
  }
  return { b, c, n, p: +Math.min(1, 2 * tail / 2 ** n).toFixed(4) };
}

/** Decisions for one named configuration, calibrated on its own jurisdiction. */
function config({ l0 = true, witness = true, judge = PRIMARY, tau = null }) {
  const inJur = (p) => (l0 ? !p.l0Equal : true) && (witness ? !p.witnessVeto : true);
  const calDiff = cal.filter((p) => p.label === "DIFF" && inJur(p) && scoreOf(p.id, judge) !== null)
    .map((p) => scoreOf(p.id, judge));
  const calSame = cal.filter((p) => p.label === "SAME" && inJur(p) && scoreOf(p.id, judge) !== null)
    .map((p) => scoreOf(p.id, judge));
  const tHi = tau ?? suppressionThreshold(calDiff, ALPHA);
  const tLo = Math.min(escalationFloor(calSame.length ? calSame : [0.5], GAMMA), tHi === Infinity ? Infinity : tHi);
  return (p) => {
    if (l0 && p.l0Equal) return "SUPPRESS";
    if (witness && p.witnessVeto) return "EXECUTE";
    const s = scoreOf(p.id, judge);
    if (s === null) return "ESCALATE";
    return decide(s, tHi, tLo);
  };
}

const CONFIGS = {
  hardened: config({}),
  layered: config({ witness: false }),
  baselineL0: (p) => (p.l0Equal ? "SUPPRESS" : "EXECUTE"),
  rawTau05: config({ tau: 0.5 }),
  hardened20B: config({ judge: "openai_gpt_oss_20b" }),
};

/** Compare two configs on a paired outcome over a subset. */
function compare(aName, bName, subset, isCorrect) {
  const A = CONFIGS[aName], B = CONFIGS[bName];
  let b = 0, c = 0;
  for (const p of subset) {
    const ok1 = isCorrect(A(p), p), ok2 = isCorrect(B(p), p);
    if (ok1 && !ok2) b++;
    if (!ok1 && ok2) c++;
  }
  return { [aName]: b, [bName]: c, ...mcnemar(b, c) };
}

const sameTest = test.filter((p) => p.label === "SAME");
const diffTest = test.filter((p) => p.label === "DIFF");
const dedupOK = (d) => d === "SUPPRESS";
const noWS = (d) => d !== "SUPPRESS";

const paired = {
  "dedup: hardened vs canonical baseline": compare("hardened", "baselineL0", sameTest, dedupOK),
  "dedup: layered vs hardened": compare("layered", "hardened", sameTest, dedupOK),
  "wrong-suppression: hardened vs layered": compare("hardened", "layered", diffTest, noWS),
  "dedup: hardened vs raw tau=0.5": compare("hardened", "rawTau05", sameTest, dedupOK),
  "dedup: 120B vs 20B (hardened)": compare("hardened", "hardened20B", sameTest, dedupOK),
  "wrong-suppression: 120B vs 20B (hardened)": compare("hardened", "hardened20B", diffTest, noWS),
};
const nComparisons = Object.keys(paired).length;
for (const v of Object.values(paired)) v.holmAdjusted = null;
// Holm-Bonferroni over the family of comparisons reported here.
{
  const entries = Object.entries(paired).sort((x, y) => x[1].p - y[1].p);
  entries.forEach(([k, v], i) => {
    const adj = Math.min(1, v.p * (nComparisons - i));
    paired[k].holmAdjusted = +Math.max(adj, i ? entries[i - 1][1].holmAdjusted ?? 0 : 0).toFixed(4);
  });
}

const out = {
  generatedAt: new Date().toISOString(), alpha: ALPHA, judge: PRIMARY,
  labelSensitivity, wrongSuppressionByCategory: wsByCategory,
  paired, familySize: nComparisons,
};
writeFileSync(resolve(base, "results", "sensitivity.json"), JSON.stringify(out, null, 2));

console.log("── label sensitivity (hardened, alpha=0.05, primary judge) ──");
for (const [k, r] of Object.entries(labelSensitivity)) {
  console.log(`${k.padEnd(16)} nSame=${String(r.nSame).padStart(3)} nDiff=${String(r.nDiff).padStart(3)} tHi=${String(r.tHi).padEnd(5)} ` +
    `WS=${fmtRate(r.wrongSuppression).padEnd(22)} dedup=${fmtRate(r.dedup).padEnd(24)} silent=${fmtRate(r.silentEscape)}`);
}
console.log("\nwrong suppressions by category (as constructed):", JSON.stringify(wsByCategory));

console.log("\n── paired McNemar tests (exact, two-sided) ──");
for (const [k, v] of Object.entries(paired)) {
  const [n1, n2] = Object.keys(v).slice(0, 2);
  console.log(`${k.padEnd(44)} ${n1}-only=${String(v[n1]).padStart(3)} ${n2}-only=${String(v[n2]).padStart(3)}  p=${v.p}  Holm=${v.holmAdjusted}`);
}
console.log(`\nfamily of ${nComparisons} comparisons; Holm-Bonferroni adjusted`);
console.log("wrote results/sensitivity.json");
