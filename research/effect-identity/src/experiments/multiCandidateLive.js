#!/usr/bin/env node
/**
 * Multiple committed candidates on an ADMITTED judge (AIJ revision, Phase 3).
 *
 * The corpus has m = 1: every pair compares one request with one committed
 * effect. Theorem 1 is about the maximum over m candidates, and until now the
 * only live test of it used a saturated 8B judge (two score values) on
 * purpose-built units. This experiment builds multi-candidate units from the
 * corpus itself and scores them with the primary judge.
 *
 *   node src/experiments/multiCandidateLive.js              build units + print the cost estimate (no model calls)
 *   node src/experiments/multiCandidateLive.js --score      score the comparisons (GPT-OSS-120B, batches of 10; resumable)
 *   node src/experiments/multiCandidateLive.js --evaluate   offline evaluation → results/multi_candidate_live.json
 *
 * ── Units ────────────────────────────────────────────────────────────────────
 * One unit per held-out residual TEST pair of the corpus (both decidable layers
 * decline it, so it is in the judge's jurisdiction). The dispatch x is the
 * pair's `b`; candidate 1 is the pair's `a` — the true match for a duplicate
 * unit, a labelled distinct act for a distinct unit. Candidates 2..mMax are
 * drawn, with a seeded generator and without replacement, from the corpus
 * inputs of the same tool that
 *   (i)   share x's semantic projection (so the refuter passes them and they
 *         reach the judge, as in a deployment),
 *   (ii)  are not in x's act class (the union of SAME-labelled pairs), and
 *   (iii) are KNOWN distinct from x: they come from a different seed act (the
 *         corpus's seed acts are distinct requests by construction), or a
 *         DIFF-labelled pair links their act class to x's.
 * Nothing else is admitted as a distinct candidate; in particular two DIFF
 * variants of one seed are not assumed distinct from each other. Prefixes of
 * the candidate list give the nested sets m ∈ {1, 2, 5, 10}. A unit whose pool
 * is smaller than mMax − 1 is evaluated only at the m it can fill.
 *
 * ── Metrics (evaluate) ───────────────────────────────────────────────────────
 * Thresholds come from the jurisdiction-matched calibration pool of the main
 * corpus (the deployed configuration's pool): uncorrected t(α) against the
 * Bonferroni t(α/m). For each m: wrong suppression over distinct units,
 * deduplication and silent/flagged escape over duplicate units, and — at m ≥ 2 —
 * response-attribution error: a suppressed duplicate whose maximising
 * candidate is not its true match, so the fence returns another act's response
 * (Section 3.3 of the manuscript). Ties at the maximum are reported both ways.
 * A drift check compares the fresh score of each unit's corpus partner with
 * the persisted corpus score.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../tools.js";
import { canonicalize, canonicalString, semanticProjection } from "../canonicalize.js";
import { suppressionThreshold, maxSuppressionThreshold, maxCertifiableCandidates, decide } from "../conformal.js";
import { rate } from "../stats.js";
import { runConfig } from "../evaluate.js";
import { ALL_SEEDS } from "../corpus/seeds.js";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CFG = JSON.parse(readFileSync(resolve(base, "repro.config.json"), "utf8")).multiCandidateLive;
if (!CFG) throw new Error("repro.config.json has no multiCandidateLive record");
const { seed: SEED, mValues: M_VALUES, judge: JUDGE, judgeKey: JKEY, batchSize: BATCH, alpha: ALPHA, gamma: GAMMA } = CFG;
const M_MAX = Math.max(...M_VALUES);
const UNITS_PATH = resolve(base, CFG.unitsFile);
const SCORES_PATH = resolve(base, CFG.scoresFile);
const RESULTS_PATH = resolve(base, CFG.output);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash32 = (s) => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const readJsonl = (f) => readFileSync(resolve(base, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ── build ────────────────────────────────────────────────────────────────────
function buildUnits() {
  const pairs = readJsonl("corpus/pairs.jsonl").filter((p) => p.split !== "attack");
  const cs = (t, x) => canonicalString(canonicalize(x, TOOLS[t]));
  const pr = (t, x) => semanticProjection(x, TOOLS[t]);
  // Base family of a pair: the generator seed act it was derived from
  // (src/corpus/seeds.js ALL_SEEDS). S*, D1 and D4 pairs have that seed as `a`;
  // D2 pairs extend its text with a distinguishing token; D3 pairs are their
  // own hand-written families unless `a` is a seed. Base seeds are distinct
  // requests by construction (different customer, order, amount, recipient).
  const seedCanon = ALL_SEEDS.map((s) => ({ tool: s.tool, canon: cs(s.tool, s.input), input: s.input }));
  const familyOf = (p) => {
    const i = seedCanon.findIndex((s) => s.tool === p.tool && s.canon === cs(p.tool, p.a));
    if (i >= 0) return `seed${i}`;
    if (p.category.startsWith("D2")) {
      const j = seedCanon.findIndex((s) => s.tool === p.tool && pr(p.tool, s.input) === pr(p.tool, p.a) &&
        Object.values(s.input).filter((v) => typeof v === "string").every((v) => JSON.stringify(p.a).includes(v.split(" —")[0])));
      if (j >= 0) return `seed${j}`;
    }
    return `own:${p.id}`;
  };
  const seedKey = familyOf;

  // Nodes are canonical inputs; the first input seen is its representative.
  const nodes = new Map();
  const node = (t, x, s) => {
    const k = `${t}|${cs(t, x)}`;
    if (!nodes.has(k)) nodes.set(k, { key: k, tool: t, input: x, proj: pr(t, x), seeds: new Set() });
    nodes.get(k).seeds.add(s);
    return k;
  };
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
  const diffLinks = [];
  for (const p of pairs) {
    const s = seedKey(p), a = node(p.tool, p.a, s), b = node(p.tool, p.b, s);
    for (const k of [a, b]) if (!parent.has(k)) parent.set(k, k);
    if (p.label === "SAME") parent.set(find(a), find(b)); else diffLinks.push([a, b]);
  }
  const linked = new Set(diffLinks.flatMap(([a, b]) => [`${find(a)}>${find(b)}`, `${find(b)}>${find(a)}`]));
  const knownDistinct = (x, c) => {
    const X = nodes.get(x), C = nodes.get(c);
    if (X.tool !== C.tool || X.proj !== C.proj || find(x) === find(c)) return false;
    if ([...X.seeds].every((s) => !C.seeds.has(s))) return true;
    return linked.has(`${find(x)}>${find(c)}`);
  };

  const byTool = {};
  for (const k of nodes.keys()) (byTool[nodes.get(k).tool] ??= []).push(k);
  const residualTest = pairs.filter((p) => p.split === "test" && cs(p.tool, p.a) !== cs(p.tool, p.b) && pr(p.tool, p.a) === pr(p.tool, p.b));

  const units = [];
  for (const p of residualTest) {
    const x = `${p.tool}|${cs(p.tool, p.b)}`, first = `${p.tool}|${cs(p.tool, p.a)}`;
    const pool = byTool[p.tool].filter((c) => c !== x && c !== first && knownDistinct(x, c)).sort();
    const rng = mulberry32(SEED ^ hash32(p.id));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    // A commit log holds distinct acts (a duplicate would have been suppressed),
    // so the candidates must also be known distinct FROM EACH OTHER: greedy over
    // the shuffled pool, one act class at a time.
    const extra = [];
    for (const c of pool) {
      if (extra.length >= M_MAX - 1) break;
      if ([first, ...extra].every((d) => knownDistinct(c, d))) extra.push(c);
    }
    units.push({
      id: `MCL_${p.id}`, sourcePair: p.id, category: p.category, label: p.label, tool: p.tool,
      dispatch: p.b,
      candidates: [{ node: first, input: p.a, role: p.label === "SAME" ? "true-match" : "distinct" },
        ...extra.map((c) => ({ node: c, input: nodes.get(c).input, role: "distinct" }))],
      poolSize: pool.length,
      mAvailable: 1 + extra.length,
    });
  }
  return units;
}

const cmpKey = (u, c) => `${u.tool}||${c.node}||${canonicalString(canonicalize(u.dispatch, TOOLS[u.tool]))}`;
function comparisons(units) {
  const m = new Map();
  for (const u of units) for (const c of u.candidates) {
    const k = cmpKey(u, c);
    if (!m.has(k)) m.set(k, { id: k, tool: u.tool, a: c.input, b: u.dispatch });
  }
  return [...m.values()];
}

function estimate(units) {
  const aa = JSON.parse(readFileSync(resolve(base, "results", "aij_analyses.json"), "utf8"));
  const cost = aa.A8_cost.judges[JKEY];
  const cmps = comparisons(units);
  const calls = Math.ceil(cmps.length / BATCH);
  const tokens = Math.round(cmps.length * cost.tokensPerComparison);
  return {
    comparisons: cmps.length, batchSize: BATCH, calls,
    tokensPerComparison: cost.tokensPerComparison, tokens,
    meanCallLatencyMs: cost.meanCallLatencyMs,
    serialWallClockMinutes: +(calls * cost.meanCallLatencyMs / 60000).toFixed(1),
    source: "results/aij_analyses.json A8_cost (the primary judge's final scoring session, batches of ten)",
  };
}

// ── score ────────────────────────────────────────────────────────────────────
async function score(units) {
  const { GroqClient } = await import("../groq.js");
  const { judgeScores, newJudgeDiagnostics } = await import("../judge.js");
  const cached = existsSync(SCORES_PATH) ? JSON.parse(readFileSync(SCORES_PATH, "utf8")) : { scores: {}, meta: {} };
  const scores = cached.scores;
  // --retry-abstentions re-asks pairs stored as null. A null can be a genuine
  // abstention or the residue of a rate-limit outage that exhausted the
  // retries; re-asking is the only way to tell, and a pair that is still null
  // after it stays an abstention (never imputed).
  const retry = process.argv.includes("--retry-abstentions");
  const todo = comparisons(units).filter((c) => scores[c.id] === undefined || (retry && scores[c.id] === null));
  process.stdout.write(`${todo.length} comparisons to score with ${JUDGE} (${Object.keys(scores).length} cached)\n`);
  const client = new GroqClient({ model: JUDGE });
  const diag = newJudgeDiagnostics();
  const t0 = Date.now();
  let dead = 0;
  for (let start = 0; start < todo.length; start += BATCH) {
    const batch = todo.slice(start, start + BATCH);
    const before = diag.transportFailures;
    const s = await judgeScores(client, batch, { batchSize: BATCH, diagnostics: diag });
    // A provider outage must not be recorded as abstentions (see score.js).
    if (s.every((v) => v === null) && diag.transportFailures > before && dead < 6) {
      dead += 1;
      const waitMs = Math.min(120_000, 5_000 * 2 ** (dead - 1));
      process.stdout.write(`  ! batch at ${start} failed on transport — waiting ${waitMs / 1000}s\n`);
      await new Promise((r) => setTimeout(r, waitMs));
      start -= BATCH;
      continue;
    }
    dead = 0;
    batch.forEach((c, i) => { scores[c.id] = s[i]; });
    const meta = {
      judge: JUDGE, reachedOn: new Date().toISOString().slice(0, 10), batchSize: BATCH, temperature: 0,
      comparisons: Object.keys(scores).length, calls: client.stats.calls,
      inputTokens: (cached.meta.inputTokens ?? 0) + client.stats.inputTokens,
      outputTokens: (cached.meta.outputTokens ?? 0) + client.stats.outputTokens,
      meanCallLatencyMs: Math.round(client.stats.totalLatencyMs / Math.max(1, client.stats.calls)),
      wallClockMs: Date.now() - t0, parse: diag,
    };
    writeFileSync(SCORES_PATH, JSON.stringify({ meta, scores }, null, 2));
    process.stdout.write(`  ${Math.min(start + BATCH, todo.length)}/${todo.length}  abstentions=${diag.abstentions}\n`);
  }
}

// ── evaluate ─────────────────────────────────────────────────────────────────
function evaluate(units) {
  if (!existsSync(SCORES_PATH)) throw new Error(`${CFG.scoresFile} not present — run --score first`);
  const { scores, meta } = JSON.parse(readFileSync(SCORES_PATH, "utf8"));
  const sc = (u, c) => scores[cmpKey(u, c)] ?? null;

  // The deployed configuration's own pool and floor (jurisdiction-matched).
  const pairs = readJsonl("corpus/pairs.jsonl");
  const rows = new Map(readJsonl("corpus/scores.jsonl").map((r) => [r.id, r]));
  const corpusScore = (id) => { const v = rows.get(id)?.judges?.[JKEY]; return v === undefined ? null : v; };
  const run = runConfig({ pairs, schemas: TOOLS, cfg: {}, judge: JKEY, scoreOf: (p) => corpusScore(p.id), alpha: ALPHA, gamma: GAMMA });
  const pool = pairs.filter((p) => p.split === "cal" && p.label === "DIFF" && p.facts.residual).map((p) => corpusScore(p.id)).filter((v) => v !== null);
  const tLo = run.calibration.tLo;

  const out = {
    generatedAt: new Date().toISOString(), status: "COMPLETE", judge: JUDGE, judgeMeta: meta, alpha: ALPHA,
    calibration: { poolN: pool.length, certifiableM: maxCertifiableCandidates(pool.length, ALPHA), tLo, source: "residual DIFF calibration pairs of corpus v1 (the deployed configuration's pool)" },
    units: { total: units.length, diff: units.filter((u) => u.label === "DIFF").length, same: units.filter((u) => u.label === "SAME").length },
    byM: [],
  };

  // Drift: fresh score of the corpus partner against the persisted one.
  const drift = units.map((u) => [sc(u, u.candidates[0]), corpusScore(u.sourcePair)]).filter(([a, b]) => a !== null && b !== null);
  out.drift = { n: drift.length, identical: rate(drift.filter(([a, b]) => a === b).length, drift.length), meanAbsDiff: drift.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / Math.max(1, drift.length) };
  // Where the drift matters: distinct partners on either side of the deployed
  // m = 1 threshold, re-scored in a different batch context.
  {
    const tHi1 = suppressionThreshold(pool, ALPHA);
    const dd = units.filter((u) => u.label === "DIFF")
      .map((u) => [sc(u, u.candidates[0]), corpusScore(u.sourcePair)]).filter(([a, b]) => a !== null && b !== null);
    out.drift.largeChange = rate(drift.filter(([a, b]) => Math.abs(a - b) >= 0.2).length, drift.length);
    out.drift.meanSignedDiff = drift.reduce((s, [a, b]) => s + (a - b), 0) / Math.max(1, drift.length);
    out.drift.distinctAtM1 = {
      tHi: tHi1, n: dd.length,
      suppressedPersisted: rate(dd.filter(([, b]) => b > tHi1).length, dd.length),
      suppressedFresh: rate(dd.filter(([a]) => a > tHi1).length, dd.length),
      crossedUp: dd.filter(([a, b]) => b <= tHi1 && a > tHi1).length,
      crossedDown: dd.filter(([a, b]) => b > tHi1 && a <= tHi1).length,
    };
  }

  for (const m of M_VALUES) {
    const eligible = units.filter((u) => u.mAvailable >= m);
    const thr = { uncorrected: suppressionThreshold(pool, ALPHA), bonferroni: maxSuppressionThreshold(pool, ALPHA, m) };
    const row = { m, nDiffUnits: eligible.filter((u) => u.label === "DIFF").length, nSameUnits: eligible.filter((u) => u.label === "SAME").length, thresholds: {}, rules: {} };
    for (const [name, tHi] of Object.entries(thr)) {
      row.thresholds[name] = tHi === Infinity ? "Infinity" : tHi;
      const decideUnit = (u) => {
        const s = u.candidates.slice(0, m).map((c) => sc(u, c));
        const answered = s.filter((v) => v !== null);
        if (!answered.length) return { decision: "ESCALATE", s };
        return { decision: decide(Math.max(...answered), tHi, Math.min(tLo, tHi)), s, max: Math.max(...answered) };
      };
      const diffU = eligible.filter((u) => u.label === "DIFF"), sameU = eligible.filter((u) => u.label === "SAME");
      const dd = diffU.map(decideUnit), ds = sameU.map(decideUnit);
      const suppressedSame = ds.filter((d) => d.decision === "SUPPRESS");
      // Attribution: candidate 0 is the true match for a duplicate unit.
      // Ties as errors: some distinct candidate scores at least the match (or
      // the match abstained). Ties broken toward the match: some distinct
      // candidate scores strictly above it (or the match abstained).
      const strict = suppressedSame.filter((d) => d.s[0] === null || d.s.slice(1).some((v) => v !== null && v >= d.s[0])).length;
      const lenient = suppressedSame.filter((d) => d.s[0] === null || d.s.slice(1).some((v) => v !== null && v > d.s[0])).length;
      row.rules[name] = {
        wrongSuppression: rate(dd.filter((d) => d.decision === "SUPPRESS").length, dd.length),
        friction: rate(dd.filter((d) => d.decision === "ESCALATE").length, dd.length),
        dedup: rate(ds.filter((d) => d.decision === "SUPPRESS").length, ds.length),
        silentEscape: rate(ds.filter((d) => d.decision === "EXECUTE").length, ds.length),
        flaggedEscape: rate(ds.filter((d) => d.decision === "ESCALATE").length, ds.length),
        ...(m >= 2 ? {
          attributionErrorTiesAsErrors: rate(strict, suppressedSame.length),
          attributionErrorTiesBroken: rate(lenient, suppressedSame.length),
        } : {}),
      };
    }
    out.byM.push(row);
  }
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(out, (k, v) => (v === Infinity ? "Infinity" : v), 2));
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
const units = buildUnits();
writeFileSync(UNITS_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), seed: SEED, mValues: M_VALUES, units }, null, 2));
const est = estimate(units);
const count = (m, lab) => units.filter((u) => u.label === lab && u.mAvailable >= m).length;
console.log(`units: ${units.length} (${units.filter((u) => u.label === "DIFF").length} distinct, ${units.filter((u) => u.label === "SAME").length} duplicate) from the residual test split`);
for (const m of M_VALUES) console.log(`  m=${String(m).padStart(2)}: ${count(m, "DIFF")} distinct and ${count(m, "SAME")} duplicate units can fill it`);
console.log(`estimate: ${est.comparisons} comparisons → ${est.calls} calls of ${est.batchSize}; ~${est.tokens.toLocaleString("en-US")} tokens at ${est.tokensPerComparison.toFixed(1)} tokens/comparison; ~${est.serialWallClockMinutes} min serial at ${est.meanCallLatencyMs} ms/call`);
writeFileSync(resolve(base, "results", "multi_candidate_live_plan.json"), JSON.stringify({ generatedAt: new Date().toISOString(), config: CFG, estimate: est,
  eligibility: Object.fromEntries(M_VALUES.map((m) => [m, { diff: count(m, "DIFF"), same: count(m, "SAME") }])) }, null, 2));

if (process.argv.includes("--score")) {
  await score(units);
  console.log("scored; now run with --evaluate");
} else if (process.argv.includes("--evaluate")) {
  const r = evaluate(units);
  const f = (x) => (x && x.ci95 ? `${(100 * x.value).toFixed(1)}% [${(100 * x.ci95.lo).toFixed(1)}–${(100 * x.ci95.hi).toFixed(1)}] (${x.successes}/${x.n})` : x ? `n/a (${x.successes}/${x.n})` : "—");
  console.log(`pool n=${r.calibration.poolN}, certifiable m ≤ ${r.calibration.certifiableM}; drift identical ${f(r.drift.identical)}`);
  for (const row of r.byM) for (const [k, v] of Object.entries(row.rules)) {
    console.log(`m=${row.m} ${k.padEnd(11)} t=${row.thresholds[k]}  WS ${f(v.wrongSuppression)}  dedup ${f(v.dedup)}  attrib ${f(v.attributionErrorTiesAsErrors)}`);
  }
  console.log(`wrote ${CFG.output}`);
} else {
  console.log("\nno model calls made. To score:  node src/experiments/multiCandidateLive.js --score   then   --evaluate");
}
