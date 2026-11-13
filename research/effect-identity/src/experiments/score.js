import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GroqClient, groqAvailable, JUDGE_MODELS, DEFAULT_JUDGE } from "../groq.js";
import { judgeScores, lexicalScores, judgeKey, newJudgeDiagnostics } from "../judge.js";
import { TOOLS } from "../tools.js";

/**
 * Score every corpus pair with (a) each LLM judge (Groq, temperature 0,
 * batched) and (b) the deterministic lexical scorer. Scores are persisted so
 * all downstream experiments and ablations are pure offline recomputation.
 *
 * Multiple judges, spanning independent model families, are scored rather than
 * one: a single judge's idiosyncrasies would otherwise be indistinguishable
 * from properties of the mechanism, and the paper's own limitation about
 * overconfident judges can only be examined by comparing judges that differ in
 * how they express uncertainty.
 *
 * Scoring is RESUMABLE at batch granularity. A full pass is tens of thousands
 * of tokens against a per-minute quota, so a run can take hours and will be
 * interrupted; without per-batch checkpoints an interruption discards
 * everything and the artifact is unreproducible for anyone on a rate-limited
 * key. Partial scores live in results/partial-<judge>.json and are reused on
 * the next run, so re-invoking this script always makes forward progress.
 *
 *   node src/experiments/score.js [--judges a,b,c] [--batch N] [--offline] [--fresh]
 */

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..", "..");
const partialPath = (model) => resolve(base, "results", `partial-${judgeKey(model)}.json`);
const progressPath = resolve(base, "results", "scoring-progress.json");

const argAfter = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const BATCH = Number(argAfter("--batch", "10"));
const FRESH = process.argv.includes("--fresh");
// An abstention is a recorded outcome, not a gap: by default a resumed run does
// NOT re-ask pairs the judge already declined under the strict contract, so the
// abstention rate a run reports is the rate that run measured.
const RETRY_ABSTENTIONS = process.argv.includes("--retry-abstentions");

