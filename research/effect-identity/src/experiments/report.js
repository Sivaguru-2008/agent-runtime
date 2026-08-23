import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fmtRate } from "../stats.js";

/**
 * Renders every reported number, with its interval and the basis of its claim,
 * as one markdown digest.
 *
 * The paper's tables are transcribed from this file and nowhere else. A number
 * that appears in the paper but not here has no provenance, which is the
 * failure mode this exists to make impossible: the previous version carried
 * figures that had been hand-copied across a corpus change and no longer
 * matched any run.
 *
 *   node src/experiments/report.js > results/REPORT.md
 */

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..", "..");
const read = (p) => (existsSync(resolve(base, p)) ? JSON.parse(readFileSync(resolve(base, p), "utf8")) : null);

const exp = read("results/experiments.json");
const multi = read("results/multi_candidate.json");
const crash = read("results/crash_replay.json");
const human = read("results/human_annotation.json");
const meta = read("corpus/meta.json");
const jmeta = read("results/judge_meta.json");
if (!exp) { console.error("results/experiments.json missing — run run.js first"); process.exit(1); }

const out = [];
const L = (s = "") => out.push(s);
const f = (r) => (r === null || r === undefined ? "n/a" : fmtRate(r));
const pct = (x, d = 1) => (x === null || x === undefined ? "n/a" : (x * 100).toFixed(d) + "%");
const thr = (t) => (t === Infinity || t === null ? "+∞" : Number(t).toFixed(3));

L(`# Results digest`);
L();
L(`Generated ${exp.generatedAt}. Primary judge: \`${exp.primaryScorer}\`.`);
L(`Corpus: ${exp.corpus.nTotal} pairs (cal ${exp.corpus.nCal}, test ${exp.corpus.nTest}, attack ${exp.corpus.nAttack}).`);
L(`Candidate-set size in this file: m = ${exp.candidateSetSize}. ${exp.candidateSetNote}`);
L();

// ── Corpus ───────────────────────────────────────────────────────────────────
if (meta) {
  L(`## Corpus composition`);
  L();
  L(`| category | label | total | cal | test | attack |`);
  L(`|---|---|---:|---:|---:|---:|`);
  for (const [cat, c] of Object.entries(meta.counts)) {
    L(`| ${cat} | ${c.label} | ${c.total} | ${c.cal} | ${c.test} | ${c.attack} |`);
  }
  L();
  L(`Totals: ${meta.totals.pairs} pairs, ${meta.totals.same} SAME, ${meta.totals.diff} DIFF.`);
  L();
  L(`| generator arm | pairs | cal | test | S2 kept/dropped | S4 kept/dropped | transport drops |`);
  L(`|---|---:|---:|---:|---|---|---:|`);
  for (const [gen, g] of Object.entries(meta.byGenerator)) {
    const s = meta.generation.perGenerator[gen] ?? {};
    L(`| ${gen} | ${g.total} | ${g.cal} | ${g.test} | ${s.s2Kept ?? 0}/${s.s2Dropped ?? 0} | ${s.s4Kept ?? 0}/${s.s4Dropped ?? 0} | ${(s.s2TransportDropped ?? 0) + (s.s4TransportDropped ?? 0)} |`);
  }
  L();
}

// ── Judge integrity ──────────────────────────────────────────────────────────
L(`## Judge integrity (the strict parser)`);
L();
if (jmeta?.models && Object.keys(jmeta.models).length) {
  L(`| judge | calls | scored | abstentions | retries | batches w/ violations | probability-scale batches | non-integer | out-of-range | missing |`);
  L(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const [k, m] of Object.entries(jmeta.models)) {
    const p = m.parse ?? { byStatus: {} };
    L(`| ${k} | ${m.calls} | ${m.scoredPairs ?? "?"} | ${m.abstentions ?? "?"} | ${p.batchRetries ?? 0} | ${p.batchesWithViolations ?? 0} | ${p.probabilityScaleBatches ?? 0} | ${p.byStatus?.non_integer ?? 0} | ${p.byStatus?.out_of_range ?? 0} | ${p.byStatus?.missing ?? 0} |`);
  }
  L();
  for (const [k, m] of Object.entries(jmeta.models)) {
    const p = m.parse ?? {};
    if (p.samples?.length) {
      L(`Rejected samples (${k}): ` + p.samples.slice(0, 5).map((s) => `\`${JSON.stringify(s.raw)}\` (${s.status})`).join(", "));
    }
    L(`Scale-ambiguous accepted values (0 or 1 as a percent) for ${k}: ${p.ambiguousAcceptedZeroOne ?? 0}.`);
  }
  L();
}
L(`Abstention rates (a pair the judge never returned an admissible score for):`);
L();
L(`| scorer | all | cal | test | attack |`);
L(`|---|---|---|---|---|`);
for (const [k, v] of Object.entries(exp.abstentions)) L(`| ${k} | ${f(v.all)} | ${f(v.cal)} | ${f(v.test)} | ${f(v.attack)} |`);
L();

