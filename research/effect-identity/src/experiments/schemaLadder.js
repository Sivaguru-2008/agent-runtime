#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPair, calibrate, decidePair, measure, DEFAULT_CONFIG } from "../evaluate.js";
import { rate, fmtRate, mcnemarExact, holmBonferroni } from "../stats.js";
import { LEVEL_SCHEMAS, SCHEMA_LEVELS, LEVEL_ORDER } from "../corpus/schemaLevels.js";
import { maxCertifiableCandidates, requiredCalibrationSize } from "../conformal.js";

/**
 * T6 monotonicity (Phase 7) and the refinement dilemma (Phase 8), on one act
 * family declared at three richness levels.
 *
 * WHAT T6 CLAIMS, AND WHAT THIS TESTS. T6 says the residual is a function of
 * the declared schema alone and shrinks monotonically under refinement. The
 * first clause is a definitional consequence and needs no experiment. The
 * second is a claim about a real quantity and the v1 corpus tested it at
 * exactly two points, on one tool, once — which cannot distinguish a monotone
 * relationship from a single lucky step. Here the same eight acts are declared
 * three ways, so every pair exists at every level and the comparison is paired
 * item-by-item rather than between samples.
 *
 * THE MONOTONICITY TEST IS NOT A FORMALITY. It can fail. A refinement that
 * types an attribute the acts do not vary on would leave the residual
 * unchanged; a refinement that types an attribute whose canonical form collides
 * across distinct acts would ENLARGE the certifier's fragment at the cost of
 * soundness. The test reports the direction of every step and flags any
 * non-monotone one rather than averaging over them.
 *
 * THE DILEMMA EXPERIMENT'S TWO CONDITIONS. T6.3' says refinement shrinks the
 * calibration pool at the same rate it shrinks the residual, so the calibrated
 * layer degrades on what remains. That predicts a deduplication collapse — but
 * so does a simple shortage of calibration data, and the v1 evidence cannot
 * separate them because it varied both at once. Two conditions here:
 *
 *   fixed        each level calibrates on the residual pairs its own fixed
 *                generation budget produced. Pool size falls with the level.
 *   replenished  every level calibrates on a pool of the SAME size n, topped up
 *                from pairs that are residual at every level (they differ only
 *                in an attribute no rung types).
 *
 * If deduplication recovers under `replenished`, the dilemma is a data-budget
 * problem and the remedy is to gather more calibration data after a schema
 * change. If it does not, the dilemma is intrinsic: the residual that survives
 * refinement is HARDER, not merely rarer, and no amount of data fixes it. These
 * are different engineering recommendations, and the paper should not assert
 * either without the comparison.
 *
 *   node src/experiments/schemaLadder.js [--judge KEY] [--alpha 0.05]
 */

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argAfter = (f, fb) => { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fb; };
const ALPHA = Number(argAfter("--alpha", "0.05"));
const GAMMA = 0.05;
const OUT = argAfter("--out", "schema_ladder.json");

