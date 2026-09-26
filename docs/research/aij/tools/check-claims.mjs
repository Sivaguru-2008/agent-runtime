#!/usr/bin/env node
/**
 * Claims checker for the AIJ manuscript and supplement.
 *
 *   node docs/research/aij/tools/check-claims.mjs
 *
 * checkPaper.js verifies every quoted INTERVAL. Headline numbers in the
 * abstract, introduction, discussion and conclusion are usually quoted bare
 * ("94.7%"), so this file verifies them: each entry names the result it comes
 * from, formats it the way the text prints it, and asserts that the formatted
 * string appears in the named files. It also rejects strings known to be stale
 * from earlier versions of the paper, and it lists every sentence that uses
 * "exactly-once" without a qualifier, so that the term cannot drift back into
 * an unqualified claim.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const aij = resolve(here, "..");
const R = resolve(aij, "..", "..", "..", "research", "effect-identity");
const J = (f) => JSON.parse(readFileSync(resolve(R, "results", f), "utf8"));
const norm = (s) => s.replace(/\\%/g, "%").replace(/~/g, " ").replace(/--/g, "–").replace(/\\,/g, "").replace(/\{,\}/g, ",");

const rc = J("residual_calibration.json"), bm = J("baseline_matrix_v1.json"), ca = J("conformal_audit_v1.json");
const am = J("attack_matrix_v1.json"), ss = J("seed_split.json"), sens = J("sensitivity.json"), aa = J("aij_analyses.json");
const cf = J("cross_family.json");
const pairs = readFileSync(resolve(R, "corpus", "pairs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cfg = (j, a = "0.05") => rc.configs[`${j}_a${a}_residualOnly`];
const G = "openai_gpt_oss_120b", S = "openai_gpt_oss_20b", Q = "qwen_qwen3_6_27b";

const pct1 = (x) => `${(100 * x).toFixed(1)}%`;
const intc = (n) => n.toLocaleString("en-US");
const CLAIMS = [
  ["corpus size", intc(pairs.length), ["sections/abstract.tex", "sections/introduction.tex", "sections/method.tex"]],
  ["SAME count", String(pairs.filter((p) => p.label === "SAME").length), ["sections/method.tex"]],
  ["DIFF count", String(pairs.filter((p) => p.label === "DIFF").length), ["sections/method.tex"]],
  ["dedup, proposed, primary", pct1(cfg(G).overall.dedup.value), ["sections/abstract.tex", "sections/introduction.tex", "sections/conclusion.tex", "sections/discussion.tex"]],
  ["WS, proposed, primary", pct1(cfg(G).overall.wrongSuppression.value), ["sections/abstract.tex", "sections/introduction.tex", "sections/conclusion.tex"]],
  ["dedup, canonical key", pct1(bm.configs.B2_content_addressed.overall.dedup.value), ["sections/abstract.tex", "sections/introduction.tex", "sections/conclusion.tex"]],
  ["dedup, 20B", pct1(cfg(S).overall.dedup.value), ["sections/abstract.tex", "sections/introduction.tex", "sections/discussion.tex"]],
  ["dedup, Qwen", pct1(cfg(Q).overall.dedup.value), ["sections/introduction.tex"]],
  ["WS, 20B", pct1(cfg(S).overall.wrongSuppression.value), ["sections/introduction.tex", "sections/discussion.tex"]],
  ["WS, Qwen", pct1(cfg(Q).overall.wrongSuppression.value), ["sections/introduction.tex", "sections/discussion.tex"]],
  ["Monte-Carlo uncorrected at m=50", pct1(ca.monteCarlo.find((r) => r.m === 50).uncorrected), ["sections/introduction.tex", "figures/fig-multiplicity.tex"]],
  ["D4a raw primary", pct1(am.declared[G].byClass.D4a_field_injection.rawJudgeFailure.value), ["sections/introduction.tex"]],
  ["D4b hardened primary", pct1(am.declared[G].byClass.D4b_text_injection.fullSystemFailure.value), ["sections/introduction.tex", "sections/limitations.tex"]],
  ["D4b hardened primary (abstract, rounded)", `${Math.round(100 * am.declared[G].byClass.D4b_text_injection.fullSystemFailure.value)}%`, ["sections/abstract.tex"]],
  ["tightened dedup primary", pct1(rc.tightened[`${G}_a0.05`].dedup.value), ["sections/introduction.tex", "sections/discussion.tex"]],
  ["tightened dedup 20B", pct1(rc.tightened[`${S}_a0.05`].dedup.value), ["sections/introduction.tex", "sections/discussion.tex"]],
  ["tightened dedup Qwen", pct1(rc.tightened[`${Q}_a0.05`].dedup.value), ["sections/introduction.tex"]],
  ["seed-split mean WS primary", pct1(ss.judges[G].seedSplit.ws.mean), ["sections/introduction.tex", "sections/discussion.tex"]],
  ["seed-split share above alpha primary", pct1(ss.judges[G].seedSplit.ws.shareAboveAlpha), ["sections/introduction.tex", "sections/limitations.tex"]],
  ["seed-split mean WS 20B", pct1(ss.judges[S].seedSplit.ws.mean), ["sections/discussion.tex"]],
  ["seed-split mean WS Qwen", pct1(ss.judges[Q].seedSplit.ws.mean), ["sections/discussion.tex"]],
  ["relabel D2 WS", pct1(sens.labelSensitivity.d2AsSame.wrongSuppression.value), ["sections/discussion.tex"]],
  ["relabel S4 WS", pct1(sens.labelSensitivity.s4AsDiff.wrongSuppression.value), ["sections/discussion.tex"]],
  ["relabel S4 dedup", pct1(sens.labelSensitivity.s4AsDiff.dedup.value), ["sections/discussion.tex"]],
  ["seed provenance sharing", pct1(ca.seedProvenanceSharing.value), ["sections/theory.tex"]],
  ["judge jurisdiction", pct1(rc.jurisdiction.test.residual.value), ["sections/limitations.tex"]],
  ["alpha=0.01 dedup primary", pct1(cfg(G, "0.01").overall.dedup.value), ["sections/limitations.tex"]],
  ["alpha=0.01 flagged primary", pct1(cfg(G, "0.01").overall.flaggedEscape.value), ["sections/limitations.tex"]],
  ["declared pool primary", `n=${aa.A5_refinement[G].declared.poolN}`, ["sections/theory.tex"]],
  ["tightened pool primary", `n=${aa.A5_refinement[G].tightened.poolN}`, ["sections/theory.tex"]],
  ["declared rank from top", `${aa.A5_refinement[G].declared.rankFromTop}th largest`, ["sections/theory.tex"]],
  ["tightened rank from top", `${aa.A5_refinement[G].tightened.rankFromTop}nd largest`, ["sections/theory.tex"]],
  ["tokens per comparison (rounded)", `about ${Math.round(aa.A8_cost.judges[G].tokensPerComparison)} tokens`, ["sections/limitations.tex"]],
  ["Qwen coverage", pct1(cf.missingness.overall.covered / cf.missingness.overall.n), ["sections/method.tex"]],
  // §8.3 class-conditional validity (results/class_conditional.json).
  ...(() => {
    const cc = J("class_conditional.json"), r = cc.judgesResult[G];
    const pools = cc.diffCategories.map((c) => r.perCategory[c].poolN);
    const d3 = r.perCategory.D3_semantic_diff;
    return [
      ["class pools primary", `${pools.slice(0, -1).join(", ")} and ${pools.at(-1)} scores`, ["sections/results.tex"]],
      ["class: D3 Mondrian threshold", `largest score, ${Number(d3.mondrianTHi).toFixed(2)}`, ["sections/results.tex"]],
      ["class: observed D3 residual share", `observed D3 share (${pct1(r.reweighting.naturalD3Share)})`, ["sections/results.tex"]],
      ["class: tools below budget", `${["zero", "one", "two", "three", "four", "five", "six"][r.toolMondrian.toolsBelowBudget.length]} of six tools below`, ["sections/results.tex"]],
      ["class: marginal certifiable m", `certifiable $m\\le${r.marginal.certifiableM}$`, ["sections/results.tex"]],
      ["class: only D2 beyond m=1", cc.diffCategories.filter((c) => r.perCategory[c].certifiableM > 1).join() === "D2_legit_repeat" ? "but only D2 beyond it" : "CLASS BUDGET CLAIM FALSE", ["sections/results.tex"]],
    ];
  })(),
  // Theorem 2 / Corollary 1: exact worst cases quoted in theory.tex.
  ...(() => {
    const tg = J("tightness.json");
    const pct3 = (x) => `${(100 * x).toFixed(3)}%`;
    const byLabel = (l) => tg.configs.find((c) => c.label === l);
    const unc = (m) => tg.uncorrectedUnderCoupling.find((u) => u.m === m).attainedSupQ;
    const sim10 = ca.monteCarlo.find((r) => r.m === 10);
    const gapsBelow = tg.configs.filter((c) => c.k !== null).every((c) => Math.abs(c.gap) < 1e-10);
    const grid = tg.budgetGrid;
    return [
      ["tightness: declared pool worst case", pct3(byLabel("declared pool, primary judge").attainedSupQ), ["sections/theory.tex"]],
      ["tightness: tightened pool worst case", pct3(byLabel("tightened pool, primary judge").attainedSupQ), ["sections/theory.tex"]],
      ["tightness: n=200 worst case", pct3(byLabel("simulation setting, m=10").attainedSupQ), ["sections/theory.tex"]],
      ["tightness: declared pool next rank", pct3(byLabel("declared pool, primary judge").nextLowerThresholdSupQ), ["sections/theory.tex"]],
      ["tightness: tightened pool next rank", pct3(byLabel("tightened pool, primary judge").nextLowerThresholdSupQ), ["sections/theory.tex"]],
      ["tightness: uncorrected m=10 under coupling", pct1(unc(10)), ["sections/theory.tex"]],
      ["tightness: uncorrected m=50 under coupling", pct1(unc(50)), ["sections/theory.tex"]],
      ["tightness: simulation corrected m=10", pct1(sim10.corrected), ["sections/theory.tex"]],
      ["tightness: simulation uncorrected m=10", pct1(sim10.uncorrected), ["sections/theory.tex"]],
      ["tightness: every gap below 1e-10", gapsBelow ? "below $10^{-10}$" : "GAP CLAIM FALSE", ["sections/theory.tex"]],
      ["tightness: Monte-Carlo agreement", tg.mcOk ? "agrees with the exact values in all eight" : "MC CLAIM FALSE", ["sections/theory.tex"]],
      ["tightness: grid exceptions", grid.every((g) => g.failures === 0 && g.maxNPlus1 >= 1e6) ? "with no exception" : "GRID CLAIM FALSE", ["sections/theory.tex"]],
      ["tightness: k=n equality grid", `over ${tg.poolMaxEquality.gridPoints.toLocaleString("en-US")} pairs`, ["sections/theory.tex"]],
      ["tightness: k=n equality precision", tg.poolMaxEquality.maxAbsDiff < 1e-12 ? "to within $10^{-12}$" : "EQUALITY PRECISION CLAIM FALSE", ["sections/theory.tex"]],
      ["tightness: k=n simulation", tg.poolMaxEquality.simulationOk && tg.poolMaxEquality.simulated.length === 6 ? "agrees in all six budget configurations" : "EQUALITY SIMULATION CLAIM FALSE", ["sections/theory.tex"]],
      ["tightness: delta 0.05",tg.budgetBand.find((b) => b.alpha === 0.05).delta < 1.1e-10 ? "delta_{0.05}<1.1" : "DELTA CLAIM FALSE", ["sections/theory.tex"]],
    ];
  })(),
];

const read = (f) => (existsSync(resolve(aij, f)) ? norm(readFileSync(resolve(aij, f), "utf8")) : null);
const failures = [];
for (const [label, want, files] of CLAIMS) {
  for (const f of files) {
    const text = read(f);
    if (text === null) { failures.push(`${label}: file ${f} missing`); continue; }
    if (!text.includes(want)) failures.push(`${label}: expected "${want}" in ${f}`);
  }
}

// Stale strings from earlier versions. Each was a real error; none may return.
const STALE = [
  [/\b73\.5\s*%/, "judge jurisdiction 73.5% (955-pair corpus; now 76.2%)"],
  [/\b26\.5\s*%/, "decided share 26.5% (now 23.8%)"],
  [/\b56\.5\s*%/, "tightened jurisdiction 56.5% (now 58.9%)"],
  [/206 (held-out )?distinct/, "206 held-out distinct pairs (now 232)"],
  [/factor of nine/, "'factor of nine' (Monte-Carlo gives 89.0% vs 5%)"],
  [/equals 35/, "conformal index 'equals 35' (at n=49 it is 48)"],
  [/5,431|4,170 tokens|\b735 (calls|dispatches|judge)|2,061/, "stale cost figures (cost model denominator bug)"],
  [/sixty-nine/, "'sixty-nine points' (not supported)"],
  [/one tool'?s (declaration|schema)/, "tightened configuration refines every tool's free-text fields, not one tool"],
  [/\bhuman[- ]validated\b/i, "labels are not human-validated"],
  [/202\s*\/\s*0/, "stale McNemar count 202/0 (now 232/0)"],
  [/fourteen further tools/, "extension corpus covers nine further tools (fourteen is toolsV2.js's total, six of which are this paper's)"],
];
// Recursive: supplement/tables/ holds generated tables, which are checked too.
const walkTex = (rel) => (existsSync(resolve(aij, rel))
  ? readdirSync(resolve(aij, rel), { withFileTypes: true }).flatMap((e) =>
    (e.isDirectory() ? walkTex(`${rel}/${e.name}`) : e.name.endsWith(".tex") ? [`${rel}/${e.name}`] : []))
  : []);
const allFiles = ["manuscript.tex", "supplement.tex",
  ...walkTex("sections"), ...walkTex("supplement"), ...walkTex("figures")]
  .filter((f) => f.endsWith(".tex") && existsSync(resolve(aij, f)));
// The errata section names the superseded numbers on purpose ("was X, now Y"),
// so a region marked ERRATA BEGIN/END is exempt from the stale-string check.
// The exemption is allowed in the supplement only, and its size is reported, so
// it cannot quietly grow into a place where a stale number would be a claim.
const ERRATA = /^%+\s*CHECK-CLAIMS: ERRATA BEGIN\s*$[\s\S]*?^%+\s*CHECK-CLAIMS: ERRATA END\s*$/gm;
let exemptChars = 0;
for (const f of allFiles) {
  const raw = read(f);
  const text = raw.replace(ERRATA, (m) => {
    if (f !== "supplement.tex") { failures.push(`errata exemption is only allowed in supplement.tex, found in ${f}`); return m; }
    exemptChars += m.length;
    return "";
  });
  for (const [re, why] of STALE) if (re.test(text)) failures.push(`stale string in ${f}: ${why}`);
}

// The main text cites supplement sections by number ("Section~S21"), because
// the two documents compile separately. Each cited number must be a section of
// supplement.tex whose title carries the expected topic, so that inserting a
// supplement section cannot silently re-point a citation.
{
  const SUPP_TOPIC = {
    2: /corpus construction/i, 3: /parser defect/i, 4: /judge coverage/i, 8: /score distributions/i,
    16: /model panel/i, 20: /artifact contents/i, 21: /tightness/i, 22: /authorisation/i, 23: /class-conditional/i,
  };
  const titles = [...readFileSync(resolve(aij, "supplement.tex"), "utf8").matchAll(/^\\section\{(.*)\}/gm)].map((m) => m[1]);
  for (const f of allFiles.filter((x) => x.startsWith("sections/") || x === "manuscript.tex")) {
    for (const m of read(f).matchAll(/Sections? S(\d+)/g)) {
      const n = +m[1];
      if (!SUPP_TOPIC[n]) failures.push(`${f} cites supplement Section S${n}, which has no expected topic in check-claims.mjs`);
      else if (!SUPP_TOPIC[n].test(titles[n - 1] ?? "")) failures.push(`${f} cites Section S${n}, but supplement section ${n} is "${titles[n - 1]}"`);
    }
  }
}

// Every sentence using "exactly-once" must qualify it.
const review = [];
for (const f of allFiles) {
  const text = read(f).replace(/%.*$/gm, "");
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (/exactly-once|exactly once/i.test(sentence) && !/(external|provider|not |never|conflat|unqualified|protocol|guarantee \(C\)|\(C\)|composition|Case A|rendered transition|stream processors|classical|fidelity)/i.test(sentence)) {
      failures.push(`unqualified "exactly-once" in ${f}: ${sentence.trim().slice(0, 160)}`);
    }
    if (/\b(the first|first to|novel)\b/i.test(sentence)) review.push(`${f}: ${sentence.trim().slice(0, 140)}`);
  }
}

console.log(`claims checked: ${CLAIMS.length} (${CLAIMS.reduce((a, c) => a + c[2].length, 0)} file assertions); stale patterns: ${STALE.length}; files: ${allFiles.length}; errata exemption: ${exemptChars} chars`);
if (review.length) { console.log(`\nfor manual review ("first"/"novel"):`); for (const r of review) console.log(`  ${r}`); }
if (failures.length) { console.error(`\n${failures.length} failure(s):`); for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
console.log("all claims present and no stale strings");
