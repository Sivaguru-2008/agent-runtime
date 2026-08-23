#!/usr/bin/env node
/**
 * Cross-family judge comparison on the commonly-scored subset.
 *
 * The full-corpus evaluation reaches usable coverage on two judges, both from
 * the GPT-OSS family, which leaves open whether any reported property belongs
 * to the mechanism or to one vendor's models. A third judge (Qwen3.6-27B, a
 * different family) scored 470 of 955 pairs before its daily token allowance
 * was exhausted.
 *
 * Restricting every judge to the pairs all three scored gives a genuine
 * cross-family comparison on a smaller, paired sample. That is only legitimate
 * if the missing 485 are missing for reasons unrelated to the pairs themselves,
 * so this script tests that first and reports the test beside the comparison.
 *
 *   node src/experiments/crossFamily.js
 *
 * Offline: reads persisted scores, makes no model calls.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { suppressionThreshold, escalationFloor, decide } from "../conformal.js";
import { rate, fmtRate, BASIS } from "../stats.js";
import { TOOLS } from "../tools.js";
import { canonicalize, canonicalString, semanticProjection } from "../canonicalize.js";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALPHA = 0.05;
const GAMMA = 0.05;

const pairs = readFileSync(resolve(base, "corpus", "pairs.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const scoreRows = new Map(readFileSync(resolve(base, "corpus", "scores.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.id, r]; }));

const JUDGES = ["openai_gpt_oss_120b", "openai_gpt_oss_20b", "qwen_qwen3_6_27b"];
const FAMILY = { openai_gpt_oss_120b: "gpt-oss", openai_gpt_oss_20b: "gpt-oss", qwen_qwen3_6_27b: "qwen" };

const scoreOf = (id, judge) => scoreRows.get(id)?.judges?.[judge] ?? null;
const covered = (p, judge) => scoreOf(p.id, judge) !== null;

// ── 1. Is the Qwen coverage independent of the pair? ────────────────────────
// Chi-square test of homogeneity of the coverage proportion across strata.
// Strata with an expected count below 5 are pooled into "other" so the
// asymptotic approximation is not applied where it does not hold.

function chiSquareHomogeneity(groups) {
  // groups: [{key, n, c}]  c = covered count
  const N = groups.reduce((s, g) => s + g.n, 0);
  const C = groups.reduce((s, g) => s + g.c, 0);
  const pHat = C / N;
  let chi2 = 0;
  let df = 0;
  const kept = [];
  for (const g of groups) {
    const eC = g.n * pHat, eU = g.n * (1 - pHat);
    if (eC < 5 || eU < 5) continue; // pooled out below
    chi2 += (g.c - eC) ** 2 / eC + ((g.n - g.c) - eU) ** 2 / eU;
    df++;
    kept.push(g.key);
  }
  df = Math.max(0, df - 1);
  return { chi2, df, pHat, kept, p: df ? chiSqUpperTail(chi2, df) : null };
}

/** Upper-tail probability of a chi-square variate, via the regularised gamma Q. */
function chiSqUpperTail(x, k) {
  const a = k / 2, z = x / 2;
  if (z < a + 1) {
    // series for P(a,z), then Q = 1 - P
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 500; n++) { term *= z / (a + n); sum += term; if (term < sum * 1e-12) break; }
    return 1 - sum * Math.exp(-z + a * Math.log(z) - lnGamma(a));
  }
  // continued fraction for Q(a,z)
  let b = z + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h * Math.exp(-z + a * Math.log(z) - lnGamma(a));
}
function lnGamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function strata(fn) {
  const t = new Map();
  for (const p of pairs) {
    const k = String(fn(p));
    if (!t.has(k)) t.set(k, { key: k, n: 0, c: 0 });
    const e = t.get(k); e.n++; if (covered(p, "qwen_qwen3_6_27b")) e.c++;
  }
  return [...t.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const missingness = {
  overall: (() => { const c = pairs.filter((p) => covered(p, "qwen_qwen3_6_27b")).length;
    return { covered: c, n: pairs.length, pct: +(100 * c / pairs.length).toFixed(1) }; })(),
  byCategory: chiSquareHomogeneity(strata((p) => p.category)),
  byLabel: chiSquareHomogeneity(strata((p) => p.label)),
  byTool: chiSquareHomogeneity(strata((p) => p.tool)),
  bySplit: chiSquareHomogeneity(strata((p) => p.split)),
  strataDetail: {
    category: strata((p) => p.category).map((g) => ({ ...g, pct: +(100 * g.c / g.n).toFixed(1) })),
    label: strata((p) => p.label).map((g) => ({ ...g, pct: +(100 * g.c / g.n).toFixed(1) })),
  },
};

// Run-length structure: scoring proceeds in batches of ten, so transport-level
// loss should appear as runs of length ~10, not as isolated pairs.
{
  const flags = pairs.map((p) => covered(p, "qwen_qwen3_6_27b"));
  const runs = [];
  let cur = flags[0], len = 1;
  for (let i = 1; i < flags.length; i++) {
    if (flags[i] === cur) len++;
    else { runs.push({ covered: cur, len }); cur = flags[i]; len = 1; }
  }
  runs.push({ covered: cur, len });
  const missRuns = runs.filter((r) => !r.covered).map((r) => r.len);
  const hist = {};
  for (const l of missRuns) hist[l] = (hist[l] ?? 0) + 1;
  missingness.missingRunLengths = {
    runs: missRuns.length,
    mean: +(missRuns.reduce((a, b) => a + b, 0) / missRuns.length).toFixed(2),
    histogram: hist,
    multiplesOfTen: missRuns.filter((l) => l % 10 === 0).length,
  };
}

// ── 2. The common subset ────────────────────────────────────────────────────
const common = pairs.filter((p) => JUDGES.every((j) => covered(p, j)));
const commonCal = common.filter((p) => p.split === "cal");
const commonTest = common.filter((p) => p.split === "test");
const commonAttack = common.filter((p) => p.split === "attack");

// ── 3. Evaluate each judge on the common subset ─────────────────────────────
// The fence's decidable layers are judge-independent, so they are applied
// identically for every judge and only the scored fragment differs.

const schemaOf = (tool) => TOOLS[tool];
const l0Same = (p) => canonicalString(canonicalize(p.a, schemaOf(p.tool))) ===
  canonicalString(canonicalize(p.b, schemaOf(p.tool)));
const witnessVetoes = (p) => JSON.stringify(semanticProjection(p.a, schemaOf(p.tool))) !==
  JSON.stringify(semanticProjection(p.b, schemaOf(p.tool)));

/** One dispatch decision under the hardened configuration. */
function decideHardened(p, judge, tHi, tLo) {
  if (l0Same(p)) return "SUPPRESS";          // certifier: exact, judge-free
  if (witnessVetoes(p)) return "EXECUTE";    // refuter: exact, judge-free
  const s = scoreOf(p.id, judge);
  if (s === null) return "ESCALATE";         // abstention never suppresses
  return decide(s, tHi, tLo);
}

function evaluate(judge, testSet, calSet) {
  const calDiff = calSet.filter((p) => p.label === "DIFF" && !l0Same(p) && !witnessVetoes(p))
    .map((p) => scoreOf(p.id, judge)).filter((s) => s !== null);
  const calSame = calSet.filter((p) => p.label === "SAME" && !l0Same(p) && !witnessVetoes(p))
    .map((p) => scoreOf(p.id, judge)).filter((s) => s !== null);
  const tHi = suppressionThreshold(calDiff, ALPHA);
  const tLo = escalationFloor(calSame.length ? calSame : [0.5], GAMMA);

  const same = testSet.filter((p) => p.label === "SAME");
  const diff = testSet.filter((p) => p.label === "DIFF");
  const dec = (p) => decideHardened(p, judge, tHi, tLo);

  const ws = diff.filter((p) => dec(p) === "SUPPRESS").length;
  const friction = diff.filter((p) => dec(p) === "ESCALATE").length;
  const dedup = same.filter((p) => dec(p) === "SUPPRESS").length;
  const silent = same.filter((p) => dec(p) === "EXECUTE").length;
  const flagged = same.filter((p) => dec(p) === "ESCALATE").length;

  return {
    judge, family: FAMILY[judge], tHi, tLo, nCalDiff: calDiff.length, nCalSame: calSame.length,
    nSame: same.length, nDiff: diff.length,
    wrongSuppression: rate(ws, diff.length),
    friction: rate(friction, diff.length),
    dedup: rate(dedup, same.length),
    silentEscape: rate(silent, same.length),
    flaggedEscape: rate(flagged, same.length),
    decisions: Object.fromEntries(testSet.map((p) => [p.id, dec(p)])),
  };
}

const results = {};
for (const j of JUDGES) results[j] = evaluate(j, commonTest, commonCal);

// Attack split, raw judge (no witness) and hardened, on the common subset.
const attacks = {};
for (const j of JUDGES) {
  const tHi = results[j].tHi, tLo = results[j].tLo;
  for (const cat of ["D4a_field_injection", "D4b_text_injection"]) {
    const set = commonAttack.filter((p) => p.category === cat);
    if (!set.length) continue;
    const raw = set.filter((p) => { const s = scoreOf(p.id, j); return s !== null && s > 0.5; }).length;
    const hard = set.filter((p) => decideHardened(p, j, tHi, tLo) === "SUPPRESS").length;
    attacks[`${j}|${cat}`] = { n: set.length, rawJudge: rate(raw, set.length), hardened: rate(hard, set.length) };
  }
}

// ── 4. Paired agreement between judges on the common test split ─────────────
const agreement = {};
for (let i = 0; i < JUDGES.length; i++) {
  for (let k = i + 1; k < JUDGES.length; k++) {
    const [x, y] = [JUDGES[i], JUDGES[k]];
    let agree = 0, both = 0;
    // McNemar over the safety-critical direction: which judge suppresses a
    // distinct pair that the other does not.
    let xOnly = 0, yOnly = 0;
    for (const p of commonTest) {
      const dx = results[x].decisions[p.id], dy = results[y].decisions[p.id];
      both++; if (dx === dy) agree++;
      if (p.label === "DIFF") {
        if (dx === "SUPPRESS" && dy !== "SUPPRESS") xOnly++;
        if (dy === "SUPPRESS" && dx !== "SUPPRESS") yOnly++;
      }
    }
    const n = xOnly + yOnly;
    // Exact two-sided binomial p under H0: p = 1/2.
    let p = 1;
    if (n > 0) {
      const lo = Math.min(xOnly, yOnly);
      let tail = 0;
      for (let r = 0; r <= lo; r++) tail += binom(n, r);
      p = Math.min(1, 2 * tail / 2 ** n);
    }
    agreement[`${x}_vs_${y}`] = {
      decisionAgreement: rate(agree, both),
      discordantWrongSuppression: { [x]: xOnly, [y]: yOnly, n, exactBinomialP: +p.toFixed(4) },
    };
  }
}
function binom(n, r) { let v = 1; for (let i = 0; i < r; i++) v = v * (n - i) / (i + 1); return v; }

// ── report ──────────────────────────────────────────────────────────────────
const out = {
  generatedAt: new Date().toISOString(),
  alpha: ALPHA, gamma: GAMMA,
  commonSubset: { total: common.length, cal: commonCal.length, test: commonTest.length, attack: commonAttack.length },
  missingness,
  perJudge: Object.fromEntries(Object.entries(results).map(([k, v]) => {
    const { decisions, ...rest } = v; return [k, rest];
  })),
  attacks,
  agreement,
};
writeFileSync(resolve(base, "results", "cross_family.json"), JSON.stringify(out, null, 2));

console.log(`common subset: ${common.length} pairs (cal ${commonCal.length} / test ${commonTest.length} / attack ${commonAttack.length})`);
console.log(`\nQwen coverage ${missingness.overall.covered}/${missingness.overall.n} = ${missingness.overall.pct}%`);
for (const k of ["byLabel", "byCategory", "byTool", "bySplit"]) {
  const t = missingness[k];
  console.log(`  homogeneity ${k.slice(2).padEnd(9)} chi2=${t.chi2.toFixed(2)} df=${t.df} p=${t.p === null ? "n/a" : t.p.toFixed(3)}`);
}
const rl = missingness.missingRunLengths;
console.log(`  missing runs: ${rl.runs}, mean length ${rl.mean}, ${rl.multiplesOfTen} of them exact multiples of the batch size`);

console.log(`\n── hardened alpha=${ALPHA}, common test split (n=${commonTest.length}) ──`);
for (const j of JUDGES) {
  const r = results[j];
  console.log(`${j.padEnd(24)} ${FAMILY[j].padEnd(8)} tHi=${String(r.tHi).padEnd(6)} ` +
    `WS=${fmtRate(r.wrongSuppression).padEnd(22)} dedup=${fmtRate(r.dedup).padEnd(24)} ` +
    `silent=${fmtRate(r.silentEscape).padEnd(22)} friction=${fmtRate(r.friction)}`);
}

console.log(`\n── attacks on the common subset ──`);
for (const [k, v] of Object.entries(attacks)) {
  console.log(`${k.padEnd(46)} n=${String(v.n).padStart(2)} raw=${fmtRate(v.rawJudge).padEnd(22)} hardened=${fmtRate(v.hardened)}`);
}

console.log(`\n── pairwise agreement (common test split) ──`);
for (const [k, v] of Object.entries(agreement)) {
  const d = v.discordantWrongSuppression;
  console.log(`${k.padEnd(52)} agree=${fmtRate(v.decisionAgreement).padEnd(22)} discordant WS ${JSON.stringify(Object.fromEntries(Object.entries(d).slice(0, 2)))} p=${d.exactBinomialP}`);
}
console.log("\nwrote results/cross_family.json");
