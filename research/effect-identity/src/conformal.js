/**
 * Split-conformal calibration for the semantic layer's SUPPRESSION decision.
 *
 * The safety-critical error is WRONG SUPPRESSION: judging a genuinely distinct
 * action "the same" as something already committed, and silently swallowing it.
 *
 * ── What the fence actually computes ─────────────────────────────────────────
 *
 * A dispatch is not compared against one committed effect. It is compared
 * against the whole surviving candidate set C (everything committed for this
 * (run, tool) that the distinctness witness did not veto), and suppressed on
 *
 *     S*(x, C) = max_{x' ∈ C} J(t, x, x')      SUPPRESS iff S* > t_hi
 *
 * Calibrating a single PAIRWISE score at level α and then thresholding the
 * MAXIMUM of m such scores does not control the maximum: with m candidates the
 * fence gets m independent chances to exceed the threshold, and the wrong-
 * suppression rate grows with m. The pairwise bound is a bound on one
 * comparison, and the algorithm makes m of them. This module controls the
 * statistic the algorithm actually thresholds.
 *
 * ── The correction, and why this one ─────────────────────────────────────────
 *
 * We calibrate the pairwise score at level α/m and take the union bound:
 *
 *     P(S* > t̂ | x distinct from every candidate)
 *       = P(∃i : s_i > t̂)  ≤  Σ_{i≤m} P(s_i > t̂)  ≤  m · (α/m)  =  α
 *
 * Conditioning on "x is distinct from every candidate" is what makes each s_i a
 * distinct-pair score, so each is exchangeable with the calibration pool and the
 * pairwise bound applies to it. The union bound needs no independence, which
 * matters because the m scores are strongly dependent — they share x.
 *
 * We prefer this over calibrating the max statistic directly (`setConformal`
 * below, retained for comparison) for three reasons:
 *
 *   1. It re-uses the pairwise calibration pool at every m. Direct calibration
 *      needs calibration UNITS with the deployment's candidate-set size, so a
 *      pool of n pairwise scores yields only ⌊n/m⌋ units and runs out: certifying
 *      α = 0.05 needs ≥ 19 units, i.e. ≥ 19m pairwise scores. At m = 50 that is
 *      950 calibration pairs for one m.
 *   2. m varies per decision at deployment (it is however many effects this run
 *      has committed for this tool). Bonferroni gives a threshold per m from one
 *      pool; direct calibration would need a separate stratum per m, and the
 *      exchangeability assumption would then be per-stratum.
 *   3. It degrades in the safe direction. When the pool cannot certify α/m the
 *      threshold is +∞ and the layer stops suppressing semantically.
 *
 * The price is conservatism: the union bound is tight only when at most one
 * candidate can score high, and it costs the mechanism its semantic suppression
 * entirely once m > α(n+1). We measure that price rather than assert it away
 * (`setConformalThreshold` gives the less conservative comparison where the
 * calibration pool is large enough to support it).
 */

/**
 * One-sided split-conformal threshold on a PAIRWISE score.
 *
 * Given calibration scores s_1..s_n from DISTINCT pairs, exchangeable with a
 * test distinct pair's score s, the ⌈(n+1)(1−α)⌉-th order statistic satisfies
 * P(s > t) ≤ α. Ties are handled conservatively by the strict inequality, which
 * can only lower the suppression probability.
 *
 * If n cannot certify level α (⌈(n+1)(1−α)⌉ > n, i.e. n < 1/α − 1), the
 * threshold is +∞: the layer never suppresses. Safety degrades to "no semantic
 * suppression", never to "unbounded wrong suppression".
 */
export function suppressionThreshold(distinctCalScores, alpha) {
  if (!(alpha > 0)) return Infinity;
  const s = [...distinctCalScores].filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  const n = s.length;
  const k = Math.ceil((n + 1) * (1 - alpha));
  if (k > n) return Infinity;
  return s[k - 1];
}

/**
 * The threshold the fence must actually use, for a candidate set of size `m`.
 *
 *   m = 0 → +∞ (never suppress). There is nothing to be identical TO, so the
 *           question does not arise; returning +∞ rather than a finite value
 *           makes it impossible for an empty candidate set to suppress through
 *           some later code path.
 *   m ≥ 1 → the pairwise threshold at level α/m (Bonferroni).
 *
 * Monotone in m: more committed candidates ⇒ a stricter threshold ⇒ less
 * semantic suppression, which is the correct direction for a safety property.
 */
export function maxSuppressionThreshold(distinctCalScores, alpha, m) {
  if (!Number.isFinite(m) || m <= 0) return Infinity;
  return suppressionThreshold(distinctCalScores, alpha / m);
}

/**
 * The largest candidate-set size at which a calibration pool of size `n` can
 * certify level α at all: ⌈(n+1)(1−α/m)⌉ ≤ n ⟺ m ≤ α(n+1).
 *
 * Beyond it every threshold is +∞ and the mechanism reduces to its decidable
 * layers. This is a hard property of the calibration budget, not a tuning
 * choice, and a deployment expecting many committed effects per (run, tool)
 * must size its calibration set accordingly: m candidates need ≥ m/α − 1
 * calibration pairs.
 */