// ── L0 ───────────────────────────────────────────────────────────────────────
L(`## RQ1 — the canonical core (L0)`);
L();
L(`- SAME caught by L0 (test): **${f(exp.l0.sameCaughtByL0)}**`);
L(`- DIFF wrongly caught by L0 (test): **${f(exp.l0.diffCaughtByL0)}** — basis \`${exp.l0.diffCaughtByL0.basis}\``);
L(`- escaping L0 and therefore requiring the semantic layer: ${pct(1 - exp.l0.sameCaughtByL0.value)} of true duplicates`);
L();
L(`Per category (L0 coverage on the test split):`);
L();
L(`| category | L0 hit rate |`);
L(`|---|---|`);
for (const [cat, r] of Object.entries(exp.l0.perCategoryL0)) L(`| ${cat} | ${f(r)} |`);
L();

// ── Main table ───────────────────────────────────────────────────────────────
const P = exp.primaryScorer;
L(`## RQ2/RQ4 — main configurations (judge \`${P}\`, test split)`);
L();
L(`| config | t_hi | t_lo | WS | dedup | flagged escape | silent escape | friction |`);
L(`|---|---|---|---|---|---|---|---|`);
const mainRow = (name, m) =>
  L(`| ${name} | ${m.tHi !== undefined ? thr(m.tHi) : "—"} | ${m.tLo !== undefined ? thr(m.tLo) : "—"} | ${f(m.wrongSuppression)} | ${f(m.dedup)} | ${f(m.flaggedEscape)} | ${f(m.silentEscape)} | ${f(m.friction)} |`);
mainRow("B0 no fence", exp.baselines.B0_noFence);
mainRow("B1 exact string", exp.baselines.B1_exactString);
mainRow("B2 canonical L0 (prior art)", exp.baselines.B2_canonicalL0);
mainRow("B4 raw judge τ=0.5", exp.baselines["B4_rawJudge_0.5"]);
mainRow("B4 raw judge τ=0.9", exp.baselines["B4_rawJudge_0.9"]);
for (const alpha of [0.01, 0.05]) {
  for (const kind of ["layered", "hardened", "tightened"]) {
    const cfg = exp.configs[`${kind}_${P}_alpha_${alpha}`];
    if (cfg) mainRow(`${kind} α=${alpha}`, cfg);
  }
}
L();
L(`\`layered\` = L0 + calibrated judge, no witness. \`hardened\` = + declared-field witness (the proposed system). \`tightened\` = + witness widened to numbers mentioned in free text.`);
L();
L(`Per-category decisions, hardened α=0.05:`);
L();
{
  const cfg = exp.configs[`hardened_${P}_alpha_0.05`];
  L(`| category | label | n | suppress | escalate | execute |`);
  L(`|---|---|---:|---|---|---|`);
  for (const [cat, c] of Object.entries(cfg.perCategory)) {
    L(`| ${cat} | ${c.label} | ${c.n} | ${f(c.suppress)} | ${f(c.escalate)} | ${f(c.execute)} |`);
  }
  L();
}

// ── Judges / ensembles ───────────────────────────────────────────────────────
L(`## RQ7 — judges and ensembles (hardened, α=0.05)`);
L();
L(`| scorer | t_hi | WS | dedup | silent escape | flagged escape | friction | abstention |`);
L(`|---|---|---|---|---|---|---|---|`);
for (const [k, m] of Object.entries(exp.judgeComparison)) {
  L(`| ${k} | ${thr(m.tHi)} | ${f(m.wrongSuppression)} | ${f(m.dedup)} | ${f(m.silentEscape)} | ${f(m.flaggedEscape)} | ${f(m.friction)} | ${f(m.abstentionRate)} |`);
}
L();
L(`\`ensemble_min\` suppresses only when EVERY judge scores above threshold — the safety-aligned aggregator under this loss asymmetry.`);
L();

