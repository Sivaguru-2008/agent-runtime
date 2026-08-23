import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GroqClient, groqAvailable, JUDGE_MODELS, DEFAULT_JUDGE } from "../groq.js";
import { judgeScores, judgeKey, newJudgeDiagnostics, lexicalScores } from "../judge.js";
import { TOOLS } from "../tools.js";
import {
  suppressionThreshold, maxSuppressionThreshold, setConformalThreshold,
  escalationFloor, decideOverCandidates, maxCertifiableCandidates, requiredCalibrationSize,
} from "../conformal.js";
import { rate, fmtRate } from "../stats.js";

/**
 * The multi-candidate experiment: does the fence still hold when a run has
 * committed MANY effects for the same tool?
 *
 * Every other experiment here runs at m ≤ 1 committed candidate, where the
 * pairwise conformal bound and the bound on the deployed max-statistic
 * coincide. That is the easy case and it hides the defect: the fence thresholds
 * S* = max over the candidate set, so with m candidates it gets m chances to
 * exceed the threshold and its wrong-suppression rate grows with m. This
 * experiment is what the corrected T3 has to be checked against.
 *
 * ── Construction ────────────────────────────────────────────────────────────
 *
 * A UNIT is one dispatch x plus an ordered candidate list of K committed
 * effects. Prefixes of that list give m ∈ {1,2,5,10,25,50} with the candidate
 * sets NESTED, so the m-curve is not confounded by re-drawing candidates.
 *
 * Every candidate shares x's SEMANTIC PROJECTION, so all of them survive the
 * distinctness witness and reach the judge. That is deliberate: candidates the
 * witness vetoes cost nothing and prove nothing, and a benchmark padded with
 * them would report a large m while judging one pair.
 *
 *   SAME units  — x paraphrases candidate[0]; the true match is in every prefix.
 *   DIFF units  — x is a distinct act sharing the projection with all K
 *                 candidates and matching none of them. Wrong suppression is
 *                 estimated over these and nothing else.
 *
 * ── Thresholds compared ─────────────────────────────────────────────────────
 *
 *   uncorrected — pairwise conformal at α, applied to the max. What the paper
 *                 previously did, and what the correction replaces.
 *   bonferroni  — pairwise conformal at α/m. The corrected rule.
 *   setconformal— calibrated directly on maxima of size-m calibration sets.
 *
 *   node src/experiments/multiCandidate.js [--judge M] [--units-diff N]
 *        [--units-same N] [--K 50] [--batch 20] [--offline] [--fresh]
 */

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..", "..");
const argAfter = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const K = Number(argAfter("--K", "50"));
const N_DIFF = Number(argAfter("--units-diff", "40"));
const N_SAME = Number(argAfter("--units-same", "20"));
const BATCH = Number(argAfter("--batch", "20"));
const OFFLINE = process.argv.includes("--offline");
const FRESH = process.argv.includes("--fresh");
// llama by default: it is the judge with enough per-minute quota headroom on
// this key to score K × units pairs in one sitting. Stated rather than implied.
const JUDGE = argAfter("--judge", "llama-3.3-70b-versatile");
const M_VALUES = [1, 2, 5, 10, 25, 50].filter((m) => m <= K);
const ALPHAS = [0.01, 0.05, 0.1];
const GAMMA = 0.05;

const scoresPath = resolve(base, "corpus", "multi-candidate-scores.json");
const unitsPath = resolve(base, "corpus", "multi-candidate-units.json");

// ── Unit construction ────────────────────────────────────────────────────────

/**
 * Two tools, chosen because they sit at opposite ends of what a schema pins.
 *
 *   charge_card — customer, amount and currency are DECLARED, so candidates can
 *     only differ in the free-text memo. The witness passes them all and the
 *     judge carries the whole decision. This is the honest hard case.
 *   wire_money  — nothing is declared, so every wire in the run is a candidate
 *     no matter how different. This is the loose-schema worst case, and the one
 *     where m grows fastest in practice.
 */