function loadPairs() {
  return readFileSync(resolve(base, "corpus", "pairs.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function readJudges() {
  const v = argAfter("--judges", null);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : Object.keys(JUDGE_MODELS);
}

const loadPartial = (model) => {
  if (FRESH || !existsSync(partialPath(model))) return {};
  try {
    return JSON.parse(readFileSync(partialPath(model), "utf8")).scores ?? {};
  } catch {
    return {};
  }
};

// Seeded shuffle so batches mix categories (avoids within-batch label runs).
let seed = 7;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

/**
 * Score one model over the pairs it has not already been scored on, saving
 * after every batch.
 */
async function scoreModel(model, shuffled) {
  const scores = loadPartial(model);
  const todo = shuffled.filter((p) =>
    scores[p.id] === undefined || (RETRY_ABSTENTIONS && scores[p.id] === null));
  const client = new GroqClient({ model });
  const diag = newJudgeDiagnostics();
  const t0 = Date.now();

  if (todo.length === 0) {
    process.stdout.write(`  [${model}] already complete (${Object.keys(scores).length} pairs)\n`);
    return { scores, meta: null, client };
  }
  process.stdout.write(`  [${model}] ${todo.length} pairs to score (${Object.keys(scores).length} cached)\n`);

  // A sustained provider outage looks, from inside one batch, like an ordinary
  // exhausted retry budget: judgeScores() gives up after its own maxAttempts
  // and returns all-null within seconds. Left unchecked, a script can burn
  // through hundreds of pairs during an outage that would have cleared in a
  // minute, recording "abstained" for pairs the judge was never actually asked
  // to answer under working conditions. This outer loop detects a run of
  // fully-failed batches and backs off before re-trying the SAME batch, rather
  // than converting an outage into abstentions. (Discovered when a v1 qwen
  // resume run reported a clean "955/955" completion line while 473 of the
  // remaining 485 pairs had in fact all failed on transport in one stretch —
  // the progress line counts attempted pairs, not answered ones.)
  let consecutiveDead = 0;
  for (let start = 0; start < todo.length; start += BATCH) {
    const batch = todo.slice(start, start + BATCH);
    // Scores may be null: an ABSTENTION, meaning the judge never returned an
    // admissible value for this pair under the strict contract. Persisted as
    // null rather than imputed, so downstream code has to decide what to do
    // with "no answer" instead of silently inheriting a fabricated 0.5.
    const before = diag.transportFailures;
    const batchScores = await judgeScores(client, batch, { batchSize: BATCH, diagnostics: diag });
    const allNull = batchScores.every((v) => v === null);
    const hadTransport = diag.transportFailures > before;
    if (allNull && hadTransport && consecutiveDead < 6) {
      consecutiveDead += 1;
      const waitMs = Math.min(120_000, 5_000 * 2 ** (consecutiveDead - 1));
      process.stdout.write(`  [${model}] ! batch at ${start} failed on transport (${consecutiveDead} in a row) — waiting ${waitMs / 1000}s and retrying it\n`);
      await new Promise((r) => setTimeout(r, waitMs));
      start -= BATCH;
      continue;
    }
    consecutiveDead = 0;
    batch.forEach((p, i) => { scores[p.id] = batchScores[i]; });

    // `Object.keys(scores).length` counts every pair ever ATTEMPTED, including
    // ones that resolved to `null` (abstention) — on a `--retry-abstentions`
    // resume, most of `scores`'s keys already exist as null from the run being
    // resumed, so that count reads "955/955 (100.0%)" after the very first
    // batch, long before 955 pairs have actually been re-asked. `answered`
    // counts only pairs that hold a real score right now, which is the number
    // a reader watching the log actually wants.
    const attempted = Object.keys(scores).length;
    const answered = Object.values(scores).filter((v) => typeof v === "number").length;
    writeFileSync(partialPath(model), JSON.stringify({ model, updatedAt: new Date().toISOString(), diagnostics: diag, scores }, null, 2));
    writeFileSync(progressPath, JSON.stringify({
      model, attempted, answered, total: shuffled.length,
      pct: Number(((answered / shuffled.length) * 100).toFixed(1)),
      abstentions: diag.abstentions,
      batchesWithViolations: diag.batchesWithViolations,
      probabilityScaleBatches: diag.probabilityScaleBatches,
      elapsedSec: Math.round((Date.now() - t0) / 1000),
      updatedAt: new Date().toISOString(),
    }, null, 2));
    process.stdout.write(`  [${model}] ${answered}/${shuffled.length} answered (${((answered / shuffled.length) * 100).toFixed(1)}%), ${attempted} attempted — abstain=${diag.abstentions} badBatches=${diag.batchesWithViolations}\n`);
  }

  return {
    scores,
    meta: {
      model,
      family: JUDGE_MODELS[model]?.family ?? "unknown",
      calls: client.stats.calls,
      inputTokens: client.stats.inputTokens,
      outputTokens: client.stats.outputTokens,
      meanCallLatencyMs: Math.round(client.stats.totalLatencyMs / Math.max(1, client.stats.calls)),
      wallClockMs: Date.now() - t0,
      batchSize: BATCH,
      // The full parse audit: how often the judge answered, answered in a form
      // the contract does not admit, or did not answer at all. The evaluation
      // this replaces reported a 0% failure rate while 23.1% of its stored
      // scores were mis-scaled, because the only thing it counted was whether
      // the JSON envelope arrived.
      parse: diag,
      abstentions: Object.values(scores).filter((s) => s === null).length,
      scoredPairs: Object.values(scores).filter((s) => s !== null && s !== undefined).length,
    },
    client,
  };
}

/**
 * Judges scored in an EARLIER invocation, recovered from their partial files.
 *
 * scores.jsonl is rewritten wholesale on every persist, so building it from
 * this run's judges alone silently deletes the columns of every judge not named
 * in `--judges` — one resumed run for a single failed judge would discard a
 * completed judge's scores and quietly turn a three-judge comparison back into
 * a one-judge result. The partial files are the durable record; read them.
 */
function loadAllPartials(activeModels) {
  const out = {};
  for (const model of Object.keys(JUDGE_MODELS)) {
    if (activeModels.includes(model)) continue; // this run supplies these
    const path = partialPath(model);
    if (!existsSync(path)) continue;
    try {
      const scores = JSON.parse(readFileSync(path, "utf8")).scores ?? {};
      if (Object.keys(scores).length > 0) out[model] = scores;
    } catch { /* unreadable partial — treat as absent */ }
  }
  return out;
}

function persist(shuffled, byModel, lexical, meta) {
  const merged = { ...loadAllPartials(Object.keys(byModel)), ...byModel };
  const rows = shuffled.map((p, i) => {
    const row = { id: p.id, lexical: lexical[i], judges: {} };
    for (const [model, scores] of Object.entries(merged)) {
      const v = scores[p.id];
      // `null` (abstention) is written out; only "never asked" is omitted.
      if (v !== undefined) row.judges[judgeKey(model)] = v;
    }
    // `judge` remains the primary-judge column so single-judge analyses and
    // the v1 comparison keep working unchanged.
    row.judge = row.judges[judgeKey(DEFAULT_JUDGE)] ?? null;
    return row;
  });
  rows.sort((a, b) => a.id.localeCompare(b.id));
  mkdirSync(resolve(base, "results"), { recursive: true });
  writeFileSync(resolve(base, "corpus", "scores.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  // MERGE judge metadata rather than replacing it. Each invocation only knows
  // about the judges it ran, so writing `meta` wholesale erases the call
  // counts, token totals and latencies of every judge scored in an earlier
  // pass — and the cost model in run.js then silently reports nulls for the
  // primary judge. A resumed or persist-only run must not destroy the
  // measurements of the run it is resuming.
  const metaPath = resolve(base, "results", "judge_meta.json");
  let mergedMeta = meta;
  if (existsSync(metaPath)) {
    try {
      const prev = JSON.parse(readFileSync(metaPath, "utf8"));
      mergedMeta = { ...prev, ...meta, models: { ...(prev.models ?? {}), ...(meta.models ?? {}) } };
    } catch { /* unreadable — fall back to this run's meta */ }
  }
  writeFileSync(metaPath, JSON.stringify(mergedMeta, null, 2));
}

async function main() {
  const pairs = loadPairs();
  const order = pairs.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const shuffled = order.map((i) => pairs[i]);
  const lexical = await lexicalScores(shuffled, TOOLS);

  const judges = readJudges();
  const byModel = {};
  const meta = { generatedAt: new Date().toISOString(), pairs: pairs.length, batchSize: BATCH, models: {} };

  if (!groqAvailable() || process.argv.includes("--offline")) {
    process.stdout.write("No Groq key or --offline: judge scores omitted.\n");
    persist(shuffled, byModel, lexical, meta);
    return;
  }

  // Rebuild scores.jsonl from the per-batch partials without calling any model.
  // scores.jsonl is only rewritten when a judge FINISHES, so a pass stopped by
  // an exhausted daily quota strands every score it did obtain in the partial
  // file, and the downstream analysis silently reads the older, smaller set.
  // The partials are the durable record; this republishes them.
  if (process.argv.includes("--persist-only")) {
    const merged = loadAllPartials([]);
    persist(shuffled, merged, lexical, meta);
    for (const [model, scores] of Object.entries(merged)) {
      const vals = Object.values(scores);
      process.stdout.write(
        `  ${judgeKey(model).padEnd(28)} scored=${vals.filter((v) => typeof v === "number").length} ` +
        `abstained=${vals.filter((v) => v === null).length} of ${vals.length}\n`
      );
    }
    process.stdout.write("scores.jsonl rebuilt from partials (no model calls).\n");
    return;
  }

  for (const model of judges) {
    process.stdout.write(`\nScoring ${pairs.length} pairs with ${model}...\n`);
    const { scores, meta: m } = await scoreModel(model, shuffled);
    byModel[model] = scores;
    if (m) meta.models[judgeKey(model)] = m;
    persist(shuffled, byModel, lexical, meta); // checkpoint per judge
  }

  process.stdout.write(`\nScored ${pairs.length} pairs with ${judges.length} judges.\n`);
  for (const [k, m] of Object.entries(meta.models)) {
    const p = m.parse;
    process.stdout.write(
      `  ${k.padEnd(28)} calls=${m.calls} latency=${m.meanCallLatencyMs}ms ` +
      `scored=${m.scoredPairs} abstain=${m.abstentions} retries=${p.batchRetries} ` +
      `badBatches=${p.batchesWithViolations} probScale=${p.probabilityScaleBatches} ` +
      `nonInt=${p.byStatus.non_integer} oor=${p.byStatus.out_of_range} missing=${p.byStatus.missing}\n`
    );
  }
}

main().then(
  () => {
    // Undici's connection pool keeps the event loop alive past the last fetch.
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
