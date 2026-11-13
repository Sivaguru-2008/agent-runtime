/**
 * Interval estimation for the reported rates.
 *
 * Every rate in the evaluation is a binomial proportion over a finite sample
 * (e.g. wrong-suppression over 72 held-out DIFF pairs). A bare point estimate
 * of "0%" is not a claim that the rate IS zero — with n = 72 the 95% upper
 * bound is still ≈ 4%, which is the same order as the α we certify. Reporting
 * the interval is what makes the safety claim honest.
 *
 * We use the Wilson score interval rather than the normal (Wald) interval: at
 * p̂ = 0 or 1 — exactly the regime our headline numbers live in — Wald collapses
 * to a degenerate zero-width interval, while Wilson stays correct.
 */

/** Two-sided normal quantile for the standard confidence levels we report. */
const Z = { 0.9: 1.6448536269514722, 0.95: 1.959963984540054, 0.99: 2.5758293035489004 };

/**
 * Wilson score interval for a binomial proportion.
 * Returns null for n = 0 (no sample, no claim).
 */
export function wilson(successes, n, level = 0.95) {
  if (!Number.isFinite(n) || n <= 0) return null;
  const z = Z[level] ?? Z[0.95];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  // At the boundaries the interval is exactly closed in real arithmetic
  // (0 successes ⇒ lo = 0; n successes ⇒ hi = 1), but the floating-point
  // subtraction leaves ~1e-18 dust. These are the cases the headline rates
  // sit on, so pin them rather than report noise.
  return {
    point: p,
    lo: successes === 0 ? 0 : Math.max(0, centre - half),
    hi: successes === n ? 1 : Math.min(1, centre + half),
    n,
    successes,
    level,
  };
}

/**
 * How a reported zero is justified. The distinction matters more than the
 * number: a decidable layer's zero is a logical consequence of the mechanism,
 * while a scorer-dependent zero is an estimate with a confidence interval that
 * a reader is entitled to see.
 *
 *   PROVABLE_A5      — follows from L0 soundness (canonical equality ⇒ identity).
 *                      The measurement tests assumption A5, not the theorem.
 *   PROVABLE_A5PRIME — follows from the distinctness witness (declared-field
 *                      difference ⇒ distinct). The measurement tests the
 *                      implementation and A5′, not the theorem.
 *   MEASURED         — an empirical estimate over a finite sample. Needs a CI.
 */
export const BASIS = {
  PROVABLE_A5: "provable-under-A5",
  PROVABLE_A5PRIME: "provable-under-A5prime",
  MEASURED: "measured",
};

/**
 * A rate reported with its interval and the basis of its claim.
 * `successes`/`n` are the raw counts so a reader can recompute any interval.
 */
export function rate(successes, n, basis = BASIS.MEASURED, level = 0.95) {
  const ci = wilson(successes, n, level);
  return {
    value: n > 0 ? successes / n : 0,
    successes,
    n,
    basis,
    ci95: ci ? { lo: ci.lo, hi: ci.hi } : null,
  };
}

/** Compact "12.3% [4.1–28.0]" rendering for console + paper tables. */
export function fmtRate(r, digits = 1) {
  if (r === null || r === undefined) return "n/a";
  if (typeof r === "number") return (r * 100).toFixed(digits) + "%";
  const pct = (x) => (x * 100).toFixed(digits);
  if (!r.ci95) return pct(r.value) + "%";
  const mark = r.basis === BASIS.MEASURED ? "" : "†";
  return `${pct(r.value)}%${mark} [${pct(r.ci95.lo)}–${pct(r.ci95.hi)}]`;
}

/**
 * Clopper–Pearson style one-sided upper bound via the rule of three, for the
 * specific case of zero observed events — the classic sanity check a reviewer
 * applies to a "0%" claim. Returns the 95% upper bound ≈ 3/n.
 */
export function zeroEventUpperBound95(n) {
  return n > 0 ? 3 / n : 1;
}

/**
 * Exact two-sided McNemar test over the discordant pairs of two methods
 * evaluated on the SAME items.
 *
 * Comparing two configurations by whether their Wilson intervals overlap throws
 * away the pairing and understates what the data can settle: the configurations
 * agree on most items, and the evidence lives entirely in the items where they
 * differ. `b` and `c` are the two discordant counts (a-correct/b-wrong and
 * a-wrong/b-correct). Under the null the discordant items split like a fair
 * coin, so the exact test is a two-sided binomial with p = 1/2, which needs no
 * asymptotic approximation and is therefore usable at the small discordant
 * counts this evaluation actually produces.
 */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return { b, c, n, p: 1 };
  const lo = Math.min(b, c);
  let tail = 0;
  for (let r = 0; r <= lo; r++) {
    let ch = 1;
    for (let i = 0; i < r; i++) ch = (ch * (n - i)) / (i + 1);
    tail += ch;
  }
  return { b, c, n, p: Math.min(1, (2 * tail) / 2 ** n) };
}

/**
 * Holm–Bonferroni step-down adjustment over a family of p-values.
 *
 * Reporting a dozen paired comparisons at a nominal 0.05 each is a different
 * experiment from reporting one, and the family here is large enough for that
 * to matter. Holm is used rather than plain Bonferroni because it is uniformly
 * more powerful at the same family-wise error rate, and because it needs no
 * assumption about dependence among the tests — which is essential, since these
 * comparisons share a test split and are strongly dependent.
 *
 * @param {Array<{key: string, p: number}>} tests
 * @returns {Record<string, {p: number, holm: number, rejectedAt05: boolean}>}
 */
export function holmBonferroni(tests) {
  const sorted = [...tests].sort((x, y) => x.p - y.p);
  const m = sorted.length;
  const out = {};
  let running = 0;
  sorted.forEach((t, i) => {
    const adj = Math.min(1, (m - i) * t.p);
    running = Math.max(running, adj); // step-down monotonicity
    out[t.key] = { p: t.p, holm: running, rejectedAt05: running < 0.05 };
  });
  return out;
}

/**
 * Krippendorff's alpha for nominal data with an arbitrary number of raters and
 * missing values.
 *
 * Fleiss' kappa needs every item rated by the same number of raters and has no
 * principled treatment of a rater who skipped an item. Real annotation returns
 * ragged data, and dropping the ragged items biases agreement upward — the
 * items annotators skip are the hard ones. Krippendorff's alpha handles both,
 * which is why it is reported alongside kappa rather than instead of it.
 *
 * @param {Array<Array<string|null>>} units  one array of rater labels per item
 * @param {string[]} categories
 */
export function krippendorffAlpha(units, categories) {
  const valued = units.map((u) => u.filter((v) => v !== null && v !== undefined));
  const usable = valued.filter((u) => u.length >= 2);
  if (usable.length === 0) return null;
  const nTotal = usable.reduce((a, u) => a + u.length, 0);
  if (nTotal < 2) return null;

  // Observed disagreement: within-unit mismatched pairs, weighted by 1/(m_u - 1).
  let Do = 0;
  for (const u of usable) {
    const m = u.length;
    let mismatched = 0;
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) if (i !== j && u[i] !== u[j]) mismatched += 1;
    Do += mismatched / (m - 1);
  }
  Do /= nTotal;

  // Expected disagreement from the pooled marginal distribution.
  const counts = Object.fromEntries(categories.map((c) => [c, 0]));
  for (const u of usable) for (const v of u) counts[v] = (counts[v] ?? 0) + 1;
  let De = 0;
  for (const a of categories) for (const b of categories) if (a !== b) De += counts[a] * counts[b];
  De /= nTotal * (nTotal - 1);

  return De === 0 ? null : 1 - Do / De;
}
