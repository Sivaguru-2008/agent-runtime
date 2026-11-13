#!/usr/bin/env node
/**
 * Analyses added in the AIJ revision (September 2026).
 *
 * Every block below answers one question a skeptical reviewer would put to the
 * manuscript and that the earlier scripts either did not answer or answered
 * under a jurisdiction-mismatched calibration pool. All of it is offline: it
 * reads the persisted corpus and scores and makes no model calls.
 *
 *   node src/experiments/aijAnalyses.js          → results/aij_analyses.json
 *
 * The decision rule is the one residualCalibration.js implements (certifier,
 * then refuter, then the conformal judge threshold with the escalation band),
 * and block A0 asserts that this file reproduces that script's headline rows
 * before any new number is computed from it.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { suppressionThreshold, escalationFloor, decide, maxCertifiableCandidates } from "../conformal.js";
import { rate } from "../stats.js";
import { TOOLS } from "../tools.js";
import { TOOLS_V2, MISDECLARED_SCHEMA } from "../toolsV2.js";
import { canonicalize, canonicalString, semanticProjection, tightenedProjection } from "../canonicalize.js";
import { extractNumbers, lexicalScore } from "../judge.js";
import { runConfig, makeScoreLookup } from "../evaluate.js";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJsonl = (f) => (existsSync(resolve(base, f))
  ? readFileSync(resolve(base, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const readJson = (f) => JSON.parse(readFileSync(resolve(base, f), "utf8"));

const ALPHA = 0.05;
const GAMMA = 0.05;
const JUDGES = ["openai_gpt_oss_120b", "openai_gpt_oss_20b", "qwen_qwen3_6_27b"];
const PRIMARY = "openai_gpt_oss_120b";
const SEED = 20260914;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const quantile = (sortedAsc, q) => sortedAsc.length
  ? sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1))] : null;
const summary = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return { n: s.length, mean, p05: quantile(s, 0.05), median: quantile(s, 0.5), p95: quantile(s, 0.95), min: s[0], max: s[s.length - 1] };
};
const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "function" ? undefined : v === Infinity ? "Infinity" : v)));
/** Mann–Whitney AUC of SAME over DIFF, ties counted one half. */
function auc(same, diff) {
  if (!same.length || !diff.length) return null;
  let w = 0;
  for (const s of same) for (const d of diff) w += s > d ? 1 : s === d ? 0.5 : 0;
  return w / (same.length * diff.length);
}

// ── corpus, scores, decidable-layer facts ────────────────────────────────────
const pairs = readJsonl("corpus/pairs.jsonl");
const scoreRowsArr = readJsonl("corpus/scores.jsonl");
const scoreRows = new Map(scoreRowsArr.map((r) => [r.id, r]));
const judgeScore = (j) => (p) => { const v = scoreRows.get(p.id)?.judges?.[j]; return v === undefined ? null : v; };
for (const p of pairs) {
  const s = TOOLS[p.tool];
  p.l0 = canonicalString(canonicalize(p.a, s)) === canonicalString(canonicalize(p.b, s));
  p.veto = semanticProjection(p.a, s) !== semanticProjection(p.b, s);
  p.tveto = tightenedProjection(p.a, s, extractNumbers) !== tightenedProjection(p.b, s, extractNumbers);
  p.res = !p.l0 && !p.veto;
  p.tres = !p.l0 && !p.tveto;
  p.lex = lexicalScore(p.tool, p.a, p.b, s);
}
const cal = pairs.filter((p) => p.split === "cal");
const test = pairs.filter((p) => p.split === "test");
const attack = pairs.filter((p) => p.split === "attack");

/** The hardened rule with a pluggable scorer, jurisdiction and refuter. */
function evalCfg({ score, jur = (p) => p.res, vetoed = (p) => p.veto, alpha = ALPHA, pool = null, tHi: tHiFixed = null, band = true, set = test }) {
  const calD = pool ?? cal.filter((p) => p.label === "DIFF" && jur(p) && score(p) !== null).map(score);
  const calS = cal.filter((p) => p.label === "SAME" && jur(p) && score(p) !== null).map(score);
  const tHi = tHiFixed ?? suppressionThreshold(calD, alpha);
  const tLo = band ? Math.min(escalationFloor(calS.length ? calS : [0.5], GAMMA), tHi === Infinity ? Infinity : tHi) : tHi;
  const dec = (p) => {
    if (p.l0) return "SUPPRESS";
    if (vetoed(p)) return "EXECUTE";
    const s = score(p);
    if (s === null) return band ? "ESCALATE" : "EXECUTE";
    return decide(s, tHi, tLo);
  };
  const same = set.filter((p) => p.label === "SAME");
  const diff = set.filter((p) => p.label === "DIFF");
  const n = (arr, d) => arr.filter((p) => dec(p) === d).length;
  return {
    tHi, tLo, nCalDiff: calD.length, nCalSame: calS.length, certifiableM: maxCertifiableCandidates(calD.length, alpha), dec,
    wrongSuppression: rate(n(diff, "SUPPRESS"), diff.length),
    dedup: rate(n(same, "SUPPRESS"), same.length),
    silentEscape: rate(n(same, "EXECUTE"), same.length),
    flaggedEscape: rate(n(same, "ESCALATE"), same.length),
    friction: rate(n(diff, "ESCALATE"), diff.length),
    attacks: Object.fromEntries(["D4a_field_injection", "D4b_text_injection"].map((c) => {
      const a = attack.filter((p) => p.category === c);
      return [c, rate(a.filter((p) => dec(p) === "SUPPRESS").length, a.length)];
    })),
  };
}
const brief = (r) => ({
  tHi: r.tHi, tLo: r.tLo, nCalDiff: r.nCalDiff, certifiableM: r.certifiableM,
  wrongSuppression: r.wrongSuppression, dedup: r.dedup, silentEscape: r.silentEscape,
  flaggedEscape: r.flaggedEscape, friction: r.friction, attacks: r.attacks,
});

