#!/usr/bin/env node
/**
 * Generate the supplement's data tables from research/effect-identity/results/.
 *
 *   node docs/research/aij/tools/make-supp-tables.mjs   -> supplement/tables/*.tex
 *
 * Every number in the supplement's tables is emitted from a results file by this
 * script, so the supplement cannot drift from the artifact. Intervals are printed
 * in the form checkPaper.js validates (NN.N\%~[lo--hi]).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const aij = resolve(here, "..");
const R = resolve(aij, "..", "..", "..", "research", "effect-identity");
const J = (f) => JSON.parse(readFileSync(resolve(R, "results", f), "utf8"));
const out = resolve(aij, "supplement", "tables");
mkdirSync(out, { recursive: true });

const iv = (r) => (r && r.value !== undefined && r.ci95
  ? `${(100 * r.value).toFixed(1)}\\%~[${(100 * r.ci95.lo).toFixed(1)}--${(100 * r.ci95.hi).toFixed(1)}]`
  : r && r.value !== undefined ? `${(100 * r.value).toFixed(1)}\\%` : "---");
const pc = (x, d = 1) => (x === null || x === undefined ? "---" : `${(100 * x).toFixed(d)}\\%`);
const num = (x, d = 2) => (x === null || x === undefined ? "---" : Number(x).toFixed(d));
const thr = (t) => (t === null || t === undefined || t === "Infinity" || t === Infinity ? "$+\\infty$" : Number(t).toFixed(2));
// Data-derived strings only (model ids, category keys, admission reasons); no
// caller passes LaTeX through esc, so escaping the active characters is safe.
const esc = (s) => String(s)
  .replace(/([_%#&])/g, "\\$1")
  .replace(/</g, "$<$").replace(/>/g, "$>$");
const JN = { openai_gpt_oss_120b: "GPT-OSS-120B", openai_gpt_oss_20b: "GPT-OSS-20B", qwen_qwen3_6_27b: "Qwen3.6-27B", llama_3_3_70b_versatile: "Llama-3.3-70B", allam_2_7b: "Allam-2-7B" };
const write = (name, body) => { writeFileSync(resolve(out, name), body + "\n"); console.log("wrote", name); };
const table = (caption, label, spec, header, rows, size = "\\footnotesize") => `\\begin{table}[htbp]
\\centering${size}\\setlength{\\tabcolsep}{3.5pt}
\\caption{${caption}}\\label{${label}}
%% Scale down only when the natural width exceeds the text block.
\\resizebox{\\ifdim\\width>\\linewidth\\linewidth\\else\\width\\fi}{!}{%
\\begin{tabular}{@{}${spec}@{}}
\\toprule
${header} \\\\
\\midrule
${rows.join(" \\\\\n")} \\\\
\\bottomrule
\\end{tabular}}
\\end{table}`;

const rc = J("residual_calibration.json"), bm = J("baseline_matrix_v1.json"), ca = J("conformal_audit_v1.json");
const am = J("attack_matrix_v1.json"), ss = J("seed_split.json"), sens = J("sensitivity.json"), aa = J("aij_analyses.json");
const cf = J("cross_family.json"), sl = J("schema_ladder.json"), mc = J("multi_candidate.json"), cr = J("crash_replay_v2.json");
const tw = J("threshold_sweep.json"), wj = J("weak_judge.json"), nl = J("non_llm_baseline.json"), ha = J("human_annotation.json");
const JUD = ["openai_gpt_oss_120b", "openai_gpt_oss_20b", "qwen_qwen3_6_27b"];

// S5: every configuration, both pools, both levels.
write("s5-configs.tex", table(
  "Every reported configuration: each judge at both levels, calibrated on its own jurisdiction (residual) and, for comparison, on the wider non-canonical pool. Rates are on the test split; the residual column conditions on the pairs the deployed rule routes to the judge.",
  "tab:s5", "llrrllll",
  "Judge & $\\alpha$ & pool $n$ & $\\thi$ & wrong suppression & dedup & silent escape & WS over residual",
  Object.entries(rc.configs).map(([k, c]) => {
    const [, a, pool] = k.match(/^(.*)_a(0\.\d+)_(\w+)$/) ? [0, k.match(/_a(0\.\d+)_/)[1], k.endsWith("residualOnly") ? "residual" : "wider"] : [];
    return `${esc(JN[c.judge])} & ${a} (${pool}) & ${c.nCalDiff} & ${thr(c.tHi)} & ${iv(c.overall.wrongSuppression)} & ${iv(c.overall.dedup)} & ${iv(c.overall.silentEscape)} & ${iv(c.residualOnly.wrongSuppression)}`;
  })));

// S6: per-category decisions, all judges.
write("s6-percategory.tex", table(
  "Per-category decisions of the proposed configuration on the test split, $\\alpha=0.05$, for each judge.",
  "tab:s6", "llrlll",
  "Judge & Category & $n$ & suppress & escalate & execute",
  JUD.flatMap((j) => Object.entries(aa.A10_perCategory[j]).map(([c, v]) =>
    `${esc(JN[j])} & ${esc(c)} & ${v.n} & ${iv(v.suppress)} & ${iv(v.escalate)} & ${iv(v.execute)}`))));

// S7: baseline and ablation matrix + paired tests.
write("s7-matrix.tex", table(
  "Baseline and ablation matrix (primary judge, $\\alpha=0.05$). Each row is calibrated on its own jurisdiction.",
  "tab:s7a", "lrrlll",
  "Configuration & pool $n$ & $\\thi$ & wrong suppression & dedup & silent escape",
  Object.entries(bm.configs).map(([k, c]) =>
    `${esc(k)} & ${c.calibration?.nCalDiff ?? "---"} & ${thr(c.calibration?.tHi)} & ${iv(c.overall.wrongSuppression)} & ${iv(c.overall.dedup)} & ${iv(c.overall.silentEscape)}`)));
write("s7-paired.tex", table(
  "Exact McNemar tests over discordant items, Holm-corrected within family (liveness and safety corrected separately).",
  "tab:s7b", "llrrr",
  "Family & Comparison & discordant & exact $p$ & Holm",
  [...bm.paired.dedupFamily.map((r) => `dedup & ${esc(r.key.replace(/^dedup:/, ""))} & ${r.n} & ${r.p.toExponential(1)} & ${r.holm.toExponential(1)}`),
   ...bm.paired.wsFamily.map((r) => `WS & ${esc(r.key.replace(/^ws:/, ""))} & ${r.n} & ${r.p.toFixed(3)} & ${r.holm.toFixed(3)}`)]));

// S8: score distributions, band ties, per-tool separation.
write("s8-band.tex", table(
  "Score distribution and escalation band, $\\alpha=0.05$. ``At extremes'' counts scores $\\le0.02$ or $\\ge0.98$ among non-certified pairs. Ties are residual duplicate test pairs whose score equals $\\thi$ exactly; a strict inequality never suppresses them.",
  "tab:s8a", "lrrrrrrr",
  "Judge & $\\thi$ & $\\tlo$ & distinct values & SAME at extremes & DIFF at extremes & suppressed & tied at $\\thi$",
  JUD.map((j) => { const b = aa.A1_band[j];
    return `${esc(JN[j])} & ${thr(b.tHi)} & ${thr(b.tLo)} & ${b.distinctValues} & ${iv(b.extremesAllNonL0.same)} & ${iv(b.extremesAllNonL0.diff)} & ${b.sameSuppressed}/${b.residualTestSame} & ${b.sameTiedAtTHi}`; })));
write("s8-separation.tex", table(
  "Per-tool score separation on residual test pairs. ``Separable'' means $\\max$ over distinct pairs $<\\min$ over duplicate pairs, so a single threshold achieves zero error in both directions on that tool.",
  "tab:s8b", "llrrrrl",
  "Judge & Tool & $n$ SAME & $n$ DIFF & max DIFF & min SAME & separable",
  JUD.flatMap((j) => Object.values(aa.A2_perToolSeparation[j]).filter((r) => r.scope === "test").map((r) =>
    `${esc(JN[j])} & ${esc(r.tool)} & ${r.nSame} & ${r.nDiff} & ${num(r.maxDiff)} & ${num(r.minSame)} & ${r.separable === null ? "---" : r.separable ? "yes" : "no"}`))));

// S9: per-tool calibration, ensembles, lexical, non-LLM baselines.
write("s9-pertool.tex", table(
  "Per-tool calibration under the jurisdiction-matched pool. Tools with fewer than 19 residual distinct calibration pairs cannot certify $\\alpha=0.05$ and receive $\\thi=+\\infty$ (no semantic suppression).",
  "tab:s9a", "llrrl",
  "Judge & Tool & pool $n$ & $\\thi$ & certifiable at $\\alpha=0.05$",
  JUD.flatMap((j) => Object.entries(aa.A3_perToolCalibration[j].perTool).map(([t, v]) =>
    `${esc(JN[j])} & ${esc(t)} & ${v.nCalDiff} & ${thr(v.tHi)} & ${v.nCalDiff >= 19 ? "yes" : "no"}`))));
write("s9-scorers.tex", table(
  "Ensembles and the deterministic lexical scorer, calibrated on the jurisdiction-matched pool, $\\alpha=0.05$, with their injection rates.",
  "tab:s9b", "lrlllll",
  "Scorer & $\\thi$ & wrong suppression & dedup & silent escape & D4a & D4b",
  Object.entries(aa.A4_scorers).map(([k, v]) =>
    `${esc(k)} & ${thr(v.hardened.tHi)} & ${iv(v.hardened.wrongSuppression)} & ${iv(v.hardened.dedup)} & ${iv(v.hardened.silentEscape)} & ${iv(v.hardened.attacks.D4a_field_injection)} & ${iv(v.hardened.attacks.D4b_text_injection)}`)));
write("s9-nonllm.tex", table(
  "Non-LLM similarity baselines through the identical conformal pipeline. An AUC below 0.5 means the score orders duplicates \\emph{below} distinct pairs on the residual: surface similarity is anti-correlated with identity there.",
  "tab:s9c", "lrrrr",
  "Scorer & residual AUC & conformal $\\tau$ & residual dedup & system dedup",
  nl.map((r) => `${esc(r.name)} & ${num(r.residualAuc, 3)} & ${num(r.conformalTau, 3)} & ${pc(r.residualDedup)} & ${pc(r.systemDedup)}`)));

// S10: multi-candidate grid.
write("s10-multicandidate.tex", table(
  `Multiple committed candidates, live judge (${esc(mc.judge)}), $K=${mc.K}$ nested candidates, ${mc.nDiffUnits} distinct and ${mc.nSameUnits} duplicate units. Wrong suppression is over the ${mc.nTestDiffUnits} held-out distinct units.`,
  "tab:s10", "rlrll",
  "$m$ & rule & $\\thi$ & wrong suppression & dedup",
  mc.grid.filter((g) => g.alpha === 0.05).flatMap((g) => ["uncorrected", "bonferroni", "setconformal"].map((rule) =>
    `${g.m} & ${rule} & ${thr(g.thresholds[rule])} & ${iv(g.rules[rule].wrongSuppression)} & ${iv(g.rules[rule].dedup)}`))));

// S11: resampling and seed-level splits.
write("s11-resample.tex", table(
  "Realised wrong suppression over 300 resampled calibration pools per size, evaluated on the fixed residual test pairs (primary judge, $\\alpha=0.05$). The mean is flat in $n$; the tail and the exceedance share are not.",
  "tab:s11a", "rrrrrrr",
  "pool $n$ & $P(\\thi=+\\infty)$ & mean & median & p95 & max & share above $\\alpha$",
  ca.resample.rows.filter((r) => !r.unavailable).map((r) =>
    `${r.n} & ${pc(r.pInfinite, 0)} & ${pc(r.mean)} & ${pc(r.median)} & ${pc(r.p95)} & ${pc(r.max)} & ${r.shareExceedingAlpha === null ? "---" : pc(r.shareExceedingAlpha)}`)));
write("s11-seedsplit.tex", table(
  `Seed-level resplitting: ${ss.reps} splits that partition the ${ss.nSeeds} seed acts first, so no seed appears on both sides. The shipped pair-level split is shown for comparison.`,
  "tab:s11b", "llrrrr",
  "Judge & pair-split WS & seed-split mean & median & p95 & share above $\\alpha$",
  JUD.map((j) => { const s = ss.judges[j];
    return `${esc(JN[j])} & ${iv(s.original.ws)} & ${pc(s.seedSplit.ws.mean)} & ${pc(s.seedSplit.ws.median)} & ${pc(s.seedSplit.ws.p95)} & ${pc(s.seedSplit.ws.shareAboveAlpha)}`; })));

// S12: threshold sweep and weak-judge transition.
write("s12-sweep.tex", table(
  "Threshold sweep on the residual test split. The ``best safe fixed'' threshold is selected using test labels and is therefore not available to a deployment; the bootstrap columns compare the conformal rule with a cross-validated fixed threshold over 500 resamples.",
  "tab:s12a", "lrlrrrr",
  "Judge & AUC & safe region & safe fraction & conformal $\\tau$ & conformal dedup & best safe dedup",
  JUD.map((j) => { const t = tw.judges[j];
    return `${esc(JN[j])} & ${num(t.auc, 3)} & $[${num(t.safeRegion.lo, 2)},${num(t.safeRegion.hi, 2)}]$ & ${pc(t.safeRegion.fraction, 0)} & ${num(t.conformal.tau, 2)} & ${pc(t.conformal.dedup)} & ${pc(t.bestSafeFixed.dedup)}`; })));
write("s12-weak.tex", table(
  "Weak-judge transition: Gaussian noise added to the primary judge's scores (calibration and test alike, so exchangeability is preserved). As separation degrades the safe fixed-threshold region collapses, while the conformal threshold rises and keeps realised wrong suppression below $\\alpha$ by suppressing less.",
  "tab:s12b", "rrlrrr",
  "$\\sigma$ & AUC & safe region & safe fraction & conformal $\\thi$ & conformal dedup",
  wj.map((r) => `${num(r.sigma, 2)} & ${num(r.auc, 3)} & ${r.safeWidth > 0 ? `width ${num(r.safeWidth, 2)}` : "empty"} & ${pc(r.safeFraction, 0)} & ${num(r.conformalTau, 2)} & ${pc(r.conformalDedup)}`)));

// S13: schema ladder.
write("s13-ladder.tex", table(
  "Schema-richness ladder: one act family declared with zero, four and six typed attributes. The residual and the judge's jurisdiction shrink together; every level's natural pool is below the 19 pairs needed to certify $\\alpha=0.05$ at $m=1$.",
  "tab:s13", "lrllrr",
  "Level & typed attributes & refuter coverage & residual & pool $n$ & certifiable $m$",
  Object.entries(sl.fixed).map(([lvl, v]) =>
    `${esc(lvl)} & ${v.typedAttributes.length} & ${iv(v.coverage.refuter)} & ${iv(v.coverage.residual)} & ${v.calibration.nCalDiff} & ${v.certifiableM}`)));

// S14: refinement decomposition.
write("s14-refinement.tex", table(
  "Refinement decomposition. The size-only counterfactual draws 5,000 random subsets of the declared pool at the refined pool's size and recomputes the threshold; ``$P(\\le$ observed$)$'' is the share of those draws whose deduplication is at most the observed refined value.",
  "tab:s14", "lrrrlrr",
  "Judge & declared $n$ & refined $n$ & refined rank & refined dedup & size-only mean dedup & $P(\\le$ observed$)$",
  JUD.map((j) => { const a = aa.A5_refinement[j];
    return `${esc(JN[j])} & ${a.declared.poolN} & ${a.tightened.poolN} & ${a.tightened.rankFromTop} & ${iv(a.tightened.dedup)} & ${pc(a.sizeOnlyCounterfactual.dedupTightenedConfig.mean)} & ${num(a.sizeOnlyCounterfactual.shareDedupAtOrBelowObserved, 3)}`; })));

// S15: crash/replay per crash point.
write("s15-crash.tex", table(
  `Crash and paraphrased replay across eight crash points, ${cr.nTrialsPerArm} trials per arm, judge ${esc(cr.judge)}, paraphrase pool written by ${esc(cr.paraphrasePool.generator)}. \\emph{Correct} means the correct final number of external effects: one wire in the duplicate arm, two in the distinct arm.`,
  "tab:s15", "llrrrr",
  "Arm & crash point & syntactic correct & semantic correct & crash point reached & window flagged",
  ["duplicate", "distinct"].flatMap((arm) => Object.entries(cr.byArm[arm].byCrashPoint).map(([cp, v]) =>
    `${arm} & ${esc(cp)} & ${v.syntactic.correctFinalState.successes}/${v.syntactic.nTrials} & ${v.semantic.correctFinalState.successes}/${v.semantic.nTrials} & ${v.semantic.crashPointReached.successes}/${v.semantic.nTrials} & ${v.semantic.windowFlagged?.successes ?? 0}/${v.semantic.nTrials}`))));

// S16: model panel per stratum + re-derivations.
write("s16-panel.tex", table(
  `Model panel (Channel M), preregistered collection: agreement with the construction per stratum over ${ha.nFullyAnnotated} fully annotated items. A stratum is contested when the interval's upper bound falls below 0.80.`,
  "tab:s16a", "lrll",
  "Stratum & $n$ & agreement with construction & contested",
  Object.entries(ha.perStratum).map(([s, v]) =>
    `${esc(s)} & ${v.n} & ${iv(v.constructionAgreement)} & ${v.constructionAgreement.ci95 && v.constructionAgreement.ci95.hi < 0.8 ? "yes" : "no"}`)));
{
  const cols = aa.A6_annotation.collections;
  write("s16-rederivation.tex", table(
    "Re-derivation of the headline rates over the annotated subset, for each state of the response files. ``As executed'' is the preregistered computation, which includes items with no judge score; ``scored only'' restricts to the items the primary judge scored. Benign excludes the held-out injection pairs.",
    "tab:s16b", "llrllll",
    "Collection & labels & items & WS (as executed) & dedup (as executed) & WS (scored only) & WS benign (scored only)",
    Object.entries(cols).flatMap(([name, c]) => ["constructed", "panel"].map((lab) =>
      `${esc(name)} & ${lab} & ${c.nFullyAnnotated} & ${iv(c.rederivationAsExecuted[lab].overall.wrongSuppression)} & ${iv(c.rederivationAsExecuted[lab].overall.dedup)} & ${iv(c.rederivationScoredOnly[lab].wrongSuppression)} & ${iv(c.rederivationScoredOnly[lab].wrongSuppressionBenign)}`))));
}

// S17: cost.
write("s17-cost.tex", table(
  "Cost accounting, measured over each judge's final scoring session (batches of ten pairs, so the system prompt is amortised over the batch). Judge calls per 1,000 dispatches follow from the judge's jurisdiction (76.2\\% declared, 58.9\\% refined).",
  "tab:s17", "lrrrrr",
  "Judge & session pairs & tokens per comparison & mean latency per call (ms) & tokens per 1,000 (declared) & tokens per 1,000 (refined)",
  Object.entries(aa.A8_cost.judges).map(([k, v]) =>
    `${esc(JN[k])} & ${v.sessionPairs} & ${num(v.tokensPerComparison, 1)} & ${v.meanCallLatencyMs} & ${v.tokensPer1000DispatchesDeclared.toLocaleString("en-US")} & ${v.tokensPer1000DispatchesTightened.toLocaleString("en-US")}`)));

// S4: judge coverage and missingness.
// Admission reasons are long sentences in the results file; the table prints the
// clause each one violates and the caption expands the abbreviations.
const clause = (r) => (/^coverage/.test(r) ? "coverage"
  : /distinct score value/.test(r) ? "resolution"
  : /signal|AUC/.test(r) ? "signal" : r);
write("s4-coverage.tex", table(
  "Judge coverage and the admission rule (coverage $\\ge$ 80\\%, at least two distinct score values, AUC $\\ge$ 0.60). AUC is computed over all scored pairs. Failed clauses are abbreviated: \\emph{coverage} (too few pairs scored to calibrate or to measure), \\emph{resolution} (fewer than two distinct score values), \\emph{signal} (no scored SAME/DIFF overlap, so discrimination is unmeasurable). Exact permutation tests (20,000 permutations) find no association between the Qwen judge's abstentions and any stratification.",
  "tab:s4a", "lrrrl",
  "Judge & scored / 1,066 & coverage & AUC & admitted",
  Object.entries(aa.A12_admission).map(([k, v]) =>
    `${esc(JN[k] ?? k)} & ${Math.round((v.coverage ?? 0) * 1066)} & ${pc(v.coverage)} & ${v.aucAllScored === null || v.aucAllScored === undefined ? "---" : num(v.aucAllScored, 3)} & ${v.admitted ? "yes" : `no (${esc([...new Set((v.reasons ?? []).map(clause))].join(", "))})`}`)));
write("s4-missingness.tex", table(
  `Abstention homogeneity for the Qwen judge (${aa.A7_missingness.nMissing} abstentions among ${aa.A7_missingness.n} pairs), by exact permutation test.`,
  "tab:s4b", "lrrr",
  "Stratification & levels & $\\chi^2$ & permutation $p$",
  Object.entries(aa.A7_missingness.tests).map(([k, v]) => `${esc(k)} & ${v.levels} & ${num(v.chi2)} & ${num(v.permutationP, 3)}`)));

// S5b: cross-family common subset.
write("s5-common.tex", table(
  `Common-subset comparison: the ${cf.commonSubset.total} pairs all three judges scored (${cf.commonSubset.cal} calibration, ${cf.commonSubset.test} test, ${cf.commonSubset.attack} attack), each judge calibrated on the common calibration split.`,
  "tab:s5b", "lrllll",
  "Judge & $\\thi$ & wrong suppression & dedup & silent escape & flagged escape",
  JUD.map((j) => { const p = cf.perJudge[j];
    return `${esc(JN[j])} & ${thr(p.tHi)} & ${iv(p.wrongSuppression)} & ${iv(p.dedup)} & ${iv(p.silentEscape)} & ${iv(p.flaggedEscape)}`; })));

// S2: generator arms.
write("s2-generators.tex", table(
  "Paraphrase generator arms and the validator's rejections at generation time. The hand-written arm has no model in the loop. Mechanical and hand-specified pairs (650) have no generator.",
  "tab:s2", "lrrrll",
  "Generator arm & pairs & cal & test & S2 kept/dropped & S4 kept/dropped",
  (() => {
    const meta = JSON.parse(readFileSync(resolve(R, "corpus", "meta.json"), "utf8"));
    const pairs = readFileSync(resolve(R, "corpus", "pairs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const gens = [...new Set(pairs.map((p) => p.generator).filter(Boolean))];
    return gens.map((g) => {
      const s = pairs.filter((p) => p.generator === g), m = meta.generation.perGenerator[g] ?? {};
      return `${esc(g)} & ${s.length} & ${s.filter((p) => p.split === "cal").length} & ${s.filter((p) => p.split === "test").length} & ${m.s2Kept ?? 0}/${m.s2Dropped ?? 0} & ${m.s4Kept ?? 0}/${m.s4Dropped ?? 0}`;
    });
  })()));

// S21: tightness of the multiplicity-corrected bound (Theorem 2, Corollary 1).
{
  const tg = J("tightness.json");
  const p3 = (x) => (x === null || x === undefined ? "---" : `${(100 * x).toFixed(3)}\\%`);
  const sci = (x) => (Math.abs(x) < 1e-12 ? "$0$" : `$${x.toExponential(1).replace(/e([+-]?)(\d+)/, (_, s, d) => `\\times10^{${s === "-" ? "-" : ""}${d}}`)}$`);
  write("s21-tightness.tex", table(
    `Worst case over $\\mathcal{Q}_{n,m}$ (Theorem~2) against the Bonferroni bound $m\\rho/(n+1)$, at $\\alpha=${tg.alpha}$. The value in parentheses is the worst case of the threshold one rank lower. The simulation column is the attaining law simulated directly (${tg.repsPerSimulation.toLocaleString("en-US")} draws per row); the gap column is exact and negative entries below $10^{-12}$ are rounding.`,
    "tab:s21", "lrrrrrrr",
    "Configuration & $n$ & $m$ & $k^\\ast$ & bound & worst case & gap & simulated \\\\ & & & & & & & (next rank)",
    tg.configs.filter((c) => c.k !== null).map((c) =>
      `${esc(c.label)} & ${c.n} & ${c.m} & ${c.k} & ${p3(c.bonferroniBound)} & ${p3(c.attainedSupQ)} & ${sci(c.gap)} & ${p3(c.simulatedCoupling.rate)} (${p3(c.nextLowerThresholdSupQ)})`)));
  write("s21-budget.tex", table(
    `Beyond the budget ($m>\\alpha(n+1)$): the worst case of the most conservative finite threshold, the pool maximum, at $\\alpha=${tg.alpha}$. Every entry exceeds $\\alpha$, so no finite scale-free threshold is valid. The grid check covers every $n+1\\le10^6$ at $\\alpha=0.05$ and $\\alpha=0.01$ (${tg.budgetGrid.map((g) => `${g.failures} exceptions at $\\alpha=${g.alpha}$`).join(", ")}).`,
    "tab:s21b", "rrrl",
    "$n$ & $m$ & $\\alpha(n+1)$ & worst case of the pool maximum",
    tg.budgetExamples.map((b) => `${b.n} & ${b.m} & ${num(b.alpha * (b.n + 1), 2)} & ${p3(b.supPoolMax)}`)));
}

// S22: the authorisation instance (second instance of the recipe).
{
  const az = J("authz_v1.json");
  const CN = { exactScope: "exact scope (no model)", rawJudge: "raw judge, $\\tau=0.5$", layeredNoRefuter: "calibrated, no refuter", hardened: "certifier + refuter + calibrated" };
  const rows = [];
  for (const j of az.admitted) for (const a of ["0.05", "0.01"]) for (const [c, e] of Object.entries(az.configs[j][a])) {
    if (a === "0.01" && (c === "exactScope" || c === "rawJudge")) continue;
    rows.push(`${esc(JN[j])} & ${a} & ${CN[c]} & ${e.tHi === null ? "---" : thr(e.tHi)} & ${iv(e.wrongAuthorisation)} & ${iv(e.wrongAuthorisationResidual)} & ${iv(e.autonomy)} & ${iv(e.attacks.B4a)} & ${iv(e.attacks.B4b)}`);
  }
  write("s22-authz.tex", table(
    `Authorisation instance, every admitted judge and configuration, calibrated on its own jurisdiction. WA is wrong authorisation over the ${az.configs[az.admitted[0]]["0.05"].hardened.wrongAuthorisation.n} not-covered test pairs, and the res. column conditions on the residual; autonomy is the permit rate over the ${az.configs[az.admitted[0]]["0.05"].hardened.autonomy.n} covered test pairs; B4a and B4b are permit rates over the ${az.configs[az.admitted[0]]["0.05"].hardened.attacks.B4a.n} + ${az.configs[az.admitted[0]]["0.05"].hardened.attacks.B4b.n} held-out attack pairs.`,
    "tab:s22", "lllllllll",
    "Judge & $\\alpha$ & configuration & $\\thi$ & WA & WA (res.) & autonomy & B4a & B4b",
    rows));
  const cats = { A1: "whitespace (certified)", A2: "paraphrase", A3: "specific instance", B1: "typed violation (refuted)", B2: "out of scope" };
  write("s22-authz-categories.tex", table(
    "Authorisation instance, permit rate by category on the test split for the proposed configuration at $\\alpha=0.05$. Categories A are covered (permitting is correct); categories B are not (permitting is wrong authorisation).",
    "tab:s22b", "l" + "l".repeat(az.admitted.length),
    `Category & ${az.admitted.map((j) => esc(JN[j])).join(" & ")}`,
    Object.entries(cats).map(([c, name]) => `${c} ${name} & ${az.admitted.map((j) => iv(az.configs[j]["0.05"].hardened.perCategory[c])).join(" & ")}`)));
}

console.log("supplement tables written to", out);
