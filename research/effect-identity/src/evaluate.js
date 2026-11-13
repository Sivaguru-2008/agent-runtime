import { canonicalize, canonicalString, semanticProjection, tightenedProjection } from "./canonicalize.js";
import { suppressionThreshold, escalationFloor, decide, maxCertifiableCandidates } from "./conformal.js";
import { extractNumbers } from "./judge.js";
import { rate } from "./stats.js";

/**
 * The shared evaluation core.
 *
 * Every configuration reported in the paper — baselines, ablations, schema
 * levels, attack rows, the human-label re-analysis — is the same decision
 * procedure with different layers switched on and a different calibration pool.
 * Writing it once, parameterised, is not tidiness: the previous arrangement had
 * each experiment re-deriving the decision rule, and two of them had drifted
 * apart on the one point that matters most (which pairs enter the pool). A
 * single implementation makes a jurisdiction mismatch impossible to introduce
 * by accident, and makes the ablation matrix mean what it says, since every row
 * differs from every other row in exactly the declared way.
 *
 * The decision rule, in full:
 *
 *   certifier fires (canonical equality)      → SUPPRESS   exact under A5
 *   refuter fires (projection difference)     → EXECUTE    exact under A5'
 *   judge abstained                           → ESCALATE   never suppress on a non-answer
 *   otherwise                                 → threshold the score
 *
 * Switching a layer OFF removes its branch. That changes which pairs reach the
 * judge, which changes the rule's jurisdiction, which changes what the pool
 * must be — so `calibrate()` derives the pool from the SAME layer flags the
 * evaluation uses, rather than taking a pool as an argument.
 */

/** Projections available as the witness sigma. */
export const PROJECTIONS = {
  declared: (input, schema) => semanticProjection(input, schema),
  tightened: (input, schema) => tightenedProjection(input, schema, extractNumbers),
};

/**
 * Annotate a pair with its decidable-layer facts under a given schema table and
 * projection. Pure; safe to call repeatedly.
 */
export function classifyPair(p, schemas, projectionName = "declared") {
  const s = schemas[p.tool];
  if (!s) throw new Error(`no schema for tool ${p.tool}`);
  const proj = PROJECTIONS[projectionName];
  const certifies = canonicalString(canonicalize(p.a, s)) === canonicalString(canonicalize(p.b, s));
  const refutes = proj(p.a, s) !== proj(p.b, s);
  return {
    certifies,
    refutes,
    // A pair is residual when neither decidable layer settles it. Note that a
    // pair can in principle be both (canonically equal yet projection-different)
    // only if the projection is not a function of the canonical form; for the
    // projections here it cannot happen, and the certifier is checked first
    // regardless, matching Algorithm 1.
    residual: !certifies && !refutes,
  };
}

/**
 * A configuration is a set of layer switches. The names are the paper's.
 *
 *   certifier   L0 canonical equality; licenses SUPPRESS
 *   refuter     the distinctness witness; licenses EXECUTE
 *   judge       the calibrated semantic layer
 *   calibrated  false = a fixed hand-set threshold instead of a conformal one
 *   band        the escalation band; false collapses ESCALATE into EXECUTE
 *   multiplicity how the threshold treats candidate-set size
 */
export const DEFAULT_CONFIG = {
  certifier: true, refuter: true, judge: true, calibrated: true, band: true,
  projection: "declared", multiplicity: "corrected",
};

/**
 * Derive the calibration pool for a configuration: the DIFF pairs that this
 * configuration's own layers would route to the judge.
 *
 * This function is the reason the module exists. A6 asks for exchangeability
 * between the calibration scores and the scores the deployed rule thresholds,
 * and which pairs those are is decided by the layers in FRONT of the judge. A
 * pool built once and reused across configurations is drawn from a different
 * population than most of them deploy on, and the resulting violation is in the
 * unsafe direction and does not announce itself in a rate measured over the
 * whole split.
 */
export function jurisdictionFilter(cfg) {
  return (facts) => {
    if (cfg.certifier && facts.certifies) return false; // settled without the judge
    if (cfg.refuter && facts.refutes) return false;     // settled without the judge
    return true;
  };
}

/**
 * Build a decision function plus its calibration record.
 *
 * @param {object[]} calPairs  calibration split, each carrying `.facts`
 * @param {(p) => number|null} scoreOf
 * @param {object} cfg
 * @param {number} alpha
 * @param {number} gamma
 * @param {{poolOverride?: number[], fixedTau?: number, m?: number}} [opts]
 */
export function calibrate(calPairs, scoreOf, cfg, alpha, gamma, opts = {}) {
  const inJurisdiction = jurisdictionFilter(cfg);
  const pool = calPairs.filter((p) => inJurisdiction(p.facts) && scoreOf(p) !== null);
  const calDiff = opts.poolOverride ?? pool.filter((p) => p.label === "DIFF").map(scoreOf);
  const calSame = pool.filter((p) => p.label === "SAME").map(scoreOf);

  const m = opts.m ?? 1;
  let tHi;
  if (!cfg.judge) tHi = Infinity;
  else if (!cfg.calibrated) tHi = opts.fixedTau ?? 0.5;
  else if (cfg.multiplicity === "uncorrected") tHi = suppressionThreshold(calDiff, alpha);
  else tHi = suppressionThreshold(calDiff, alpha / Math.max(1, m));

  // The band's floor is calibrated on SAME scores. With the band off there is no
  // zone of doubt: everything at or below t_hi executes, silently.
  const tLo = cfg.band
    ? Math.min(escalationFloor(calSame.length ? calSame : [0.5], gamma), tHi === Infinity ? Infinity : tHi)
    : (tHi === Infinity ? Infinity : tHi);

  return {
    tHi, tLo, nCalDiff: calDiff.length, nCalSame: calSame.length,
    certifiableM: maxCertifiableCandidates(calDiff.length, alpha),
    poolIsResidual: cfg.certifier && cfg.refuter,
  };
}

