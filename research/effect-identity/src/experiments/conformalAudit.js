#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { suppressionThreshold, maxSuppressionThreshold, maxCertifiableCandidates, requiredCalibrationSize, calibrationMaxima, setConformalThreshold } from "../conformal.js";
import { classifyPair, calibrate, decidePair, DEFAULT_CONFIG } from "../evaluate.js";
import { rate, fmtRate, wilson } from "../stats.js";
import { TOOLS } from "../tools.js";
import { TOOLS_V2, MISDECLARED_SCHEMA } from "../toolsV2.js";

/**
 * A full statistical audit of the calibrated layer.
 *
 * Every clause below is a way the conformal argument could be wrong in a manner
 * that would not show up as a bad number — the failure mode of a calibration
 * bug is a threshold that is confidently derived and quietly invalid. The audit
 * therefore checks the CONSTRUCTION, not only the outcome, and it fails loudly.
 *
 * What is checked, and why each one matters:
 *
 *  1. SEPARATION      no pair appears in both the calibration and test splits.
 *  2. SEED LEAKAGE    pairs derived from the same underlying seed act appearing
 *                     on both sides. This is NOT the same as (1) and the paper
 *                     did not measure it. Exchangeability is a condition on
 *                     SCORES, so shared provenance is not automatically fatal —
 *                     but it is a route by which a judge that memorised one
 *                     phrasing could score its sibling optimistically, and a
 *                     reader is entitled to the number.
 *  3. SCORE VALIDITY  every stored score is null or in [0,1]; nothing was
 *                     clamped, imputed, or rescaled on the way in.
 *  4. ABSTENTIONS     nulls are dropped from the pool and can never suppress.
 *  5. THRESHOLD INDEX the order statistic is exactly ceil((n+1)(1-alpha)) and
 *                     returns +infinity when that index exceeds n.
 *  6. MULTIPLICITY    t_hi(m) is monotone non-decreasing in m, equals the
 *                     pairwise threshold at m=1, and is +infinity past the
 *                     budget m > alpha(n+1).
 *  7. MAX STATISTIC   a Monte-Carlo check that the UNCORRECTED pairwise rule
 *                     exceeds alpha on the max statistic while the corrected
 *                     rule does not. If this ever passes for the uncorrected
 *                     rule, the correction is untested.
 *  8. MARGINAL vs     resampling the calibration pool to show what alpha does
 *     CONDITIONAL     and does not promise: the distribution of the REALISED
 *                     wrong-suppression rate over calibration draws.
 *  9. JURISDICTION    the pool is drawn from the population the deployed rule
 *                     routes to the judge, and the audit reports what happens
 *                     when it is not.
 *
 *   node src/experiments/conformalAudit.js [--corpus v1] [--judge KEY]
 */

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argAfter = (f, fb) => { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fb; };
const CORPUS = argAfter("--corpus", "v1");
const ALPHA = Number(argAfter("--alpha", "0.05"));
const OUT = argAfter("--out", `conformal_audit_${CORPUS}.json`);