const out = { generatedAt: new Date().toISOString(), alpha: ALPHA, gamma: GAMMA, judges: JUDGES };

// ── A0. Reproduce residualCalibration.js before computing anything new ───────
{
  const rc = readJson("results/residual_calibration.json");
  const checks = [];
  for (const j of JUDGES) {
    const mine = evalCfg({ score: judgeScore(j) });
    const theirs = rc.configs[`${j}_a0.05_residualOnly`];
    checks.push({ config: `${j} hardened`, ok: mine.tHi === theirs.tHi && mine.wrongSuppression.successes === theirs.overall.wrongSuppression.successes && mine.dedup.successes === theirs.overall.dedup.successes });
    const mt = evalCfg({ score: judgeScore(j), jur: (p) => p.tres, vetoed: (p) => p.tveto });
    const tt = rc.tightened[`${j}_a0.05`];
    checks.push({ config: `${j} tightened`, ok: (mt.tHi === tt.tHi || (mt.tHi === Infinity && tt.tHi === null)) && mt.dedup.successes === tt.dedup.successes });
  }
  out.A0_reproduction = { allOk: checks.every((c) => c.ok), checks };
  if (!out.A0_reproduction.allOk) { console.error("A0 reproduction FAILED", checks); process.exit(1); }
}

// ── A1. Where the escalation band exists, and why ────────────────────────────
// The band exists only when t_lo < t_hi, i.e. when the γ-quantile of residual
// SAME calibration scores sits below the (1−α) order statistic of residual DIFF
// scores. And with integer-percent scores and a STRICT suppression inequality,
// a SAME score that TIES t_hi is not suppressed: it is flagged if the band is
// non-empty and executed silently if it is empty. Both effects are counted.
out.A1_band = {};
for (const j of JUDGES) {
  const score = judgeScore(j);
  const r = evalCfg({ score });
  const resSame = test.filter((p) => p.res && p.label === "SAME" && score(p) !== null).map(score);
  const resDiff = test.filter((p) => p.res && p.label === "DIFF" && score(p) !== null).map(score);
  const nonL0 = pairs.filter((p) => !p.l0 && score(p) !== null);
  const ext = (xs) => rate(xs.filter((s) => s <= 0.02 || s >= 0.98).length, xs.length);
  out.A1_band[j] = {
    tHi: r.tHi, tLo: r.tLo, bandEmpty: !(r.tLo < r.tHi),
    residualTestSame: resSame.length,
    sameSuppressed: resSame.filter((s) => s > r.tHi).length,
    sameTiedAtTHi: resSame.filter((s) => s === r.tHi).length,
    sameInBand: resSame.filter((s) => s > r.tLo && s <= r.tHi).length,
    sameBandTies: resSame.filter((s) => s > r.tLo && s === r.tHi).length,
    sameSilent: resSame.filter((s) => s <= r.tLo).length,
    sameSilentTies: resSame.filter((s) => s <= r.tLo && s === r.tHi).length,
    diffInBand: resDiff.filter((s) => s > r.tLo && s <= r.tHi).length,
    extremesAllNonL0: {
      same: ext(nonL0.filter((p) => p.label === "SAME").map(score)),
      diff: ext(nonL0.filter((p) => p.label === "DIFF").map(score)),
    },
    medians: {
      sameNonL0: quantile(nonL0.filter((p) => p.label === "SAME").map(score).sort((a, b) => a - b), 0.5),
      diffNonL0: quantile(nonL0.filter((p) => p.label === "DIFF").map(score).sort((a, b) => a - b), 0.5),
    },
    distinctValues: new Set(nonL0.map(score)).size,
  };
}

// ── A2. Per-tool score separation on the residual (does T4 bite per tool?) ──
out.A2_perToolSeparation = {};
for (const j of JUDGES) {
  const score = judgeScore(j);
  const rows = {};
  for (const tool of Object.keys(TOOLS)) {
    for (const [scope, set] of [["test", test], ["calPlusTest", [...cal, ...test]]]) {
      const res = set.filter((p) => p.tool === tool && p.res && score(p) !== null);
      const S = res.filter((p) => p.label === "SAME").map(score);
      const D = res.filter((p) => p.label === "DIFF").map(score);
      const maxD = D.length ? Math.max(...D) : null;
      const minS = S.length ? Math.min(...S) : null;
      rows[`${tool}|${scope}`] = {
        tool, scope, nSame: S.length, nDiff: D.length, maxDiff: maxD, minSame: minS,
        separable: S.length && D.length ? maxD < minS : null,
        diffAtOrAboveMinSame: minS === null ? 0 : D.filter((s) => s >= minS).length,
        sameAtOrBelowMaxDiff: maxD === null ? 0 : S.filter((s) => s <= maxD).length,
      };
    }
  }
  out.A2_perToolSeparation[j] = rows;
}

