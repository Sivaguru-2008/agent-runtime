import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runConfig, makeScoreLookup } from "../evaluate.js";
import { rate, fmtRate } from "../stats.js";
import { TOOLS } from "../tools.js";

/**
 * Seed-level splitting — closing the leakage threat §8.14 disclosed (Task 5).
 *
 * The shipped corpus is split by PAIR. §8.14 measured the consequence and did
 * not act on it: 86.4% of test pairs derive from a seed act that also appears
 * somewhere in the calibration split. Exchangeability is a condition on scores
 * rather than on provenance, so that is not automatically a violation — but it
 * is a live route by which a judge could score a test pair optimistically
 * because it saw a sibling phrasing during calibration, and "we have not built
 * one" was the honest but unsatisfying answer.
 *
 * This builds one. Seeds are partitioned first; every pair follows its seed; no
 * seed appears on both sides. The effective sample shrinks, because seeds are
 * unequally productive and a whole seed's worth of pairs moves at once. That
 * cost is the point of the exercise rather than an objection to it.
 *
 *   node src/experiments/seedSplit.js [--judge <key>] [--alpha 0.05] [--reps 200]
 */

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argAfter = (f, fb) => { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fb; };
const ALPHA = Number(argAfter("--alpha", "0.05"));
const REPS = Number(argAfter("--reps", "200"));
const JUDGES = (argAfter("--judge", "openai_gpt_oss_120b,openai_gpt_oss_20b,qwen_qwen3_6_27b")).split(",");

