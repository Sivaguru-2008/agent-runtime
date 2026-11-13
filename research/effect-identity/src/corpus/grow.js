import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WIRE_SEEDS_GROWTH, D3_PAIRS_GROWTH } from "./growthSeeds.js";
import { extractNumbers } from "../judge.js";

/**
 * Duplicated from generate.js rather than imported: that module runs the whole
 * corpus build at import time, so importing it here would regenerate the frozen
 * 955-pair record as a side effect of growing it. Kept byte-identical to the
 * original so the two arms render amounts the same way; a unit test pins them
 * together.
 */
function numberToWords(n) {
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  if (n === 0) return "zero";
  const parts = [];
  if (n >= 1000) { parts.push(numberToWords(Math.floor(n / 1000)), "thousand"); n %= 1000; }
  if (n >= 100) { parts.push(ones[Math.floor(n / 100)], "hundred"); n %= 100; }
  if (n >= 20) { parts.push(tens[Math.floor(n / 10)]); n %= 10; }
  if (n > 0) parts.push(ones[n]);
  return parts.filter(Boolean).join(" ");
}

/**
 * Grow the two load-bearing cells (Task 4), additively.
 *
 * The alternative — regenerating the corpus with bigger S3/D3 arms — would
 * change every id, invalidate every persisted score, void the frozen annotation
 * sheet, and make the whole of §8 a fresh measurement rather than a revision.
 * That is a lot of destruction to buy statistical power in two cells. This
 * appends new pairs with fresh ids and leaves all 955 existing pairs, their
 * splits, and their scores byte-identical.
 *
 * The new pairs take the same stratified 50/50 calibration/test split as the
 * original build, under a declared seed. Note what that implies and what it
 * does not:
 *
 *   - S3 is SAME, and the hardened calibration pool is drawn from DIFF pairs
 *     only, so no S3 pair can move a threshold. Growing S3 changes S3's
 *     denominator and nothing else.
 *   - D3 is DIFF, so its calibration half DOES enter the pool and can move
 *     `t_hi`. That is a real perturbation of every downstream rate, and it is
 *     reported rather than avoided by parking the growth in the test split —
 *     a held-out-only arm would be a different sampling rule for one category,
 *     which is worse than a small, disclosed threshold movement.
 *
 *   node src/corpus/grow.js [--dry]
 */

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..", "..");
const pairsPath = resolve(base, "corpus", "pairs.jsonl");

