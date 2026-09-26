#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { GroqClient, groqAvailable, JUDGE_MODELS } from "../groq.js";
import { judgeScores, lexicalScores, newJudgeDiagnostics, judgeKey } from "../judge.js";
import { TOOLS_V2, MISDECLARED_SCHEMA } from "../toolsV2.js";
import { LEVEL_SCHEMAS } from "../corpus/schemaLevels.js";

/**
 * Generic scorer for the v2 corpora.
 *
 * `score.js` is bound to `corpus/pairs.jsonl` and the v1 tool table, which is
 * correct for the frozen v1 record and useless for the extension, the ladder,
 * and any later corpus. This one takes the pair file and the schema table as
 * arguments and is otherwise the same contract: strict parsing, abstentions
 * recorded as null rather than imputed, per-batch checkpointing so an
 * interrupted pass loses nothing, and diagnostics persisted beside the scores.
 *
 * Pairs are scored in a SHUFFLED order with a fixed seed. Batching adjacent
 * pairs would put a whole category in one prompt, and a judge that sees six
 * near-miss mutations together is being given a hint about the answer that a
 * deployment would never give it.
 *
 *   node src/experiments/scoreV2.js --pairs corpus/ladder.jsonl \
 *        --out corpus/scores-ladder.jsonl --judges openai/gpt-oss-120b,qwen/qwen3.6-27b
 */

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argAfter = (f, fb) => { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fb; };
const PAIRS_FILE = argAfter("--pairs", "corpus/pairs-v2ext.jsonl");
const OUT_FILE = argAfter("--out", null) ?? PAIRS_FILE.replace(/pairs-?/, "scores-").replace(/^corpus\//, "corpus/");
const BATCH = Number(argAfter("--batch", "10"));
const JUDGES = argAfter("--judges", "openai/gpt-oss-120b").split(",").map((s) => s.trim()).filter(Boolean);
const FRESH = process.argv.includes("--fresh");
// --task authz scores (approval, action) pairs with the authorisation judge.
// It has no identity schema and no lexical stand-in, so both are skipped.
const TASK = argAfter("--task", "identity");
if (!["identity", "authz"].includes(TASK)) throw new Error(`unknown --task ${TASK}`);
const JUDGE_OPTIONS = TASK === "authz" ? (await import("../authz/judge.js")).AUTHZ_JUDGE_OPTIONS : {};
const RETRY_ABSTENTIONS = process.argv.includes("--retry-abstentions");

/** Every schema any v2 corpus can reference, in one table. */
const SCHEMAS = {
  ...TOOLS_V2,
  ...LEVEL_SCHEMAS,
  pay_by_account_no: MISDECLARED_SCHEMA,
};

const tag = basename(PAIRS_FILE).replace(/\.jsonl$/, "");
const partialPath = (model) => resolve(base, "results", `partial-${tag}-${judgeKey(model)}.json`);

const loadPartial = (model) => {
  if (FRESH) return {};
  const p = partialPath(model);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
};
const savePartial = (model, scores, diag) => {
  mkdirSync(resolve(base, "results"), { recursive: true });
  writeFileSync(partialPath(model), JSON.stringify({ scores, diag, at: new Date().toISOString() }, null, 2));
};

async function scoreModel(model, pairs) {
  const stored = loadPartial(model);
  const scores = stored.scores ?? {};
  const diag = newJudgeDiagnostics();
  const client = new GroqClient({ model });
  // Only pairs with no recorded outcome. A recorded `null` is an abstention that
  // a previous pass already spent its retries on; re-attempting it every run
  // would make the abstention count depend on how many times the script was
  // invoked rather than on the judge.
  // `--retry-abstentions` exists because a stored `null` has two very different
  // causes and the file cannot tell them apart. A judge that read the pair and
  // declined is a measurement; a batch that never reached the API during a
  // provider outage is not, and re-running without this flag would freeze an
  // outage into the corpus as if it were the judge's behaviour. One pass of
  // this experiment lost 480 of 570 ladder pairs that way, with the quota
  // untouched and the API healthy minutes later.
  const todo = pairs.filter((p) => scores[p.id] === undefined || (RETRY_ABSTENTIONS && scores[p.id] === null));
  process.stdout.write(`${model}: ${todo.length} to score (${pairs.length - todo.length} already stored)\n`);

  // A sustained provider outage looks, to the inner client, like a long run of
  // independent per-batch failures: each batch exhausts judgeScores' own retry
  // budget and returns all-null within a couple of seconds, so a pass can burn
  // through hundreds of pairs during an outage that would have cleared in a
  // minute. This outer loop detects a run of fully-failed batches and backs off
  // before trying the SAME batch again, rather than converting an outage into a
  // corpus of abstentions.
  let consecutiveDead = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const before = diag.transportFailures;
    const vals = await judgeScores(
      client,
      batch.map((p) => ({ tool: p.tool, a: p.a, b: p.b, id: p.id })),
      { batchSize: BATCH, diagnostics: diag, ...JUDGE_OPTIONS }
    );
    const allNull = vals.every((v) => v === null);
    const hadTransport = diag.transportFailures > before;
    if (allNull && hadTransport && consecutiveDead < 6) {
      consecutiveDead += 1;
      const waitMs = Math.min(120_000, 5_000 * 2 ** (consecutiveDead - 1));
      process.stdout.write(`\n  ! batch at ${i} failed on transport (${consecutiveDead} in a row) — waiting ${waitMs / 1000}s and retrying it\n`);
      await new Promise((r) => setTimeout(r, waitMs));
      i -= BATCH;
      continue;
    }
    consecutiveDead = 0;
    batch.forEach((p, j) => { scores[p.id] = vals[j]; });
    savePartial(model, scores, diag);
    process.stdout.write(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}\r`);
  }
  const vals = Object.values(scores);
  process.stdout.write(
    `\n  scored=${vals.filter((v) => typeof v === "number").length} abstained=${vals.filter((v) => v === null).length}` +
    ` calls=${client.stats.calls} retries=${diag.batchRetries} transportFail=${diag.transportFailures}` +
    ` nonInt=${diag.byStatus.non_integer} oor=${diag.byStatus.out_of_range} missing=${diag.byStatus.missing}\n`
  );
  return {
    scores,
    meta: {
      model, family: JUDGE_MODELS[model]?.family ?? "unknown",
      calls: client.stats.calls,
      meanCallLatencyMs: client.stats.calls ? Math.round(client.stats.totalLatencyMs / client.stats.calls) : 0,
      inputTokens: client.stats.inputTokens, outputTokens: client.stats.outputTokens,
      batchSize: BATCH, temperature: 0,
      scoredPairs: vals.filter((v) => typeof v === "number").length,
      abstentions: vals.filter((v) => v === null).length,
      parse: { batchRetries: diag.batchRetries, transportFailures: diag.transportFailures, byStatus: diag.byStatus, ambiguousZeroOne: diag.ambiguousAcceptedZeroOne },
    },
  };
}

async function main() {
  const pairs = readFileSync(resolve(base, PAIRS_FILE), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  let s = 20260818;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const order = pairs.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const shuffled = order.map((i) => pairs[i]);

  let lexical = shuffled.map(() => null);
  if (TASK === "identity") {
    const missing = [...new Set(shuffled.map((p) => p.tool))].filter((t) => !SCHEMAS[t]);
    if (missing.length) throw new Error(`no schema for tools: ${missing.join(", ")}`);
    lexical = await lexicalScores(shuffled, SCHEMAS);
  }
  const byModel = {}, metas = {};
  if (groqAvailable() && !process.argv.includes("--offline")) {
    for (const model of JUDGES) {
      const { scores, meta } = await scoreModel(model, shuffled);
      byModel[judgeKey(model)] = scores;
      metas[judgeKey(model)] = meta;
      writeOut(shuffled, byModel, lexical, metas);
    }
  }
  writeOut(shuffled, byModel, lexical, metas);
  console.log(`\nwritten: ${OUT_FILE}`);
}

function writeOut(pairs, byModel, lexical, metas) {
  const lines = pairs.map((p, i) => JSON.stringify({
    id: p.id,
    lexical: lexical[i],
    judges: Object.fromEntries(Object.entries(byModel).map(([k, sc]) => [k, sc[p.id] ?? null])),
  }));
  writeFileSync(resolve(base, OUT_FILE), lines.join("\n") + "\n");
  writeFileSync(resolve(base, "results", `judge_meta-${tag}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), pairs: pairs.length, models: metas }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
