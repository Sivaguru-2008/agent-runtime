#!/usr/bin/env node
/**
 * Residual-conditional calibration.
 *
 * T6 says every non-provable error lies in the residual — the pairs the
 * certifier and the refuter both decline. The hardened fence therefore asks the
 * judge about residual pairs and nothing else. But the calibration pool used
 * throughout the main evaluation is every distinct calibration pair the
 * canonical core did not settle, which still includes pairs the witness would
 * veto and the judge would consequently never score.
 *
 * A6 requires the calibration scores to be exchangeable with the scores the
 * rule actually thresholds at deployment. Witness-vetoed pairs are systematically
 * easy — their declared fields differ — so including them shifts the calibration
 * distribution downward relative to deployment, which lowers t_hi, which makes
 * suppression easier. The direction of the resulting error is the unsafe one.
 *
 * This script measures the size of that effect: same corpus, same judges, same
 * α, one change to which pairs enter the pool.
 *
 *   node src/experiments/residualCalibration.js
 *
 * Offline: reads persisted scores, makes no model calls.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { suppressionThreshold, escalationFloor, decide, maxCertifiableCandidates } from "../conformal.js";
import { rate, fmtRate } from "../stats.js";
import { TOOLS } from "../tools.js";
import { canonicalize, canonicalString, semanticProjection, tightenedProjection } from "../canonicalize.js";
import { extractNumbers } from "../judge.js";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GAMMA = 0.05;
const ALPHAS = [0.01, 0.05];
const JUDGES = ["openai_gpt_oss_120b", "openai_gpt_oss_20b"];

const pairs = readFileSync(resolve(base, "corpus", "pairs.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rows = new Map(readFileSync(resolve(base, "corpus", "scores.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.id, r]; }));

const scoreOf = (id, j) => rows.get(id)?.judges?.[j] ?? null;
const schemaOf = (t) => TOOLS[t];

for (const p of pairs) {
  const s = schemaOf(p.tool);
  p.l0Equal = canonicalString(canonicalize(p.a, s)) === canonicalString(canonicalize(p.b, s));
  p.witnessVeto = semanticProjection(p.a, s) !== semanticProjection(p.b, s);
  // The tightened schema lifts numeric mentions out of free text into the
  // projection, which enlarges the refuter and shrinks the residual (T6.3).
  p.tightVeto = tightenedProjection(p.a, s, extractNumbers) !== tightenedProjection(p.b, s, extractNumbers);
  // The residual: not settled by the certifier, not settled by the refuter.
  p.residual = !p.l0Equal && !p.witnessVeto;
  p.tightResidual = !p.l0Equal && !p.tightVeto;
}

const cal = pairs.filter((p) => p.split === "cal");
const test = pairs.filter((p) => p.split === "test");

/** The two candidate pools, differing only in whether vetoed pairs are kept. */
const POOLS = {
  // As used throughout the main evaluation.
  asPublished: (p) => !p.l0Equal,
  // Restricted to pairs the deployed hardened rule would actually score.
  residualOnly: (p) => p.residual,
};

function evaluate(judge, alpha, poolName) {
  const keep = POOLS[poolName];
  const calDiff = cal.filter((p) => p.label === "DIFF" && keep(p) && scoreOf(p.id, judge) !== null)
    .map((p) => scoreOf(p.id, judge));
  const calSame = cal.filter((p) => p.label === "SAME" && keep(p) && scoreOf(p.id, judge) !== null)
    .map((p) => scoreOf(p.id, judge));
  const tHi = suppressionThreshold(calDiff, alpha);
  const tLo = Math.min(escalationFloor(calSame.length ? calSame : [0.5], GAMMA), tHi === Infinity ? Infinity : tHi);

  const decideOne = (p) => {
    if (p.l0Equal) return "SUPPRESS";
    if (p.witnessVeto) return "EXECUTE";
    const s = scoreOf(p.id, judge);
    if (s === null) return "ESCALATE";
    return decide(s, tHi, tLo);
  };

  const on = (set) => {
    const same = set.filter((p) => p.label === "SAME");
    const diff = set.filter((p) => p.label === "DIFF");
    return {
      nSame: same.length, nDiff: diff.length,
      wrongSuppression: rate(diff.filter((p) => decideOne(p) === "SUPPRESS").length, diff.length),
      friction: rate(diff.filter((p) => decideOne(p) === "ESCALATE").length, diff.length),
      dedup: rate(same.filter((p) => decideOne(p) === "SUPPRESS").length, same.length),
      silentEscape: rate(same.filter((p) => decideOne(p) === "EXECUTE").length, same.length),
      flaggedEscape: rate(same.filter((p) => decideOne(p) === "ESCALATE").length, same.length),
    };
  };

  // Attack split: all DIFF, so any suppression is wrong. Held out of
  // calibration, so the bound is not claimed here; these are raw measurements.
  const attackWS = {};
  for (const cat of ["D4a_field_injection", "D4b_text_injection"]) {
    const set = pairs.filter((p) => p.split === "attack" && p.category === cat);
    attackWS[cat] = rate(set.filter((p) => decideOne(p) === "SUPPRESS").length, set.length);
  }

  return {
    judge, alpha, pool: poolName, tHi, tLo,
    nCalDiff: calDiff.length, nCalSame: calSame.length,
    certifiableM: maxCertifiableCandidates(calDiff.length, alpha),
    overall: on(test),
    residualOnly: on(test.filter((p) => p.residual)),
    attacks: attackWS,
  };
}

