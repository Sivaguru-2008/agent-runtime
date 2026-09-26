#!/usr/bin/env node
/**
 * Class-conditional validity (AIJ revision, Phase 2).
 *
 *   node src/experiments/classConditional.js     → results/class_conditional.json
 *
 * Theorem 1 bounds wrong suppression MARGINALLY over the distinct pairs in the
 * judge's jurisdiction, and that population is a mix of categories we chose
 * (D1 near-miss mutations, D2 legitimate repeats, D3 hand-specified semantic
 * differences). A marginal bound says nothing about any one category, and D3
 * is already reported at 6.5% on the primary judge, above α. This script asks
 * how far the marginal guarantee is from a class-conditional one, using only
 * persisted scores (no model calls):
 *
 *   A. per-category wrong suppression under the deployed (marginal) threshold;
 *   B. Mondrian (per-category) thresholds, each calibrated on that category's
 *      own residual calibration pool, with pool sizes and certifiability
 *      (+∞ where a pool is below the budget of Proposition 5(a));
 *   C. the deployable version of B. A DIFF category is defined by the label, so
 *      it is not observable when the fence decides; the only rule that is valid
 *      for every category without knowing which one applies is the MAXIMUM of
 *      the per-category thresholds. Its deduplication is the price of
 *      class-conditional validity over unobservable classes;
 *   D. an observable partition (by tool), which is deployable as Mondrian
 *      calibration proper, for comparison;
 *   E. reweighting: realised residual wrong suppression when the test DIFF mix
 *      is shifted toward D3 (the category the marginal bound hides).
 *
 * Every rate is a {value, ci95} record so checkPaper.js can verify quotes. The
 * reweighted rates are not binomial proportions; their intervals are stratified
 * percentile bootstraps (seeded) and are labelled as such in `basis`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { suppressionThreshold, maxCertifiableCandidates, requiredCalibrationSize, decide } from "../conformal.js";
import { rate } from "../stats.js";
import { TOOLS } from "../tools.js";
import { runConfig } from "../evaluate.js";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cfgFile = JSON.parse(readFileSync(resolve(base, "repro.config.json"), "utf8"));
const spec = cfgFile.classConditional ?? {};
const ALPHA = spec.alpha ?? 0.05;
const GAMMA = 0.05;
const JUDGES = ["openai_gpt_oss_120b", "openai_gpt_oss_20b", "qwen_qwen3_6_27b"];
const DIFF_CATS = ["D1_near_miss", "D2_legit_repeat", "D3_semantic_diff"];
const D3 = "D3_semantic_diff";
const D3_SHARES = spec.d3Shares ?? [0.13, 0.25, 0.5];
const BOOT = spec.bootstrapReplicates ?? 10000;
const SEED = spec.seed ?? 20260926;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const readJsonl = (f) => readFileSync(resolve(base, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pairs = readJsonl("corpus/pairs.jsonl");
const scoreRows = new Map(readJsonl("corpus/scores.jsonl").map((r) => [r.id, r]));
const rc = JSON.parse(readFileSync(resolve(base, "results", "residual_calibration.json"), "utf8"));
const inf = (t) => (t === Infinity ? "Infinity" : t);

const out = {
  generatedAt: new Date().toISOString(),
  alpha: ALPHA, gamma: GAMMA, judges: JUDGES, diffCategories: DIFF_CATS,
  requiredPoolForM1: requiredCalibrationSize(1, ALPHA),
  note: "Offline. Mondrian thresholds over DIFF categories are an ORACLE analysis: the category is defined by the label and is not observable at decision time. The deployable rule valid for every category is the maximum per-category threshold (block C). The tool partition (block D) is observable.",
  judgesResult: {},
};

for (const J of JUDGES) {
  const scoreOf = (p) => { const v = scoreRows.get(p.id)?.judges?.[J]; return v === undefined ? null : v; };
  // The deployed configuration, exactly as in the main tables. Assert that it
  // reproduces residual_calibration.json before computing anything new from it.
  const run = runConfig({ pairs, schemas: TOOLS, cfg: {}, judge: J, scoreOf, alpha: ALPHA, gamma: GAMMA });
  const pub = rc.configs[`${J}_a${ALPHA}_residualOnly`];
  if (Math.abs(run.overall.wrongSuppression.value - pub.overall.wrongSuppression.value) > 1e-12 ||
      Math.abs(run.overall.dedup.value - pub.overall.dedup.value) > 1e-12) {
    throw new Error(`[${J}] evaluate.js does not reproduce residual_calibration.json; refusing to continue`);
  }
  const cal = pairs.filter((p) => p.split === "cal");
  const test = pairs.filter((p) => p.split === "test");
  const tMarg = run.calibration.tHi;
  const tLo = run.calibration.tLo;

  // Decision of the proposed configuration at an arbitrary threshold t_hi.
  const decideAt = (p, tHi) => {
    if (p.facts.certifies) return "SUPPRESS";
    if (p.facts.refutes) return "EXECUTE";
    const s = scoreOf(p);
    if (s === null) return "ESCALATE";
    return decide(s, tHi, Math.min(tLo, tHi));
  };
  const wsOver = (set, tHi) => rate(set.filter((p) => decideAt(p, tHi) === "SUPPRESS").length, set.length);
  const testDiff = test.filter((p) => p.label === "DIFF");
  const testSame = test.filter((p) => p.label === "SAME");

  // ── A + B: per category, marginal vs Mondrian ──────────────────────────────
  const perCategory = {};
  for (const c of DIFF_CATS) {
    const pool = cal.filter((p) => p.category === c && p.label === "DIFF" && p.facts.residual).map(scoreOf).filter((v) => v !== null);
    const tC = suppressionThreshold(pool, ALPHA);
    const all = testDiff.filter((p) => p.category === c);
    const res = all.filter((p) => p.facts.residual);
    perCategory[c] = {
      poolN: pool.length,
      certifiableM: maxCertifiableCandidates(pool.length, ALPHA),
      certifiableAtM1: pool.length >= requiredCalibrationSize(1, ALPHA),
      mondrianTHi: inf(tC),
      marginalTHi: tMarg,
      nTest: all.length, nTestResidual: res.length,
      marginal: { wrongSuppression: wsOver(all, tMarg), residualWrongSuppression: wsOver(res, tMarg) },
      mondrian: { wrongSuppression: wsOver(all, tC), residualWrongSuppression: wsOver(res, tC) },
      exceedsAlphaUnderMarginal: wsOver(all, tMarg).value > ALPHA,
    };
  }

  // ── C: the deployable class-valid rule — max of the per-category thresholds ─
  const tMax = Math.max(...DIFF_CATS.map((c) => (perCategory[c].mondrianTHi === "Infinity" ? Infinity : perCategory[c].mondrianTHi)));
  const bindingCategory = DIFF_CATS.reduce((a, c) => ((perCategory[c].mondrianTHi === "Infinity" ? Infinity : perCategory[c].mondrianTHi) >= (perCategory[a].mondrianTHi === "Infinity" ? Infinity : perCategory[a].mondrianTHi) ? c : a), DIFF_CATS[0]);
  const classValid = {
    tHi: inf(tMax), bindingCategory,
    wrongSuppression: wsOver(testDiff, tMax),
    dedup: rate(testSame.filter((p) => decideAt(p, tMax) === "SUPPRESS").length, testSame.length),
    silentEscape: rate(testSame.filter((p) => decideAt(p, tMax) === "EXECUTE").length, testSame.length),
    perCategoryWrongSuppression: Object.fromEntries(DIFF_CATS.map((c) => [c, wsOver(testDiff.filter((p) => p.category === c), tMax)])),
    marginalDedup: run.overall.dedup, marginalWrongSuppression: run.overall.wrongSuppression,
  };

  // ── D: an observable partition — Mondrian by tool ──────────────────────────
  const tools = [...new Set(pairs.map((p) => p.tool))].sort();
  const byTool = {};
  const toolThr = {};
  for (const t of tools) {
    const pool = cal.filter((p) => p.tool === t && p.label === "DIFF" && p.facts.residual).map(scoreOf).filter((v) => v !== null);
    toolThr[t] = suppressionThreshold(pool, ALPHA);
    byTool[t] = { poolN: pool.length, certifiableM: maxCertifiableCandidates(pool.length, ALPHA), tHi: inf(toolThr[t]) };
  }
  const decideTool = (p) => decideAt(p, toolThr[p.tool]);
  const toolMondrian = {
    byTool,
    toolsBelowBudget: tools.filter((t) => byTool[t].certifiableM < 1),
    wrongSuppression: rate(testDiff.filter((p) => decideTool(p) === "SUPPRESS").length, testDiff.length),
    dedup: rate(testSame.filter((p) => decideTool(p) === "SUPPRESS").length, testSame.length),
    perCategoryWrongSuppression: Object.fromEntries(DIFF_CATS.map((c) => {
      const s = testDiff.filter((p) => p.category === c);
      return [c, rate(s.filter((p) => decideTool(p) === "SUPPRESS").length, s.length)];
    })),
  };

  // ── E: reweighting the residual DIFF test mix toward D3 ────────────────────
  // Rate(w) = Σ_c w_c · WS_c over residual distinct test pairs, with w_D3 set
  // and the remaining weight split between D1 and D2 in their observed ratio.
  const resByCat = Object.fromEntries(DIFF_CATS.map((c) => [c, testDiff.filter((p) => p.category === c && p.facts.residual)]));
  const nRes = DIFF_CATS.reduce((a, c) => a + resByCat[c].length, 0);
  const naturalD3 = resByCat[D3].length / nRes;
  const others = DIFF_CATS.filter((c) => c !== D3);
  const nOthers = others.reduce((a, c) => a + resByCat[c].length, 0);
  const weightsFor = (d3) => Object.fromEntries([[D3, d3], ...others.map((c) => [c, (1 - d3) * resByCat[c].length / nOthers])]);
  const reweight = (tOf, label) => {
    const hits = Object.fromEntries(DIFF_CATS.map((c) => [c, resByCat[c].map((p) => (decideAt(p, tOf(p)) === "SUPPRESS" ? 1 : 0))]));
    const est = (h, w) => DIFF_CATS.reduce((a, c) => a + w[c] * (h[c].length ? h[c].reduce((x, y) => x + y, 0) / h[c].length : 0), 0);
    const rows = [];
    for (const d3 of [naturalD3, ...D3_SHARES]) {
      const w = weightsFor(d3);
      const rng = mulberry32(SEED + Math.round(d3 * 1e4) + (label === "marginal" ? 0 : 7919));
      const boots = [];
      for (let b = 0; b < BOOT; b++) {
        const hb = Object.fromEntries(DIFF_CATS.map((c) => [c, hits[c].map(() => hits[c][Math.floor(rng() * hits[c].length)])]));
        boots.push(est(hb, w));
      }
      boots.sort((a, b) => a - b);
      rows.push({
        d3Share: d3, natural: d3 === naturalD3, weights: w,
        residualWrongSuppression: {
          value: est(hits, w),
          ci95: { lo: boots[Math.floor(0.025 * BOOT)], hi: boots[Math.ceil(0.975 * BOOT) - 1] },
          n: nRes, basis: `reweighted; stratified percentile bootstrap, ${BOOT} replicates`,
          // With no suppressions in any stratum every replicate is 0 and the
          // interval collapses; such a row is not quoted as an interval.
          degenerate: boots[0] === boots[BOOT - 1],
        },
        exceedsAlpha: est(hits, w) > ALPHA,
      });
    }
    return rows;
  };
  const tMaxFn = () => tMax;
  const reweighting = {
    naturalD3Share: naturalD3, nResidualDiffTest: nRes,
    residualCountsByCategory: Object.fromEntries(DIFF_CATS.map((c) => [c, resByCat[c].length])),
    marginal: reweight(() => tMarg, "marginal"),
    classValid: reweight(tMaxFn, "classValid"),
  };

  out.judgesResult[J] = {
    marginal: { tHi: tMarg, poolN: run.calibration.nCalDiff, certifiableM: run.calibration.certifiableM,
      wrongSuppression: run.overall.wrongSuppression, residualWrongSuppression: run.residual.wrongSuppression, dedup: run.overall.dedup },
    perCategory, classValid, toolMondrian, reweighting,
  };
}

// ── summary facts used by the manuscript ─────────────────────────────────────
const P = out.judgesResult[JUDGES[0]];
out.summary = {
  categoriesExceedingAlphaUnderMarginal: Object.fromEntries(JUDGES.map((j) => [j,
    DIFF_CATS.filter((c) => out.judgesResult[j].perCategory[c].exceedsAlphaUnderMarginal)])),
  minCategoryPool: Object.fromEntries(JUDGES.map((j) => [j, Math.min(...DIFF_CATS.map((c) => out.judgesResult[j].perCategory[c].poolN))])),
  primaryD3MarginalWS: P.perCategory[D3].marginal.wrongSuppression.value,
  primaryD3MondrianWS: P.perCategory[D3].mondrian.wrongSuppression.value,
  // Budget of the corollary: every category certifiable at m iff min_c n_c ≥ ⌈m/α⌉−1.
  classCertifiableM: Object.fromEntries(JUDGES.map((j) => [j, Math.min(...DIFF_CATS.map((c) => out.judgesResult[j].perCategory[c].certifiableM))])),
  marginalCertifiableM: Object.fromEntries(JUDGES.map((j) => [j, out.judgesResult[j].marginal.certifiableM])),
};

writeFileSync(resolve(base, "results", "class_conditional.json"), JSON.stringify(out, null, 2));

// ── console report ───────────────────────────────────────────────────────────
const f = (r) => `${(100 * r.value).toFixed(1)}% [${(100 * r.ci95.lo).toFixed(1)}–${(100 * r.ci95.hi).toFixed(1)}] (${r.successes ?? "·"}/${r.n})`;
for (const J of JUDGES) {
  const r = out.judgesResult[J];
  console.log(`\n== ${J}  marginal t_hi=${r.marginal.tHi} n=${r.marginal.poolN} m*=${r.marginal.certifiableM}  WS ${f(r.marginal.wrongSuppression)}`);
  for (const c of DIFF_CATS) {
    const x = r.perCategory[c];
    console.log(`  ${c.padEnd(18)} pool ${String(x.poolN).padStart(3)} m*=${x.certifiableM} t_c=${x.mondrianTHi}  marginal ${f(x.marginal.wrongSuppression)}  mondrian ${f(x.mondrian.wrongSuppression)}`);
  }
  console.log(`  class-valid (max t_c=${r.classValid.tHi}, bound by ${r.classValid.bindingCategory}): WS ${f(r.classValid.wrongSuppression)} dedup ${f(r.classValid.dedup)} vs marginal dedup ${f(r.classValid.marginalDedup)}`);
  console.log(`  by tool: below budget ${JSON.stringify(r.toolMondrian.toolsBelowBudget)} WS ${f(r.toolMondrian.wrongSuppression)} dedup ${f(r.toolMondrian.dedup)} D3 ${f(r.toolMondrian.perCategoryWrongSuppression[D3])}`);
  for (const k of ["marginal", "classValid"]) {
    console.log(`  reweight[${k}]: ` + r.reweighting[k].map((w) => `D3=${(100 * w.d3Share).toFixed(1)}% → ${f(w.residualWrongSuppression)}`).join(" | "));
  }
}
console.log("\nwrote results/class_conditional.json");