// ── A3. Per-tool calibration, jurisdiction-matched ───────────────────────────
out.A3_perToolCalibration = {};
for (const j of JUDGES) {
  const score = judgeScore(j);
  const per = {};
  for (const tool of Object.keys(TOOLS)) {
    const cd = cal.filter((p) => p.tool === tool && p.label === "DIFF" && p.res && score(p) !== null).map(score);
    const cs = cal.filter((p) => p.tool === tool && p.label === "SAME" && p.res && score(p) !== null).map(score);
    const tHi = suppressionThreshold(cd, ALPHA);
    const tLo = Math.min(escalationFloor(cs.length ? cs : [0.5], GAMMA), tHi === Infinity ? Infinity : tHi);
    per[tool] = { nCalDiff: cd.length, nCalSame: cs.length, tHi, tLo };
  }
  const dec = (p) => {
    if (p.l0) return "SUPPRESS";
    if (p.veto) return "EXECUTE";
    const s = score(p);
    if (s === null) return "ESCALATE";
    return decide(s, per[p.tool].tHi, per[p.tool].tLo);
  };
  const same = test.filter((p) => p.label === "SAME"), diff = test.filter((p) => p.label === "DIFF");
  const n = (arr, d) => arr.filter((p) => dec(p) === d).length;
  out.A3_perToolCalibration[j] = {
    perTool: per,
    perToolRule: {
      wrongSuppression: rate(n(diff, "SUPPRESS"), diff.length), dedup: rate(n(same, "SUPPRESS"), same.length),
      silentEscape: rate(n(same, "EXECUTE"), same.length), flaggedEscape: rate(n(same, "ESCALATE"), same.length),
      friction: rate(n(diff, "ESCALATE"), diff.length),
    },
    globalRule: brief(evalCfg({ score })),
    toolsUncertified: Object.entries(per).filter(([, v]) => v.tHi === Infinity).map(([k]) => k),
  };
}

// ── A4. Ensembles and the lexical scorer, jurisdiction-matched ───────────────
{
  const vals = (p) => JUDGES.map((j) => judgeScore(j)(p)).filter((v) => v !== null);
  const scorers = {
    ensemble_min: (p) => { const v = vals(p); return v.length ? Math.min(...v) : null; },
    ensemble_mean: (p) => { const v = vals(p); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; },
    lexical: (p) => p.lex,
  };
  out.A4_scorers = {};
  for (const [name, score] of Object.entries(scorers)) {
    const hardened = evalCfg({ score });
    const layered = evalCfg({ score, jur: (p) => !p.l0, vetoed: () => false });
    const raw = evalCfg({ score, jur: (p) => !p.l0, vetoed: () => false, tHi: 0.5 });
    out.A4_scorers[name] = { hardened: brief(hardened), layered: brief(layered), rawTau05: brief(raw) };
  }
}