const UNIT_SPECS = {
  charge_card: {
    fixed: { customer_id: "cust_07", amount: 250, currency: "USD" },
    // Distinct acts that agree on every declared field: separate installments
    // of one payment plan. Genuinely different money movements.
    candidate: (k) => ({ memo: `subscription plan — installment ${k} of 120` }),
    // A SAME dispatch: the same installment, reworded.
    sameDispatch: (k) => ({ memo: `installment ${k} of 120 for the subscription plan` }),
    // A DIFF dispatch: an installment that is NOT among the candidates.
    diffDispatch: (k) => ({ memo: `subscription plan — installment ${k} of 120` }),
  },
  wire_money: {
    fixed: {},
    candidate: (k) => ({
      amount_text: "$780.00",
      beneficiary_text: "Marlow Freight",
      reference: `Shipment ${88000 + k}`,
    }),
    sameDispatch: (k) => ({
      amount_text: "seven hundred eighty dollars",
      beneficiary_text: "MARLOW FREIGHT",
      reference: `shipment #${88000 + k}`,
    }),
    diffDispatch: (k) => ({
      amount_text: "$780.00",
      beneficiary_text: "Marlow Freight",
      reference: `Shipment ${88000 + k}`,
    }),
  },
};

function buildUnits() {
  const units = [];
  const tools = Object.keys(UNIT_SPECS);
  let id = 0;
  for (let u = 0; u < N_DIFF + N_SAME; u++) {
    const label = u < N_DIFF ? "DIFF" : "SAME";
    const tool = tools[u % tools.length];
    const spec = UNIT_SPECS[tool];
    // Each unit gets its own disjoint index block, so no two units share an act
    // and a candidate can never coincide with another unit's dispatch.
    const offset = 1 + u * (K + 2);
    const candidates = Array.from({ length: K }, (_, i) => ({ ...spec.fixed, ...spec.candidate(offset + i) }));
    const dispatch = label === "SAME"
      ? { ...spec.fixed, ...spec.sameDispatch(offset) }        // paraphrase of candidates[0]
      : { ...spec.fixed, ...spec.diffDispatch(offset + K + 1) }; // an act in no prefix
    units.push({ id: `U${String(++id).padStart(3, "0")}`, tool, label, dispatch, candidates });
  }
  return units;
}

// ── Scoring ──────────────────────────────────────────────────────────────────

