#!/usr/bin/env node
/**
 * Cross-check the manuscript against the persisted results.
 *
 *   node src/experiments/checkPaper.js
 *
 * The paper claims that every rate it quotes regenerates from the stored
 * corpus. This makes that claim machine-checkable rather than rhetorical: it
 * extracts every `NN.N% [lo-hi]` interval from the Markdown and asserts that a
 * rate with that point estimate AND that interval exists somewhere in
 * results/*.json. A quoted interval that matches no computed rate is either a
 * stale number or a typo, and both are reported.
 *
 * Exits non-zero if any interval is unmatched. `--list` prints every computed
 * rate instead of checking.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAPER = resolve(base, "..", "..", "docs", "research", "Semantic-Effect-Identity-Paper.md");
const RESULT_FILES = [
  "experiments.json", "crash_replay.json", "multi_candidate.json",
  "residual_calibration.json", "cross_family.json", "sensitivity.json",
  "crash_replay_v2.json", "baseline_matrix_v1.json", "attack_matrix_v1.json",
  "conformal_audit_v1.json", "schema_ladder.json",
  // §8.16's annotation result and §8.14's seed-split robustness check. Both
  // produce rates quoted in the manuscript, so both must be checkable; without
  // them the checker would silently pass every number in those sections.
  "human_annotation.json", "seed_split.json",
];

/** Walk any JSON and collect every {value, ci95:{lo,hi}} rate record. */
function collectRates(node, path, sink) {
  if (node === null || typeof node !== "object") return;
  if (typeof node.value === "number" && node.ci95 && typeof node.ci95.lo === "number") {
    sink.push({
      path,
      pct: +(100 * node.value).toFixed(1),
      lo: +(100 * node.ci95.lo).toFixed(1),
      hi: +(100 * node.ci95.hi).toFixed(1),
      basis: node.basis ?? "",
      n: node.n,
    });
    return;
  }
  for (const [k, v] of Object.entries(node)) collectRates(v, path ? `${path}.${k}` : k, sink);
}

const rates = [];
for (const f of RESULT_FILES) {
  const p = resolve(base, "results", f);
  if (!existsSync(p)) {
    console.error(`missing results file: ${f} — run the experiments first`);
    process.exit(2);
  }
  collectRates(JSON.parse(readFileSync(p, "utf8")), f.replace(/\.json$/, ""), rates);
}

if (process.argv.includes("--list")) {
  for (const r of rates.sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`${r.pct.toFixed(1).padStart(6)}% [${r.lo.toFixed(1)}-${r.hi.toFixed(1)}]  n=${String(r.n ?? "").padStart(4)}  ${r.path}`);
  }
  console.log(`\n${rates.length} rates`);
  process.exit(0);
}

// Index by the triple the paper quotes. Tolerance covers the paper's rounding.
const near = (a, b) => Math.abs(a - b) <= 0.06;
const paper = readFileSync(PAPER, "utf8");

// Intervals are written `12.3% [4.5–67.8]`, optionally with a dagger before the
// bracket, optionally bolded. The dash is an en-dash in the manuscript.
const QUOTED = /(\d+(?:\.\d+)?)%(?:†)?\s*\[(\d+(?:\.\d+)?)[–-](\d+(?:\.\d+)?)\]/g;

const unmatched = [];
const seen = new Set();
let total = 0;

for (const m of paper.matchAll(QUOTED)) {
  const [full, p, lo, hi] = m;
  total++;
  if (seen.has(full)) continue;
  seen.add(full);
  const hit = rates.some((r) => near(r.pct, +p) && near(r.lo, +lo) && near(r.hi, +hi));
  if (!hit) {
    const line = paper.slice(0, m.index).split("\n").length;
    unmatched.push({ quoted: full, line });
  }
}

console.log(`checked ${total} quoted intervals (${seen.size} distinct) against ${rates.length} computed rates`);
if (unmatched.length === 0) {
  console.log("all quoted intervals matched a computed rate");
  process.exit(0);
}

console.error(`\n${unmatched.length} quoted interval(s) with no matching computed rate:`);
for (const u of unmatched) console.error(`  line ${u.line}: ${u.quoted}`);
console.error("\nEach is either stale, a typo, or computed by a script whose output is not in results/.");
process.exit(1);
