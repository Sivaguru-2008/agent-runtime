#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runConfig, makeScoreLookup, classifyPair } from "../evaluate.js";
import { rate, fmtRate, mcnemarExact, holmBonferroni } from "../stats.js";
import { TOOLS } from "../tools.js";
import { TOOLS_V2 } from "../toolsV2.js";
import { suppressionThreshold } from "../conformal.js";

/**
 * The baseline and ablation matrix.
 *
 * The v1 evaluation compared the proposed fence against a content-addressed
 * baseline, a raw judge, and four one-layer ablations. That is enough to show
 * the mechanism does something and not enough to say WHICH part does it: with
 * three layers and two calibration choices there are combinations whose
 * behaviour is not predictable from the single-layer rows, and a reviewer is
 * entitled to ask about them rather than be told they are uninteresting.
 *
 * Eleven configurations, every one evaluated on the SAME test pairs, every one
 * calibrated on its OWN jurisdiction (removing a layer changes which pairs reach
 * the judge, so a shared pool would confound the layer's contribution with a
 * threshold shift):
 *
 *   B0  no fence                      every dispatch executes
 *   B1  exact-string identity         byte equality only
 *   B2  content-addressed             the prior art: certifier alone
 *   B3  raw judge, fixed tau          no decidable layers, no calibration, no band
 *   B4  calibrated judge alone        conformal threshold, no decidable layers
 *   B5  certifier + judge             no refuter — the v1 "layered" configuration
 *   B6  refuter + judge               no certifier
 *   B7  certifier + refuter, no judge the decidable core alone
 *   B8  full system                   the proposed mechanism
 *   B9  full, no escalation band      suppress-or-execute
 *   B10 full, no calibration          hand-set tau inside the full layering
 *   B11 full, naive pairwise multiplicity   vs
 *   B12 full, corrected max-over-candidates
 *
 * B11 and B12 are reported at m = 1 and m = 5. At m = 1 they are the SAME RULE
 * and the identical row is the point: the correction is invisible until a run
 * has committed more than one effect per tool, which is exactly why calibrating
 * a pairwise score and deploying a maximum is an easy mistake to ship.
 *
 *   node src/experiments/baselineMatrix.js [--corpus v1|v2ext|union] [--judge KEY]
 */

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argAfter = (flag, fb) => { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fb; };
const CORPUS = argAfter("--corpus", "v1");
const ALPHA = Number(argAfter("--alpha", "0.05"));
const OUT = argAfter("--out", `baseline_matrix_${CORPUS}.json`);