// ── Cross-generator ──────────────────────────────────────────────────────────
L(`## RQ7 — cross-generator (self-recognition check, hardened α=0.05)`);
L();
L(`| judge | paraphrases written by | self-family? | model-written? | n SAME (test) | dedup |`);
L(`|---|---|---|---|---:|---|`);
for (const [scorer, r] of Object.entries(exp.crossGenerator)) {
  for (const [gen, m] of Object.entries(r.perGenerator)) {
    L(`| ${scorer} | ${gen} | ${m.selfGenerated === null ? "n/a" : m.selfGenerated} | ${m.isModelWritten} | ${m.nSame} | ${f(m.dedup)} |`);
  }
}
L();

// ── Attacks ──────────────────────────────────────────────────────────────────
L(`## RQ3 — adversarial injection (held-out D4 pairs, all DIFF)`);
L();
L(`| config | D4a field-injection WS | D4b text-injection WS |`);
L(`|---|---|---|`);
for (const [k, m] of Object.entries(exp.attacks)) {
  L(`| ${k} | ${f(m.wrongSuppression_D4a_field)} | ${f(m.wrongSuppression_D4b_text)} |`);
}
L();
L(`† = zero as a logical consequence of a decidable layer, not a sample estimate.`);
L();

// ── Ablations ────────────────────────────────────────────────────────────────
L(`## Ablations (judge \`${P}\`, α=0.05, witness-free so each line isolates one component)`);
L();
L(`| ablation | WS | dedup | flagged | silent | friction |`);
L(`|---|---|---|---|---|---|`);
for (const [k, m] of Object.entries(exp.ablations)) {
  if (!m.wrongSuppression) continue;
  L(`| ${k} | ${f(m.wrongSuppression)} | ${f(m.dedup)} | ${f(m.flaggedEscape)} | ${f(m.silentEscape)} | ${f(m.friction)} |`);
}
L();
const jj = exp.ablations.judgeJurisdiction;
L(`Judge jurisdiction: L0 settles ${f(jj.settledByL0)}, the declared-field witness ${f(jj.settledByWitness)}, leaving ${f(jj.needsJudge)} for the judge. With the tightened witness: ${f(jj.settledByTightWitness)} settled, ${f(jj.needsJudgeTightened)} judged.`);
L();

// ── Per-tool calibration ─────────────────────────────────────────────────────
L(`## RQ4 — friction reduction A: per-tool calibration`);
L();
L(`| scorer / α | per-tool WS | per-tool friction | per-tool dedup | global WS | global friction | global dedup |`);
L(`|---|---|---|---|---|---|---|`);
for (const [k, v] of Object.entries(exp.perToolCalibration)) {
  L(`| ${k} | ${f(v.wrongSuppression)} | ${f(v.friction)} | ${f(v.dedup)} | ${f(v.globalComparison.wrongSuppression)} | ${f(v.globalComparison.friction)} | ${f(v.globalComparison.dedup)} |`);
}
L();
{
  const key = `${P}_alpha_0.05`;
  const v = exp.perToolCalibration[key];
  if (v) {
    L(`Per-tool thresholds (${key}):`);
    L();
    L(`| tool | t_hi | t_lo | n cal DIFF | n cal SAME |`);
    L(`|---|---|---|---:|---:|`);
    for (const [tool, t] of Object.entries(v.perTool)) {
      L(`| ${tool} | ${thr(t.tHi)} | ${thr(t.tLo)} | ${t.nCalDiff} | ${t.nCalSame} |`);
    }
    L();
  }
}

// ── Calibration sweep ────────────────────────────────────────────────────────
L(`## Calibration-size sweep (α=0.05, 300 resamples)`);
L();
L(`| n | P(t_hi=+∞) | mean WS | median WS | p95 WS | max WS | certifies m ≤ |`);
L(`|---:|---:|---:|---:|---:|---:|---:|`);
for (const s of exp.sweeps.calibrationSize) {
  L(`| ${s.n} | ${pct(s.pThresholdInfinite)} | ${pct(s.meanWrongSuppression, 2)} | ${pct(s.medianWrongSuppression, 2)} | ${pct(s.p95WrongSuppression, 2)} | ${pct(s.maxWrongSuppression, 2)} | ${s.certifiableCandidateSets} |`);
}
L();
L(`Calibration pairs required to certify level α at candidate-set size m (⌈m/α⌉−1):`);
L();
L(`| m | ` + exp.alphas.map((a) => `α=${a}`).join(" | ") + " |");
L(`|---:|` + exp.alphas.map(() => "---:").join("|") + "|");
for (const [m, byAlpha] of Object.entries(exp.sweeps.calibrationBudgetForM)) {
  L(`| ${m} | ` + exp.alphas.map((a) => byAlpha[a]).join(" | ") + " |");
}
L();

