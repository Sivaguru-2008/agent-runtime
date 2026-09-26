#!/usr/bin/env node
/**
 * Transcribe the numbers plotted in the AIJ figures from research/effect-identity/results/
 * into small data files read by pgfplots. Nothing is typed by hand: every plotted
 * value and interval comes from a results file, so a re-run of the experiments
 * re-draws the figures.
 *
 *   node docs/research/aij/tools/make-figure-data.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const aij = resolve(here, "..");
const results = resolve(aij, "..", "..", "..", "research", "effect-identity", "results");
const J = (f) => JSON.parse(readFileSync(resolve(results, f), "utf8"));
const outDir = resolve(aij, "figures", "data");
mkdirSync(outDir, { recursive: true });
const P = (x) => (100 * x).toFixed(2);
const row = (r) => [P(r.value), P(r.value - r.ci95.lo), P(r.ci95.hi - r.value)];

// Figure: multiplicity (Monte-Carlo, exchangeable scores).
const audit = J("conformal_audit_v1.json");
writeFileSync(resolve(outDir, "multiplicity.dat"),
  "m uncorrected corrected\n" + audit.monteCarlo.map((r) => `${r.m} ${P(r.uncorrected)} ${P(r.corrected)}`).join("\n") + "\n");

// Figure: main comparison (test split). y index is the row position, top to bottom.
const bm = J("baseline_matrix_v1.json").configs;
const rc = J("residual_calibration.json");
const rows = [
  ["canonical", bm.B2_content_addressed.overall],
  ["rawjudge", bm.B3_raw_judge.overall],
  ["layered", bm.B5_certifier_judge.overall],
  ["hardened120b", rc.configs["openai_gpt_oss_120b_a0.05_residualOnly"].overall],
  ["hardened20b", rc.configs["openai_gpt_oss_20b_a0.05_residualOnly"].overall],
  ["hardenedqwen", rc.configs["qwen_qwen3_6_27b_a0.05_residualOnly"].overall],
  ["tightened120b", rc.tightened["openai_gpt_oss_120b_a0.05"]],
];
writeFileSync(resolve(outDir, "main.dat"),
  "y name ws wsm wsp dedup dm dp\n" + rows.map(([name, o], i) => {
    const [w, wm, wp] = row(o.wrongSuppression); const [d, dm, dp] = row(o.dedup);
    return `${rows.length - i} ${name} ${w} ${wm} ${wp} ${d} ${dm} ${dp}`;
  }).join("\n") + "\n");

// Figure: adversarial injection, per judge and configuration.
const am = J("attack_matrix_v1.json");
const judges = [["openai_gpt_oss_120b", "120B"], ["openai_gpt_oss_20b", "20B"], ["qwen_qwen3_6_27b", "Qwen"]];
for (const cls of ["D4a_field_injection", "D4b_text_injection"]) {
  const lines = ["judge raw rawm rawp cal calm calp hard hardm hardp tight tightm tightp"];
  for (const [k, lab] of judges) {
    const d = am.declared[k].byClass[cls], t = am.tightened[k].byClass[cls];
    lines.push([lab, ...row(d.rawJudgeFailure), ...row(d.calibratedJudgeFailure), ...row(d.fullSystemFailure), ...row(t.fullSystemFailure)].join(" "));
  }
  writeFileSync(resolve(outDir, `${cls.split("_")[0]}.dat`), lines.join("\n") + "\n");
}
console.log(`wrote figure data to ${outDir}`);
