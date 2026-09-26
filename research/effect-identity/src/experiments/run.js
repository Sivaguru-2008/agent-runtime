import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, canonicalString, semanticProjection, tightenedProjection } from "../canonicalize.js";
import {
  suppressionThreshold, escalationFloor, decide,
  maxCertifiableCandidates, requiredCalibrationSize,
} from "../conformal.js";
import { lexicalScore, judgeKey, extractNumbers } from "../judge.js";
import { rate, fmtRate, BASIS, zeroEventUpperBound95 } from "../stats.js";
import { TOOLS } from "../tools.js";

/**
 * All corpus experiments and ablations, computed offline from the persisted
 * pairs and judge scores (no network). Rerunnable and deterministic.
 *
 * Decision model per pair (a committed, b dispatched):
 *   SUPPRESS — b treated as the same effect as a (deduplicated)
 *   ESCALATE — b executes but is durably flagged DUPLICATE_SUSPECT
 *   EXECUTE  — b executes as a distinct effect
 *
 * Safety metric:      wrongSuppression = P(SUPPRESS | DIFF)   (bounded by α)
 * Liveness metrics:   silentEscape     = P(EXECUTE  | SAME)   (silent duplicate)
 *                     flaggedEscape    = P(ESCALATE | SAME)   (loud duplicate)
 *                     dedup            = P(SUPPRESS | SAME)
 *                     friction         = P(ESCALATE | DIFF)
 *
 * CANDIDATE-SET SIZE. Every pair here is one candidate against one dispatch, so
 * m = 1 and the multiplicity-corrected threshold t_hi(m) = t_hi(α/m) coincides
 * with the pairwise one. That is why this file calibrates pairwise and the
 * m > 1 behaviour lives in multiCandidate.js: reporting a corrected threshold
 * here would imply a correction the data cannot exercise.
 *
 * ABSTENTIONS. A judge score may be `null` — the strict parser recorded no
 * admissible answer. Null is never imputed: it is dropped from calibration and
 * decided as ESCALATE (execute, but flagged), matching the fence. Counting it
 * as 0.5 would both move the thresholds and manufacture a judgment.
 *
 * Every rate is reported with raw counts and a Wilson 95% interval; a "0%" over
 * 10^2 samples is a claim about the sample, not the rate. Rates whose zero
 * follows from a decidable layer carry the basis that justifies them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..", "..");
const GAMMA = 0.05; // escalation-floor level: unflagged-escape target for L1
const ALPHAS = [0.01, 0.02, 0.05, 0.1, 0.2];

const pairs = readFileSync(resolve(base, "corpus", "pairs.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
// SCORES_FILE lets a dry run read a scratch score file while a live scoring pass
// is still writing the real one; without it the two races over one path.
const scoresPath = process.env.SCORES_FILE ?? resolve(base, "corpus", "scores.jsonl");
const scores = new Map(
  readFileSync(scoresPath, "utf8")
    .split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.id, r]; })
);
const judgeMeta = existsSync(resolve(base, "results", "judge_meta.json"))
  ? JSON.parse(readFileSync(resolve(base, "results", "judge_meta.json"), "utf8"))
  : { models: {} };

const JUDGE_COLS = [...new Set(
  [...scores.values()].flatMap((r) => Object.keys(r.judges ?? {}))
)].sort();

const usable = (v) => v !== null && v !== undefined;

/**
 * Judges whose coverage is high enough to report at all.
 *
 * A judge that abstained on most of the corpus still produces a full set of
 * metrics, and they look excellent: with almost no scores the calibration pool
 * cannot certify α, `t_hi` becomes +∞, nothing is ever suppressed, and the row
 * reads "0.0% wrong-suppression, 0.0% silent escape". That is the appearance of
 * a flawless judge produced by the ABSENCE of a judge. Such columns are still
 * computed (so §7.0 can report exactly how much coverage each judge had) but
 * are excluded from the ensembles and flagged `insufficientCoverage` so no
 * table can quietly present them as results.
 */
const MIN_COVERAGE = 0.8;
const coverageOf = (col) =>
  [...scores.values()].filter((r) => usable(r.judges?.[col])).length / Math.max(1, scores.size);
const ENSEMBLE_COLS = JUDGE_COLS.filter((c) => coverageOf(c) >= MIN_COVERAGE);

