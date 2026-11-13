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

for (const p of pairs) {
  const schema = TOOLS[p.tool];
  p.l0Equal = canonicalString(canonicalize(p.a, schema)) === canonicalString(canonicalize(p.b, schema));
  p.semEqual = semanticProjection(p.a, schema) === semanticProjection(p.b, schema);
}

const cal = pairs.filter((p) => p.split === 'cal');
const test = pairs.filter((p) => p.split === 'test');

function tokenize(obj) {
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
}

function jaccard(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 1.0;
}

function charNgrams(str, n = 3) {
  const s = (typeof str === 'string' ? str : JSON.stringify(str)).toLowerCase();
  const counts = new Map();
  for (let i = 0; i <= s.length - n; i++) {
    const gram = s.slice(i, i + n);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

function ngramCosine(a, b, n = 3) {
  const cA = charNgrams(a, n);
  const cB = charNgrams(b, n);
  let dot = 0, normA = 0, normB = 0;
  for (const v of cA.values()) normA += v * v;
  for (const v of cB.values()) normB += v * v;
  for (const [k, v] of cA.entries()) {
    if (cB.has(k)) dot += v * cB.get(k);
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 1.0;
}

function levenshteinSimilarity(a, b) {
  const s1 = typeof a === 'string' ? a : JSON.stringify(a);
  const s2 = typeof b === 'string' ? b : JSON.stringify(b);
  const m = s1.length, n = s2.length;
  if (m === 0) return n === 0 ? 1.0 : 0.0;
  if (n === 0) return 0.0;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  const maxLen = Math.max(m, n);
  return 1.0 - (d[m][n] / maxLen);
}

function computeAuc(sameScores, diffScores) {
  let wins = 0, total = 0;
  for (const s of sameScores) {
    for (const d of diffScores) {
      if (s > d) wins += 1;
      else if (s === d) wins += 0.5;
      total += 1;
    }
  }
  return total > 0 ? wins / total : 0.5;
}

const baselines = {
  'Token Jaccard': (p) => jaccard(p.a, p.b),
  'Char 3-gram Cosine': (p) => ngramCosine(p.a, p.b, 3),
  'Levenshtein Ratio': (p) => levenshteinSimilarity(p.a, p.b)
};

const results = [];

for (const [name, scoreFn] of Object.entries(baselines)) {
  const rCal = cal.filter((p) => !p.l0Equal && p.semEqual);
  const rTest = test.filter((p) => !p.l0Equal && p.semEqual);

  const rCalDiff = rCal.filter((p) => p.label === 'DIFF').map(scoreFn);
  const rTestDiff = rTest.filter((p) => p.label === 'DIFF').map(scoreFn);
  const rTestSame = rTest.filter((p) => p.label === 'SAME').map(scoreFn);

  const auc = computeAuc(rTestSame, rTestDiff);
  const confT = suppressionThreshold(rCalDiff, ALPHA);

  const confWS = isFinite(confT) ? rTestDiff.filter((s) => s > confT).length / rTestDiff.length : 0;
  const confDedup = isFinite(confT) ? rTestSame.filter((s) => s > confT).length / rTestSame.length : 0;

  // Full system test split evaluation (including L0 and witness)
  const fullTest = test;
  let fullWSCount = 0, fullDiffCount = 0;
  let fullDedupCount = 0, fullSameCount = 0;

  for (const p of fullTest) {
    if (p.label === 'DIFF') fullDiffCount++;
    if (p.label === 'SAME') fullSameCount++;

    let decision = 'EXECUTE';
    if (p.l0Equal) {
      decision = 'SUPPRESS';
    } else if (!p.semEqual) {
      decision = 'EXECUTE';
    } else {
      const s = scoreFn(p);
      if (isFinite(confT) && s > confT) {
        decision = 'SUPPRESS';
      }
    }

    if (decision === 'SUPPRESS' && p.label === 'DIFF') fullWSCount++;
    if (decision === 'SUPPRESS' && p.label === 'SAME') fullDedupCount++;
  }

  results.push({
    name,
    residualAuc: auc,
    conformalTau: confT,
    residualWS: confWS,
    residualDedup: confDedup,
    systemWS: fullWSCount / fullDiffCount,
    systemDedup: fullDedupCount / fullSameCount
  });
}

console.log('Non-LLM Baseline Results:');
console.table(results.map(r => ({
  'Baseline': r.name,
  'Residual AUC': r.residualAuc.toFixed(3),
  'Conf Tau': isFinite(r.conformalTau) ? r.conformalTau.toFixed(3) : 'Inf',
  'Residual WS': (r.residualWS * 100).toFixed(1) + '%',
  'Residual Dedup': (r.residualDedup * 100).toFixed(1) + '%',
  'System WS': (r.systemWS * 100).toFixed(1) + '%',
  'System Dedup': (r.systemDedup * 100).toFixed(1) + '%'
})));

writeFileSync(resolve(base, 'results', 'non_llm_baseline.json'), JSON.stringify(results, null, 2));