// ── Distributions ────────────────────────────────────────────────────────────
L(`## Score distributions (non-L0 pairs)`);
L();
L(`| scorer | SAME median | SAME q25 | SAME saturated | DIFF median | DIFF q90 | DIFF saturated |`);
L(`|---|---|---|---|---|---|---|`);
for (const k of exp.scorers) {
  const d = exp.distributions[k];
  if (!d?.same || !d?.diff) continue;
  L(`| ${k} | ${d.same.median.toFixed(3)} | ${d.same.q25.toFixed(3)} | ${pct(d.same.saturatedFraction)} | ${d.diff.median.toFixed(3)} | ${d.diff.q90.toFixed(3)} | ${pct(d.diff.saturatedFraction)} |`);
}
L();

// ── Cost ─────────────────────────────────────────────────────────────────────
L(`## RQ4 — cost per 1000 irreversible actions`);
L();
if (exp.cost?.judgeMeta) {
  const jm = exp.cost.judgeMeta;
  L(`Judge \`${exp.cost.judge}\`: ${jm.calls} calls at batch ${jm.batchSize}, ${jm.inputTokens + jm.outputTokens} tokens total, ${jm.tokensPerComparison?.toFixed(1)} tokens per comparison, ${jm.meanCallLatencyMs} ms mean call latency.`);
  L();
}
L(`| witness | fraction judged | judge calls / 1000 dispatches | judge tokens / 1000 | added latency per judged dispatch | escalations / 1000 distinct actions |`);
L(`|---|---|---:|---:|---:|---:|`);
for (const k of ["declaredWitness", "tightenedWitness"]) {
  const c = exp.cost[k];
  if (!c) continue;
  L(`| ${k} | ${pct(c.fractionJudged)} | ${c.judgeCallsPer1000} | ${c.judgeTokensPer1000} | ${c.addedLatencyMsPerJudgedDispatch} ms | ${c.escalationsPer1000DistinctActions} |`);
}
L();
{
  const c = exp.cost.declaredWitness;
  if (c?.usdPer1000AtRate) {
    L(`Token cost per 1000 dispatches at a hypothetical rate (we measured tokens, not prices):`);
    L();
    L(`| rate | USD / 1000 dispatches |`);
    L(`|---|---:|`);
    for (const [r, v] of Object.entries(c.usdPer1000AtRate)) L(`| ${r} | ${v} |`);
    L();
  }
}

// ── Multi-candidate ──────────────────────────────────────────────────────────
L(`## RQ6 — multiple committed candidates`);
L();
if (!multi) {
  L(`**PENDING** — \`results/multi_candidate.json\` not present. Run \`node src/experiments/multiCandidate.js\`.`);
} else {
  L(`Judge \`${multi.judge}\`. K=${multi.K}. DIFF units ${multi.nDiffUnits} (test ${multi.nTestDiffUnits}), SAME units ${multi.nSameUnits}.`);
  L(`Calibration pool: ${multi.calibration.corpusDiffN} corpus DIFF scores → certifiable m ≤ ${JSON.stringify(multi.calibration.maxCertifiableM)}. t_lo=${thr(multi.calibration.tLo)}.`);
  L();
  for (const alpha of [...new Set(multi.grid.map((g) => g.alpha))]) {
    L(`### α = ${alpha}`);
    L();
    L(`| m | rule | t_hi | WS | dedup | friction | silent escape |`);
    L(`|---:|---|---|---|---|---|---|`);
    for (const g of multi.grid.filter((x) => x.alpha === alpha)) {
      for (const [name, r] of Object.entries(g.rules)) {
        L(`| ${g.m} | ${name} | ${thr(r.tHi)} | ${f(r.wrongSuppression)} | ${f(r.dedup)} | ${f(r.friction)} | ${f(r.silentEscape)} |`);
      }
    }
    L();
  }
  L(`How the maximum distinct-pair score grows with m — the mechanism the correction exists for:`);
  L();
  L(`| m | n | mean max | median max | p90 max | max max |`);
  L(`|---:|---:|---:|---:|---:|---:|`);
  for (const g of multi.maxScoreGrowth) {
    L(`| ${g.m} | ${g.n} | ${g.meanMaxScore?.toFixed(3)} | ${g.medianMaxScore?.toFixed(3)} | ${g.p90MaxScore?.toFixed(3)} | ${g.maxMaxScore?.toFixed(3)} |`);
  }
  L();
  const c0 = multi.grid.find((g) => g.alpha === 0.05);
  if (c0) L(`Cost at α=0.05: ${JSON.stringify(multi.grid.filter((g) => g.alpha === 0.05).map((g) => ({ m: g.m, ...g.cost })))}`);
  L();
}