for (const p of pairs) {
  const s = scores.get(p.id);
  for (const col of JUDGE_COLS) {
    const v = s?.judges?.[col];
    p[col] = v === undefined ? null : v; // null = abstention or never scored
  }
  // Lexical scores are recomputed live (deterministic, offline) so scorer
  // improvements are always reflected; scores.jsonl is authoritative only for
  // the LLM judges.
  p.lexical = lexicalScore(p.tool, p.a, p.b, TOOLS[p.tool]);
  // Ensemble arms. `min` is the safety-aligned aggregator under this loss
  // asymmetry: it suppresses only when EVERY judge agrees the pair is the same
  // act, so a single dissenting judge is enough to prevent a wrong suppression.
  // `mean` is the conventional aggregator, kept for comparison. An abstaining
  // judge is DROPPED from the aggregate rather than counted as agreement; if
  // every judge abstained the ensemble abstains too.
  // Ensembles are built ONLY from judges with usable coverage (see
  // ENSEMBLE_COLS). Aggregating over every column would silently vary the
  // ensemble's membership from pair to pair — a judge that abstained on 94% of
  // the corpus would contribute to the 6% it answered and vanish elsewhere, so
  // "the min ensemble" would name a different estimator on almost every row.
  const js = ENSEMBLE_COLS.map((c) => p[c]).filter(usable);
  p.ensemble_min = js.length ? Math.min(...js) : null;
  p.ensemble_mean = js.length ? js.reduce((a, b) => a + b, 0) / js.length : null;
  p.nJudgesAnswering = js.length;

  const schema = TOOLS[p.tool];
  p.l0Equal = canonicalString(canonicalize(p.a, schema)) === canonicalString(canonicalize(p.b, schema));
  p.exactEqual = JSON.stringify(p.a) === JSON.stringify(p.b);
  p.semEqual = semanticProjection(p.a, schema) === semanticProjection(p.b, schema);
  // The tightened-schema witness: declared fields plus the numeric magnitudes
  // mentioned in free text (§ schema-first friction reduction).
  p.semEqualTight =
    tightenedProjection(p.a, schema, extractNumbers) === tightenedProjection(p.b, schema, extractNumbers);
}

const SCORERS = [...JUDGE_COLS, "ensemble_min", "ensemble_mean", "lexical"];
// The primary judge is declared explicitly rather than inferred from a name
// prefix, so adding a judge cannot silently move the headline.
const PRIMARY = process.env.PRIMARY_JUDGE
  ?? JUDGE_COLS.find((c) => c.includes("gpt_oss"))
  ?? JUDGE_COLS[0] ?? "lexical";

const cal = pairs.filter((p) => p.split === "cal");
const test = pairs.filter((p) => p.split === "test");
const attack = pairs.filter((p) => p.split === "attack");
const GENERATORS = [...new Set(pairs.filter((p) => p.generator).map((p) => p.generator))].sort();
const TOOL_NAMES = [...new Set(pairs.map((p) => p.tool))].sort();

function metrics(decisions, basisFor = {}) {
  const same = decisions.filter((d) => d.label === "SAME");
  const diff = decisions.filter((d) => d.label === "DIFF");
  const count = (arr, dec) => arr.filter((d) => d.decision === dec).length;
  const r = (arr, dec, name) => rate(count(arr, dec), arr.length, basisFor[name] ?? BASIS.MEASURED);
  const perCategory = {};
  for (const cat of new Set(decisions.map((d) => d.category))) {
    const rows = decisions.filter((d) => d.category === cat);
    perCategory[cat] = {
      n: rows.length, label: rows[0].label,
      suppress: rate(count(rows, "SUPPRESS"), rows.length),
      escalate: rate(count(rows, "ESCALATE"), rows.length),
      execute: rate(count(rows, "EXECUTE"), rows.length),
    };
  }
  return {
    nSame: same.length, nDiff: diff.length,
    wrongSuppression: r(diff, "SUPPRESS", "wrongSuppression"),
    friction: r(diff, "ESCALATE", "friction"),
    correctExecute: r(diff, "EXECUTE", "correctExecute"),
    dedup: r(same, "SUPPRESS", "dedup"),
    flaggedEscape: r(same, "ESCALATE", "flaggedEscape"),
    silentEscape: r(same, "EXECUTE", "silentEscape"),
    perCategory,
  };
}

/**
 * One fence decision on one pair.
 *
 * `witness`: false | "declared" (σ = declared non-text fields) | "tight"
 * (σ additionally pins the numbers mentioned in free text).
 */
