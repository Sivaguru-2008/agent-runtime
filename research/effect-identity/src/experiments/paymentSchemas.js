#!/usr/bin/env node
/**
 * Experiment 3: realistic payment schemas, offline (PREREG_EXP3.md).
 *
 * Re-declares the loose `wire_money` tool at rungs R1 (typed amount, currency,
 * payee) and R2 (R1 + structured remittance), in variant P (parsed from the
 * free text, label-blind) and variant A (act-typed: a duplicate carries the
 * original act's typed fields), and recomputes the deployed decision rule from
 * the persisted scores. No model calls.
 *
 *   node src/experiments/paymentSchemas.js   → results/exp3_payment_schemas.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../tools.js";
import { runConfig, makeScoreLookup, decidePair, DEFAULT_CONFIG } from "../evaluate.js";
import { rate } from "../stats.js";
import { maxCertifiableCandidates } from "../conformal.js";
import { WIRE_RUNGS, buildPayeeRegistry, typeWirePair } from "../corpus/paymentTyping.js";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJsonl = (f) => readFileSync(resolve(base, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const ALPHA = 0.05;
const GAMMA = 0.05;
const JUDGES = ["openai_gpt_oss_120b", "openai_gpt_oss_20b", "qwen_qwen3_6_27b"];
const PRIMARY = JUDGES[0];
const RUNGS = ["R0", "R1", "R2"];
const VARIANTS = ["P", "A"];
const TOOL_NAMES = Object.keys(TOOLS);

const corpus = readJsonl("corpus/pairs.jsonl");
const scoreRows = readJsonl("corpus/scores.jsonl");
const registry = buildPayeeRegistry(corpus.filter((p) => p.tool === "wire_money").map((p) => p.a.beneficiary_text));

const fin = (x) => (x === Infinity ? "Infinity" : x);
const decl = (rung) => ({ ...TOOLS, wire_money: WIRE_RUNGS[rung] });
const pairsAt = (rung, variant) => corpus.map((p) => (p.tool === "wire_money"
  ? typeWirePair(p, rung, variant, registry)
  : { ...p }));

function shareResidual(set) {
  return rate(set.filter((p) => p.facts.residual).length, set.length);
}

/** Per-tool rates from one run's decisions, restricted to that tool's test pairs. */
function toolRates(pairs, decisionsById, tool) {
  const test = pairs.filter((p) => p.tool === tool && p.split === "test");
  const diff = test.filter((p) => p.label === "DIFF");
  const same = test.filter((p) => p.label === "SAME");
  const resDiff = diff.filter((p) => p.facts.residual);
  const d = (p) => decisionsById[p.id];
  return {
    wrongSuppression: rate(diff.filter((p) => d(p) === "SUPPRESS").length, diff.length),
    residualWrongSuppression: rate(resDiff.filter((p) => d(p) === "SUPPRESS").length, resDiff.length),
    dedup: rate(same.filter((p) => d(p) === "SUPPRESS").length, same.length),
    silentEscape: rate(same.filter((p) => d(p) === "EXECUTE").length, same.length),
  };
}

function structure(pairs, tool) {
  const t = pairs.filter((p) => p.tool === tool);
  const by = (split, label) => t.filter((p) => p.split === split && p.label === label);
  const test = t.filter((p) => p.split === "test");
  const layer = (p) => (p.facts.certifies ? "certifier" : p.facts.refutes ? "refuter" : "residual");
  const split = {};
  for (const p of test) split[layer(p)] = (split[layer(p)] ?? 0) + 1;
  return {
    calDiffResidual: shareResidual(by("cal", "DIFF")),
    testDiffResidual: shareResidual(by("test", "DIFF")),
    testSameResidual: shareResidual(by("test", "SAME")),
    testLayerCounts: split,
  };
}