const readJsonl = (f) => readFileSync(resolve(base, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function loadCorpus() {
  const v1 = readJsonl("corpus/pairs.jsonl").map((p) => ({ ...p, corpusVersion: "v1" }));
  let ext = [];
  try { ext = readJsonl("corpus/pairs-v2ext.jsonl"); } catch { /* not generated yet */ }
  const pairs = CORPUS === "v1" ? v1 : CORPUS === "v2ext" ? ext : [...v1, ...ext];
  const scores = [
    ...readJsonl("corpus/scores.jsonl"),
    ...(() => { try { return readJsonl("corpus/scores-v2ext.jsonl"); } catch { return []; } })(),
  ];
  return { pairs, scores, schemas: CORPUS === "v1" ? TOOLS : TOOLS_V2 };
}

const CONFIGS = {
  B0_no_fence: { certifier: false, refuter: false, judge: false, label: "no fence" },
  B1_exact_string: { certifier: false, refuter: false, judge: false, exactOnly: true, label: "exact-string identity" },
  B2_content_addressed: { certifier: true, refuter: false, judge: false, label: "content-addressed fence (prior art)" },
  B3_raw_judge: { certifier: false, refuter: false, judge: true, calibrated: false, band: false, label: "raw judge, tau=0.5" },
  B4_calibrated_judge: { certifier: false, refuter: false, judge: true, calibrated: true, band: true, label: "calibrated judge alone" },
  B5_certifier_judge: { certifier: true, refuter: false, judge: true, label: "certifier + judge (v1 layered)" },
  B6_refuter_judge: { certifier: false, refuter: true, judge: true, label: "refuter + judge" },
  B7_decidable_only: { certifier: true, refuter: true, judge: false, label: "certifier + refuter, no judge" },
  B8_full: { certifier: true, refuter: true, judge: true, label: "full system (proposed)" },
  B9_full_no_band: { certifier: true, refuter: true, judge: true, band: false, label: "full, no escalation band" },
  B10_full_no_calibration: { certifier: true, refuter: true, judge: true, calibrated: false, label: "full, hand-set tau" },
  B11_naive_multiplicity_m1: { certifier: true, refuter: true, judge: true, multiplicity: "uncorrected", m: 1, label: "full, naive pairwise (m=1)" },
  B12_corrected_multiplicity_m1: { certifier: true, refuter: true, judge: true, multiplicity: "corrected", m: 1, label: "full, corrected max-over-candidates (m=1)" },
  B11_naive_multiplicity_m5: { certifier: true, refuter: true, judge: true, multiplicity: "uncorrected", m: 5, label: "full, naive pairwise (m=5)" },
  B12_corrected_multiplicity_m5: { certifier: true, refuter: true, judge: true, multiplicity: "corrected", m: 5, label: "full, corrected max-over-candidates (m=5)" },
};

/**
 * B1 is byte equality, which the general machinery cannot express as a layer
 * switch (the certifier IS canonical equality). Handled as its own decision
 * function rather than approximated, because "exact string" is the baseline a
 * reader will assume is trivially safe and it is worth showing exactly how
 * little it catches.
 */
function exactStringDecisions(pairs) {
  return Object.fromEntries(pairs.map((p) => [p.id, JSON.stringify(p.a) === JSON.stringify(p.b) ? "SUPPRESS" : "EXECUTE"]));
}

function main() {
  const { pairs, scores, schemas } = loadCorpus();
  if (pairs.length === 0) { console.error(`corpus ${CORPUS} is empty`); process.exit(1); }
  const available = [...new Set(scores.flatMap((r) => Object.keys(r.judges ?? {})))];
  const JUDGE = argAfter("--judge", available.includes("openai_gpt_oss_120b") ? "openai_gpt_oss_120b" : available[0]);
  const scoreOf = makeScoreLookup(scores, JUDGE);

  const test = pairs.filter((p) => p.split === "test");
  const results = {}, decisions = {};
  for (const [name, spec] of Object.entries(CONFIGS)) {
    const { label, exactOnly, m, ...cfg } = spec;
    if (exactOnly) {
      for (const p of pairs) p.facts = classifyPair(p, schemas, "declared");
      const dec = exactStringDecisions(test);
      const same = test.filter((p) => p.label === "SAME"), diff = test.filter((p) => p.label === "DIFF");
      results[name] = {
        label, calibration: { tHi: null, nCalDiff: 0 },
        overall: {
          nSame: same.length, nDiff: diff.length,
          wrongSuppression: rate(diff.filter((p) => dec[p.id] === "SUPPRESS").length, diff.length),
          friction: rate(0, diff.length),
          dedup: rate(same.filter((p) => dec[p.id] === "SUPPRESS").length, same.length),
          silentEscape: rate(same.filter((p) => dec[p.id] !== "SUPPRESS").length, same.length),
          flaggedEscape: rate(0, same.length),
        },
      };
      decisions[name] = dec;
      continue;
    }
    const r = runConfig({ pairs, schemas, cfg, judge: JUDGE, scoreOf, alpha: ALPHA, opts: { m: m ?? 1, fixedTau: 0.5 } });
    results[name] = { label, ...r };
    decisions[name] = r.decisionsById;
  }

  // ── Paired comparisons on identical items ─────────────────────────────────
  // Two families, tested and corrected separately because they answer different
  // questions and pooling them would dilute both.
  const correctFor = (p, d) => (p.label === "SAME" ? d === "SUPPRESS" : d !== "SUPPRESS");
  const compare = (a, b, subset) => {
    let bOnly = 0, cOnly = 0;
    for (const p of subset) {
      const ca = correctFor(p, decisions[a][p.id]), cb = correctFor(p, decisions[b][p.id]);
      if (ca && !cb) bOnly += 1;
      else if (!ca && cb) cOnly += 1;
    }
    return { a, b, aOnly: bOnly, bOnly: cOnly, ...mcnemarExact(bOnly, cOnly) };
  };

  const sameSet = test.filter((p) => p.label === "SAME");
  const diffSet = test.filter((p) => p.label === "DIFF");
  const dedupFamily = [
    ["B8_full", "B2_content_addressed"], ["B8_full", "B5_certifier_judge"], ["B8_full", "B7_decidable_only"],
    ["B8_full", "B3_raw_judge"], ["B8_full", "B4_calibrated_judge"], ["B8_full", "B6_refuter_judge"],
    ["B8_full", "B9_full_no_band"], ["B8_full", "B10_full_no_calibration"],
  ].map(([a, b]) => ({ key: `dedup:${a} vs ${b}`, ...compare(a, b, sameSet) }));
  const wsFamily = [
    ["B8_full", "B3_raw_judge"], ["B8_full", "B4_calibrated_judge"], ["B8_full", "B5_certifier_judge"],
    ["B8_full", "B10_full_no_calibration"], ["B8_full", "B12_corrected_multiplicity_m5"],
  ].map(([a, b]) => ({ key: `ws:${a} vs ${b}`, ...compare(a, b, diffSet) }));

  const holmDedup = holmBonferroni(dedupFamily.map((t) => ({ key: t.key, p: t.p })));
  const holmWs = holmBonferroni(wsFamily.map((t) => ({ key: t.key, p: t.p })));
  for (const t of dedupFamily) Object.assign(t, holmDedup[t.key]);
  for (const t of wsFamily) Object.assign(t, holmWs[t.key]);

  const out = {
    generatedAt: new Date().toISOString(), corpus: CORPUS, judge: JUDGE, alpha: ALPHA,
    nPairs: pairs.length, nTest: test.length, nTestSame: sameSet.length, nTestDiff: diffSet.length,
    configs: results,
    paired: { dedupFamily, wsFamily, note: "Two families, Holm-corrected separately: liveness and safety are different questions and pooling them would dilute both." },
  };
  writeFileSync(resolve(base, "results", OUT), JSON.stringify(out, null, 2));

  console.log(`corpus=${CORPUS}  judge=${JUDGE}  alpha=${ALPHA}  test=${test.length} (${sameSet.length} SAME / ${diffSet.length} DIFF)\n`);
  const H = ["configuration", "n_cal", "tHi", "WS", "dedup", "silent", "flagged"];
  console.log(H[0].padEnd(42) + H[1].padStart(6) + H[2].padStart(7) + "  " + H[3].padEnd(24) + H[4].padEnd(24) + H[5].padEnd(24) + H[6]);
  for (const [name, r] of Object.entries(results)) {
    const o = r.overall;
    console.log(
      // A configuration with the judge switched off has no threshold and no
      // pool in its decision path. Printing the numbers it would have had
      // invites a reader to compare them with rows where they mean something.
      `${name.padEnd(42)}${String(r.config?.judge === false ? "—" : (r.calibration?.nCalDiff ?? "—")).padStart(6)}` +
      `${String(r.config?.judge === false ? "—" : (r.calibration?.tHi ?? "—")).padStart(9)}  ` +
      `${fmtRate(o.wrongSuppression).padEnd(24)}${fmtRate(o.dedup).padEnd(24)}${fmtRate(o.silentEscape).padEnd(24)}${fmtRate(o.flaggedEscape)}`
    );
  }
  console.log("\n-- paired McNemar (exact, two-sided), Holm-corrected within family --");
  for (const t of [...dedupFamily, ...wsFamily]) {
    console.log(`${t.key.padEnd(56)} disc ${String(t.aOnly).padStart(3)}/${String(t.bOnly).padStart(3)}  p=${t.p.toExponential(2)}  Holm=${t.holm.toExponential(2)}${t.rejectedAt05 ? " *" : ""}`);
  }
  console.log(`\nwritten: results/${OUT}`);
}

main();