function layeredDecision(p, scorerKey, tHi, tLo, { useL0 = true, witness = false } = {}) {
  if (useL0 && p.l0Equal) return "SUPPRESS";
  if (witness === "declared" && !p.semEqual) return "EXECUTE";
  if (witness === "tight" && !p.semEqualTight) return "EXECUTE";
  const s = p[scorerKey];
  // An abstention is suspected-but-unjudgeable: execute AND flag. Never
  // suppress on it, and never let it pass as a confident distinct verdict.
  if (!usable(s)) return "ESCALATE";
  return decide(s, tHi, tLo);
}

const results = {
  generatedAt: new Date().toISOString(),
  gamma: GAMMA,
  alphas: ALPHAS,
  judgeColumns: JUDGE_COLS,
  scorers: SCORERS,
  primaryScorer: PRIMARY,
  generators: GENERATORS,
  tools: TOOL_NAMES,
  candidateSetSize: 1,
  candidateSetNote:
    "Every corpus pair is one candidate against one dispatch (m = 1), so the " +
    "multiplicity-corrected threshold coincides with the pairwise one here. " +
    "The m > 1 behaviour is measured in multiCandidate.js.",
  corpus: { nCal: cal.length, nTest: test.length, nAttack: attack.length, nTotal: pairs.length },
  abstentions: {}, configs: {}, baselines: {}, sweeps: {}, ablations: {}, distributions: {},
  l0: {}, crossGenerator: {}, judgeComparison: {}, perToolCalibration: {}, cost: {},
};

// ── Abstention accounting ────────────────────────────────────────────────────
for (const col of [...JUDGE_COLS, "ensemble_min", "ensemble_mean"]) {
  results.abstentions[col] = {
    all: rate(pairs.filter((p) => !usable(p[col])).length, pairs.length),
    test: rate(test.filter((p) => !usable(p[col])).length, test.length),
    cal: rate(cal.filter((p) => !usable(p[col])).length, cal.length),
    attack: rate(attack.filter((p) => !usable(p[col])).length, attack.length),
  };
}

// ── L0 coverage facts ────────────────────────────────────────────────────────
{
  const testSame = test.filter((p) => p.label === "SAME");
  const testDiff = test.filter((p) => p.label === "DIFF");
  results.l0 = {
    sameCaughtByL0: rate(testSame.filter((p) => p.l0Equal).length, testSame.length),
    // MUST be 0. T2 proves this GIVEN A5 (policy soundness); the measurement
    // therefore tests A5 against the corpus, not the theorem.
    diffCaughtByL0: rate(testDiff.filter((p) => p.l0Equal).length, testDiff.length, BASIS.PROVABLE_A5),
    perCategoryL0: Object.fromEntries(
      [...new Set(test.map((p) => p.category))].map((cat) => {
        const catPairs = test.filter((p) => p.category === cat);
        return [cat, rate(catPairs.filter((p) => p.l0Equal).length, catPairs.length)];
      })
    ),
  };
}

// ── Baselines ────────────────────────────────────────────────────────────────
const asDecisions = (fn, rows = test) =>
  rows.map((p) => ({ label: p.label, category: p.category, generator: p.generator, tool: p.tool, decision: fn(p) }));
results.baselines.B0_noFence = metrics(asDecisions(() => "EXECUTE"));
results.baselines.B1_exactString = metrics(asDecisions((p) => (p.exactEqual ? "SUPPRESS" : "EXECUTE")));
results.baselines.B2_canonicalL0 = metrics(
  asDecisions((p) => (p.l0Equal ? "SUPPRESS" : "EXECUTE")),
  { wrongSuppression: BASIS.PROVABLE_A5 }
);
for (const tau of [0.5, 0.9, 0.95]) {
  results.baselines[`B4_rawJudge_${tau}`] = metrics(
    asDecisions((p) => (usable(p[PRIMARY]) && p[PRIMARY] > tau ? "SUPPRESS" : "EXECUTE")));
}

// ── Layered configurations, per scorer ───────────────────────────────────────
const calScoresFor = (scorerKey, rows = cal) => ({
  diff: rows.filter((p) => p.label === "DIFF" && usable(p[scorerKey]) && !p.l0Equal).map((p) => p[scorerKey]),
  same: rows.filter((p) => p.label === "SAME" && usable(p[scorerKey]) && !p.l0Equal).map((p) => p[scorerKey]),
});