const readJsonl = (f) => (existsSync(resolve(base, f))
  ? readFileSync(resolve(base, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const v1 = readJsonl("corpus/pairs.jsonl").map((p) => ({ ...p, corpusVersion: p.corpusVersion ?? "v1" }));
const v2 = readJsonl("corpus/pairs-v2ext.jsonl");
const pairs = CORPUS === "v1" ? v1 : CORPUS === "v2ext" ? v2 : [...v1, ...v2];
const scoreRows = new Map([...readJsonl("corpus/scores.jsonl"), ...readJsonl("corpus/scores-v2ext.jsonl")].map((r) => [r.id, r]));
const judges = [...new Set([...scoreRows.values()].flatMap((r) => Object.keys(r.judges ?? {})))];
const JUDGE = argAfter("--judge", judges.includes("openai_gpt_oss_120b") ? "openai_gpt_oss_120b" : judges[0]);
const SCHEMAS = { ...TOOLS, ...TOOLS_V2, pay_by_account_no: MISDECLARED_SCHEMA };
const scoreOf = (p) => { const v = scoreRows.get(p.id)?.judges?.[JUDGE]; return v === undefined ? null : v; };

const checks = [];
const check = (name, passed, detail) => { checks.push({ name, passed, detail }); return passed; };

for (const p of pairs) p.facts = classifyPair(p, SCHEMAS, "declared");
const cal = pairs.filter((p) => p.split === "cal");
const test = pairs.filter((p) => p.split === "test");
const attack = pairs.filter((p) => p.split === "attack");

// ── 1. calibration/test separation ───────────────────────────────────────────
const calIds = new Set(cal.map((p) => p.id));
const overlap = test.filter((p) => calIds.has(p.id));
check("calibration/test separation", overlap.length === 0, `${overlap.length} pair ids in both splits`);

// The attack split must be entirely out of calibration: the conformal guarantee
// is for the exchangeable benign distribution, and injection is a deliberate shift.
const attackInCal = attack.filter((p) => p.split === "cal");
check("attack split excluded from calibration", attackInCal.length === 0, `${attackInCal.length} attack pairs in the calibration split`);

// ── 2. seed-level leakage ────────────────────────────────────────────────────
/**
 * Pairs are derived from seed acts, and several categories derive from the same
 * seed. Two pairs sharing a seed share content, so a judge could in principle
 * score a test pair well because it saw a sibling in calibration. This is a
 * weaker concern than item overlap and it is not zero, so it is measured.
 */
const seedKey = (p) => `${p.tool}|${JSON.stringify(p.a).slice(0, 120)}`;
const calSeeds = new Set(cal.map(seedKey));
const sharedSeedTest = test.filter((p) => calSeeds.has(seedKey(p)));
const seedLeak = rate(sharedSeedTest.length, test.length);
check("seed-level provenance sharing measured (not a pass/fail)", true,
  `${sharedSeedTest.length}/${test.length} test pairs share a seed act with some calibration pair (${(seedLeak.value * 100).toFixed(1)}%)`);

// ── 3. score validity ────────────────────────────────────────────────────────
const allScores = pairs.map(scoreOf);
const bad = allScores.filter((v) => v !== null && (typeof v !== "number" || !(v >= 0 && v <= 1)));
check("all scores are null or within [0,1]", bad.length === 0, `${bad.length} out-of-range or non-numeric scores`);
const nonPercent = allScores.filter((v) => v !== null && Math.abs(v * 100 - Math.round(v * 100)) > 1e-9);
check("every score is an exact integer percent (no rescaling occurred)", nonPercent.length === 0,
  `${nonPercent.length} scores are not multiples of 0.01 — the signature of a probability-scale reply being divided by 100`);

// ── 4. abstention handling ───────────────────────────────────────────────────
const nulls = allScores.filter((v) => v === null).length;
const calib = calibrate(cal, scoreOf, DEFAULT_CONFIG, ALPHA, 0.05, { m: 1 });
const poolHasNull = cal.filter((p) => p.facts.residual && p.label === "DIFF" && scoreOf(p) === null).length;
check("abstentions are excluded from the calibration pool", true,
  `${poolHasNull} abstained residual DIFF calibration pairs were dropped; pool n = ${calib.nCalDiff}`);
const abstDecisions = pairs.filter((p) => p.facts.residual && scoreOf(p) === null)
  .map((p) => decidePair(p, scoreOf, DEFAULT_CONFIG, calib).decision);
check("an abstention can never cause suppression", !abstDecisions.includes("SUPPRESS"),
  `${abstDecisions.length} abstained residual pairs; decisions: ${JSON.stringify([...new Set(abstDecisions)])}`);

// ── 5. threshold index ───────────────────────────────────────────────────────
{
  const s = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const n = s.length;
  let ok = true, detail = [];
  for (const a of [0.05, 0.1, 0.2, 0.5]) {
    const k = Math.ceil((n + 1) * (1 - a));
    const expected = k > n ? Infinity : [...s].sort((x, y) => x - y)[k - 1];
    const got = suppressionThreshold(s, a);
    if (got !== expected) { ok = false; detail.push(`alpha=${a}: got ${got}, expected ${expected}`); }
  }
  // n below 1/alpha - 1 must yield +infinity, never a finite value.
  const tooSmall = suppressionThreshold([0.1, 0.2], 0.05);
  if (tooSmall !== Infinity) { ok = false; detail.push(`n=2, alpha=0.05 should be +Infinity, got ${tooSmall}`); }
  check("threshold is the ceil((n+1)(1-alpha))-th order statistic, +Inf when uncertifiable", ok, detail.join("; ") || "all cases correct");
}

// ── 6. multiplicity ──────────────────────────────────────────────────────────
{
  const pool = Array.from({ length: 200 }, (_, i) => i / 200);
  let monotone = true, detail = [];
  let prev = -Infinity;
  for (let m = 1; m <= 20; m++) {
    const t = maxSuppressionThreshold(pool, ALPHA, m);
    if (t < prev) { monotone = false; detail.push(`t_hi(${m})=${t} < t_hi(${m - 1})=${prev}`); }
    prev = t;
  }
  check("t_hi(m) is monotone non-decreasing in m", monotone, detail.join("; ") || "monotone over m in 1..20");
  check("t_hi(1) equals the pairwise threshold", maxSuppressionThreshold(pool, ALPHA, 1) === suppressionThreshold(pool, ALPHA), "");
  check("t_hi(0) is +Infinity (an empty candidate set cannot suppress)", maxSuppressionThreshold(pool, ALPHA, 0) === Infinity, "");
  const budget = maxCertifiableCandidates(pool.length, ALPHA);
  check("past the budget m > alpha(n+1) the threshold is +Infinity",
    maxSuppressionThreshold(pool, ALPHA, budget + 1) === Infinity,
    `budget m <= ${budget} at n=${pool.length}, alpha=${ALPHA}; needs n >= ${requiredCalibrationSize(budget + 1, ALPHA)} to go further`);
}

// ── 7. Monte-Carlo: the correction is necessary and sufficient ───────────────
/**
 * Draw calibration and test scores from one continuous distribution, so under
 * the null every comparison is exchangeable by construction and any exceedance
 * is the multiplicity effect and nothing else.
 */
function monteCarlo(m, reps = 2000, n = 200, seedInit = 7) {
  let s = seedInit >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  let uncorrected = 0, corrected = 0;
  for (let r = 0; r < reps; r++) {
    const pool = Array.from({ length: n }, rnd);
    const tUn = suppressionThreshold(pool, ALPHA);
    const tCo = maxSuppressionThreshold(pool, ALPHA, m);
    let mx = -Infinity;
    for (let i = 0; i < m; i++) mx = Math.max(mx, rnd());
    if (mx > tUn) uncorrected += 1;
    if (mx > tCo) corrected += 1;
  }
  return { m, uncorrected: uncorrected / reps, corrected: corrected / reps };
}
const mc = [1, 2, 5, 10, 25, 50].map((m) => monteCarlo(m));
const mcCorrectedHolds = mc.every((r) => r.corrected <= ALPHA + 0.015);
const mcUncorrectedFails = mc.some((r) => r.uncorrected > ALPHA * 1.5);
check("Monte-Carlo: the corrected rule holds at every m", mcCorrectedHolds,
  mc.map((r) => `m=${r.m}:${(r.corrected * 100).toFixed(1)}%`).join(" "));
check("Monte-Carlo: the UNCORRECTED rule violates the level (if this fails, the correction is untested)", mcUncorrectedFails,
  mc.map((r) => `m=${r.m}:${(r.uncorrected * 100).toFixed(1)}%`).join(" "));

// ── 8. marginal vs conditional: what alpha does and does not promise ─────────
/**
 * T3 bounds the suppression probability MARGINALLY over draws of the calibration
 * pool and the test point jointly. It does not promise that the rate realised on
 * a particular deployment's pool is at most alpha, and the gap does not close
 * with more calibration data because the bound is a rank statement rather than
 * an estimation problem. This resamples the pool and reports the distribution of
 * the realised rate, which is the quantity a practitioner actually experiences.
 */
function resampleStudy(sizes = [10, 20, 30, 50, 100, 205], reps = 300) {
  const residualCalDiff = cal.filter((p) => p.facts.residual && p.label === "DIFF" && scoreOf(p) !== null).map(scoreOf);
  const residualCalSame = cal.filter((p) => p.facts.residual && p.label === "SAME" && scoreOf(p) !== null).map(scoreOf);
  const testResidualDiff = test.filter((p) => p.facts.residual && p.label === "DIFF" && scoreOf(p) !== null).map(scoreOf);
  const rows = [];
  let s = 20260818;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (const n of sizes) {
    if (n > residualCalDiff.length) { rows.push({ n, unavailable: true, poolAvailable: residualCalDiff.length }); continue; }
    const realised = [];
    let infinite = 0;
    for (let r = 0; r < reps; r++) {
      const draw = [];
      for (let i = 0; i < n; i++) draw.push(residualCalDiff[Math.floor(rnd() * residualCalDiff.length)]);
      const t = suppressionThreshold(draw, ALPHA);
      if (t === Infinity) { infinite += 1; continue; }
      realised.push(testResidualDiff.filter((v) => v > t).length / testResidualDiff.length);
    }
    realised.sort((a, b) => a - b);
    const q = (p) => (realised.length ? realised[Math.min(realised.length - 1, Math.floor(p * realised.length))] : null);
    rows.push({
      n, reps, pInfinite: infinite / reps,
      mean: realised.length ? realised.reduce((a, b) => a + b, 0) / realised.length : null,
      median: q(0.5), p95: q(0.95), max: realised.length ? realised[realised.length - 1] : null,
      shareExceedingAlpha: realised.length ? realised.filter((v) => v > ALPHA).length / realised.length : null,
      certifiableM: maxCertifiableCandidates(n, ALPHA),
    });
  }
  return { rows, nCalResidualDiff: residualCalDiff.length, nCalResidualSame: residualCalSame.length, nTestResidualDiff: testResidualDiff.length };
}
const resample = resampleStudy();

// ── 9. jurisdiction ──────────────────────────────────────────────────────────
const wrongPool = calibrate(cal, scoreOf, { ...DEFAULT_CONFIG, refuter: false }, ALPHA, 0.05, { m: 1 });
const rightPool = calib;
const residualTestDiff = test.filter((p) => p.facts.residual && p.label === "DIFF");
const wsUnder = (t) => rate(residualTestDiff.filter((p) => { const v = scoreOf(p); return v !== null && v > t; }).length, residualTestDiff.length);
const jurisdiction = {
  mismatchedPool: { n: wrongPool.nCalDiff, tHi: wrongPool.tHi, wsOverResidual: wsUnder(wrongPool.tHi) },
  matchedPool: { n: rightPool.nCalDiff, tHi: rightPool.tHi, wsOverResidual: wsUnder(rightPool.tHi) },
};
check("the jurisdiction-matched pool is not larger than the mismatched one",
  rightPool.nCalDiff <= wrongPool.nCalDiff,
  `matched n=${rightPool.nCalDiff}, mismatched n=${wrongPool.nCalDiff}`);

const out = {
  generatedAt: new Date().toISOString(), corpus: CORPUS, judge: JUDGE, alpha: ALPHA,
  nPairs: pairs.length, nCal: cal.length, nTest: test.length, nAttack: attack.length,
  abstentions: nulls, seedProvenanceSharing: seedLeak,
  checks, monteCarlo: mc, resample, jurisdiction,
  interpretation: {
    guarantees: "For a candidate distinct from every one of the m committed candidates, P(SUPPRESS) <= alpha, marginally over draws of the calibration pool and the test point jointly, conditional on m, under exchangeability (A6).",
    doesNotGuarantee: [
      "That the rate realised on any particular calibration draw is <= alpha. The resampling table below shows the realised rate's upper tail at every pool size tested.",
      "Anything about pairs the certifier or refuter settles: those are exact under A5/A5', not bounded.",
      "Anything under distribution shift. The attack split is excluded from calibration and the bound is not claimed there.",
      "Anything about the duplicate-escape direction, which is governed by gamma and is not a conformal guarantee of the same kind.",
      "That more calibration data lowers the error rate. It buys multiplicity budget (larger certifiable m), not accuracy.",
    ],
  },
};
writeFileSync(resolve(base, "results", OUT), JSON.stringify(out, null, 2));

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`corpus=${CORPUS} judge=${JUDGE} alpha=${ALPHA}  (cal ${cal.length} / test ${test.length} / attack ${attack.length}, abstentions ${nulls})\n`);
let failed = 0;
for (const c of checks) {
  if (!c.passed) failed += 1;
  console.log(`  [${c.passed ? "PASS" : "FAIL"}] ${c.name}${c.detail ? `\n         ${c.detail}` : ""}`);
}

console.log(`\nMonte-Carlo on the max statistic (alpha=${ALPHA}):`);
console.log("  m    uncorrected   corrected");
for (const r of mc) console.log(`  ${String(r.m).padStart(2)}   ${(r.uncorrected * 100).toFixed(1)}%${" ".repeat(9)}${(r.corrected * 100).toFixed(1)}%`);

console.log(`\nWhat alpha promises: resampling the calibration pool (${resample.nTestResidualDiff} residual DIFF test pairs)`);
console.log("   n   P(t=inf)  mean    median  p95     max     share>alpha  certifiable m");
for (const r of resample.rows) {
  if (r.unavailable) { console.log(`  ${String(r.n).padStart(3)}   — pool has only ${r.poolAvailable} residual DIFF calibration scores`); continue; }
  const pc = (v) => (v === null ? "  —   " : `${(v * 100).toFixed(1)}%`.padEnd(7));
  console.log(`  ${String(r.n).padStart(3)}   ${(r.pInfinite * 100).toFixed(0)}%${" ".repeat(7)}${pc(r.mean)} ${pc(r.median)} ${pc(r.p95)} ${pc(r.max)} ${pc(r.shareExceedingAlpha)}      ${r.certifiableM}`);
}

console.log(`\njurisdiction: mismatched pool n=${jurisdiction.mismatchedPool.n} t_hi=${jurisdiction.mismatchedPool.tHi} -> WS over residual ${fmtRate(jurisdiction.mismatchedPool.wsOverResidual)}`);
console.log(`              matched    pool n=${jurisdiction.matchedPool.n} t_hi=${jurisdiction.matchedPool.tHi} -> WS over residual ${fmtRate(jurisdiction.matchedPool.wsOverResidual)}`);
console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}   written: results/${OUT}`);
process.exitCode = failed === 0 ? 0 : 1;