const pairs = readFileSync(resolve(base, "corpus", "pairs.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const scores = readFileSync(resolve(base, "corpus", "scores.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

/**
 * The seed key, identical to the one conformalAudit.js measures leakage with,
 * so the fix is evaluated against exactly the quantity that raised the alarm.
 * Using a different key here would let the split look clean while leaving the
 * disclosed sharing untouched.
 */
const seedKey = (p) => `${p.tool}|${JSON.stringify(p.a).slice(0, 120)}`;

// Attack pairs are held out of calibration in every configuration, so they play
// no part in the split and are carried through unchanged.
const benign = pairs.filter((p) => p.split !== "attack");
const attack = pairs.filter((p) => p.split === "attack");

const seeds = [...new Set(benign.map(seedKey))];
const bySeed = new Map(seeds.map((s) => [s, benign.filter((p) => seedKey(p) === s)]));

/** Assign whole seeds to cal/test, targeting a 50/50 split of PAIRS. Seeds are
 *  unequally productive, so greedy balancing on pair count beats a coin flip on
 *  seeds — otherwise one prolific seed can swing the split by tens of pairs. */
function seedSplitOnce(rnd) {
  const order = [...seeds].sort(() => rnd() - 0.5);
  let nCal = 0, nTest = 0;
  const side = new Map();
  for (const s of order) {
    const k = bySeed.get(s).length;
    const toCal = nCal <= nTest;
    side.set(s, toCal ? "cal" : "test");
    if (toCal) nCal += k; else nTest += k;
  }
  return benign.map((p) => ({ ...p, split: side.get(seedKey(p)) }));
}

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function leakage(set) {
  const cal = set.filter((p) => p.split === "cal");
  const test = set.filter((p) => p.split === "test");
  const calSeeds = new Set(cal.map(seedKey));
  return rate(test.filter((p) => calSeeds.has(seedKey(p))).length, test.length);
}

function evaluate(judge, set) {
  const scoreOf = makeScoreLookup(scores, judge);
  return runConfig({ pairs: [...set, ...attack], schemas: TOOLS, cfg: {}, judge, scoreOf, alpha: ALPHA });
}

const out = { generatedAt: new Date().toISOString(), alpha: ALPHA, reps: REPS, seedKeyDefinition: "tool | JSON(a) truncated to 120 chars — identical to conformalAudit.js", nSeeds: seeds.length, judges: {} };

console.log(`${seeds.length} distinct seed acts across ${benign.length} benign pairs (${attack.length} attack pairs held out of both splits)\n`);

for (const judge of JUDGES) {
  if (!scores.some((r) => typeof r.judges?.[judge] === "number")) { console.log(`skip ${judge} — no scores`); continue; }

  const original = benign.map((p) => ({ ...p }));
  const origLeak = leakage(original);
  const origRes = evaluate(judge, original);

  // A single seed split is one draw. Because whole seeds move together, the
  // variance across draws is much larger than under pair-level splitting, and a
  // single seed-split number would be a coin flip reported as a finding.
  const draws = [];
  for (let r = 0; r < REPS; r++) {
    const set = seedSplitOnce(mulberry32(1000 + r));
    const res = evaluate(judge, set);
    draws.push({
      leak: leakage(set).value,
      tHi: res.calibration.tHi,
      nCalDiff: res.calibration.nCalDiff,
      ws: res.overall.wrongSuppression.value,
      dedup: res.overall.dedup.value,
      nTestDiff: res.overall.wrongSuppression.n,
      nTestSame: res.overall.dedup.n,
    });
  }
  const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const ws = draws.map((d) => d.ws), dedup = draws.map((d) => d.dedup);

  const row = {
    original: {
      leakage: origLeak, tHi: origRes.calibration.tHi, nCalDiff: origRes.calibration.nCalDiff,
      ws: origRes.overall.wrongSuppression, dedup: origRes.overall.dedup, silent: origRes.overall.silentEscape,
    },
    seedSplit: {
      maxLeakageObserved: Math.max(...draws.map((d) => d.leak)),
      meanNCalDiff: Math.round(mean(draws.map((d) => d.nCalDiff))),
      meanNTestDiff: Math.round(mean(draws.map((d) => d.nTestDiff))),
      meanNTestSame: Math.round(mean(draws.map((d) => d.nTestSame))),
      tHi: { mean: mean(draws.map((d) => d.tHi)), p05: q(draws.map((d) => d.tHi), 0.05), p95: q(draws.map((d) => d.tHi), 0.95) },
      ws: { mean: mean(ws), median: q(ws, 0.5), p05: q(ws, 0.05), p95: q(ws, 0.95), max: Math.max(...ws), shareAboveAlpha: ws.filter((x) => x > ALPHA).length / ws.length },
      dedup: { mean: mean(dedup), median: q(dedup, 0.5), p05: q(dedup, 0.05), p95: q(dedup, 0.95), min: Math.min(...dedup) },
    },
  };
  out.judges[judge] = row;

  console.log(`══ ${judge} ══`);
  console.log(`  pair-split (as shipped) : leakage ${fmtRate(origLeak)}  t_hi=${row.original.tHi}  pool=${row.original.nCalDiff}`);
  console.log(`                            WS ${fmtRate(row.original.ws)}   dedup ${fmtRate(row.original.dedup)}`);
  console.log(`  seed-split (${REPS} draws)  : leakage 0.0% by construction (max observed ${(row.seedSplit.maxLeakageObserved * 100).toFixed(1)}%)`);
  console.log(`                            pool mean=${row.seedSplit.meanNCalDiff}  t_hi mean=${row.seedSplit.tHi.mean.toFixed(3)} [p05 ${row.seedSplit.tHi.p05}, p95 ${row.seedSplit.tHi.p95}]`);
  console.log(`                            WS    mean ${(row.seedSplit.ws.mean * 100).toFixed(1)}%  median ${(row.seedSplit.ws.median * 100).toFixed(1)}%  p95 ${(row.seedSplit.ws.p95 * 100).toFixed(1)}%  max ${(row.seedSplit.ws.max * 100).toFixed(1)}%  draws over alpha ${(row.seedSplit.ws.shareAboveAlpha * 100).toFixed(1)}%`);
  console.log(`                            dedup mean ${(row.seedSplit.dedup.mean * 100).toFixed(1)}%  median ${(row.seedSplit.dedup.median * 100).toFixed(1)}%  p05 ${(row.seedSplit.dedup.p05 * 100).toFixed(1)}%  min ${(row.seedSplit.dedup.min * 100).toFixed(1)}%`);
  console.log();
}

writeFileSync(resolve(base, "results", "seed_split.json"), JSON.stringify(out, null, 2));
console.log("wrote results/seed_split.json");
