#!/usr/bin/env node
/**
 * Scoring-context stability (TMLR revision).
 *
 * The multi-candidate run found that re-scoring corpus pairs in a different
 * batch context at temperature 0 changes most scores slightly and doubled
 * m = 1 wrong suppression on the residual (4 -> 8 of 144). A6 asks the pool to
 * be exchangeable with the deployed comparisons; if the judge's output depends
 * on batch context, the pool and the deployed scores must come from the SAME
 * scoring context. This experiment tests exactly that.
 *
 *   node src/experiments/scoringStability.js --score [--retry-abstentions]
 *   node src/experiments/scoringStability.js --evaluate   -> results/scoring_stability.json
 *
 * Scoring: every residual pair of corpus v1 (calibration and test, both labels)
 * is scored once more by the primary judge, in batches of ten drawn from ONE
 * seeded shuffle of all of them together, so calibration and test pairs share a
 * scoring context. Evaluation compares, for the deployed configuration at
 * alpha = 0.05:
 *   matched-persisted   pool and test from the original scoring (the paper's headline)
 *   matched-fresh       pool and test both from the new scoring
 *   mismatched          pool from the original scoring, test from the new one
 *   mismatched-reverse  pool from the new scoring, test from the original one
 * plus score agreement between the two scorings and, where available, a third
 * scoring of the test pairs (the multi-candidate run's fresh partner scores).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../tools.js";
import { classifyPair } from "../evaluate.js";
import { suppressionThreshold, escalationFloor, decide } from "../conformal.js";
import { rate } from "../stats.js";
import { canonicalize, canonicalString } from "../canonicalize.js";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CFG = JSON.parse(readFileSync(resolve(base, "repro.config.json"), "utf8")).scoringStability;
if (!CFG) throw new Error("repro.config.json has no scoringStability record");
const { seed: SEED, judge: JUDGE, judgeKey: JKEY, batchSize: BATCH, alpha: ALPHA, gamma: GAMMA } = CFG;
const SCORES = resolve(base, CFG.scoresFile);
const OUT = resolve(base, CFG.output);

const readJsonl = (f) => readFileSync(resolve(base, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pairs = readJsonl("corpus/pairs.jsonl").filter((p) => p.split === "cal" || p.split === "test");
for (const p of pairs) p.facts = classifyPair(p, TOOLS, "declared");
const residual = pairs.filter((p) => p.facts.residual);
const persisted = new Map(readJsonl("corpus/scores.jsonl").map((r) => [r.id, r.judges?.[JKEY] ?? null]));

// One shuffle of calibration and test together: they share a scoring context.
const order = [...residual];
{ const rng = mulberry32(SEED); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; } }

async function score() {
  const { GroqClient } = await import("../groq.js");
  const { judgeScores, newJudgeDiagnostics } = await import("../judge.js");
  const cached = existsSync(SCORES) ? JSON.parse(readFileSync(SCORES, "utf8")) : { scores: {}, meta: {} };
  const scores = cached.scores;
  const retry = process.argv.includes("--retry-abstentions");
  const todo = order.filter((p) => scores[p.id] === undefined || (retry && scores[p.id] === null));
  process.stdout.write(`${todo.length} residual pairs to score with ${JUDGE} (${Object.keys(scores).length} cached)\n`);
  const client = new GroqClient({ model: JUDGE });
  const diag = newJudgeDiagnostics();
  let dead = 0;
  for (let start = 0; start < todo.length; start += BATCH) {
    const batch = todo.slice(start, start + BATCH).map((p) => ({ id: p.id, tool: p.tool, a: p.a, b: p.b }));
    const before = diag.transportFailures;
    const s = await judgeScores(client, batch, { batchSize: BATCH, diagnostics: diag });
    if (s.every((v) => v === null) && diag.transportFailures > before && dead < 6) {
      dead += 1;
      const waitMs = Math.min(120_000, 5_000 * 2 ** (dead - 1));
      process.stdout.write(`  ! batch at ${start} failed on transport — waiting ${waitMs / 1000}s\n`);
      await new Promise((r) => setTimeout(r, waitMs));
      start -= BATCH;
      continue;
    }
    dead = 0;
    batch.forEach((p, i) => { scores[p.id] = s[i]; });
    const meta = {
      judge: JUDGE, batchSize: BATCH, temperature: 0, seed: SEED, lastRun: new Date().toISOString().slice(0, 10),
      scored: Object.keys(scores).length,
      inputTokens: (cached.meta.inputTokens ?? 0) + client.stats.inputTokens,
      outputTokens: (cached.meta.outputTokens ?? 0) + client.stats.outputTokens,
    };
    writeFileSync(SCORES, JSON.stringify({ meta, scores }, null, 2));
    process.stdout.write(`  ${Math.min(start + BATCH, todo.length)}/${todo.length}  abstentions=${diag.abstentions}\n`);
  }
}

function evaluate() {
  const { scores: fresh, meta } = JSON.parse(readFileSync(SCORES, "utf8"));
  const missing = residual.filter((p) => fresh[p.id] === undefined).length;
  if (missing) throw new Error(`${missing} residual pairs not yet scored — finish --score first`);
  const persistedOf = (p) => persisted.get(p.id) ?? null;
  const freshOf = (p) => (fresh[p.id] === undefined ? null : fresh[p.id]);
  const cal = residual.filter((p) => p.split === "cal");
  const test = residual.filter((p) => p.split === "test");
  const testDiff = test.filter((p) => p.label === "DIFF"), testSame = test.filter((p) => p.label === "SAME");

  const calibrateOn = (scoreOf) => {
    const pool = cal.filter((p) => p.label === "DIFF").map(scoreOf).filter((v) => v !== null);
    const same = cal.filter((p) => p.label === "SAME").map(scoreOf).filter((v) => v !== null);
    const tHi = suppressionThreshold(pool, ALPHA);
    const tLo = Math.min(escalationFloor(same.length ? same : [0.5], GAMMA), tHi);
    return { tHi, tLo, poolN: pool.length };
  };
  const measure = (cal, scoreOf) => {
    const d = (p) => { const s = scoreOf(p); return s === null ? "ESCALATE" : decide(s, cal.tHi, cal.tLo); };
    return {
      tHi: cal.tHi === Infinity ? "Infinity" : cal.tHi, poolN: cal.poolN,
      residualWrongSuppression: rate(testDiff.filter((p) => d(p) === "SUPPRESS").length, testDiff.length),
      residualDedup: rate(testSame.filter((p) => d(p) === "SUPPRESS").length, testSame.length),
    };
  };
  const cP = calibrateOn(persistedOf), cF = calibrateOn(freshOf);
  const conditions = {
    matchedPersisted: measure(cP, persistedOf),
    matchedFresh: measure(cF, freshOf),
    mismatched: measure(cP, freshOf),
    mismatchedReverse: measure(cF, persistedOf),
  };

  // Agreement between scorings.
  const agree = (xs, a, b) => {
    const both = xs.map((p) => [a(p), b(p)]).filter(([x, y]) => x !== null && y !== null);
    return {
      n: both.length,
      identical: rate(both.filter(([x, y]) => x === y).length, both.length),
      largeChange: rate(both.filter(([x, y]) => Math.abs(x - y) >= 0.2).length, both.length),
      meanSignedDiff: both.reduce((s, [x, y]) => s + (x - y), 0) / Math.max(1, both.length),
    };
  };
  const agreement = { freshVsPersisted: agree(residual, freshOf, persistedOf) };

  // Third scoring of the test pairs, if the multi-candidate run exists.
  const mclPath = resolve(base, "corpus", "multi-candidate-live-scores.json");
  const unitsPath = resolve(base, "corpus", "multi-candidate-live-units.json");
  if (existsSync(mclPath) && existsSync(unitsPath)) {
    const mcl = JSON.parse(readFileSync(mclPath, "utf8")).scores;
    const units = JSON.parse(readFileSync(unitsPath, "utf8")).units;
    const third = new Map(units.map((u) => [u.sourcePair,
      mcl[`${u.tool}||${u.candidates[0].node}||${canonicalString(canonicalize(u.dispatch, TOOLS[u.tool]))}`] ?? null]));
    const thirdOf = (p) => third.get(p.id) ?? null;
    agreement.freshVsMultiCandidateRun = agree(test, freshOf, thirdOf);
    agreement.persistedVsMultiCandidateRun = agree(test, persistedOf, thirdOf);
    const covered = test.filter((p) => thirdOf(p) !== null);
    if (covered.length === test.length) conditions.mismatchedThirdScoring = measure(cP, thirdOf);
  }

  const out = { generatedAt: new Date().toISOString(), judge: JUDGE, alpha: ALPHA, scoringMeta: meta,
    nResidual: residual.length, nCal: cal.length, nTest: test.length, conditions, agreement };
  writeFileSync(OUT, JSON.stringify(out, (k, v) => (v === Infinity ? "Infinity" : v), 2));
  const f = (x) => `${(100 * x.value).toFixed(1)}% [${(100 * x.ci95.lo).toFixed(1)}–${(100 * x.ci95.hi).toFixed(1)}] (${x.successes}/${x.n})`;
  for (const [k, v] of Object.entries(conditions)) console.log(`${k.padEnd(24)} t_hi=${v.tHi} n=${v.poolN}  WS ${f(v.residualWrongSuppression)}  dedup ${f(v.residualDedup)}`);
  for (const [k, v] of Object.entries(agreement)) console.log(`${k.padEnd(32)} identical ${f(v.identical)}  |Δ|≥0.2 ${f(v.largeChange)}  mean Δ ${v.meanSignedDiff.toFixed(3)}`);
  console.log(`wrote ${CFG.output}`);
}

console.log(`residual pairs: ${residual.length} (cal ${residual.filter((p) => p.split === "cal").length}, test ${residual.filter((p) => p.split === "test").length}); ~${Math.round(residual.length * 184).toLocaleString("en-US")} tokens`);
if (process.argv.includes("--score")) await score();
else if (process.argv.includes("--evaluate")) evaluate();
else console.log("no model calls made. --score to score, --evaluate to analyse.");