const thresholds = {};
for (const scorerKey of SCORERS) {
  const { diff: calDiff, same: calSame } = calScoresFor(scorerKey);
  for (const alpha of ALPHAS) {
    const tHi = suppressionThreshold(calDiff, alpha);
    const tLo = Math.min(escalationFloor(calSame, GAMMA), tHi === Infinity ? Infinity : tHi);
    thresholds[`${scorerKey}_${alpha}`] = { tHi, tLo };
    const common = {
      alpha, scorer: scorerKey, tHi, tLo, nCalDiff: calDiff.length, nCalSame: calSame.length,
      // What this calibration budget would support if a run committed several
      // effects for one tool — the constraint the multi-candidate experiment
      // then measures against.
      maxCertifiableCandidates: maxCertifiableCandidates(calDiff.length, alpha),
    };
    results.configs[`layered_${scorerKey}_alpha_${alpha}`] = {
      ...common, witness: false,
      ...metrics(asDecisions((p) => layeredDecision(p, scorerKey, tHi, tLo))),
    };
    results.configs[`hardened_${scorerKey}_alpha_${alpha}`] = {
      ...common, witness: "declared",
      ...metrics(asDecisions((p) => layeredDecision(p, scorerKey, tHi, tLo, { witness: "declared" }))),
    };
    results.configs[`tightened_${scorerKey}_alpha_${alpha}`] = {
      ...common, witness: "tight",
      ...metrics(asDecisions((p) => layeredDecision(p, scorerKey, tHi, tLo, { witness: "tight" }))),
    };
  }
}

// ── Per-tool calibration (friction reduction A) ──────────────────────────────
// One global threshold serves six tools whose score distributions differ. Per-
// tool calibration should buy friction back; it also splits the calibration
// budget six ways, which is the cost. Both are measured.
{
  for (const scorerKey of [...JUDGE_COLS, "ensemble_min", "ensemble_mean"]) {
    for (const alpha of [0.01, 0.05]) {
      const perTool = {};
      const decisions = [];
      for (const tool of TOOL_NAMES) {
        const c = calScoresFor(scorerKey, cal.filter((p) => p.tool === tool));
        const tHi = suppressionThreshold(c.diff, alpha);
        const tLo = Math.min(escalationFloor(c.same, GAMMA), tHi === Infinity ? Infinity : tHi);
        perTool[tool] = { tHi, tLo, nCalDiff: c.diff.length, nCalSame: c.same.length };
        for (const p of test.filter((x) => x.tool === tool)) {
          decisions.push({
            label: p.label, category: p.category, generator: p.generator, tool,
            decision: layeredDecision(p, scorerKey, tHi, tLo, { witness: "declared" }),
          });
        }
      }
      const global = results.configs[`hardened_${scorerKey}_alpha_${alpha}`];
      results.perToolCalibration[`${scorerKey}_alpha_${alpha}`] = {
        alpha, scorer: scorerKey, perTool,
        ...metrics(decisions),
        globalComparison: {
          wrongSuppression: global.wrongSuppression, dedup: global.dedup, friction: global.friction,
        },
      };
    }
  }
}

// ── Cross-generator × judge matrix (circularity check) ───────────────────────
function judgeFamilyOf(scorerKey) {
  if (scorerKey.startsWith("llama")) return "llama";
  if (scorerKey.startsWith("openai") || scorerKey.includes("gpt_oss")) return "gpt-oss";
  if (scorerKey.startsWith("qwen")) return "qwen";
  return null; // an ensemble spans families; "did this judge write it" has no answer
}
function familyOfGenerator(model) {
  if (model.startsWith("llama")) return "llama";
  if (model.startsWith("openai/")) return "gpt-oss";
  if (model.startsWith("qwen/")) return "qwen";
  return model; // handwritten-authors: no model family at all
}
{
  const alpha = 0.05;
  for (const scorerKey of [...JUDGE_COLS, "ensemble_min", "ensemble_mean"]) {
    const { tHi, tLo } = thresholds[`${scorerKey}_${alpha}`];
    const perGen = {};
    for (const gen of GENERATORS) {
      const rows = test.filter((p) => p.generator === gen);
      if (rows.length === 0) continue;
      const dec = asDecisions((p) => layeredDecision(p, scorerKey, tHi, tLo, { witness: "declared" }), rows);
      const same = dec.filter((d) => d.label === "SAME");
      perGen[gen] = {
        nSame: same.length,
        dedup: rate(same.filter((d) => d.decision === "SUPPRESS").length, same.length),
        silentEscape: rate(same.filter((d) => d.decision === "EXECUTE").length, same.length),
        selfGenerated: judgeFamilyOf(scorerKey) === null ? null : judgeFamilyOf(scorerKey) === familyOfGenerator(gen),
        isModelWritten: gen !== "handwritten-authors",
      };
    }
    results.crossGenerator[scorerKey] = { alpha, tHi, tLo, perGenerator: perGen };
  }
}

