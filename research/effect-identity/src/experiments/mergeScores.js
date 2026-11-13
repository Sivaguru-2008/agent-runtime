#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

/**
 * Merge per-judge score files into one.
 *
 * Judges are scored in SEPARATE PROCESSES because their throughput differs by
 * an order of magnitude — one model's per-minute token allowance lets it finish
 * a corpus in twenty minutes while another needs hours — and a single
 * sequential pass makes the slowest judge the schedule for all of them. Running
 * them concurrently into one output file does not work either: each writer
 * rewrites the whole file from its own view, so the last writer silently drops
 * every other judge's column. Per-judge files plus an explicit merge is the
 * arrangement where neither failure is possible.
 *
 *   node src/experiments/mergeScores.js --tag pairs-v2ext --out corpus/scores-v2ext.jsonl
 */

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argAfter = (f, fb) => { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fb; };
const TAG = argAfter("--tag", "pairs-v2ext");
const OUT = argAfter("--out", `corpus/scores-${TAG.replace(/^pairs-?/, "")}.jsonl`);

const partials = readdirSync(resolve(base, "results"))
  .filter((f) => f.startsWith(`partial-${TAG}-`) && f.endsWith(".json"));
if (partials.length === 0) { console.error(`no partials for tag ${TAG}`); process.exit(1); }

const byJudge = {};
for (const f of partials) {
  const judge = f.replace(`partial-${TAG}-`, "").replace(/\.json$/, "");
  byJudge[judge] = JSON.parse(readFileSync(resolve(base, "results", f), "utf8")).scores ?? {};
}

const pairsFile = `corpus/${TAG}.jsonl`;
const pairs = readFileSync(resolve(base, pairsFile), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Preserve any lexical column an earlier single-process run already computed.
const existing = existsSync(resolve(base, OUT))
  ? new Map(readFileSync(resolve(base, OUT), "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.id, r]; }))
  : new Map();

const lines = pairs.map((p) => JSON.stringify({
  id: p.id,
  lexical: existing.get(p.id)?.lexical ?? null,
  judges: Object.fromEntries(Object.entries(byJudge).map(([j, sc]) => [j, sc[p.id] ?? null])),
}));
writeFileSync(resolve(base, OUT), lines.join("\n") + "\n");

console.log(`merged ${partials.length} judge file(s) over ${pairs.length} pairs -> ${OUT}`);
for (const [j, sc] of Object.entries(byJudge)) {
  const vals = pairs.map((p) => sc[p.id]);
  const scored = vals.filter((v) => typeof v === "number").length;
  const abst = vals.filter((v) => v === null).length;
  console.log(`  ${j.padEnd(30)} scored ${String(scored).padStart(5)}  abstained ${String(abst).padStart(5)}  unattempted ${String(vals.filter((v) => v === undefined).length).padStart(5)}  coverage ${((100 * scored) / pairs.length).toFixed(1)}%`);
}