// ── A5. The refinement dilemma, decomposed: pool SIZE vs pool COMPOSITION ────
// Tightening the declaration changes the calibration pool in two ways at once:
// it has fewer pairs (a finite-sample effect — the conformal index moves to a
// higher rank from the top) and different pairs (the pairs the wider refuter
// removes are not a random sample of the old pool). Subsampling the DECLARED
// pool down to the tightened pool's size, many times, isolates the size effect.
out.A5_refinement = {};
for (const j of JUDGES) {
  const score = judgeScore(j);
  const decl = evalCfg({ score });
  const tight = evalCfg({ score, jur: (p) => p.tres, vetoed: (p) => p.tveto });
  const Pdecl = cal.filter((p) => p.label === "DIFF" && p.res && score(p) !== null).map(score);
  const Ptight = cal.filter((p) => p.label === "DIFF" && p.tres && score(p) !== null).map(score);
  const removed = cal.filter((p) => p.label === "DIFF" && p.res && !p.tres && score(p) !== null).map(score);
  const tightSubset = cal.filter((p) => p.label === "DIFF" && p.tres && score(p) !== null).every((p) => p.res);
  const k = (n) => Math.ceil((n + 1) * (1 - ALPHA));
  const rng = mulberry32(SEED);
  const R = 5000;
  const tHis = [], dedTight = [], dedDecl = [], wsTight = [];
  for (let r = 0; r < R; r++) {
    const a = [...Pdecl];
    for (let i = a.length - 1; i > 0; i--) { const q = Math.floor(rng() * (i + 1)); [a[i], a[q]] = [a[q], a[i]]; }
    const sub = a.slice(0, Ptight.length);
    const th = suppressionThreshold(sub, ALPHA);
    tHis.push(th === Infinity ? 1.01 : th);
    const et = evalCfg({ score, jur: (p) => p.tres, vetoed: (p) => p.tveto, tHi: th });
    const ed = evalCfg({ score, tHi: th });
    dedTight.push(et.dedup.value); wsTight.push(et.wrongSuppression.value); dedDecl.push(ed.dedup.value);
  }
  const obsDedup = tight.dedup.value;
  const sd = [...Pdecl].sort((a, b) => b - a), st = [...Ptight].sort((a, b) => b - a);
  const share = (xs, f) => xs.length ? xs.filter(f).length / xs.length : null;
  const sameTest = test.filter((p) => p.label === "SAME");
  const falseVetoesTight = sameTest.filter((p) => !p.l0 && p.tveto && !p.veto).map((p) => p.id);
  const lost = sameTest.filter((p) => decl.dec(p) === "SUPPRESS" && tight.dec(p) !== "SUPPRESS");
  out.A5_refinement[j] = {
    declared: { poolN: Pdecl.length, tHi: decl.tHi, tLo: decl.tLo, conformalIndex: k(Pdecl.length), rankFromTop: Pdecl.length - k(Pdecl.length) + 1, dedup: decl.dedup, ws: decl.wrongSuppression, silentEscape: decl.silentEscape, flaggedEscape: decl.flaggedEscape, certifiableM: decl.certifiableM },
    tightened: { poolN: Ptight.length, tHi: tight.tHi, tLo: tight.tLo, conformalIndex: k(Ptight.length), rankFromTop: Ptight.length - k(Ptight.length) + 1, dedup: tight.dedup, ws: tight.wrongSuppression, silentEscape: tight.silentEscape, flaggedEscape: tight.flaggedEscape, attacks: tight.attacks, certifiableM: tight.certifiableM },
    tightenedPoolIsSubsetOfDeclared: tightSubset,
    removedByRefinement: { n: removed.length, medianScore: quantile([...removed].sort((a, b) => a - b), 0.5), shareAtOrAbove08: share(removed, (s) => s >= 0.8) },
    retained: { n: Ptight.length, medianScore: quantile([...Ptight].sort((a, b) => a - b), 0.5), shareAtOrAbove08: share(Ptight, (s) => s >= 0.8) },
    top10: { declared: sd.slice(0, 10), tightened: st.slice(0, 10) },
    shareAtOrAbove: {
      declared: { "0.8": share(Pdecl, (s) => s >= 0.8), "0.9": share(Pdecl, (s) => s >= 0.9), "0.95": share(Pdecl, (s) => s >= 0.95), "1.0": share(Pdecl, (s) => s >= 1) },
      tightened: { "0.8": share(Ptight, (s) => s >= 0.8), "0.9": share(Ptight, (s) => s >= 0.9), "0.95": share(Ptight, (s) => s >= 0.95), "1.0": share(Ptight, (s) => s >= 1) },
    },
    plain95thPercentile: { declared: quantile([...Pdecl].sort((a, b) => a - b), 0.95), tightened: quantile([...Ptight].sort((a, b) => a - b), 0.95) },
    sizeOnlyCounterfactual: {
      description: `${R} random subsets of the declared residual pool, each of the tightened pool's size (${Ptight.length}); t_hi recomputed per subset (1.01 encodes +Infinity)`,
      tHi: summary(tHis),
      shareTHiAtLeastTightened: tHis.filter((t) => t >= (tight.tHi === Infinity ? 1.01 : tight.tHi)).length / R,
      shareTHiAtCeiling: tHis.filter((t) => t >= 1).length / R,
      dedupTightenedConfig: summary(dedTight),
      shareDedupAtOrBelowObserved: dedTight.filter((d) => d <= obsDedup + 1e-12).length / R,
      wsTightenedConfig: summary(wsTight),
      dedupDeclaredConfig: summary(dedDecl),
    },
    falseVetoesByTightenedWitness: { count: falseVetoesTight.length, ids: falseVetoesTight },
    lostDedup: {
      total: lost.length,
      nowVetoed: lost.filter((p) => p.tveto).length,
      nowFlagged: lost.filter((p) => !p.tveto && tight.dec(p) === "ESCALATE").length,
      nowSilent: lost.filter((p) => !p.tveto && tight.dec(p) === "EXECUTE").length,
    },
  };
}