// ── Attack evaluation (D4 injection pairs; all DIFF) ─────────────────────────
{
  const alpha = 0.05;
  const attackDecisions = (fn) => attack.map((p) => ({ label: p.label, category: p.category, decision: fn(p) }));
  const suppressionRate = (dec, cat, basis) => {
    const rows = dec.filter((d) => d.category === cat);
    return rows.length === 0 ? null : rate(rows.filter((d) => d.decision === "SUPPRESS").length, rows.length, basis);
  };
  const evalCfg = (fn, { d4aBasis = BASIS.MEASURED, d4bBasis = BASIS.MEASURED } = {}) => {
    const dec = attackDecisions(fn);
    return {
      n: attack.length,
      wrongSuppression_D4a_field: suppressionRate(dec, "D4a_field_injection", d4aBasis),
      wrongSuppression_D4b_text: suppressionRate(dec, "D4b_text_injection", d4bBasis),
    };
  };
  results.attacks = {};
  for (const scorerKey of [...JUDGE_COLS, "ensemble_min", "ensemble_mean", "lexical"]) {
    const { tHi, tLo } = thresholds[`${scorerKey}_${alpha}`];
    results.attacks[`rawJudge_${scorerKey}`] = evalCfg((p) => (usable(p[scorerKey]) && p[scorerKey] > 0.5 ? "SUPPRESS" : "EXECUTE"));
    results.attacks[`layered_${scorerKey}`] = evalCfg((p) => layeredDecision(p, scorerKey, tHi, tLo));
    // D4a: the declared field differs, so the veto fires before the judge is
    // consulted — zero as a logical consequence of A5′, not an estimate.
    results.attacks[`hardened_${scorerKey}`] = evalCfg(
      (p) => layeredDecision(p, scorerKey, tHi, tLo, { witness: "declared" }),
      { d4aBasis: BASIS.PROVABLE_A5PRIME });
    // D4b: identical declared fields, so only a WIDER projection can reach it.
    results.attacks[`tightened_${scorerKey}`] = evalCfg(
      (p) => layeredDecision(p, scorerKey, tHi, tLo, { witness: "tight" }),
      { d4aBasis: BASIS.PROVABLE_A5PRIME, d4bBasis: BASIS.PROVABLE_A5PRIME });
  }
}

// ── Ablations (on the primary judge) ─────────────────────────────────────────
{
  const scorerKey = PRIMARY;
  const alpha = 0.05;
  const { tHi, tLo } = thresholds[`${scorerKey}_${alpha}`];
  results.ablations.noL0 = metrics(asDecisions((p) => layeredDecision(p, scorerKey, tHi, tLo, { useL0: false })));
  results.ablations.noEscalation = metrics(asDecisions(
    (p) => (p.l0Equal ? "SUPPRESS" : (usable(p[scorerKey]) && p[scorerKey] > tHi ? "SUPPRESS" : "EXECUTE"))));
  results.ablations.noCalibration = metrics(asDecisions(
    (p) => (p.l0Equal ? "SUPPRESS" : (usable(p[scorerKey]) ? decide(p[scorerKey], 0.5, 0.3) : "ESCALATE"))));
  const settledByL0 = test.filter((p) => p.l0Equal).length;
  const settledByWitness = test.filter((p) => !p.l0Equal && !p.semEqual).length;
  const settledByTightWitness = test.filter((p) => !p.l0Equal && !p.semEqualTight).length;
  results.ablations.judgeJurisdiction = {
    nTest: test.length,
    settledByL0: rate(settledByL0, test.length),
    settledByWitness: rate(settledByWitness, test.length),
    settledByTightWitness: rate(settledByTightWitness, test.length),
    needsJudge: rate(test.length - settledByL0 - settledByWitness, test.length),
    needsJudgeTightened: rate(test.length - settledByL0 - settledByTightWitness, test.length),
  };
}