export const maxCertifiableCandidates = (n, alpha) => Math.floor(alpha * (n + 1));

/** Calibration pool size needed to certify level α at candidate-set size m. */
export const requiredCalibrationSize = (m, alpha) => Math.ceil(m / alpha) - 1;

/**
 * DIRECT set-conformal calibration, for comparison with the Bonferroni route.
 *
 * Partitions the pairwise calibration pool into ⌊n/m⌋ disjoint synthetic
 * candidate sets of size m and calibrates on their maxima, so the calibrated
 * statistic is the deployed statistic. Tighter than Bonferroni when several
 * candidates can score high at once.
 *
 * It buys that tightness with a strictly stronger assumption — the synthetic
 * calibration sets must be exchangeable with the DEPLOYED candidate sets, i.e.
 * the calibration data must reproduce the candidate-set structure seen at
 * deployment — and with calibration units that get m times scarcer. Disjoint
 * partitioning (rather than resampling) is what keeps the units exchangeable;
 * overlapping sets would re-use scores across units and void the argument.
 */
export function calibrationMaxima(distinctCalScores, m, rngSeed = 1) {
  const s = [...distinctCalScores].filter((v) => v !== null && v !== undefined);
  if (m <= 0 || s.length < m) return [];
  let state = rngSeed >>> 0;
  const rnd = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = s.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [s[i], s[j]] = [s[j], s[i]];
  }
  const maxima = [];
  for (let start = 0; start + m <= s.length; start += m) {
    maxima.push(Math.max(...s.slice(start, start + m)));
  }
  return maxima;
}

/** Threshold for S* calibrated directly on candidate sets of size m. */
export function setConformalThreshold(distinctCalScores, alpha, m, rngSeed = 1) {
  if (!Number.isFinite(m) || m <= 0) return Infinity;
  return suppressionThreshold(calibrationMaxima(distinctCalScores, m, rngSeed), alpha);
}

/**
 * Lower edge of the escalation band, calibrated on SAME-pair scores: t_lo is the
 * ⌊(n+1)·γ⌋-th smallest same-pair calibration score, so a true duplicate falls
 * below the band — executing with NO flag — with probability at most ≈ γ.
 *
 * No multiplicity correction is needed here, and the reason is worth stating:
 * for a true duplicate the candidate set CONTAINS its match, so
 * S* ≥ s_match and P(S* ≤ t_lo) ≤ P(s_match ≤ t_lo) ≤ γ. Taking a maximum
 * hurts the safety side (more chances to exceed t_hi) and helps the liveness
 * side (more chances to clear t_lo). The asymmetry of the correction mirrors
 * the asymmetry of the loss.
 */
export function escalationFloor(sameCalScores, gamma) {
  const s = [...sameCalScores].filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  const k = Math.floor((n + 1) * gamma);
  if (k < 1) return 0;
  return s[Math.min(k, n) - 1];
}

/**
 * The layered decision rule for a single score:
 *   s >  tHi          → SUPPRESS  (wrong-suppression ≤ α by construction)
 *   tLo <  s ≤ tHi    → ESCALATE  (execute + flag for reconciliation)
 *   s ≤ tLo           → EXECUTE   (treat as a distinct action)
 */
export function decide(score, tHi, tLo) {
  if (score > tHi) return "SUPPRESS";
  if (score > tLo) return "ESCALATE";
  return "EXECUTE";
}

/**
 * The decision over a whole candidate set — what Algorithm 1 runs.
 *
 * `scores` is aligned with the candidate set and may contain `null` for a pair
 * the judge ABSTAINED on. Abstentions are dropped from the maximum rather than
 * imputed: a judge that did not answer is not evidence of distinctness, so if
 * every candidate abstained the decision is ESCALATE (execute, but flag) rather
 * than EXECUTE. Only a real score can clear t_lo into a silent execution, and
 * only a real score above t_hi can suppress.
 *
 * @returns {{decision: string, score: number|null, index: number, m: number, tHi: number}}
 */
export function decideOverCandidates(scores, { distinctCalScores, alpha, tLo, tHiOverride }) {
  const m = scores.length;
  if (m === 0) return { decision: "EXECUTE", score: null, index: -1, m: 0, tHi: Infinity };

  const tHi = tHiOverride !== undefined ? tHiOverride : maxSuppressionThreshold(distinctCalScores, alpha, m);
  let best = -1, bestScore = null;
  for (let i = 0; i < m; i++) {
    const s = scores[i];
    if (s === null || s === undefined) continue;
    if (bestScore === null || s > bestScore) { bestScore = s; best = i; }
  }
  if (bestScore === null) {
    // Every comparison abstained: suspected but unjudgeable. Never suppress.
    return { decision: "ESCALATE", score: null, index: 0, m, tHi };
  }
  return { decision: decide(bestScore, tHi, tLo), score: bestScore, index: best, m, tHi };
}