async function scoreUnits(units) {
  const cached = !FRESH && existsSync(scoresPath) ? JSON.parse(readFileSync(scoresPath, "utf8")) : { scores: {}, meta: {} };
  const scores = cached.scores ?? {};
  const flat = [];
  for (const u of units) {
    u.candidates.forEach((c, i) => {
      const key = `${u.id}:${i}`;
      if (scores[key] === undefined) flat.push({ key, tool: u.tool, a: c, b: u.dispatch, id: key });
    });
  }
  if (flat.length === 0) {
    process.stdout.write(`all ${Object.keys(scores).length} comparisons cached\n`);
    return { scores, meta: cached.meta };
  }
  process.stdout.write(`scoring ${flat.length} comparisons with ${OFFLINE ? "lexical-offline" : JUDGE}...\n`);

  if (OFFLINE || !groqAvailable()) {
    const s = await lexicalScores(flat, TOOLS);
    flat.forEach((p, i) => { scores[p.key] = s[i]; });
    const meta = { judge: "lexical-offline", comparisons: flat.length };
    writeFileSync(scoresPath, JSON.stringify({ meta, scores }, null, 2));
    return { scores, meta };
  }

  const client = new GroqClient({ model: JUDGE });
  const diag = newJudgeDiagnostics();
  const t0 = Date.now();
  for (let start = 0; start < flat.length; start += BATCH) {
    const batch = flat.slice(start, start + BATCH);
    const s = await judgeScores(client, batch, { batchSize: BATCH, diagnostics: diag });
    batch.forEach((p, i) => { scores[p.key] = s[i]; });
    const meta = {
      judge: JUDGE, family: JUDGE_MODELS[JUDGE]?.family ?? "unknown",
      comparisons: Object.keys(scores).length, batchSize: BATCH,
      calls: client.stats.calls, inputTokens: client.stats.inputTokens, outputTokens: client.stats.outputTokens,
      meanCallLatencyMs: Math.round(client.stats.totalLatencyMs / Math.max(1, client.stats.calls)),
      meanComparisonLatencyMs: Math.round(client.stats.totalLatencyMs / Math.max(1, Object.keys(scores).length)),
      wallClockMs: Date.now() - t0, parse: diag,
    };
    writeFileSync(scoresPath, JSON.stringify({ meta, scores }, null, 2));
    process.stdout.write(`  ${Object.keys(scores).length}/${units.length * K} abstain=${diag.abstentions}\n`);
  }
  return { scores, meta: JSON.parse(readFileSync(scoresPath, "utf8")).meta };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Calibration pool. The primary source is the MAIN corpus's DIFF calibration
 * split for the same judge: that is the pool a deployment would actually have,
 * and using it here tests assumption A6 (that calibration and deployment
 * distinct-pair scores are exchangeable) rather than assuming it — the
 * multi-candidate population is constructed differently, so if the corrected
 * bound holds here it is holding across a distribution shift.
 *
 * The secondary source is in-experiment: one randomly chosen comparison per
 * calibration UNIT, which keeps the pool free of the within-unit clustering
 * that pooling all K scores would introduce (K scores sharing one dispatch are
 * not K exchangeable draws).
 */
function corpusCalibration(judgeCol) {
  const pairsPath = resolve(base, "corpus", "pairs.jsonl");
  const scoresFile = resolve(base, "corpus", "scores.jsonl");
  if (!existsSync(pairsPath) || !existsSync(scoresFile)) return { diff: [], same: [] };
  const pairs = readFileSync(pairsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sc = new Map(readFileSync(scoresFile, "utf8").split("\n").filter(Boolean)
    .map((l) => { const r = JSON.parse(l); return [r.id, r]; }));
  // The lexical scorer lives in its own top-level column, not under `judges`.
  const val = (p) => (judgeCol === "lexical" ? sc.get(p.id)?.lexical : sc.get(p.id)?.judges?.[judgeCol]);
  const usable = (v) => v !== null && v !== undefined;
  return {
    diff: pairs.filter((p) => p.split === "cal" && p.label === "DIFF").map(val).filter(usable),
    same: pairs.filter((p) => p.split === "cal" && p.label === "SAME").map(val).filter(usable),
  };
}

function unitScores(unit, scores, m) {
  return Array.from({ length: m }, (_, i) => scores[`${unit.id}:${i}`] ?? null);
}

function main() {
  const units = buildUnits();
  writeFileSync(unitsPath, JSON.stringify({ K, nDiff: N_DIFF, nSame: N_SAME, units }, null, 2));
  return units;
}

const units = main();

(async () => {
  const { scores, meta } = await scoreUnits(units);
  const judgeCol = OFFLINE || !groqAvailable() ? "lexical" : judgeKey(JUDGE);
  const cal = corpusCalibration(judgeCol);

  // In-experiment calibration: half the DIFF units, ONE comparison each.
  const diffUnits = units.filter((u) => u.label === "DIFF");
  const sameUnits = units.filter((u) => u.label === "SAME");
  const calUnits = diffUnits.filter((_, i) => i % 2 === 0);
  const testDiff = diffUnits.filter((_, i) => i % 2 === 1);
  let seed = 4242;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const inExpCal = calUnits
    .map((u) => scores[`${u.id}:${Math.floor(rnd() * K)}`])
    .filter((v) => v !== null && v !== undefined);

  const tLo = escalationFloor(cal.same.length ? cal.same : [0.5], GAMMA);

  const results = {
    generatedAt: new Date().toISOString(),
    judge: meta?.judge ?? judgeCol,
    judgeMeta: meta,
    K, nDiffUnits: diffUnits.length, nSameUnits: sameUnits.length,
    nTestDiffUnits: testDiff.length,
    calibration: {
      corpusDiffN: cal.diff.length,
      corpusSameN: cal.same.length,
      inExperimentDiffN: inExpCal.length,
      tLo,
      // The budget constraint that decides whether large m is reachable at all.
      maxCertifiableM: Object.fromEntries(ALPHAS.map((a) => [a, maxCertifiableCandidates(cal.diff.length, a)])),
      requiredNForM: Object.fromEntries(M_VALUES.map((m) => [m, Object.fromEntries(ALPHAS.map((a) => [a, requiredCalibrationSize(m, a)]))])),
    },
    grid: [],
  };

  for (const alpha of ALPHAS) {
    for (const m of M_VALUES) {
      const rules = {
        uncorrected: suppressionThreshold(cal.diff, alpha),
        bonferroni: maxSuppressionThreshold(cal.diff, alpha, m),
        setconformal: setConformalThreshold(cal.diff, alpha, m, 7),
        inExperimentBonferroni: maxSuppressionThreshold(inExpCal, alpha, m),
      };
      const row = { alpha, m, thresholds: rules, rules: {} };
      for (const [name, tHi] of Object.entries(rules)) {
        const decideUnit = (u) => decideOverCandidates(unitScores(u, scores, m), { tHiOverride: tHi, tLo }).decision;
        const dDiff = testDiff.map(decideUnit);
        const dSame = sameUnits.map(decideUnit);
        row.rules[name] = {
          tHi,
          wrongSuppression: rate(dDiff.filter((d) => d === "SUPPRESS").length, dDiff.length),
          friction: rate(dDiff.filter((d) => d === "ESCALATE").length, dDiff.length),
          dedup: rate(dSame.filter((d) => d === "SUPPRESS").length, dSame.length),
          flaggedEscape: rate(dSame.filter((d) => d === "ESCALATE").length, dSame.length),
          silentEscape: rate(dSame.filter((d) => d === "EXECUTE").length, dSame.length),
        };
      }
      // Cost of one dispatch at this m: the judge sees every surviving candidate.
      row.cost = {
        comparisonsPerDispatch: m,
        meanComparisonLatencyMs: meta?.meanComparisonLatencyMs ?? null,
        estimatedJudgeLatencyMsPerDispatch: meta?.meanComparisonLatencyMs ? meta.meanComparisonLatencyMs * m : null,
        tokensPerComparison: meta?.comparisons
          ? Math.round(((meta.inputTokens ?? 0) + (meta.outputTokens ?? 0)) / meta.comparisons)
          : null,
      };
      results.grid.push(row);
    }
  }

  // False-positive accumulation: for the DIFF test units, how the max score
  // itself grows with m. This is the mechanism behind the correction, measured
  // independently of any threshold.
  results.maxScoreGrowth = M_VALUES.map((m) => {
    const maxima = testDiff.map((u) => {
      const s = unitScores(u, scores, m).filter((v) => v !== null && v !== undefined);
      return s.length ? Math.max(...s) : null;
    }).filter((v) => v !== null);
    maxima.sort((a, b) => a - b);
    const q = (p) => (maxima.length ? maxima[Math.min(maxima.length - 1, Math.floor(p * maxima.length))] : null);
    return {
      m, n: maxima.length,
      meanMaxScore: maxima.reduce((a, b) => a + b, 0) / Math.max(1, maxima.length),
      medianMaxScore: q(0.5), p90MaxScore: q(0.9), maxMaxScore: maxima[maxima.length - 1] ?? null,
    };
  });

  mkdirSync(resolve(base, "results"), { recursive: true });
  writeFileSync(resolve(base, "results", "multi_candidate.json"), JSON.stringify(results, null, 2));

  console.log(`\njudge=${results.judge}  K=${K}  DIFF units=${diffUnits.length} (test ${testDiff.length})  SAME units=${sameUnits.length}`);
  console.log(`corpus calibration: nDiff=${cal.diff.length} → certifiable m ≤ ${JSON.stringify(results.calibration.maxCertifiableM)}`);
  console.log(`t_lo=${tLo}`);
  for (const alpha of ALPHAS) {
    console.log(`\n── α=${alpha} ──`);
    console.log("  m   rule                    tHi        WS                       dedup                    friction");
    for (const row of results.grid.filter((r) => r.alpha === alpha)) {
      for (const [name, r] of Object.entries(row.rules)) {
        if (name === "inExperimentBonferroni") continue;
        console.log(
          `${String(row.m).padStart(3)}   ${name.padEnd(22)} ${String(r.tHi === Infinity ? "+inf" : r.tHi.toFixed(2)).padEnd(10)} ` +
          `${fmtRate(r.wrongSuppression).padEnd(24)} ${fmtRate(r.dedup).padEnd(24)} ${fmtRate(r.friction)}`
        );
      }
    }
  }
  console.log("\n── how the max distinct-pair score grows with m (the reason for the correction) ──");
  for (const g of results.maxScoreGrowth) {
    console.log(`m=${String(g.m).padStart(2)}  mean=${g.meanMaxScore.toFixed(3)}  median=${g.medianMaxScore?.toFixed(3)}  p90=${g.p90MaxScore?.toFixed(3)}  max=${g.maxMaxScore?.toFixed(3)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