function runOne(rung, variant, judge) {
  const schemas = decl(rung);
  const scoreOf = makeScoreLookup(scoreRows, judge);

  // Pooled (deployed) calibration across all six tools.
  const pairs = pairsAt(rung, variant);
  const pooled = runConfig({ pairs, schemas, cfg: {}, judge, scoreOf, alpha: ALPHA, gamma: GAMMA });

  const perTool = {};
  for (const tool of TOOL_NAMES) {
    // Tool-conditional calibration: the pool is this tool's residual cal DIFF only.
    const own = pairsAt(rung, variant).filter((p) => p.tool === tool);
    const cond = runConfig({ pairs: own, schemas, cfg: {}, judge, scoreOf, alpha: ALPHA, gamma: GAMMA });
    perTool[tool] = {
      structure: structure(pairs, tool),
      pooled: toolRates(pairs, pooled.decisionsById, tool),
      toolConditional: {
        nCalDiff: cond.calibration.nCalDiff,
        certifiableM: maxCertifiableCandidates(cond.calibration.nCalDiff, ALPHA),
        tHi: fin(cond.calibration.tHi),
        tLo: fin(cond.calibration.tLo),
        ...toolRates(own, cond.decisionsById, tool),
      },
    };
  }

  const wireTest = pairs.filter((p) => p.tool === "wire_money" && p.split === "test");
  // The attack row runConfig reports pools every tool's D4b pairs; this is wire_money's alone.
  const wireAttacks = pairs.filter((p) => p.tool === "wire_money" && p.split === "attack");
  const decideAttack = (p) => decidePair(p, scoreOf, DEFAULT_CONFIG, pooled.calibration);
  const wireAttack = {
    n: wireAttacks.length,
    failure: rate(wireAttacks.filter((p) => decideAttack(p).decision === "SUPPRESS").length, wireAttacks.length),
    stoppedBy: wireAttacks.reduce((m, p) => { const b = decideAttack(p).by; m[b] = (m[b] ?? 0) + 1; return m; }, {}),
  };
  const perCategory = {};
  for (const p of wireTest) {
    const c = (perCategory[p.category] ??= { label: p.label, n: 0, certifier: 0, refuter: 0, residual: 0, SUPPRESS: 0, ESCALATE: 0, EXECUTE: 0 });
    c.n++;
    c[p.facts.certifies ? "certifier" : p.facts.refutes ? "refuter" : "residual"]++;
    c[pooled.decisionsById[p.id]]++;
  }

  return {
    pooled: {
      nCalDiff: pooled.calibration.nCalDiff,
      certifiableM: pooled.calibration.certifiableM,
      tHi: fin(pooled.calibration.tHi),
      tLo: fin(pooled.calibration.tLo),
      overall: pooled.overall,
      residual: pooled.residual,
      allToolsAttackD4b: pooled.attacks.D4b_text_injection ?? null,
      wireAttack,
    },
    perTool,
    wirePerCategory: perCategory,
    // Parser audit (§4.6): duplicates the label-blind parser refutes.
    sameRefutedByParser: variant === "P"
      ? pairs.filter((p) => p.tool === "wire_money" && p.label === "SAME" && p.facts.refutes).map((p) => p.id)
      : [],
  };
}

const results = {};
for (const rung of RUNGS) {
  results[rung] = {};
  for (const variant of (rung === "R0" ? ["P"] : VARIANTS)) {
    results[rung][variant] = {};
    for (const judge of JUDGES) results[rung][variant][judge] = runOne(rung, variant, judge);
  }
}

// ── A0: R0 must reproduce the published primary residual WS (4 of 144) ──────
const a0 = results.R0.P[PRIMARY].pooled.residual.wrongSuppression;
if (!(a0.successes === 4 && a0.n === 144)) {
  console.error(`A0 FAILED: R0 primary residual WS = ${a0.successes}/${a0.n}, expected 4/144`);
  process.exit(1);
}

// ── P5: variants A and P share the calibration pool and WS ────────────────────
const p5 = [];
for (const rung of ["R1", "R2"]) for (const judge of JUDGES) {
  const P = results[rung].P[judge], A = results[rung].A[judge];
  const same = P.pooled.nCalDiff === A.pooled.nCalDiff && P.pooled.tHi === A.pooled.tHi
    && P.pooled.overall.wrongSuppression.successes === A.pooled.overall.wrongSuppression.successes
    && P.perTool.wire_money.toolConditional.nCalDiff === A.perTool.wire_money.toolConditional.nCalDiff;
  const dedupOk = A.pooled.overall.dedup.value >= P.pooled.overall.dedup.value;
  p5.push({ rung, judge, poolAndWsIdentical: same, dedupAtLeastAsHigh: dedupOk });
}

