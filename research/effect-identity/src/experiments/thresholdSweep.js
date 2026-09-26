/**
 * §8.17 — Threshold sensitivity analysis.
 *
 * For each admitted judge, sweep a fixed suppression threshold τ ∈ [0,1]
 * on the jurisdiction-matched residual test split and record:
 *   - which τ values achieve WS ≤ α (the "safe region")
 *   - the conformal threshold's position within that region
 *   - AUC-ROC of the judge on residual pairs
 *   - bootstrap comparison of conformal vs cross-validated fixed thresholds
 *
 * No network; deterministic recomputation from persisted scores.
 *
 * Usage:
 *   node src/experiments/thresholdSweep.js
 *   node src/experiments/thresholdSweep.js --bootstrap 500
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..", "..");

import { canonicalize, canonicalString, semanticProjection } from "../canonicalize.js";
import { suppressionThreshold } from "../conformal.js";
import { TOOLS } from "../tools.js";

const ALPHA = 0.05;
const bootIdx = process.argv.indexOf("--bootstrap");
const bootArg = process.argv.find((a) => a.startsWith("--bootstrap="))?.split("=")[1]
  ?? (bootIdx >= 0 ? process.argv[bootIdx + 1] : null) ?? "500";
const N_BOOT = parseInt(bootArg, 10);

const pairs = readFileSync(resolve(base, "corpus", "pairs.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const scores = new Map(
  readFileSync(resolve(base, "corpus", "scores.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.id, r]; })
);

const JUDGES = [...new Set(
  [...scores.values()].flatMap((r) => Object.keys(r.judges ?? {}))
)].sort();

const usable = (v) => v !== null && v !== undefined;
const MIN_COVERAGE = 0.8;
const admitted = JUDGES.filter((j) =>
  [...scores.values()].filter((r) => usable(r.judges?.[j])).length / scores.size >= MIN_COVERAGE
);

for (const p of pairs) {
  const schema = TOOLS[p.tool];
  p.l0Equal = canonicalString(canonicalize(p.a, schema)) === canonicalString(canonicalize(p.b, schema));
  p.semEqual = semanticProjection(p.a, schema) === semanticProjection(p.b, schema);
}

const cal = pairs.filter((p) => p.split === "cal");
const test = pairs.filter((p) => p.split === "test");

function seededRng(seed) {
  let state = seed >>> 0;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function resample(arr, rng) {
  return Array.from({ length: arr.length }, () => arr[Math.floor(rng() * arr.length)]);
}

const results = { generatedAt: new Date().toISOString(), alpha: ALPHA, bootstrapN: N_BOOT, judges: {} };

for (const judge of admitted) {
  const getScore = (p) => scores.get(p.id)?.judges?.[judge] ?? null;
  const residualCal = cal.filter((p) => !p.l0Equal && p.semEqual && usable(getScore(p)));
  const residualTest = test.filter((p) => !p.l0Equal && p.semEqual && usable(getScore(p)));
  const rCalDiff = residualCal.filter((p) => p.label === "DIFF");
  const rTestDiff = residualTest.filter((p) => p.label === "DIFF");
  const rTestSame = residualTest.filter((p) => p.label === "SAME");

  if (rTestDiff.length === 0 || rTestSame.length === 0) continue;

  // Threshold sweep
  const sweep = [];
  for (let i = 0; i <= 100; i++) {
    const tau = i / 100;
    const ws = rTestDiff.filter((p) => getScore(p) > tau).length / rTestDiff.length;
    const dedup = rTestSame.filter((p) => getScore(p) > tau).length / rTestSame.length;
    sweep.push({ tau, ws, dedup, safe: ws <= ALPHA });
  }

  const safeRegion = sweep.filter((r) => r.safe);
  const bestSafe = safeRegion.reduce((a, b) => (a.dedup > b.dedup ? a : b), { tau: NaN, dedup: 0 });

  // Conformal
  const confT = suppressionThreshold(rCalDiff.map(getScore), ALPHA);
  const confWS = rTestDiff.filter((p) => getScore(p) > confT).length / rTestDiff.length;
  const confDedup = rTestSame.filter((p) => getScore(p) > confT).length / rTestSame.length;

  // AUC
  const diffScores = rTestDiff.map(getScore);
  const sameScores = rTestSame.map(getScore);
  let conc = 0, disc = 0, tied = 0;
  for (const s of sameScores) for (const d of diffScores) {
    if (s > d) conc++; else if (s < d) disc++; else tied++;
  }
  const auc = (conc + 0.5 * tied) / (conc + disc + tied);

  // Bootstrap
  const allResidual = [...residualCal, ...residualTest];
  let confExc = 0, fixExc = 0;
  const confWsList = [], fixWsList = [];
  for (let b = 0; b < N_BOOT; b++) {
    const rng = seededRng(42 + b);
    const sample = resample(allResidual, rng);
    const half = Math.floor(sample.length / 2);
    const bCal = sample.slice(0, half);
    const bTest = sample.slice(half);
    const bCalDiff = bCal.filter((p) => p.label === "DIFF");
    const bCalSame = bCal.filter((p) => p.label === "SAME");
    const bTestDiff = bTest.filter((p) => p.label === "DIFF");
    const bTestSame = bTest.filter((p) => p.label === "SAME");
    if (bTestDiff.length === 0 || bCalDiff.length === 0 || bTestSame.length === 0) continue;

    const tC = suppressionThreshold(bCalDiff.map(getScore), ALPHA);
    const wsC = bTestDiff.filter((p) => getScore(p) > tC).length / bTestDiff.length;
    confWsList.push(wsC);
    if (wsC > ALPHA) confExc++;

    let bestTau = 1.0;
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      if (bCalDiff.filter((p) => getScore(p) > t).length / bCalDiff.length <= ALPHA) {
        const dd = bCalSame.length > 0
          ? bCalSame.filter((p) => getScore(p) > t).length / bCalSame.length : 0;
        if (dd > 0 || bestTau === 1.0) bestTau = t;
        break;
      }
    }
    const wsF = bTestDiff.length > 0
      ? bTestDiff.filter((p) => getScore(p) > bestTau).length / bTestDiff.length : 0;
    fixWsList.push(wsF);
    if (wsF > ALPHA) fixExc++;
  }

  const mean = (a) => a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * q)]; };

  const jr = {
    auc,
    safeRegion: { lo: safeRegion[0]?.tau, hi: safeRegion[safeRegion.length - 1]?.tau, count: safeRegion.length, fraction: safeRegion.length / 101 },
    conformal: { tau: confT, ws: confWS, dedup: confDedup },
    bestSafeFixed: { tau: bestSafe.tau, ws: bestSafe.ws ?? null, dedup: bestSafe.dedup },
    residual: { calDiff: rCalDiff.length, testDiff: rTestDiff.length, testSame: rTestSame.length },
    bootstrap: {
      n: N_BOOT,
      conformal: { meanWS: mean(confWsList), p95WS: pct(confWsList, 0.95), exceedsAlpha: confExc, rate: confExc / confWsList.length },
      cvFixed: { meanWS: mean(fixWsList), p95WS: pct(fixWsList, 0.95), exceedsAlpha: fixExc, rate: fixExc / fixWsList.length },
    },
  };

  results.judges[judge] = jr;

  const short = judge.split("_").slice(-2).join("_");
  console.log(`${short}: AUC=${auc.toFixed(4)}  safe=[${jr.safeRegion.lo?.toFixed(2)},${jr.safeRegion.hi?.toFixed(2)}] (${(jr.safeRegion.fraction * 100).toFixed(0)}%)  conformal τ=${confT} dedup=${(confDedup * 100).toFixed(1)}%  best_safe τ=${bestSafe.tau} dedup=${(bestSafe.dedup * 100).toFixed(1)}%`);
  console.log(`  bootstrap: conformal exceeds α ${(jr.bootstrap.conformal.rate * 100).toFixed(1)}%, CV-fixed ${(jr.bootstrap.cvFixed.rate * 100).toFixed(1)}%`);
}

mkdirSync(resolve(base, "results"), { recursive: true });
writeFileSync(resolve(base, "results", "threshold_sweep.json"), JSON.stringify(results, null, 2));
console.log(`\nResults written to results/threshold_sweep.json`);