// ── A6. The annotation re-derivation, re-examined ────────────────────────────
// Two collections exist. The PREREGISTERED one is the set of response files as
// committed when the panel analysis was published (snapshotted, byte-for-byte,
// in annotation/preregistered-collection/). The working-tree files later gained
// 23 late responses (re-asked non-responses, collected after the analysis was
// published). The first is the primary analysis; the second is post hoc.
{
  const key = readJsonl("annotation/key.jsonl");
  const keyByPair = new Map(key.map((k) => [k.pairId, k]));
  const parseCsv = (text) => {
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
  };
  const readResponses = (dir, f) => {
    const rows = parseCsv(readFileSync(resolve(base, dir, f), "utf8"));
    const h = rows[0].map((c) => c.trim().toLowerCase());
    const iItem = h.indexOf("item"), iLab = h.indexOf("label");
    const m = new Map();
    for (const r of rows.slice(1)) {
      const lab = (r[iLab] || "").trim().toUpperCase();
      if (["SAME", "DIFF", "UNSURE"].includes(lab)) m.set(r[iItem].trim(), lab);
    }
    return m;
  };
  const v2 = readJsonl("corpus/pairs-v2ext.jsonl");
  const allSchemas = { ...TOOLS, ...TOOLS_V2, pay_by_account_no: MISDECLARED_SCHEMA };
  const byId = new Map([...pairs, ...v2].map((p) => [p.id, p]));
  const facts = (p) => {
    const s = allSchemas[p.tool];
    const certifies = canonicalString(canonicalize(p.a, s)) === canonicalString(canonicalize(p.b, s));
    const refutes = semanticProjection(p.a, s) !== semanticProjection(p.b, s);
    return { certifies, refutes, residual: !certifies && !refutes };
  };
  const score120 = judgeScore(PRIMARY);

  // (i) The re-derivation exactly as annotation.js executed it: v1 + v2ext
  //     corpus, v2ext scores looked up in a file that does not exist.
  const loadCorpusRaw = () => [...readJsonl("corpus/pairs.jsonl"), ...readJsonl("corpus/pairs-v2ext.jsonl")];
  const lookupAsExecuted = makeScoreLookup([...scoreRowsArr, ...readJsonl("corpus/scores-v2ext.jsonl")], PRIMARY);
  const asExecuted = (subsetIds, labelMap) => {
    const forEval = loadCorpusRaw().map((p) => (subsetIds.has(p.id)
      ? { ...p, split: "test", label: labelMap.get(p.id) ?? p.label }
      : { ...p, split: p.split === "test" ? "unused" : p.split }));
    const r = runConfig({ pairs: forEval, schemas: allSchemas, cfg: {}, judge: PRIMARY, scoreOf: lookupAsExecuted, alpha: ALPHA });
    const reachedJudgeUnscored = forEval.filter((p) => subsetIds.has(p.id) && p.facts.residual && lookupAsExecuted(p) === null).length;
    return { tHi: r.calibration.tHi, nCalDiff: r.calibration.nCalDiff, overall: r.overall, reachedJudgeWithNoScore: reachedJudgeUnscored };
  };
  // (ii) Restricted to items the primary judge actually scored (all are v1).
  const scoredOnly = (subsetIds, labelMap) => {
    const subset = [...subsetIds].filter((id) => score120({ id }) !== null);
    const S = new Set(subset);
    const calPool = cal.filter((p) => !S.has(p.id) && p.label === "DIFF" && p.res && score120(p) !== null).map(score120);
    const calSame = cal.filter((p) => !S.has(p.id) && p.label === "SAME" && p.res && score120(p) !== null).map(score120);
    const tHi = suppressionThreshold(calPool, ALPHA);
    const tLo = Math.min(escalationFloor(calSame, GAMMA), tHi);
    const items = pairs.filter((p) => S.has(p.id)).map((p) => ({ ...p, label: labelMap.get(p.id) ?? p.label }));
    const dec = (p) => (p.l0 ? "SUPPRESS" : p.veto ? "EXECUTE" : score120(p) === null ? "ESCALATE" : decide(score120(p), tHi, tLo));
    const same = items.filter((p) => p.label === "SAME"), diff = items.filter((p) => p.label === "DIFF");
    const benignDiff = diff.filter((p) => p.split !== "attack");
    const n = (arr, d) => arr.filter((p) => dec(p) === d).length;
    return {
      tHi, tLo, nCalDiff: calPool.length, nItems: items.length, nExcludedUnscored: subsetIds.size - items.length,
      nSame: same.length, nDiff: diff.length,
      wrongSuppression: rate(n(diff, "SUPPRESS"), diff.length),
      wrongSuppressionBenign: rate(n(benignDiff, "SUPPRESS"), benignDiff.length),
      wrongSuppressionAttackSplit: rate(n(diff.filter((p) => p.split === "attack"), "SUPPRESS"), diff.filter((p) => p.split === "attack").length),
      dedup: rate(n(same, "SUPPRESS"), same.length),
      wsItems: diff.filter((p) => dec(p) === "SUPPRESS").map((p) => `${p.id} (${p.split})`),
    };
  };

  // preregistered : the files the published analysis ran on (commit 226a355)
  // head0dc8464   : +2 late responses committed ten minutes later, never ingested
  // workingTree   : +23 further late responses (re-asked non-responses), post hoc
  const collections = {
    preregistered: "annotation/preregistered-collection",
    head0dc8464: "annotation/response-history/0dc8464",
    workingTree: "annotation",
  };
  // The analysis as originally published (commit 226a355), preserved verbatim;
  // results/human_annotation.json is regenerated and must not be compared to itself.
  const published = readJson("results/human_annotation.published-20260825.json");
  const pubFlips = new Set(published.labelFlips.map((f) => f.pairId));
  const res = {};
  for (const [name, dir] of Object.entries(collections)) {
    const ann = ["compound", "compound-mini", "qwen27b"].map((n) => readResponses(dir, `responses-${n}.csv`));
    const adj = readResponses(dir, "responses-adjudicator-adjudicator-safeguard20b.csv");
    const final = new Map();
    const full = [];
    let adjudicated = 0;
    for (const k of key) {
      const votes = ann.map((a) => a.get(k.item));
      if (votes.some((v) => v === undefined)) continue;
      full.push(k);
      const c = { SAME: 0, DIFF: 0 };
      for (const v of votes) if (v in c) c[v]++;
      let lab = c.SAME * 2 > 3 ? "SAME" : c.DIFF * 2 > 3 ? "DIFF" : null;
      if (!lab) { adjudicated++; const a = adj.get(k.item); lab = a === "SAME" || a === "DIFF" ? a : null; }
      if (lab) final.set(k.item, lab);
    }
    const flips = full.filter((k) => final.has(k.item) && final.get(k.item) !== k.constructedLabel);
    const flipFacts = flips.map((k) => ({ pairId: k.pairId, category: k.category, corpusVersion: k.corpusVersion, tool: k.tool, from: k.constructedLabel, to: final.get(k.item), scored: score120({ id: k.pairId }) !== null, ...facts(byId.get(k.pairId)) }));
    const subsetIds = new Set(full.filter((k) => final.has(k.item)).map((k) => k.pairId));
    const constructedMap = new Map(full.map((k) => [k.pairId, k.constructedLabel]));
    const panelMap = new Map(full.filter((k) => final.has(k.item)).map((k) => [k.pairId, final.get(k.item)]));
    const annotatedDiff = full.filter((k) => k.constructedLabel === "DIFF");
    res[name] = {
      directory: dir,
      nFullyAnnotated: full.length, adjudicated,
      fullyAnnotatedByVersion: full.reduce((m, k) => ((m[k.corpusVersion] = (m[k.corpusVersion] || 0) + 1), m), {}),
      fullyAnnotatedWithPrimaryScore: full.filter((k) => score120({ id: k.pairId }) !== null).length,
      vsPublished: {
        nFullyAnnotated: { thisCollection: full.length, published: published.nFullyAnnotated },
        flipsIdenticalToPublished: flips.length === pubFlips.size && flips.every((f) => pubFlips.has(f.pairId)),
      },
      flips: flipFacts,
      flipSummary: {
        n: flipFacts.length,
        residual: flipFacts.filter((f) => f.residual).length,
        refuterDecided: flipFacts.filter((f) => f.refutes).length,
        certifierDecided: flipFacts.filter((f) => f.certifies).length,
        byVersion: flipFacts.reduce((m, f) => ((m[f.corpusVersion] = (m[f.corpusVersion] || 0) + 1), m), {}),
        scored: flipFacts.filter((f) => f.scored).length,
      },
      denominator: {
        annotatedConstructedDiff: annotatedDiff.length,
        annotatedConstructedDiffUnscored: annotatedDiff.filter((k) => score120({ id: k.pairId }) === null).length,
        diffToSameFlips: flipFacts.filter((f) => f.from === "DIFF").length,
        diffToSameFlipsUnscored: flipFacts.filter((f) => f.from === "DIFF" && !f.scored).length,
      },
      rederivationAsExecuted: { constructed: asExecuted(subsetIds, constructedMap), panel: asExecuted(subsetIds, panelMap) },
      rederivationScoredOnly: { constructed: scoredOnly(subsetIds, constructedMap), panel: scoredOnly(subsetIds, panelMap) },
    };
  }
  const v2partialPath = resolve(base, "results", "partial-pairs-v2ext-openai_gpt_oss_120b.json");
  const v2partial = existsSync(v2partialPath) ? JSON.parse(readFileSync(v2partialPath, "utf8")).scores ?? {} : {};
  out.A6_annotation = {
    sheetByCorpusVersion: key.reduce((m, k) => ((m[k.corpusVersion] = (m[k.corpusVersion] || 0) + 1), m), {}),
    scoresV2extFilePresent: existsSync(resolve(base, "corpus", "scores-v2ext.jsonl")),
    v2extPartialScoresOnDisk: { ids: Object.keys(v2partial).length, coverSheetItems: key.filter((k) => k.corpusVersion === "v2ext" && v2partial[k.pairId] !== undefined).length },
    collections: res,
  };
}