// ── Predictions ──────────────────────────────────────────────────────────────
const wireRes = (rung) => results[rung].P[PRIMARY].perTool.wire_money.structure.testDiffResidual;
const cats = (rung) => results[rung].P[PRIMARY].wirePerCategory;
const wireN = (rung) => results[rung].P[PRIMARY].perTool.wire_money.toolConditional.nCalDiff;
const predictions = {
  P1_R1_residual_does_not_collapse: {
    R1_D2_residual: `${cats("R1").D2_legit_repeat?.residual}/${cats("R1").D2_legit_repeat?.n}`,
    R1_D3_residual: `${cats("R1").D3_semantic_diff?.residual}/${cats("R1").D3_semantic_diff?.n}`,
    R1_D1_residual: `${cats("R1").D1_near_miss?.residual}/${cats("R1").D1_near_miss?.n}`,
    confirmed: cats("R1").D2_legit_repeat?.residual === cats("R1").D2_legit_repeat?.n
      && cats("R1").D3_semantic_diff?.residual === cats("R1").D3_semantic_diff?.n,
  },
  P2_R2_moves_D2_D1ref_D4b_keeps_digitless_D3: {
    R2_D2_refuted: `${cats("R2").D2_legit_repeat?.refuter}/${cats("R2").D2_legit_repeat?.n}`,
    R2_D1_refuted: `${cats("R2").D1_near_miss?.refuter}/${cats("R2").D1_near_miss?.n}`,
    R2_D3_residual: `${cats("R2").D3_semantic_diff?.residual}/${cats("R2").D3_semantic_diff?.n}`,
    R2_D4b_stoppedBy: results.R2.P[PRIMARY].pooled.wireAttack?.stoppedBy,
    confirmed: cats("R2").D2_legit_repeat?.refuter === cats("R2").D2_legit_repeat?.n
      && cats("R2").D1_near_miss?.refuter === cats("R2").D1_near_miss?.n
      && (cats("R2").D3_semantic_diff?.residual ?? 0) > 0
      && results.R2.P[PRIMARY].pooled.wireAttack.stoppedBy.refuter === results.R2.P[PRIMARY].pooled.wireAttack.n,
  },
  P3_R2_residual_at_most_20pct_of_R0: {
    R0: wireRes("R0"), R2: wireRes("R2"),
    ratio: wireRes("R0").value ? wireRes("R2").value / wireRes("R0").value : null,
    confirmed: wireRes("R2").value <= 0.2 * wireRes("R0").value,
  },
  P4_R2_tool_pool_below_19: {
    nCalDiff: { R0: wireN("R0"), R1: wireN("R1"), R2: wireN("R2") },
    confirmed: wireN("R2") < 19,
  },
  P5_variants_share_pool_and_ws: { checks: p5, confirmed: p5.every((c) => c.poolAndWsIdentical && c.dedupAtLeastAsHigh) },
};

const out = {
  experiment: "Experiment 3: realistic payment schemas (offline re-analysis)",
  prereg: "PREREG_EXP3.md",
  alpha: ALPHA, gamma: GAMMA, judges: JUDGES, primary: PRIMARY,
  payeeRegistrySize: registry.size,
  a0: { primaryResidualWrongSuppressionR0: `${a0.successes}/${a0.n}`, reproduced: true },
  predictions,
  results,
  limitations: [
    "Re-analysis of persisted scores the author has seen in aggregate; not blind.",
    "Pairs that reach the judge keep scores computed on the free-text presentation; a judge shown typed inputs might score differently.",
    "Variant A uses the SAME label to give duplicates the original act's typed fields; it bounds deduplication and is not a decision rule.",
  ],
};
writeFileSync(resolve(base, "results/exp3_payment_schemas.json"), JSON.stringify(out, null, 2) + "\n");

// ── console summary ──────────────────────────────────────────────────────────
const pct = (r) => (r && r.n ? `${(100 * r.value).toFixed(1)}% (${r.successes}/${r.n})` : "n/a");
console.log(`A0 ok: R0 primary residual WS ${a0.successes}/${a0.n}`);
for (const rung of RUNGS) for (const variant of Object.keys(results[rung])) {
  const r = results[rung][variant][PRIMARY];
  const w = r.perTool.wire_money;
  console.log(`\n${rung}/${variant}  pooled n=${r.pooled.nCalDiff} tHi=${r.pooled.tHi}  WS=${pct(r.pooled.overall.wrongSuppression)} resWS=${pct(r.pooled.residual.wrongSuppression)} dedup=${pct(r.pooled.overall.dedup)}`);
  console.log(`  wire: testDIFF residual ${pct(w.structure.testDiffResidual)}  testSAME residual ${pct(w.structure.testSameResidual)}  layers ${JSON.stringify(w.structure.testLayerCounts)}`);
  console.log(`  wire pooled: WS ${pct(w.pooled.wrongSuppression)} dedup ${pct(w.pooled.dedup)} escape ${pct(w.pooled.silentEscape)}`);
  console.log(`  wire tool-cond: n=${w.toolConditional.nCalDiff} m*=${w.toolConditional.certifiableM} tHi=${w.toolConditional.tHi} WS ${pct(w.toolConditional.wrongSuppression)} dedup ${pct(w.toolConditional.dedup)}`);
  console.log(`  attack D4b: ${JSON.stringify(r.pooled.wireAttack?.stoppedBy)} fail ${pct(r.pooled.wireAttack?.failure)}`);
  if (r.sameRefutedByParser.length) console.log(`  parser-refuted SAME: ${r.sameRefutedByParser.length}`);
}
console.log("\nPredictions:");
for (const [k, v] of Object.entries(predictions)) console.log(`  ${k}: ${v.confirmed ? "CONFIRMED" : "NOT CONFIRMED"}`);