/** The decision this configuration makes on one pair. */
export function decidePair(p, scoreOf, cfg, cal) {
  if (cfg.certifier && p.facts.certifies) return { decision: "SUPPRESS", by: "certifier" };
  if (cfg.refuter && p.facts.refutes) return { decision: "EXECUTE", by: "refuter" };
  if (!cfg.judge) return { decision: "EXECUTE", by: "no-judge" };
  const s = scoreOf(p);
  // An abstention is not evidence of distinctness. It can never suppress, and
  // with the band on it escalates; with the band off there is nowhere for it to
  // go but execution, which is the honest consequence of removing the band.
  if (s === null) return { decision: cfg.band ? "ESCALATE" : "EXECUTE", by: "abstention" };
  return { decision: decide(s, cal.tHi, cal.tLo), by: "judge" };
}

/** Rates over an arbitrary pair set, given a decision function. */
export function measure(set, decideOne, labelOf = (p) => p.label) {
  const same = set.filter((p) => labelOf(p) === "SAME");
  const diff = set.filter((p) => labelOf(p) === "DIFF");
  const d = (p) => decideOne(p).decision;
  return {
    nSame: same.length, nDiff: diff.length,
    wrongSuppression: rate(diff.filter((p) => d(p) === "SUPPRESS").length, diff.length),
    friction: rate(diff.filter((p) => d(p) === "ESCALATE").length, diff.length),
    dedup: rate(same.filter((p) => d(p) === "SUPPRESS").length, same.length),
    silentEscape: rate(same.filter((p) => d(p) === "EXECUTE").length, same.length),
    flaggedEscape: rate(same.filter((p) => d(p) === "ESCALATE").length, same.length),
  };
}

/** Which layer settled each decision — the jurisdiction split of §8.10. */
export function jurisdiction(set, decideOne) {
  const by = { certifier: 0, refuter: 0, judge: 0, abstention: 0, "no-judge": 0 };
  for (const p of set) by[decideOne(p).by] = (by[decideOne(p).by] ?? 0) + 1;
  const n = set.length;
  return {
    n,
    certifier: rate(by.certifier, n),
    refuter: rate(by.refuter, n),
    judge: rate(by.judge + by.abstention, n),
    residualShare: rate(set.filter((p) => p.facts.residual).length, n),
  };
}

/**
 * Run one configuration end to end.
 *
 * @returns {{config, calibration, overall, residual, jurisdiction, perCategory, decisions}}
 */
export function runConfig({ pairs, schemas, cfg, judge, scoreOf, alpha, gamma = 0.05, opts = {}, labelOf }) {
  const conf = { ...DEFAULT_CONFIG, ...cfg };
  for (const p of pairs) p.facts = classifyPair(p, schemas, conf.projection);
  const cal = pairs.filter((p) => p.split === "cal");
  const test = pairs.filter((p) => p.split === "test");
  const calibration = calibrate(cal, scoreOf, conf, alpha, gamma, opts);
  const decideOne = (p) => decidePair(p, scoreOf, conf, calibration);

  const perCategory = {};
  for (const cat of [...new Set(test.map((p) => p.category))]) {
    const set = test.filter((p) => p.category === cat);
    perCategory[cat] = {
      n: set.length, label: set[0]?.label,
      suppress: rate(set.filter((p) => decideOne(p).decision === "SUPPRESS").length, set.length),
      escalate: rate(set.filter((p) => decideOne(p).decision === "ESCALATE").length, set.length),
      execute: rate(set.filter((p) => decideOne(p).decision === "EXECUTE").length, set.length),
    };
  }

  const attacks = {};
  for (const cat of [...new Set(pairs.filter((p) => p.split === "attack").map((p) => p.category))]) {
    const set = pairs.filter((p) => p.split === "attack" && p.category === cat);
    // For an attack the failure is the decision that contradicts the label: a
    // DIFF attack fails when suppressed, a SAME attack (forced execution) fails
    // when it is NOT suppressed.
    const fails = set.filter((p) => {
      const dec = decideOne(p).decision;
      return (set[0].label === "DIFF") ? dec === "SUPPRESS" : dec !== "SUPPRESS";
    });
    attacks[cat] = {
      label: set[0]?.label,
      failure: rate(fails.length, set.length),
      stoppedBy: set.reduce((m, p) => { const b = decideOne(p).by; m[b] = (m[b] ?? 0) + 1; return m; }, {}),
      reachedJudge: rate(set.filter((p) => ["judge", "abstention"].includes(decideOne(p).by)).length, set.length),
    };
  }

  return {
    config: conf, judge, alpha, calibration,
    overall: measure(test, decideOne, labelOf),
    residual: measure(test.filter((p) => p.facts.residual), decideOne, labelOf),
    jurisdiction: jurisdiction(test, decideOne),
    perCategory, attacks,
    decisionsById: Object.fromEntries(test.map((p) => [p.id, decideOne(p).decision])),
  };
}

/** Load a corpus file (jsonl) and attach scores from a scores file. */
export function makeScoreLookup(scoreRows, judgeKeyName) {
  const byId = new Map(scoreRows.map((r) => [r.id, r]));
  return (p) => {
    const r = byId.get(p.id);
    if (!r) return null;
    const v = r.judges?.[judgeKeyName];
    return v === undefined ? null : v;
  };
}
