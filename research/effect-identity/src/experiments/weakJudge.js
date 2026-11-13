import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, '..', '..');

import { canonicalize, canonicalString, semanticProjection } from '../canonicalize.js';
import { suppressionThreshold } from '../conformal.js';
import { TOOLS } from '../tools.js';

const ALPHA = 0.05;

const pairs = readFileSync(resolve(base, 'corpus', 'pairs.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const scores = new Map(
  readFileSync(resolve(base, 'corpus', 'scores.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.id, r]; })
);

for (const p of pairs) {
  const schema = TOOLS[p.tool];
  p.l0Equal = canonicalString(canonicalize(p.a, schema)) === canonicalString(canonicalize(p.b, schema));
  p.semEqual = semanticProjection(p.a, schema) === semanticProjection(p.b, schema);
}

const cal = pairs.filter((p) => p.split === 'cal');
const test = pairs.filter((p) => p.split === 'test');

const judge = 'openai_gpt_oss_120b';
const usable = (v) => v !== null && v !== undefined;
const getScore = (p) => scores.get(p.id)?.judges?.[judge] ?? null;

const rCal = cal.filter((p) => !p.l0Equal && p.semEqual && usable(getScore(p)));
const rTest = test.filter((p) => !p.l0Equal && p.semEqual && usable(getScore(p)));

const rCalDiff = rCal.filter((p) => p.label === 'DIFF');
const rTestDiff = rTest.filter((p) => p.label === 'DIFF');
const rTestSame = rTest.filter((p) => p.label === 'SAME');

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function computeAuc(sameScores, diffScores) {
  let wins = 0;
  let total = 0;
  for (const s of sameScores) {
    for (const d of diffScores) {
      if (s > d) wins += 1;
      else if (s === d) wins += 0.5;
      total += 1;
    }
  }
  return total > 0 ? wins / total : 0.5;
}

const sigmas = [0.0, 0.10, 0.20, 0.30, 0.40, 0.55, 0.75, 1.05, 1.60];
const rows = [];

for (const sigma of sigmas) {
  let totalAuc = 0;
  let totalSafeWidth = 0;
  let totalSafeFraction = 0;
  let totalConfTau = 0;
  let totalConfWS = 0;
  let totalConfDedup = 0;
  let totalBestSafeDedup = 0;
  let numInfinite = 0;
  
  const N_TRIALS = 200;
  for (let trial = 0; trial < N_TRIALS; trial++) {
    const trialRng = seededRng(trial * 1000 + Math.round(sigma * 100));
    const noisyScore = (p) => {
      const raw = getScore(p);
      if (sigma === 0) return raw;
      const n = raw + gaussian(trialRng) * sigma;
      return Math.max(0, Math.min(1, n));
    };

    const calDiffScores = rCalDiff.map(noisyScore);
    const testDiffScores = rTestDiff.map(noisyScore);
    const testSameScores = rTestSame.map(noisyScore);

    const auc = computeAuc(testSameScores, testDiffScores);
    totalAuc += auc;

    const sweep = [];
    for (let i = 0; i <= 100; i++) {
      const tau = i / 100;
      const ws = testDiffScores.filter((s) => s > tau).length / testDiffScores.length;
      const dedup = testSameScores.filter((s) => s > tau).length / testSameScores.length;
      sweep.push({ tau, ws, dedup, safe: ws <= ALPHA });
    }

    const safePoints = sweep.filter((r) => r.safe);
    const safeFraction = safePoints.length / sweep.length;
    const safeTaus = safePoints.map((r) => r.tau);
    const minSafeTau = safeTaus.length ? Math.min(...safeTaus) : 1.0;
    const maxSafeTau = safeTaus.length ? Math.max(...safeTaus) : 1.0;
    const safeWidth = safeTaus.length ? (maxSafeTau - minSafeTau) : 0.0;
    const bestSafeDedup = safePoints.length ? Math.max(...safePoints.map((r) => r.dedup)) : 0.0;

    totalSafeWidth += safeWidth;
    totalSafeFraction += safeFraction;
    totalBestSafeDedup += bestSafeDedup;

    const confT = suppressionThreshold(calDiffScores, ALPHA);
    if (!isFinite(confT)) {
      numInfinite += 1;
      totalConfTau += 1.0;
      totalConfWS += 0.0;
      totalConfDedup += 0.0;
    } else {
      totalConfTau += confT;
      const confWS = testDiffScores.filter((s) => s > confT).length / testDiffScores.length;
      const confDedup = testSameScores.filter((s) => s > confT).length / testSameScores.length;
      totalConfWS += confWS;
      totalConfDedup += confDedup;
    }
  }

  rows.push({
    sigma,
    auc: totalAuc / N_TRIALS,
    safeWidth: totalSafeWidth / N_TRIALS,
    safeFraction: totalSafeFraction / N_TRIALS,
    conformalTau: totalConfTau / N_TRIALS,
    conformalWS: totalConfWS / N_TRIALS,
    conformalDedup: totalConfDedup / N_TRIALS,
    bestSafeDedup: totalBestSafeDedup / N_TRIALS,
    infiniteFraction: numInfinite / N_TRIALS
  });
}

console.log('Noise Sweep / Weak Judge Transition Results:');
console.table(rows.map(r => ({
  'Noise sigma': r.sigma.toFixed(2),
  'AUC': r.auc.toFixed(3),
  'Safe Width': r.safeWidth.toFixed(2),
  'Safe Pct': (r.safeFraction * 100).toFixed(0) + '%',
  'Conf Tau': r.conformalTau.toFixed(2),
  'Conf WS': (r.conformalWS * 100).toFixed(1) + '%',
  'Conf Dedup': (r.conformalDedup * 100).toFixed(1) + '%',
  'Best Safe Dedup': (r.bestSafeDedup * 100).toFixed(1) + '%'
})));

writeFileSync(resolve(base, 'results', 'weak_judge.json'), JSON.stringify(rows, null, 2));