// ── Crash/replay ─────────────────────────────────────────────────────────────
L(`## RQ5 — paraphrased crash/replay across process death`);
L();
if (!crash) {
  L(`**PENDING** — \`results/crash_replay.json\` not present.`);
} else {
  L(`${crash.nTrials} trials, three OS processes each. Judge \`${crash.judge}\` (family ${crash.judgeFamily}); paraphrase pool from \`${crash.paraphrasePool.generator}\` (family ${crash.paraphrasePool.family}, ${crash.paraphrasePool.size} variants, ${crash.paraphrasePool.rejected} rejected).`);
  L(`Cross-family pool: **${crash.crossFamily ? "yes" : "NO — self-recognition confound present"}**. Thresholds t_hi=${thr(crash.thresholds.tHi)}, t_lo=${thr(crash.thresholds.tLo)} (source \`${crash.thresholds.source}\`).`);
  L();
  L(`| crash point | commit window? | mode | n | exactly-once | mean wired | crash point reached | suppressed | window flagged |`);
  L(`|---|---|---|---:|---|---:|---|---|---|`);
  for (const cp of crash.crashPoints) {
    const s = crash.byCrashPoint[cp];
    for (const mode of ["syntactic", "semantic"]) {
      const m = s?.[mode];
      if (!m) continue;
      L(`| ${cp} | ${s.isCommitWindow ? "yes" : "no"} | ${mode} | ${m.nTrials} | ${f(m.exactlyOnceRate)} | $${m.meanWiredUSD.toFixed(0)} | ${f(m.crashPointReached)} | ${f(m.suppressionTrials)} | ${f(m.windowSuspectFlagged)} |`);
    }
  }
  L();
  L(`| scope | mode | n | exactly-once | mean wired | total wired | window flagged |`);
  L(`|---|---|---:|---|---:|---:|---|`);
  for (const [scope, obj] of [["all crash points", crash.overall], ["outside the commit window", crash.defensibleOnly], ["inside the commit window", crash.commitWindowOnly]]) {
    for (const mode of ["syntactic", "semantic"]) {
      const m = obj[mode];
      L(`| ${scope} | ${mode} | ${m.nTrials} | ${f(m.exactlyOnceRate)} | $${m.meanWiredUSD.toFixed(0)} | $${m.totalWiredUSD} | ${f(m.windowSuspectFlagged)} |`);
    }
  }
  L();
  const scoresSeen = crash.trials.flatMap((t) => t.modes.semantic.suppressionScores).filter((s) => s !== null && s !== undefined);
  if (scoresSeen.length) {
    L(`Semantic suppression scores observed: min ${Math.min(...scoresSeen).toFixed(2)}, max ${Math.max(...scoresSeen).toFixed(2)}, n=${scoresSeen.length}, against t_hi=${thr(crash.thresholds.tHi)}.`);
    L();
  }
}

// ── Human annotation ─────────────────────────────────────────────────────────
L(`## Human-verified labels`);
L();
if (!human || human.status === "PENDING") {
  L(`**PENDING.** ${human?.reason ?? "not exported"}`);
  if (human?.sheetItems) L(`A blinded, stratified sheet of ${human.sheetItems} items is exported and waiting: ${JSON.stringify(human.strata)}.`);
  L(`No human labels exist. Nothing in the paper may be attributed to human annotation.`);
} else {
  L(`Annotators: ${human.annotators.join(", ")}. Fully annotated: ${human.nFullyAnnotated}/${human.nItems}.`);
  L(`Fleiss κ = ${human.fleissKappa?.toFixed(3)}; adjudication rate ${f(human.adjudicationRate)}; agreement with construction ${f(human.constructionAgreementOverall)}.`);
  L();
  L(`| stratum | n | agreement with construction | UNSURE rate | adjudication rate |`);
  L(`|---|---:|---|---|---|`);
  for (const [s, v] of Object.entries(human.perStratum)) {
    L(`| ${s} | ${v.n} | ${f(v.constructionAgreement)} | ${f(v.unsureRate)} | ${f(v.adjudicationRate)} |`);
  }
}
L();

const text = out.join("\n") + "\n";
writeFileSync(resolve(base, "results", "REPORT.md"), text);
process.stdout.write(text);