const readJsonl = (f) => readFileSync(resolve(base, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const pairs = readJsonl("corpus/ladder.jsonl");
const scoreRows = new Map(readJsonl("corpus/scores-ladder.jsonl").map((r) => [r.id, r]));
const judgeKeys = [...new Set(readJsonl("corpus/scores-ladder.jsonl").flatMap((r) => Object.keys(r.judges ?? {})))];
const JUDGE = argAfter("--judge", judgeKeys.includes("openai_gpt_oss_120b") ? "openai_gpt_oss_120b" : judgeKeys[0]);
const scoreOf = (p) => { const r = scoreRows.get(p.id); const v = r?.judges?.[JUDGE]; return v === undefined ? null : v; };

const CFG = { ...DEFAULT_CONFIG };
for (const p of pairs) p.facts = classifyPair(p, LEVEL_SCHEMAS, "declared");

/** Seeded subsample so the replenished pools are reproducible. */
function subsample(arr, k, seedInit) {
  let s = seedInit >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k);
}

function levelRows(level) {
  const rows = pairs.filter((p) => p.level === level);
  return {
    all: rows,
    cal: rows.filter((p) => p.split === "cal"),
    test: rows.filter((p) => p.split === "test"),
    attack: rows.filter((p) => p.split === "attack"),
  };
}

/**
 * One level, one calibration condition.
 *
 * `poolSize` null means "use whatever this level's own budget produced"
 * (the fixed condition). A number means top the pool up to exactly that size
 * from the replenishment rows, which are residual at every level.
 */
function runLevel(level, { poolSize = null, useReplenishment = false } = {}) {
  const { cal, test, attack } = levelRows(level);
  const residualCal = cal.filter((p) => p.facts.residual && scoreOf(p) !== null);
  const natural = residualCal.filter((p) => p.category !== "L_replenish" && p.label === "DIFF");
  const replen = residualCal.filter((p) => p.category === "L_replenish" && p.label === "DIFF");

  let poolPairs;
  if (!useReplenishment) {
    poolPairs = natural;
  } else {
    const need = Math.max(0, (poolSize ?? natural.length) - natural.length);
    poolPairs = [...natural, ...subsample(replen, need, 424242 + LEVEL_ORDER.indexOf(level))];
    if (poolSize !== null && poolPairs.length > poolSize) poolPairs = subsample(poolPairs, poolSize, 99 + LEVEL_ORDER.indexOf(level));
  }
  const poolOverride = poolPairs.map(scoreOf);

  const calSameSource = cal.filter((p) => p.facts.residual && p.label === "SAME" && scoreOf(p) !== null);
  const cfg = { ...CFG };
  const calib = calibrate(
    // Pass a synthetic calibration set carrying only the SAME side; the DIFF
    // side is supplied explicitly through poolOverride so the two conditions
    // differ in exactly one place.
    calSameSource, scoreOf, cfg, ALPHA, GAMMA, { poolOverride, m: 1 }
  );
  const decideOne = (p) => decidePair(p, scoreOf, cfg, calib);

  // Decidable-layer coverage, measured over the whole level (test + attack), so
  // the jurisdiction numbers describe the declaration rather than a split.
  const scope = [...test, ...attack];
  const cover = (fn) => rate(scope.filter(fn).length, scope.length);

  // Does the implementation agree with the design about which classes the
  // refuter settles? A mismatch is a mechanism bug, not a finding about T6.
  const designCheck = [];
  for (const p of scope.filter((x) => x.mutation)) {
    if (p.decidedByDesign !== undefined && p.decidedByDesign !== p.facts.refutes) {
      designCheck.push({ id: p.id, mutation: p.mutation, designSays: p.decidedByDesign, mechanismSays: p.facts.refutes });
    }
  }

  const attackByMutation = {};
  for (const mu of [...new Set(attack.map((p) => p.mutation))]) {
    const set = attack.filter((p) => p.mutation === mu);
    attackByMutation[mu] = {
      n: set.length,
      failure: rate(set.filter((p) => decideOne(p).decision === "SUPPRESS").length, set.length),
      reachedJudge: rate(set.filter((p) => ["judge", "abstention"].includes(decideOne(p).by)).length, set.length),
    };
  }

  return {
    level,
    typedAttributes: SCHEMA_LEVELS[level].typedAttributes,
    poolCondition: useReplenishment ? `replenished(n=${poolOverride.length})` : "fixed",
    calibration: { ...calib, nPool: poolOverride.length, nNatural: natural.length, nReplenished: poolOverride.length - natural.length },
    requiredForM1: requiredCalibrationSize(1, ALPHA),
    certifiableM: maxCertifiableCandidates(poolOverride.length, ALPHA),
    coverage: {
      certifier: cover((p) => p.facts.certifies),
      refuter: cover((p) => !p.facts.certifies && p.facts.refutes),
      residual: cover((p) => p.facts.residual),
      judgeCallRate: rate(scope.filter((p) => ["judge", "abstention"].includes(decideOne(p).by)).length, scope.length),
    },
    test: measure(test, decideOne),
    residualTest: measure(test.filter((p) => p.facts.residual), decideOne),
    attackFailure: rate(attack.filter((p) => decideOne(p).decision === "SUPPRESS").length, attack.length),
    attackByMutation,
    designCheck,
    decisionsById: Object.fromEntries(test.map((p) => [p.id, decideOne(p).decision])),
  };
}

// ── Phase 7: monotonicity ──────────────────────────────────────────────────
const fixed = Object.fromEntries(LEVEL_ORDER.map((l) => [l, runLevel(l)]));

const monotone = [];
for (let i = 1; i < LEVEL_ORDER.length; i++) {
  const lo = fixed[LEVEL_ORDER[i - 1]], hi = fixed[LEVEL_ORDER[i]];
  monotone.push({
    step: `${LEVEL_ORDER[i - 1]} -> ${LEVEL_ORDER[i]}`,
    residualFrom: lo.coverage.residual.value, residualTo: hi.coverage.residual.value,
    residualShrinks: hi.coverage.residual.value < lo.coverage.residual.value,
    jurisdictionFrom: lo.coverage.judgeCallRate.value, jurisdictionTo: hi.coverage.judgeCallRate.value,
    jurisdictionShrinks: hi.coverage.judgeCallRate.value < lo.coverage.judgeCallRate.value,
    attackFrom: lo.attackFailure.value, attackTo: hi.attackFailure.value,
    attackFalls: hi.attackFailure.value <= lo.attackFailure.value,
    poolFrom: lo.calibration.nPool, poolTo: hi.calibration.nPool,
  });
}
const monotoneHolds = monotone.every((m) => m.residualShrinks && m.jurisdictionShrinks);

// ── Phase 8: fixed vs replenished calibration budget ───────────────────────
// Every level is topped up to the SAME n, chosen as the largest pool the
// scarcest level can actually reach, so no level is advantaged.
const maxCommon = Math.min(...LEVEL_ORDER.map((l) => {
  const { cal } = levelRows(l);
  return cal.filter((p) => p.facts.residual && p.label === "DIFF" && scoreOf(p) !== null).length;
}));
const replenished = Object.fromEntries(LEVEL_ORDER.map((l) => [l, runLevel(l, { poolSize: maxCommon, useReplenishment: true })]));

const dilemma = LEVEL_ORDER.map((l) => ({
  level: l,
  fixed: { n: fixed[l].calibration.nPool, tHi: fixed[l].calibration.tHi, dedup: fixed[l].test.dedup, ws: fixed[l].test.wrongSuppression, flagged: fixed[l].test.flaggedEscape },
  replenished: { n: replenished[l].calibration.nPool, tHi: replenished[l].calibration.tHi, dedup: replenished[l].test.dedup, ws: replenished[l].test.wrongSuppression, flagged: replenished[l].test.flaggedEscape },
  dedupRecovered: replenished[l].test.dedup.value - fixed[l].test.dedup.value,
}));

// Paired test: at the finest level, does replenishment change per-item outcomes?
const l3test = levelRows("L3_strict").test.filter((p) => p.label === "SAME");
let b = 0, c = 0;
for (const p of l3test) {
  const f = fixed.L3_strict.decisionsById[p.id] === "SUPPRESS";
  const r = replenished.L3_strict.decisionsById[p.id] === "SUPPRESS";
  if (r && !f) b += 1; else if (f && !r) c += 1;
}
const replenishTest = { replenishedOnly: b, fixedOnly: c, ...mcnemarExact(b, c) };

const out = {
  generatedAt: new Date().toISOString(), judge: JUDGE, alpha: ALPHA, gamma: GAMMA,
  levels: LEVEL_ORDER, schemaLevels: Object.fromEntries(LEVEL_ORDER.map((l) => [l, SCHEMA_LEVELS[l].typedAttributes])),
  fixed, replenished, monotone, monotoneHolds, commonPoolSize: maxCommon, dilemma, replenishTest,
  designCheckClean: LEVEL_ORDER.every((l) => fixed[l].designCheck.length === 0),
};
writeFileSync(resolve(base, "results", OUT), JSON.stringify(out, null, 2));

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`judge=${JUDGE}  alpha=${ALPHA}\n`);
console.log("== Phase 7: schema richness vs residual (fixed budget) ==");
console.log("level         typed  certifier                refuter                  residual                 judge-calls              pool  tHi   certM  attackWS");
for (const l of LEVEL_ORDER) {
  const r = fixed[l];
  console.log(
    `${l.padEnd(13)}${String(r.typedAttributes.length).padStart(5)}  ${fmtRate(r.coverage.certifier).padEnd(24)}` +
    `${fmtRate(r.coverage.refuter).padEnd(25)}${fmtRate(r.coverage.residual).padEnd(25)}${fmtRate(r.coverage.judgeCallRate).padEnd(25)}` +
    `${String(r.calibration.nPool).padStart(4)}${String(r.calibration.tHi).padStart(6)}${String(r.certifiableM).padStart(6)}   ${fmtRate(r.attackFailure)}`
  );
}
console.log(`\nmonotone in residual AND judge jurisdiction across every step: ${monotoneHolds ? "YES" : "NO"}`);
for (const m of monotone) {
  console.log(`  ${m.step.padEnd(28)} residual ${(m.residualFrom * 100).toFixed(1)}% -> ${(m.residualTo * 100).toFixed(1)}% ${m.residualShrinks ? "(shrinks)" : "(NOT MONOTONE)"}   ` +
    `judge ${(m.jurisdictionFrom * 100).toFixed(1)}% -> ${(m.jurisdictionTo * 100).toFixed(1)}% ${m.jurisdictionShrinks ? "" : "(NOT MONOTONE)"}   pool ${m.poolFrom} -> ${m.poolTo}`);
}
console.log(`\nimplementation matches the design's per-class refuter predictions: ${out.designCheckClean ? "YES" : "NO — see designCheck"}`);

console.log(`\n== Phase 8: refinement dilemma — fixed vs replenished calibration budget (common n=${maxCommon}) ==`);
console.log("level          cond          n   tHi     dedup                    WS                       flagged");
for (const d of dilemma) {
  for (const cond of ["fixed", "replenished"]) {
    const x = d[cond];
    console.log(`${d.level.padEnd(14)}${cond.padEnd(13)}${String(x.n).padStart(3)}${String(x.tHi).padStart(7)}   ${fmtRate(x.dedup).padEnd(25)}${fmtRate(x.ws).padEnd(25)}${fmtRate(x.flagged)}`);
  }
}
console.log("\ndedup recovered by replenishment, per level:");
for (const d of dilemma) console.log(`  ${d.level.padEnd(14)} ${(d.dedupRecovered * 100 >= 0 ? "+" : "")}${(d.dedupRecovered * 100).toFixed(1)} points`);
console.log(`\npaired McNemar at L3 (replenished vs fixed, SAME pairs): +${replenishTest.replenishedOnly}/-${replenishTest.fixedOnly}  p=${replenishTest.p.toExponential(2)}`);
console.log(`\nwritten: results/${OUT}`);
