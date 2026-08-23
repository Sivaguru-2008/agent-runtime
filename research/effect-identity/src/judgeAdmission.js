import { rate } from "./stats.js";

/**
 * Whether a judge's numbers may be reported at all.
 *
 * The manuscript already carries one admission rule: a judge that abstains on
 * most pairs contributes no calibration pool, so its threshold is +infinity, so
 * it never suppresses, so its row reads "0.0% wrong-suppression, 0.0% silent
 * escape" — the appearance of a flawless judge manufactured by the absence of a
 * judge. That rule is necessary and, as this file exists to record, not
 * sufficient.
 *
 * THE DUAL PATHOLOGY. A judge can answer every pair and still say nothing. We
 * found one: `allam-2-7b` returns 0.9 for essentially every comparison, giving
 * 100% coverage, a SAME mean of 0.90 and a DIFF mean of 0.91 — separation of
 * MINUS one point. Follow that through the deployed rule and the arithmetic is
 * the same as the abstaining judge's. The calibration pool is a pile of 0.9s,
 * so the conformal threshold is 0.9; the suppression rule is a STRICT
 * inequality, so a test score of 0.9 does not clear it; nothing is ever
 * suppressed; wrong-suppression is 0.0% and deduplication is 0.0%. The row is
 * identical in shape to the abstaining judge's and identical in shape to a
 * perfect safety result, and a coverage filter admits it.
 *
 * So a coverage rule alone lets exactly the failure it was written to prevent
 * back in through the other door. Reporting a "0% wrong-suppression" judge that
 * never makes a decision is the single easiest way to manufacture a safety
 * claim in this design, and both routes to it must be closed.
 *
 * THE ADMISSION RULE, in full:
 *
 *   1. COVERAGE   at least `minCoverage` of pairs scored (default 0.80).
 *   2. RESOLUTION at least `minDistinct` distinct score values (default 2).
 *                 Two is the floor, not three: a judge answering only 0 and 1
 *                 can still order SAME above DIFF perfectly, and one of the
 *                 paper's own experiments depends on exactly such a judge.
 *                 Excluding it would discard a real measurement to enforce a
 *                 stylistic preference. What a binary judge CANNOT support is
 *                 the escalation band, which needs mass between the extremes —
 *                 so that is reported as a capability flag
 *                 (`supportsEscalationBand`) rather than as an exclusion.
 *   3. SIGNAL     the score must order SAME above DIFF better than chance, by a
 *                 rank statistic (AUC) with a margin: `minAuc` (default 0.60).
 *                 AUC is used rather than a mean difference because it is
 *                 invariant to the judge's scale, and judges here disagree about
 *                 scale far more than about order.
 *
 * A judge failing any clause is reported with its diagnostics and WITHOUT rates.
 * The exclusion itself is a result — "this model cannot serve as an effect-
 * identity oracle" — and is more informative than a row of zeros.
 */

/**
 * Rank-based AUC: the probability that a randomly chosen SAME pair scores above
 * a randomly chosen DIFF pair, ties counted as half. Equivalent to the
 * normalised Mann-Whitney U, computed directly because the samples here are
 * small enough that clarity beats an O(n log n) formulation.
 */
export function auc(sameScores, diffScores) {
  const a = sameScores.filter((v) => v !== null && v !== undefined);
  const b = diffScores.filter((v) => v !== null && v !== undefined);
  if (a.length === 0 || b.length === 0) return null;
  let wins = 0;
  for (const x of a) for (const y of b) wins += x > y ? 1 : x === y ? 0.5 : 0;
  return wins / (a.length * b.length);
}

export const ADMISSION_DEFAULTS = { minCoverage: 0.8, minDistinct: 2, minAuc: 0.6 };

/**
 * @param {object} args
 * @param {(number|null)[]} args.scores      aligned with `labels`
 * @param {("SAME"|"DIFF")[]} args.labels
 * @param {object} [args.thresholds]
 * @returns {{admitted: boolean, reasons: string[], diagnostics: object}}
 */
export function assessJudge({ scores, labels, thresholds = {} }) {
  const t = { ...ADMISSION_DEFAULTS, ...thresholds };
  const n = scores.length;
  const scored = scores.filter((v) => v !== null && v !== undefined);
  const coverage = n > 0 ? scored.length / n : 0;
  const distinct = new Set(scored).size;
  const same = scores.filter((v, i) => v !== null && labels[i] === "SAME");
  const diff = scores.filter((v, i) => v !== null && labels[i] === "DIFF");
  const a = auc(same, diff);
  const mean = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null);
  const atExtremes = scored.filter((v) => v <= 0.02 || v >= 0.98).length;

  const reasons = [];
  if (coverage < t.minCoverage) reasons.push(`coverage ${(coverage * 100).toFixed(1)}% < ${(t.minCoverage * 100).toFixed(0)}% — too few scores to calibrate or to measure`);
  if (distinct < t.minDistinct) reasons.push(`only ${distinct} distinct score value — no threshold can separate anything, so every rate is an artefact of the constant`);
  if (a === null) reasons.push("no SAME/DIFF overlap in the scored sample — signal is unmeasurable");
  else if (a < t.minAuc) reasons.push(`AUC ${a.toFixed(3)} < ${t.minAuc} — scores do not order SAME above DIFF better than chance`);

  return {
    admitted: reasons.length === 0,
    reasons,
    diagnostics: {
      n,
      coverage: rate(scored.length, n),
      abstentions: n - scored.length,
      distinctValues: distinct,
      auc: a,
      sameMean: mean(same), diffMean: mean(diff),
      separation: mean(same) !== null && mean(diff) !== null ? mean(same) - mean(diff) : null,
      atExtremesShare: scored.length ? atExtremes / scored.length : null,
      // A judge whose mass sits at 0 and 1 is admissible but cannot support the
      // escalation band: there is no doubt for the band to catch, so its misses
      // fall straight through to silent execution.
      supportsEscalationBand: scored.length ? atExtremes / scored.length < 0.9 : false,
    },
  };
}