// ── A7. Qwen's 25 abstentions: an exact (permutation) homogeneity test ───────
// The published χ² collapsed strata to df = 1 and could not be computed for
// tool; with 25 missing pairs in 1,066 the asymptotic test is not credible.
{
  const miss = pairs.map((p) => judgeScore("qwen_qwen3_6_27b")(p) === null);
  const strata = {
    category: pairs.map((p) => p.category), label: pairs.map((p) => p.label), tool: pairs.map((p) => p.tool),
    split: pairs.map((p) => p.split), generator: pairs.map((p) => String(p.generator ?? "none")),
  };
  const chi2 = (keys, m) => {
    const tot = m.filter(Boolean).length / m.length;
    const g = {};
    keys.forEach((k, i) => { g[k] ??= [0, 0]; g[k][m[i] ? 1 : 0]++; });
    let x = 0;
    for (const [a, b] of Object.values(g)) { const n = a + b, e1 = n * tot, e0 = n - e1; if (e1 > 0) x += (b - e1) ** 2 / e1; if (e0 > 0) x += (a - e0) ** 2 / e0; }
    return x;
  };
  const rng = mulberry32(SEED + 7), R = 20000;
  out.A7_missingness = { nMissing: miss.filter(Boolean).length, n: pairs.length, permutations: R, tests: {} };
  for (const [name, keys] of Object.entries(strata)) {
    const obs = chi2(keys, miss);
    let ge = 0;
    const m = [...miss];
    for (let r = 0; r < R; r++) {
      for (let i = m.length - 1; i > 0; i--) { const q = Math.floor(rng() * (i + 1)); [m[i], m[q]] = [m[q], m[i]]; }
      if (chi2(keys, m) >= obs - 1e-12) ge++;
    }
    out.A7_missingness.tests[name] = { chi2: obs, levels: new Set(keys).size, permutationP: (ge + 1) / (R + 1) };
  }
}

// ── A8. Cost, with the denominator fixed ─────────────────────────────────────
// judge_meta.json records token counts for the FINAL scoring session only
// (parse.pairsScored pairs), not for every pair ever scored; the earlier cost
// model divided those tokens by all scored pairs and understated per-comparison
// cost by roughly an order of magnitude.
{
  const jm = readJson("results/judge_meta.json");
  const rc = readJson("results/residual_calibration.json");
  const jur = rc.jurisdiction.test;
  const tightJur = rc.tightened[`${PRIMARY}_a0.05`].judgeJurisdiction;
  out.A8_cost = { note: "tokens per comparison measured over the final scoring session (batches of 10 pairs, system prompt amortised over the batch)", judges: {} };
  for (const [k, m] of Object.entries(jm.models)) {
    const n = m.parse.pairsScored;
    const tpc = (m.inputTokens + m.outputTokens) / n;
    out.A8_cost.judges[k] = {
      sessionPairs: n, sessionCalls: m.calls, inputTokens: m.inputTokens, outputTokens: m.outputTokens,
      tokensPerComparison: tpc, meanCallLatencyMs: m.meanCallLatencyMs,
      judgeCallsPer1000Declared: Math.round(1000 * jur.residual.value),
      tokensPer1000DispatchesDeclared: Math.round(1000 * jur.residual.value * tpc),
      judgeCallsPer1000Tightened: Math.round(1000 * tightJur.value),
      tokensPer1000DispatchesTightened: Math.round(1000 * tightJur.value * tpc),
    };
  }
}