// ── Judge / ensemble comparison ──────────────────────────────────────────────
{
  const alpha = 0.05;
  for (const scorerKey of SCORERS) {
    const cfg = results.configs[`hardened_${scorerKey}_alpha_${alpha}`];
    results.judgeComparison[scorerKey] = {
      tHi: cfg.tHi, tLo: cfg.tLo,
      wrongSuppression: cfg.wrongSuppression, dedup: cfg.dedup,
      silentEscape: cfg.silentEscape, flaggedEscape: cfg.flaggedEscape, friction: cfg.friction,
      abstentionRate: results.abstentions[scorerKey]?.test ?? null,
    };
  }
}

// ── Calibration-size sweep (validity of the finite-sample bound) ─────────────
{
  const scorerKey = PRIMARY;
  const alpha = 0.05;
  const calDiffAll = calScoresFor(scorerKey).diff;
  const testDiff = test.filter((p) => p.label === "DIFF" && !p.l0Equal);
  let s = 99;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const sweep = [];
  for (const n of [10, 20, 30, 50, 100, calDiffAll.length]) {
    let sumWS = 0, infCount = 0, maxWS = 0;
    const observed = [];
    const R = 300;
    for (let r2 = 0; r2 < R; r2++) {
      const sample = Array.from({ length: n }, () => calDiffAll[Math.floor(rnd() * calDiffAll.length)]);
      const t = suppressionThreshold(sample, alpha);
      if (t === Infinity) { infCount += 1; continue; }
      const ws = testDiff.filter((p) => usable(p[scorerKey]) && p[scorerKey] > t).length / testDiff.length;
      observed.push(ws);
      sumWS += ws;
      maxWS = Math.max(maxWS, ws);
    }
    observed.sort((a, b) => a - b);
    const q = (p2) => (observed.length ? observed[Math.min(observed.length - 1, Math.floor(p2 * observed.length))] : 0);
    sweep.push({
      n, alpha, resamples: R,
      pThresholdInfinite: infCount / R,
      meanWrongSuppression: infCount === R ? 0 : sumWS / (R - infCount),
      medianWrongSuppression: q(0.5), p95WrongSuppression: q(0.95), maxWrongSuppression: maxWS,
      nTestDiff: testDiff.length,
      certifiableCandidateSets: maxCertifiableCandidates(n, alpha),
    });
  }
  results.sweeps.calibrationSize = sweep;
  results.sweeps.calibrationBudgetForM = Object.fromEntries(
    [1, 2, 5, 10, 25, 50].map((m) => [m, Object.fromEntries(ALPHAS.map((a) => [a, requiredCalibrationSize(m, a)]))]));
}

// ── Score distributions ──────────────────────────────────────────────────────
function quantiles(values) {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  // Fraction of scores at the extremes: the concrete measure of the
  // overconfidence that turns missed duplicates into SILENT rather than
  // flagged escapes (a judge that never emits mid-band scores gives the
  // escalation band nothing to catch).
  const saturated = v.filter((x) => x <= 0.02 || x >= 0.98).length / v.length;
  return { n: v.length, mean, min: v[0], q10: q(0.1), q25: q(0.25), median: q(0.5), q75: q(0.75), q90: q(0.9), max: v[v.length - 1], saturatedFraction: saturated };
}
for (const scorerKey of SCORERS) {
  results.distributions[scorerKey] = {
    same: quantiles(pairs.filter((p) => p.label === "SAME" && !p.l0Equal && usable(p[scorerKey])).map((p) => p[scorerKey])),
    diff: quantiles(pairs.filter((p) => p.label === "DIFF" && usable(p[scorerKey])).map((p) => p[scorerKey])),
    perCategory: Object.fromEntries(
      [...new Set(pairs.map((p) => p.category))].map((cat) => [
        cat, quantiles(pairs.filter((p) => p.category === cat && usable(p[scorerKey])).map((p) => p[scorerKey])),
      ])
    ),
  };
}