const GROWTH_SEED = 20260824;
let seed = GROWTH_SEED;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const existing = readFileSync(pairsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const existingIds = new Set(existing.map((p) => p.id));

/**
 * S3 variant forms.
 *
 * Every form must preserve the ACT: same amount, same beneficiary, same
 * referenced document. What may vary is how the amount is rendered, how the
 * beneficiary is cased, and how the reference is punctuated — the presentational
 * surface a re-synthesising model actually changes on a retry.
 */
function s3GrowthVariants(input) {
  const amount = [...extractNumbers(input.amount_text)][0];
  // A non-integral amount cannot be rendered in words without either dropping
  // or rounding the cents, and a rounded amount is a DIFFERENT ACT. Refuse.
  if (!Number.isInteger(amount)) throw new Error(`S3 growth seed has a non-integral amount (${input.amount_text}); the word-form variant would mislabel it`);
  const words = numberToWords(amount);
  const ref = input.reference;
  return [
    { amount_text: `${amount} USD`, beneficiary_text: input.beneficiary_text, reference: ref.replace(/^(Invoice|PO)\s+/i, "") },
    { amount_text: `${words} dollars`, beneficiary_text: input.beneficiary_text, reference: ref.toLowerCase() },
    { amount_text: `USD ${amount.toLocaleString("en-US")}`, beneficiary_text: input.beneficiary_text.toUpperCase(), reference: ref },
    { amount_text: `${amount.toLocaleString("en-US")}.00 US dollars`, beneficiary_text: input.beneficiary_text.trim(), reference: ref.replace(/\s+(\d)/, " #$1") },
    { amount_text: `${words} dollars (${input.amount_text})`, beneficiary_text: input.beneficiary_text.replace(/\s+(Ltd|LLC|Co)$/i, " $1."), reference: ref.replace(/\s+/g, "  ") },
    { amount_text: `${amount}`, beneficiary_text: ` ${input.beneficiary_text} `, reference: ref.toUpperCase() },
  ];
}

/** A SAME variant that changed the amount would be the one mislabel the corpus
 *  cannot tolerate. Check it rather than trust the generator. */
function assertAmountPreserved(a, b) {
  const x = [...extractNumbers(a.amount_text)][0];
  const y = [...extractNumbers(b.amount_text)][0];
  if (x !== y) throw new Error(`S3 variant changed the amount: ${a.amount_text} -> ${b.amount_text} (${x} != ${y})`);
}

const fresh = [];
let s3n = 0, d3n = 0;
const add = (category, label, tool, a, b, source, idNum) => {
  const id = `${category}_g${String(idNum).padStart(3, "0")}`;
  if (existingIds.has(id)) throw new Error(`id collision: ${id}`);
  fresh.push({ id, category, label, tool, a, b, source, generator: null, growth: true });
};

for (const s of WIRE_SEEDS_GROWTH) {
  for (const v of s3GrowthVariants(s.input)) {
    assertAmountPreserved(s.input, v);
    add("S3_loose_value", "SAME", s.tool, s.input, v, "mechanical", ++s3n);
  }
}
for (const p of D3_PAIRS_GROWTH) add("D3_semantic_diff", "DIFF", p.tool, p.a, p.b, "handcrafted", ++d3n);

// Stratified 50/50 split, per category, on the NEW pairs only.
for (const cat of ["S3_loose_value", "D3_semantic_diff"]) {
  const list = shuffle(fresh.filter((p) => p.category === cat));
  list.forEach((p, i) => { p.split = i < Math.floor(list.length / 2) ? "cal" : "test"; });
}

const before = {};
const after = {};
for (const p of existing) {
  before[p.category] ??= { total: 0, cal: 0, test: 0, attack: 0 };
  before[p.category].total += 1; before[p.category][p.split] += 1;
}
const all = [...existing, ...fresh];
for (const p of all) {
  after[p.category] ??= { total: 0, cal: 0, test: 0, attack: 0 };
  after[p.category].total += 1; after[p.category][p.split] += 1;
}

console.log(`existing ${existing.length}  +  new ${fresh.length}  =  ${all.length}`);
for (const cat of ["S3_loose_value", "D3_semantic_diff"]) {
  const b = before[cat], a = after[cat];
  console.log(`  ${cat.padEnd(20)} ${b.total} (cal ${b.cal} / test ${b.test})  ->  ${a.total} (cal ${a.cal} / test ${a.test})`);
}

if (process.argv.includes("--dry")) { console.log("\n--dry: nothing written"); process.exit(0); }

writeFileSync(pairsPath, all.map((p) => JSON.stringify(p)).join("\n") + "\n");

// Record the growth so it is a documented event rather than a diff someone has
// to reverse-engineer.
writeFileSync(resolve(base, "corpus", "growth-manifest.json"), JSON.stringify({
  grownAt: new Date().toISOString(),
  reason: "Task 4 — S3 (the paper's motivating example) and D3 carried named qualitative claims at n=8 and n=5 test pairs",
  seed: GROWTH_SEED,
  additive: true,
  existingPairsModified: 0,
  newPairs: fresh.length,
  before: { S3_loose_value: before.S3_loose_value, D3_semantic_diff: before.D3_semantic_diff },
  after: { S3_loose_value: after.S3_loose_value, D3_semantic_diff: after.D3_semantic_diff },
  newIds: fresh.map((p) => p.id),
  note: "S3 is SAME and cannot enter the DIFF calibration pool, so it moves no threshold. D3 is DIFF and its calibration half does enter the pool; any movement in t_hi is reported in §8.3.",
}, null, 2));

console.log(`\nwrote ${all.length} pairs to corpus/pairs.jsonl`);
console.log(`wrote corpus/growth-manifest.json`);
console.log(`\nNext: score the ${fresh.length} new pairs, then re-run the experiments.`);