// ── A9. Do the judges err on the same pairs? ─────────────────────────────────
{
  const ws = {}, silent = {};
  for (const j of JUDGES) {
    const r = evalCfg({ score: judgeScore(j) });
    ws[j] = test.filter((p) => p.label === "DIFF" && r.dec(p) === "SUPPRESS").map((p) => p.id);
    silent[j] = test.filter((p) => p.label === "SAME" && r.dec(p) === "EXECUTE").map((p) => p.id);
  }
  const inter = (a, b) => a.filter((x) => b.includes(x));
  out.A9_errorOverlap = {
    wrongSuppressions: ws,
    wsPairwiseOverlap: { "120b|20b": inter(ws[JUDGES[0]], ws[JUDGES[1]]).length, "120b|qwen": inter(ws[JUDGES[0]], ws[JUDGES[2]]).length, "20b|qwen": inter(ws[JUDGES[1]], ws[JUDGES[2]]).length },
    wsUnion: [...new Set(Object.values(ws).flat())].length,
    silentEscapePairwiseOverlap: { "120b|20b": inter(silent[JUDGES[0]], silent[JUDGES[1]]).length, "120b|qwen": inter(silent[JUDGES[0]], silent[JUDGES[2]]).length, "20b|qwen": inter(silent[JUDGES[1]], silent[JUDGES[2]]).length },
    silentCounts: Object.fromEntries(Object.entries(silent).map(([k, v]) => [k, v.length])),
  };
}

// ── A10. Per-category decisions, every judge (hardened, α = 0.05) ────────────
out.A10_perCategory = {};
for (const j of JUDGES) {
  const r = evalCfg({ score: judgeScore(j) });
  const per = {};
  for (const c of [...new Set(test.map((p) => p.category))].sort()) {
    const set = test.filter((p) => p.category === c);
    per[c] = { label: set[0].label, n: set.length, suppress: rate(set.filter((p) => r.dec(p) === "SUPPRESS").length, set.length), escalate: rate(set.filter((p) => r.dec(p) === "ESCALATE").length, set.length), execute: rate(set.filter((p) => r.dec(p) === "EXECUTE").length, set.length) };
  }
  out.A10_perCategory[j] = per;
}

// ── A11. Crash/replay: where the suppressions fired ──────────────────────────
{
  const cr = readJson("results/crash_replay_v2.json");
  const layers = {};
  let total = 0;
  for (const t of cr.trials) {
    for (const l of t.modes.semantic.suppressionLayers ?? []) { layers[`${t.arm}|${l}`] = (layers[`${t.arm}|${l}`] || 0) + 1; total++; }
  }
  const distinctScores = cr.trials.filter((t) => t.arm === "distinct").flatMap((t) => t.modes.semantic.judgeScores ?? []);
  out.A11_crash = {
    thresholds: cr.thresholds, suppressionsByArmAndLayer: layers, totalSuppressions: total,
    distinctArmJudgeScores: summary(distinctScores.filter((s) => typeof s === "number")),
  };
}

// ── A12. Judge admission: recorded diagnostics and a direct AUC recompute ────
{
  const am = readJson("results/attack_matrix_v1.json");
  out.A12_admission = {};
  for (const [k, v] of Object.entries(am.admission)) {
    const sc = judgeScore(k);
    const scored = pairs.filter((p) => sc(p) !== null);
    const nonL0 = scored.filter((p) => !p.l0);
    const resid = scored.filter((p) => p.res && p.split !== "attack");
    out.A12_admission[k] = {
      admitted: v.admitted, reasons: v.reasons, coverage: v.diagnostics?.coverage?.value, recordedAuc: v.diagnostics?.auc,
      distinctValues: v.diagnostics?.distinctValues,
      aucAllScored: auc(scored.filter((p) => p.label === "SAME").map(sc), scored.filter((p) => p.label === "DIFF").map(sc)),
      aucNonL0: auc(nonL0.filter((p) => p.label === "SAME").map(sc), nonL0.filter((p) => p.label === "DIFF").map(sc)),
      aucResidualBenign: auc(resid.filter((p) => p.label === "SAME").map(sc), resid.filter((p) => p.label === "DIFF").map(sc)),
    };
  }
}

// ── A13. Self-recognition check under the jurisdiction-matched pool ─────────
// The earlier cross-generator table was computed under the mismatched pool
// (t_hi = 0.2 for the primary judge), where every arm is deduplicated almost
// completely and a difference between arms could not show.
{
  out.A13_crossGenerator = {};
  const gens = [...new Set(test.filter((p) => p.label === "SAME" && p.generator).map((p) => p.generator))];
  for (const j of JUDGES) {
    const r = evalCfg({ score: judgeScore(j) });
    const row = {};
    for (const g of gens) {
      const set = test.filter((p) => p.label === "SAME" && p.generator === g);
      const s2 = set.filter((p) => p.category === "S2_paraphrase");
      row[g] = {
        n: set.length, dedup: rate(set.filter((p) => r.dec(p) === "SUPPRESS").length, set.length),
        nS2: s2.length, dedupS2: rate(s2.filter((p) => r.dec(p) === "SUPPRESS").length, s2.length),
      };
    }
    out.A13_crossGenerator[j] = row;
  }
}

