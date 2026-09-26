import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tightness of the multiplicity-corrected bound (Theorem 2 of the manuscript).
 *
 * The class Q: the n pool scores and each candidate score s'_i are i.i.d. with a
 * continuous law; the dependence among s'_1..s'_m is arbitrary. Every law in Q
 * satisfies A6. For a rank threshold s_(k), 1 <= k <= n,
 *
 *     sup_Q P(max_i s'_i > s_(k)) = E[min(1, m B)],   B ~ Beta(n+1-k, k),
 *
 * attained by the rotation coupling s'_i = frac(V + (i-1)/m), V ~ U(0,1)
 * independent of the pool (scores taken uniform w.l.o.g.).
 *
 * This file computes that value exactly (integer-parameter Beta via binomial
 * tails), checks it by simulating the coupling itself, and checks the
 * budget-necessity condition over a grid. No model is called and no corpus is
 * read: every number here is a property of the order statistics.
 *
 *   node src/experiments/tightness.js
 */

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, "..", "..", "results", "tightness.json");

// ─── Exact values ────────────────────────────────────────────────────────────

const LOG_FACT = [0];
function logFact(n) {
  for (let i = LOG_FACT.length; i <= n; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
  return LOG_FACT[n];
}

/** P(Binomial(N, c) >= a), summed in log space. */
function binomUpperTail(N, c, a) {
  if (a <= 0) return 1;
  if (a > N) return 0;
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  const lc = Math.log(c), l1c = Math.log1p(-c);
  let sum = 0;
  for (let j = a; j <= N; j++) {
    sum += Math.exp(logFact(N) - logFact(j) - logFact(N - j) + j * lc + (N - j) * l1c);
  }
  return Math.min(1, sum);
}

/** Regularised incomplete beta I_c(a, b) for positive integers a, b. */
const regIncBeta = (c, a, b) => binomUpperTail(a + b - 1, c, a);

/**
 * E[min(1, m B)] for B ~ Beta(a, b), a, b positive integers.
 * min(1, mB) = mB 1{B <= 1/m} + 1{B > 1/m}, and E[B 1{B <= c}] = a/(a+b) I_c(a+1, b).
 */
export function expectedMinOneMB(m, a, b) {
  const c = 1 / m;
  return m * (a / (a + b)) * regIncBeta(c, a + 1, b) + (1 - regIncBeta(c, a, b));
}

/** Pool rank of the fence's threshold (Eq. thi), or null when it is +infinity. */
export function thresholdRank(n, alpha, m) {
  const k = Math.ceil((n + 1) * (1 - alpha / m) - 1e-12);
  return k <= n ? k : null;
}

/** sup over Q of the suppression probability of the rank-k threshold rule. */
export const supOverQ = (n, m, k) => expectedMinOneMB(m, n + 1 - k, k);

// ─── Simulation of the attaining coupling ────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulate the rotation coupling: pool of n i.i.d. U(0,1), candidates
 * s'_i = frac(V + (i-1)/m). Each candidate is U(0,1) and independent of the
 * pool, so every (pool, s'_i) is i.i.d.; the candidates are maximally spread.
 */
function simulateCoupling(n, m, k, reps, seed) {
  const rnd = mulberry32(seed);
  const pool = new Float64Array(n);
  let hits = 0;
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < n; i++) pool[i] = rnd();
    pool.sort();
    const t = pool[k - 1];
    const v = rnd();
    let hit = false;
    for (let j = 0; j < m && !hit; j++) {
      const s = (v + j / m) % 1;
      if (s > t) hit = true;
    }
    if (hit) hits += 1;
  }
  const p = hits / reps;
  return { reps, rate: p, se: Math.sqrt((p * (1 - p)) / reps) };
}

/** The same pool with INDEPENDENT candidates. Recorded for contrast only; not quoted in the paper. */
function simulateIndependent(n, m, k, reps, seed) {
  const rnd = mulberry32(seed);
  const pool = new Float64Array(n);
  let hits = 0;
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < n; i++) pool[i] = rnd();
    pool.sort();
    const t = pool[k - 1];
    let hit = false;
    for (let j = 0; j < m && !hit; j++) if (rnd() > t) hit = true;
    if (hit) hits += 1;
  }
  const p = hits / reps;
  return { reps, rate: p, se: Math.sqrt((p * (1 - p)) / reps) };
}

// ─── Budget necessity ────────────────────────────────────────────────────────

/** sup over Q for the most conservative finite threshold, the pool maximum (k = n). */
const supPoolMax = (n, m) => (m / (n + 1)) * (1 - Math.exp((n + 1) * Math.log1p(-1 / m)));

/** Root x0 > alpha of x(1 - e^{-1/x}) = alpha (the function is increasing on x > 0). */
function budgetBandEdge(alpha) {
  const f = (x) => x * -Math.expm1(-1 / x) - alpha;
  let lo = alpha, hi = 1e6;
  for (let i = 0; i < 400; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid; else lo = mid;
  }
  return hi;
}

/**
 * For every N = n+1 in [2, maxN], take the smallest m violating the budget
 * (m > alpha N) and test whether the pool-maximum rule already exceeds alpha
 * under Q. E[min(1, mB)] is non-decreasing in m, so the smallest violating m is
 * the only one that needs checking.
 */