const out = { generatedAt: new Date().toISOString(), gamma: GAMMA, configs: {} };

// Jurisdiction facts, which are judge-independent.
const jur = (set) => ({
  n: set.length,
  certifier: rate(set.filter((p) => p.l0Equal).length, set.length),
  refuter: rate(set.filter((p) => !p.l0Equal && p.witnessVeto).length, set.length),
  residual: rate(set.filter((p) => p.residual).length, set.length),
});
out.jurisdiction = { test: jur(test), testSame: jur(test.filter((p) => p.label === "SAME")), testDiff: jur(test.filter((p) => p.label === "DIFF")) };

for (const j of JUDGES) for (const a of ALPHAS) for (const pool of Object.keys(POOLS)) {
  out.configs[`${j}_a${a}_${pool}`] = evaluate(j, a, pool);
}

/**
 * Ablations, each calibrated on its OWN jurisdiction.
 *
 * Removing a layer changes which pairs reach the judge, so it changes the pool
 * the threshold must be calibrated on. Holding the pool fixed across ablations
 * confounds the layer's contribution with a threshold shift, which is the same
 * mis-specification this script exists to measure.
 */
function ablation(judge, alpha, { l0 = true, witness = true, band = true, calibrated = true }) {
  const inJurisdiction = (p) => (l0 ? !p.l0Equal : true) && (witness ? !p.witnessVeto : true);
  const calDiff = cal.filter((p) => p.label === "DIFF" && inJurisdiction(p) && scoreOf(p.id, judge) !== null)
    .map((p) => scoreOf(p.id, judge));
  const calSame = cal.filter((p) => p.label === "SAME" && inJurisdiction(p) && scoreOf(p.id, judge) !== null)
    .map((p) => scoreOf(p.id, judge));
  const tHi = calibrated ? suppressionThreshold(calDiff, alpha) : 0.5;
  const tLo = band
    ? Math.min(escalationFloor(calSame.length ? calSame : [0.5], GAMMA), tHi === Infinity ? Infinity : tHi)
    : tHi; // no band: the middle region collapses into EXECUTE

  const decideOne = (p) => {
    if (l0 && p.l0Equal) return "SUPPRESS";
    if (witness && p.witnessVeto) return "EXECUTE";
    const s = scoreOf(p.id, judge);
    if (s === null) return band ? "ESCALATE" : "EXECUTE";
    return decide(s, tHi, tLo);
  };

  const same = test.filter((p) => p.label === "SAME");
  const diff = test.filter((p) => p.label === "DIFF");
  return {
    tHi, tLo, nCalDiff: calDiff.length,
    wrongSuppression: rate(diff.filter((p) => decideOne(p) === "SUPPRESS").length, diff.length),
    dedup: rate(same.filter((p) => decideOne(p) === "SUPPRESS").length, same.length),
    flaggedEscape: rate(same.filter((p) => decideOne(p) === "ESCALATE").length, same.length),
    silentEscape: rate(same.filter((p) => decideOne(p) === "EXECUTE").length, same.length),
    friction: rate(diff.filter((p) => decideOne(p) === "ESCALATE").length, diff.length),
  };
}

/**
 * The tightened schema, calibrated on its own (smaller) residual. T6.3 says a
 * finer projection shrinks the residual monotonically; the calibration pool
 * shrinks with it, so the multiplicity budget tightens at the same time. Both
 * effects are reported rather than only the favourable one.
 */