// ── Cost model: what the mechanism costs per 1000 irreversible actions ───────
// Escalation is a HUMAN cost and judge calls are a machine cost; both are
// reported in the same units. (At α = 0.05 on the primary judge the band is
// empty, so escalation contributes nothing and the judge's cost is what remains.)
{
  const alpha = 0.05;
  const jm = judgeMeta.models?.[PRIMARY];
  const needsJudge = results.ablations.judgeJurisdiction.needsJudge.value;
  const needsJudgeTight = results.ablations.judgeJurisdiction.needsJudgeTightened.value;
  const hardened = results.configs[`hardened_${PRIMARY}_alpha_${alpha}`];
  const tightened = results.configs[`tightened_${PRIMARY}_alpha_${alpha}`];
  // judge_meta.json records tokens for the FINAL scoring session only, so the
  // denominator must be the pairs scored in that session (parse.pairsScored),
  // not every pair ever scored. Dividing by the latter understated the
  // per-comparison cost roughly ten-fold (corrected 2026-09-14).
  const sessionPairs = jm ? (jm.parse?.pairsScored ?? jm.scoredPairs ?? pairs.length) : null;
  const perPairTokens = jm ? (jm.inputTokens + jm.outputTokens) / Math.max(1, sessionPairs) : null;
  const perPairLatency = jm ? jm.meanCallLatencyMs / Math.max(1, jm.batchSize ?? 1) : null;
  // Mean latency of one BATCHED call (batchSize pairs). A deployed dispatch
  // makes one call over its m candidates, so this is a proxy, not a measurement
  // of an unbatched single-pair call.
  const dispatchLatency = jm ? jm.meanCallLatencyMs : null;

  const per1000 = (fracJudged, escalationRate) => ({
    judgeCallsPer1000: Math.round(fracJudged * 1000),
    judgeTokensPer1000: perPairTokens === null ? null : Math.round(fracJudged * 1000 * perPairTokens),
    addedLatencyMsPerJudgedDispatch: dispatchLatency,
    escalationsPer1000DistinctActions: Math.round(escalationRate * 1000),
    // Cost is left as a rate the reader supplies: we measured tokens, not
    // prices, and quoting a vendor price we did not verify would be inventing
    // a number in a paper about not inventing numbers.
    usdPer1000AtRate: perPairTokens === null ? null : Object.fromEntries(
      [0.1, 0.5, 1.0].map((usdPerMtok) => [
        `$${usdPerMtok}/Mtok`,
        Number(((fracJudged * 1000 * perPairTokens) / 1e6 * usdPerMtok).toFixed(4)),
      ])),
  });

  results.cost = {
    judge: PRIMARY,
    judgeMeta: jm ? {
      calls: jm.calls, batchSize: jm.batchSize, inputTokens: jm.inputTokens, outputTokens: jm.outputTokens,
      meanCallLatencyMs: jm.meanCallLatencyMs, tokensPerComparison: perPairTokens,
      batchedLatencyMsPerComparison: perPairLatency,
    } : null,
    declaredWitness: { fractionJudged: needsJudge, ...per1000(needsJudge, hardened.friction.value) },
    tightenedWitness: { fractionJudged: needsJudgeTight, ...per1000(needsJudgeTight, tightened.friction.value) },
    note:
      "Escalations are the human cost and are counted per 1000 GENUINELY DISTINCT actions " +
      "(the population that gets escalated); judge calls are per 1000 dispatches.",
  };
}

mkdirSync(resolve(base, "results"), { recursive: true });
writeFileSync(resolve(base, "results", "experiments.json"), JSON.stringify(results, null, 2));

// ── Console summary ──────────────────────────────────────────────────────────
const row = (name, m) =>
  `${name.padEnd(38)} ws=${fmtRate(m.wrongSuppression).padEnd(22)} dedup=${fmtRate(m.dedup).padEnd(22)} flagged=${fmtRate(m.flaggedEscape).padEnd(22)} silent=${fmtRate(m.silentEscape).padEnd(22)} friction=${fmtRate(m.friction)}`;

console.log(`corpus: ${JSON.stringify(results.corpus)}`);
console.log(`judges: ${JUDGE_COLS.join(", ")}   primary=${PRIMARY}`);
console.log(`generators: ${GENERATORS.join(", ")}`);
console.log("\n── abstentions (strict parser: no answer is recorded as no answer) ──");
for (const [k, v] of Object.entries(results.abstentions)) console.log(`${k.padEnd(28)} all=${fmtRate(v.all)}  test=${fmtRate(v.test)}`);

console.log(`\nL0 coverage of SAME (test): ${fmtRate(results.l0.sameCaughtByL0)}`);
console.log(`L0 false hits on DIFF:      ${fmtRate(results.l0.diffCaughtByL0)}  († = zero by T2 given A5; measurement tests A5)`);
console.log(`   rule-of-three check at n=${results.l0.diffCaughtByL0.n}: ${(zeroEventUpperBound95(results.l0.diffCaughtByL0.n) * 100).toFixed(1)}%`);