function budgetGridCheck(alphaNum, alphaDen, maxN) {
  const alpha = alphaNum / alphaDen;
  let failures = 0, firstFailure = null, minMargin = Infinity, argMin = null;
  for (let N = 2; N <= maxN; N++) {
    const m = Math.floor((alphaNum * N) / alphaDen) + 1; // smallest integer m with m*den > num*N
    const val = supPoolMax(N - 1, m);
    const margin = val - alpha;
    if (margin < minMargin) { minMargin = margin; argMin = { n: N - 1, m, value: val }; }
    if (!(val > alpha)) { failures += 1; if (!firstFailure) firstFailure = { n: N - 1, m, value: val }; }
  }
  return { alpha, maxNPlus1: maxN, failures, firstFailure, minMargin, argMin };
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const ALPHA = 0.05;
const REPS = 200_000;

function row(n, m, alpha, label, seed) {
  const k = thresholdRank(n, alpha, m);
  if (k === null) return { label, n, m, alpha, k: null, thresholdInfinite: true };
  const rho = n + 1 - k;
  const bonferroni = (m * rho) / (n + 1);
  const attained = supOverQ(n, m, k);
  const nextLower = k > 1 ? supOverQ(n, m, k - 1) : null;
  const sim = simulateCoupling(n, m, k, REPS, seed);
  const indep = simulateIndependent(n, m, k, REPS, seed + 1);
  return {
    label, n, m, alpha, k, rho,
    bonferroniBound: bonferroni,
    attainedSupQ: attained,
    gap: bonferroni - attained,
    nextLowerThresholdSupQ: nextLower,
    simulatedCoupling: sim,
    simulatedIndependent: indep,
  };
}

const configs = [
  row(142, 1, ALPHA, "declared pool, primary judge", 11),
  row(49, 1, ALPHA, "tightened pool, primary judge", 13),
  row(200, 1, ALPHA, "simulation setting, m=1", 17),
  row(200, 2, ALPHA, "simulation setting, m=2", 19),
  row(200, 5, ALPHA, "simulation setting, m=5", 23),
  row(200, 10, ALPHA, "simulation setting, m=10", 29),
  row(199, 10, ALPHA, "guidance: 199 pairs for m=10", 31),
  row(999, 50, ALPHA, "m=50, pool that certifies it", 37),
];

// Uncorrected rule (per-candidate level alpha) under the attaining coupling.
const uncorrected = [1, 2, 5, 10, 25, 50].map((m) => {
  const n = 200;
  const k = thresholdRank(n, ALPHA, 1);
  return { n, m, k, attainedSupQ: supOverQ(n, m, k) };
});

// Budget: pool maximum under Q when the budget is exceeded.
const budgetExamples = [
  { n: 200, m: 11 }, { n: 200, m: 25 }, { n: 200, m: 50 }, { n: 142, m: 8 }, { n: 49, m: 3 }, { n: 18, m: 1 },
].map(({ n, m }) => ({ n, m, alpha: ALPHA, budgetExceeded: m > ALPHA * (n + 1), supPoolMax: supPoolMax(n, m) }));

const band = [0.01, 0.05, 0.1].map((a) => {
  const x0 = budgetBandEdge(a);
  return { alpha: a, x0, delta: x0 - a };
});

const grid = [budgetGridCheck(1, 20, 1_000_000), budgetGridCheck(1, 100, 1_000_000)];

// Monte-Carlo agreement: every simulated coupling within 4 standard errors of the exact value.
const mcAgreement = configs
  .filter((c) => c.k !== null)
  .map((c) => ({ label: c.label, z: (c.simulatedCoupling.rate - c.attainedSupQ) / Math.max(c.simulatedCoupling.se, 1e-12) }));
const mcOk = mcAgreement.every((c) => Math.abs(c.z) < 4);

const out = {
  generatedBy: "src/experiments/tightness.js",
  note: "Exact order-statistic computations and a simulation of the attaining coupling. No model calls, no corpus.",
  alpha: ALPHA,
  repsPerSimulation: REPS,
  configs,
  uncorrectedUnderCoupling: uncorrected,
  budgetExamples,
  budgetBand: band,
  budgetGrid: grid,
  mcAgreement,
  mcOk,
};
writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");

const pct = (x) => (x === null ? "  —  " : (100 * x).toFixed(3) + "%");
console.log("config                                   n    m   k  bonf      attained  gap        simCoupled  simIndep   nextLower");
for (const c of configs) {
  if (c.k === null) { console.log(c.label, "threshold +inf"); continue; }
  console.log(
    c.label.padEnd(40), String(c.n).padStart(4), String(c.m).padStart(4), String(c.k).padStart(4),
    pct(c.bonferroniBound), pct(c.attainedSupQ), c.gap.toExponential(2).padStart(10),
    pct(c.simulatedCoupling.rate), pct(c.simulatedIndependent.rate), pct(c.nextLowerThresholdSupQ),
  );
}
console.log("uncorrected under coupling (n=200):", uncorrected.map((u) => `m=${u.m}: ${pct(u.attainedSupQ)}`).join(", "));
console.log("budget examples:", budgetExamples.map((b) => `n=${b.n},m=${b.m}: exceeded=${b.budgetExceeded} supPoolMax=${pct(b.supPoolMax)}`).join("; "));
console.log("band:", band.map((b) => `alpha=${b.alpha}: delta=${b.delta.toExponential(3)}`).join("; "));
console.log("grid:", grid.map((g) => `alpha=${g.alpha}: failures=${g.failures} over n+1<=${g.maxNPlus1}, min margin=${g.minMargin.toExponential(3)} at n=${g.argMin.n},m=${g.argMin.m}`).join("; "));
console.log("Monte-Carlo agreement:", mcOk ? "OK" : "FAILED", mcAgreement.map((c) => c.z.toFixed(2)).join(" "));
console.log("wrote", outFile);