function tightened(judge, alpha) {
  const inJur = (p) => p.tightResidual;
  const calDiff = cal.filter((p) => p.label === "DIFF" && inJur(p) && scoreOf(p.id, judge) !== null)
    .map((p) => scoreOf(p.id, judge));
  const calSame = cal.filter((p) => p.label === "SAME" && inJur(p) && scoreOf(p.id, judge) !== null)
    .map((p) => scoreOf(p.id, judge));
  const tHi = suppressionThreshold(calDiff, alpha);
  const tLo = Math.min(escalationFloor(calSame.length ? calSame : [0.5], GAMMA), tHi === Infinity ? Infinity : tHi);
  const decideOne = (p) => {
    if (p.l0Equal) return "SUPPRESS";
    if (p.tightVeto) return "EXECUTE";
    const s = scoreOf(p.id, judge);
    if (s === null) return "ESCALATE";
    return decide(s, tHi, tLo);
  };
  const same = test.filter((p) => p.label === "SAME");
  const diff = test.filter((p) => p.label === "DIFF");
  const attackWS = {};
  for (const cat of ["D4a_field_injection", "D4b_text_injection"]) {
    const set = pairs.filter((p) => p.split === "attack" && p.category === cat);
    attackWS[cat] = rate(set.filter((p) => decideOne(p) === "SUPPRESS").length, set.length);
  }
  return {
    tHi, tLo, nCalDiff: calDiff.length, certifiableM: maxCertifiableCandidates(calDiff.length, alpha),
    judgeJurisdiction: rate(test.filter(inJur).length, test.length),
    wrongSuppression: rate(diff.filter((p) => decideOne(p) === "SUPPRESS").length, diff.length),
    dedup: rate(same.filter((p) => decideOne(p) === "SUPPRESS").length, same.length),
    flaggedEscape: rate(same.filter((p) => decideOne(p) === "ESCALATE").length, same.length),
    silentEscape: rate(same.filter((p) => decideOne(p) === "EXECUTE").length, same.length),
    friction: rate(diff.filter((p) => decideOne(p) === "ESCALATE").length, diff.length),
    attacks: attackWS,
  };
}
out.tightened = {};
for (const j of JUDGES) for (const a of ALPHAS) out.tightened[`${j}_a${a}`] = tightened(j, a);

const ABLATIONS = {
  hardened: {},
  minusL0: { l0: false },
  minusWitness: { witness: false },
  minusBand: { band: false },
  minusCalibration: { calibrated: false },
};
out.ablations = {};
for (const j of JUDGES) for (const a of ALPHAS) for (const [name, cfg] of Object.entries(ABLATIONS)) {
  out.ablations[`${j}_a${a}_${name}`] = ablation(j, a, cfg);
}

writeFileSync(resolve(base, "results", "residual_calibration.json"), JSON.stringify(out, null, 2));

console.log("── jurisdiction on the test split (judge-independent) ──");
for (const [k, v] of Object.entries(out.jurisdiction)) {
  console.log(`${k.padEnd(10)} n=${String(v.n).padStart(3)}  certifier=${fmtRate(v.certifier).padEnd(22)} refuter=${fmtRate(v.refuter).padEnd(22)} residual=${fmtRate(v.residual)}`);
}

for (const j of JUDGES) {
  console.log(`\n══ ${j} ══`);
  for (const a of ALPHAS) {
    console.log(`  alpha=${a}`);
    for (const pool of Object.keys(POOLS)) {
      const r = out.configs[`${j}_a${a}_${pool}`];
      console.log(`    ${pool.padEnd(13)} nCalDiff=${String(r.nCalDiff).padStart(3)} tHi=${String(r.tHi).padEnd(6)} m<=${String(r.certifiableM).padStart(2)}`);
      console.log(`      full test    WS=${fmtRate(r.overall.wrongSuppression).padEnd(22)} dedup=${fmtRate(r.overall.dedup).padEnd(24)} silent=${fmtRate(r.overall.silentEscape).padEnd(22)} friction=${fmtRate(r.overall.friction)}`);
      console.log(`      residual n=${String(r.residualOnly.nDiff + r.residualOnly.nSame).padStart(3)}  WS=${fmtRate(r.residualOnly.wrongSuppression).padEnd(22)} dedup=${fmtRate(r.residualOnly.dedup).padEnd(24)} silent=${fmtRate(r.residualOnly.silentEscape).padEnd(22)} friction=${fmtRate(r.residualOnly.friction)}`);
    }
  }
}
console.log("\nwrote results/residual_calibration.json");