writeFileSync(resolve(base, "results", "aij_analyses.json"), JSON.stringify(strip(out), null, 2));
{
  const f13 = (r) => `${(100 * r.value).toFixed(1)}% (${r.successes}/${r.n}) [${(100 * r.ci95.lo).toFixed(1)}-${(100 * r.ci95.hi).toFixed(1)}]`;
  for (const [j, row] of Object.entries(out.A13_crossGenerator)) {
    console.log(`A13 ${j}: ` + Object.entries(row).map(([g, v]) => `${g}: ${f13(v.dedup)} | S2 ${f13(v.dedupS2)}`).join(" || "));
  }
}

// ── console digest ───────────────────────────────────────────────────────────
const pct = (r) => (r && r.value !== undefined ? `${(100 * r.value).toFixed(1)}% (${r.successes}/${r.n})` : String(r));
console.log(`A0 reproduction of residualCalibration.js: ${out.A0_reproduction.allOk ? "OK" : "FAILED"}`);
for (const j of JUDGES) {
  const b = out.A1_band[j];
  console.log(`A1 ${j}: tHi=${b.tHi} tLo=${b.tLo} bandEmpty=${b.bandEmpty} | resSAME=${b.residualTestSame} supp=${b.sameSuppressed} tiedAtTHi=${b.sameTiedAtTHi} inBand=${b.sameInBand} (ties ${b.sameBandTies}) silent=${b.sameSilent} (ties ${b.sameSilentTies}) | extremes SAME ${pct(b.extremesAllNonL0.same)} DIFF ${pct(b.extremesAllNonL0.diff)} | distinct values ${b.distinctValues} | medians ${b.medians.sameNonL0}/${b.medians.diffNonL0}`);
}
for (const j of JUDGES) {
  const b = out.A5_refinement[j];
  const s = b.sizeOnlyCounterfactual;
  console.log(`A5 ${j}: decl n=${b.declared.poolN} tHi=${b.declared.tHi} rank ${b.declared.rankFromTop} dedup ${pct(b.declared.dedup)} | tight n=${b.tightened.poolN} tHi=${b.tightened.tHi} rank ${b.tightened.rankFromTop} dedup ${pct(b.tightened.dedup)} WS ${pct(b.tightened.ws)}`);
  console.log(`   removed n=${b.removedByRefinement.n} median ${b.removedByRefinement.medianScore} share>=0.8 ${b.removedByRefinement.shareAtOrAbove08?.toFixed(3)} | retained median ${b.retained.medianScore} share>=0.8 ${b.retained.shareAtOrAbove08?.toFixed(3)}`);
  console.log(`   size-only: tHi median ${s.tHi.median} [${s.tHi.p05}, ${s.tHi.p95}] | dedup mean ${(100 * s.dedupTightenedConfig.mean).toFixed(1)}% median ${(100 * s.dedupTightenedConfig.median).toFixed(1)}% [${(100 * s.dedupTightenedConfig.p05).toFixed(1)}, ${(100 * s.dedupTightenedConfig.p95).toFixed(1)}] | P(size-only dedup <= observed) = ${s.shareDedupAtOrBelowObserved.toFixed(3)}`);
}
for (const [name, c] of Object.entries(out.A6_annotation.collections)) {
  console.log(`A6 [${name}] full=${c.nFullyAnnotated} byVersion ${JSON.stringify(c.fullyAnnotatedByVersion)} withScore=${c.fullyAnnotatedWithPrimaryScore} vsPublished=${JSON.stringify(c.vsPublished)}`);
  console.log(`   flips ${JSON.stringify(c.flipSummary)} | denominator ${JSON.stringify(c.denominator)}`);
  for (const [lab, v] of Object.entries(c.rederivationAsExecuted)) console.log(`   asExecuted ${lab}: tHi=${v.tHi} n=${v.nCalDiff} WS ${pct(v.overall.wrongSuppression)} dedup ${pct(v.overall.dedup)} reachedJudgeWithNoScore=${v.reachedJudgeWithNoScore}`);
  for (const [lab, v] of Object.entries(c.rederivationScoredOnly)) console.log(`   scoredOnly ${lab}: tHi=${v.tHi} items=${v.nItems} (excluded ${v.nExcludedUnscored}) S/D ${v.nSame}/${v.nDiff} WS ${pct(v.wrongSuppression)} benign ${pct(v.wrongSuppressionBenign)} attack ${pct(v.wrongSuppressionAttackSplit)} dedup ${pct(v.dedup)} :: ${v.wsItems.join(", ")}`);
}
console.log(`A6 sheet ${JSON.stringify(out.A6_annotation.sheetByCorpusVersion)} v2partial ${JSON.stringify(out.A6_annotation.v2extPartialScoresOnDisk)}`);
for (const [k, v] of Object.entries(out.A7_missingness.tests)) console.log(`A7 ${k}: chi2=${v.chi2.toFixed(2)} levels=${v.levels} permutation p=${v.permutationP.toFixed(3)}`);
for (const [k, v] of Object.entries(out.A12_admission)) console.log(`A12 ${k}: admitted=${v.admitted} recordedAuc=${v.recordedAuc?.toFixed(4)} aucAll=${v.aucAllScored?.toFixed(4)} aucNonL0=${v.aucNonL0?.toFixed(4)} aucResidual=${v.aucResidualBenign?.toFixed(4)} values=${v.distinctValues}`);
console.log("wrote results/aij_analyses.json");