console.log("\n── baselines ──");
for (const [k, m] of Object.entries(results.baselines)) console.log(row(k, m));

console.log("\n── main configurations (primary judge) ──");
for (const alpha of [0.01, 0.05]) {
  for (const kind of ["layered", "hardened", "tightened"]) {
    console.log(row(`${kind} α=${alpha}`, results.configs[`${kind}_${PRIMARY}_alpha_${alpha}`]));
  }
}

console.log("\n── hardened α=0.05, by scorer (three judges + ensembles) ──");
for (const [k, m] of Object.entries(results.judgeComparison)) {
  console.log(`${k.padEnd(28)} tHi=${String(m.tHi).padEnd(6)} ws=${fmtRate(m.wrongSuppression).padEnd(22)} dedup=${fmtRate(m.dedup).padEnd(22)} silent=${fmtRate(m.silentEscape).padEnd(22)} friction=${fmtRate(m.friction)}`);
}

console.log("\n── per-tool calibration vs one global threshold (α=0.05) ──");
for (const [k, v] of Object.entries(results.perToolCalibration)) {
  if (!k.endsWith("0.05")) continue;
  console.log(`${k.padEnd(34)} perTool: ws=${fmtRate(v.wrongSuppression).padEnd(22)} friction=${fmtRate(v.friction).padEnd(22)} | global: ws=${fmtRate(v.globalComparison.wrongSuppression).padEnd(22)} friction=${fmtRate(v.globalComparison.friction)}`);
}

console.log("\n── cross-generator (circularity check, α=0.05) ──");
for (const [scorer, r] of Object.entries(results.crossGenerator)) {
  for (const [gen, m] of Object.entries(r.perGenerator)) {
    console.log(`${scorer.padEnd(26)} gen=${gen.padEnd(26)} self=${String(m.selfGenerated).padEnd(5)} dedup=${fmtRate(m.dedup)}`);
  }
}

console.log("\n── ablations (primary judge) ──");
for (const [k, m] of Object.entries(results.ablations)) if (m.wrongSuppression) console.log(row(k, m));
const jj = results.ablations.judgeJurisdiction;
console.log(`judgeJurisdiction: L0=${fmtRate(jj.settledByL0)} witness=${fmtRate(jj.settledByWitness)} needsJudge=${fmtRate(jj.needsJudge)}  (tightened: witness=${fmtRate(jj.settledByTightWitness)} needsJudge=${fmtRate(jj.needsJudgeTightened)})`);

console.log("\n── attacks (D4 wrong-suppression) ──");
for (const [k, m] of Object.entries(results.attacks)) {
  console.log(`${k.padEnd(38)} D4a=${fmtRate(m.wrongSuppression_D4a_field).padEnd(24)} D4b=${fmtRate(m.wrongSuppression_D4b_text)}`);
}

console.log("\n── score distributions ──");
for (const scorerKey of SCORERS) {
  const d = results.distributions[scorerKey];
  if (!d.same || !d.diff) continue;
  console.log(`${scorerKey.padEnd(26)} same: med=${d.same.median.toFixed(2)} sat=${(d.same.saturatedFraction * 100).toFixed(0)}%   diff: med=${d.diff.median.toFixed(2)} sat=${(d.diff.saturatedFraction * 100).toFixed(0)}%`);
}

console.log("\n── calibration-size sweep ──");
for (const s2 of results.sweeps.calibrationSize) {
  console.log(`n=${String(s2.n).padEnd(3)} P(t=∞)=${(s2.pThresholdInfinite * 100).toFixed(1)}% meanWS=${(s2.meanWrongSuppression * 100).toFixed(2)}% p95WS=${(s2.p95WrongSuppression * 100).toFixed(1)}% maxWS=${(s2.maxWrongSuppression * 100).toFixed(1)}%  certifies m≤${s2.certifiableCandidateSets}`);
}

console.log("\n── cost per 1000 dispatches (primary judge) ──");
for (const k of ["declaredWitness", "tightenedWitness"]) {
  const c = results.cost[k];
  if (!c) continue;
  console.log(`${k.padEnd(20)} judged=${(c.fractionJudged * 100).toFixed(1)}%  calls/1000=${c.judgeCallsPer1000}  tokens/1000=${c.judgeTokensPer1000}  escalations/1000 distinct=${c.escalationsPer1000DistinctActions}  latency/judged=${c.addedLatencyMsPerJudgedDispatch}ms`);
}
