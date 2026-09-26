#!/usr/bin/env node
/**
 * analyze_human_study.js
 *
 * Standalone analysis tool for Channel H (Independent Human Validation) of:
 * "Effect Identity for LLM Agents: Schema-Determined Limits on Duplicate Suppression"
 * (Elsevier Artificial Intelligence Journal submission).
 *
 * Usage:
 *   node analyze_human_study.js [--submissions <dir>] [--key <file>] [--out <file>]
 *
 * Defaults:
 *   --submissions  ./submissions  (or ./ if responses-*.csv are in current dir)
 *   --key          ./key.jsonl
 *   --out          ./human_study_results.json
 *
 * Zero external dependencies: pure standard Node.js (>=18).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Statistical Utilities ───────────────────────────────────────────────────

const Z95 = 1.959963984540054;

export function wilson(successes, n, level = 0.95) {
  if (!Number.isFinite(n) || n <= 0) return null;
  const z = level === 0.95 ? Z95 : 1.96;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    point: p,
    lo: successes === 0 ? 0 : Math.max(0, centre - half),
    hi: successes === n ? 1 : Math.min(1, centre + half),
    n,
    successes,
  };
}

export function fmtRate(successes, n, digits = 1) {
  if (!Number.isFinite(n) || n === 0) return "n/a";
  const ci = wilson(successes, n);
  const p = (successes / n) * 100;
  const lo = (ci.lo * 100).toFixed(digits);
  const hi = (ci.hi * 100).toFixed(digits);
  return `${p.toFixed(digits)}% [${lo}–${hi}]`;
}

export function cohenKappa(a, b, categories = ["SAME", "DIFF", "UNSURE"]) {
  const n = a.length;
  if (n === 0) return null;
  let agree = 0;
  const pa = {}, pb = {};
  for (const c of categories) { pa[c] = 0; pb[c] = 0; }
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree += 1;
    pa[a[i]] = (pa[a[i]] ?? 0) + 1;
    pb[b[i]] = (pb[b[i]] ?? 0) + 1;
  }
  const po = agree / n;
  let pe = 0;
  for (const c of categories) pe += (pa[c] / n) * (pb[c] / n);
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

export function fleissKappa(matrix, categories = ["SAME", "DIFF", "UNSURE"]) {
  const N = matrix.length;
  if (N === 0) return null;
  const R = matrix[0].reduce((a, b) => a + b, 0);
  if (R < 2) return null;
  const pj = categories.map((_, j) => matrix.reduce((a, row) => a + row[j], 0) / (N * R));
  const Pi = matrix.map((row) => (row.reduce((a, n) => a + n * n, 0) - R) / (R * (R - 1)));
  const Pbar = Pi.reduce((a, b) => a + b, 0) / N;
  const PeBar = pj.reduce((a, p) => a + p * p, 0);
  return PeBar === 1 ? null : (Pbar - PeBar) / (1 - PeBar);
}

export function krippendorffAlpha(units, categories = ["SAME", "DIFF", "UNSURE"]) {
  const valued = units.map((u) => u.filter((v) => v !== null && v !== undefined));
  const usable = valued.filter((u) => u.length >= 2);
  if (usable.length === 0) return null;
  const nTotal = usable.reduce((a, u) => a + u.length, 0);
  if (nTotal < 2) return null;

  let Do = 0;
  for (const u of usable) {
    const m = u.length;
    let mismatched = 0;
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        if (i !== j && u[i] !== u[j]) mismatched += 1;
      }
    }
    Do += mismatched / (m - 1);
  }
  Do /= nTotal;

  const counts = Object.fromEntries(categories.map((c) => [c, 0]));
  for (const u of usable) for (const v of u) counts[v] = (counts[v] ?? 0) + 1;
  let De = 0;
  for (const a of categories) {
    for (const b of categories) {
      if (a !== b) De += (counts[a] ?? 0) * (counts[b] ?? 0);
    }
  }
  De /= nTotal * (nTotal - 1);

  return De === 0 ? null : 1 - Do / De;
}

// ── CSV Parser ──────────────────────────────────────────────────────────────

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.length));
}

// ── Catch Trials Specification ──────────────────────────────────────────────

const CATCH_TRIALS = [
  { item: "IT013", expect: "SAME", why: "purely presentational difference (key order / whitespace)" },
  { item: "IT022", expect: "SAME", why: "purely presentational difference (key order / whitespace)" },
  { item: "IT108", expect: "DIFF", why: "single numeric field 'nights' differs (2 vs 1)" },
];

const CATS = ["SAME", "DIFF", "UNSURE"];

// ── CLI Argument Parser ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const getArg = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };

  let subDir = getArg("--submissions", null);
  if (!subDir) {
    if (existsSync(resolve(__dirname, "submissions"))) subDir = resolve(__dirname, "submissions");
    else if (existsSync(resolve(__dirname, "..", "annotation"))) subDir = resolve(__dirname, "..", "annotation");
    else subDir = __dirname;
  } else {
    subDir = resolve(process.cwd(), subDir);
  }

  const keyPath = resolve(process.cwd(), getArg("--key", resolve(__dirname, "key.jsonl")));
  const outPath = resolve(process.cwd(), getArg("--out", resolve(__dirname, "human_study_results.json")));

  return { subDir, keyPath, outPath };
}

// ── Main Analysis Flow ──────────────────────────────────────────────────────

export function runAnalysis(options = {}) {
  const { subDir, keyPath, outPath } = { ...parseArgs(), ...options };

  console.log("===============================================================================");
  console.log(" EFFECT IDENTITY: CHANNEL H INDEPENDENT HUMAN VALIDATION AUDIT TOOL");
  console.log("===============================================================================");
  console.log(`Submissions directory : ${subDir}`);
  console.log(`Key file              : ${keyPath}`);
  console.log(`Output file           : ${outPath}\n`);

  if (!existsSync(keyPath)) {
    console.error(`ERROR: Key file not found at ${keyPath}`);
    process.exit(1);
  }

  // Load Key
  const rawKey = readFileSync(keyPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const keyMap = new Map(rawKey.map((k) => [k.item, k]));
  console.log(`Loaded key with ${keyMap.size} frozen evaluation items.`);

  // Find CSV responses
  if (!existsSync(subDir)) {
    console.log(`\nStatus: PENDING`);
    console.log(`Reason: Submissions directory does not exist (${subDir}).`);
    const pendingResult = {
      status: "PENDING",
      timestamp: new Date().toISOString(),
      reason: "No submissions directory found.",
      itemsInKey: keyMap.size,
    };
    if (outPath) writeFileSync(outPath, JSON.stringify(pendingResult, null, 2));
    return pendingResult;
  }

  const allFiles = readdirSync(subDir).filter((f) => /^responses-.+\.csv$/i.test(f));
  const raterFiles = allFiles.filter((f) => !/^responses-adjudicator/i.test(f));
  const adjFiles = allFiles.filter((f) => /^responses-adjudicator/i.test(f));

  if (raterFiles.length === 0) {
    console.log(`\nStatus: PENDING`);
    console.log(`Reason: No responses-*.csv files found in ${subDir}.`);
    console.log(`Awaiting independent human annotations.`);
    const pendingResult = {
      status: "PENDING",
      timestamp: new Date().toISOString(),
      reason: "No responses-*.csv present in submissions folder.",
      itemsInKey: keyMap.size,
    };
    if (outPath) writeFileSync(outPath, JSON.stringify(pendingResult, null, 2));
    return pendingResult;
  }

  console.log(`Discovered ${raterFiles.length} annotator response file(s) and ${adjFiles.length} adjudicator file(s).`);

  const readResponseFile = (filePath) => {
    const content = readFileSync(filePath, "utf8");
    const rows = parseCsv(content);
    if (rows.length < 2) return new Map();
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const iItem = header.indexOf("item");
    const iLabel = header.indexOf("label");
    if (iItem === -1 || iLabel === -1) {
      throw new Error(`File ${filePath} missing required 'item' or 'label' columns.`);
    }
    const map = new Map();
    for (const r of rows.slice(1)) {
      const item = (r[iItem] ?? "").trim();
      const label = (r[iLabel] ?? "").trim().toUpperCase();
      if (item && keyMap.has(item) && CATS.includes(label)) {
        map.set(item, label);
      }
    }
    return map;
  };

  const allAnnotators = {};
  for (const f of raterFiles) {
    const id = f.replace(/^responses-/i, "").replace(/\.csv$/i, "");
    allAnnotators[id] = readResponseFile(resolve(subDir, f));
  }

  const adjudicators = {};
  for (const f of adjFiles) {
    const id = f.replace(/^responses-/i, "").replace(/\.csv$/i, "");
    adjudicators[id] = readResponseFile(resolve(subDir, f));
  }

  // ── Step 1: Catch Trial Audit ─────────────────────────────────────────────
  console.log("\n--- STEP 1: CATCH TRIAL AUDIT (PREREGISTRATION §4) ---");
  const catchAudit = {};
  const droppedRaters = [];
  const validAnnotators = {};

  for (const [id, responses] of Object.entries(allAnnotators)) {
    const trialResults = CATCH_TRIALS.map((t) => ({
      item: t.item,
      expect: t.expect,
      got: responses.get(t.item) ?? null,
      passed: responses.get(t.item) === t.expect,
      why: t.why,
    }));
    const passedAll = trialResults.every((t) => t.passed);
    catchAudit[id] = { passed: passedAll, trials: trialResults };

    if (!passedAll) {
      droppedRaters.push({
        annotator: id,
        failedTrials: trialResults.filter((t) => !t.passed),
      });
      console.log(`[EXCLUDED] Annotator '${id}' FAILED catch trial(s). All responses dropped.`);
      for (const t of trialResults.filter((x) => !x.passed)) {
        console.log(`           - Item ${t.item}: Expected '${t.expect}', received '${t.got}' (${t.why})`);
      }
    } else {
      validAnnotators[id] = responses;
      console.log(`[PASSED]   Annotator '${id}' passed all ${CATCH_TRIALS.length} catch trials.`);
    }
  }

  const validRaterIds = Object.keys(validAnnotators);
  if (validRaterIds.length === 0) {
    console.log(`\nStatus: INCONCLUSIVE`);
    console.log(`Reason: All annotators failed catch trials. No admissible responses remain.`);
    const inconclusiveResult = {
      status: "INCONCLUSIVE",
      timestamp: new Date().toISOString(),
      reason: "All annotators failed catch trials.",
      catchAudit,
      droppedRaters,
    };
    if (outPath) writeFileSync(outPath, JSON.stringify(inconclusiveResult, null, 2));
    return inconclusiveResult;
  }

  // ── Step 2: Inter-Annotator Reliability ────────────────────────────────────
  console.log(`\n--- STEP 2: INTER-ANNOTATOR RELIABILITY (N = ${validRaterIds.length} raters) ---`);

  // Build matrix and unit vectors for items evaluated
  const itemIds = [...keyMap.keys()].sort();
  const agreementUnits = [];
  const fleissMatrix = [];

  for (const item of itemIds) {
    const unit = [];
    const counts = { SAME: 0, DIFF: 0, UNSURE: 0 };
    for (const rId of validRaterIds) {
      const resp = validAnnotators[rId].get(item);
      if (resp) {
        unit.push(resp);
        counts[resp] = (counts[resp] ?? 0) + 1;
      }
    }
    agreementUnits.push(unit);
    if (unit.length === validRaterIds.length) {
      fleissMatrix.push([counts.SAME, counts.DIFF, counts.UNSURE]);
    }
  }

  const kAlpha = krippendorffAlpha(agreementUnits, CATS);
  const fKappa = fleissKappa(fleissMatrix, CATS);

  console.log(`Krippendorff's alpha (nominal, ternary) : ${kAlpha !== null ? kAlpha.toFixed(4) : "n/a"}`);
  console.log(`Fleiss' kappa (complete ratings)        : ${fKappa !== null ? fKappa.toFixed(4) : "n/a"}`);

  // Pairwise Cohen's kappa
  const pairwiseKappas = {};
  for (let i = 0; i < validRaterIds.length; i++) {
    for (let j = i + 1; j < validRaterIds.length; j++) {
      const rA = validRaterIds[i], rB = validRaterIds[j];
      const pairedA = [], pairedB = [];
      for (const item of itemIds) {
        const vA = validAnnotators[rA].get(item);
        const vB = validAnnotators[rB].get(item);
        if (vA && vB) { pairedA.push(vA); pairedB.push(vB); }
      }
      const ck = cohenKappa(pairedA, pairedB, CATS);
      pairwiseKappas[`${rA}_vs_${rB}`] = ck;
      console.log(`Pairwise Cohen's kappa (${rA} vs ${rB}): ${ck !== null ? ck.toFixed(4) : "n/a"} (n = ${pairedA.length})`);
    }
  }

  // ── Step 3: Majority Voting, Adjudication, & Construction Agreement ────────
  console.log("\n--- STEP 3: CONSTRUCTION AGREEMENT & ADJUDICATION ---");
  const adjudicatedItems = [];
  const flips = [];
  const stratumStats = {};

  const adjId = Object.keys(adjudicators)[0] ?? null;
  const adjMap = adjId ? adjudicators[adjId] : null;

  for (const item of itemIds) {
    const meta = keyMap.get(item);
    const votes = validRaterIds.map((rId) => validAnnotators[rId].get(item)).filter(Boolean);
    const counts = { SAME: 0, DIFF: 0, UNSURE: 0 };
    for (const v of votes) counts[v] = (counts[v] ?? 0) + 1;

    let adjudicatedLabel = null;
    let adjudicationMethod = "majority";

    // Absolute majority
    const half = votes.length / 2;
    if (counts.SAME > half) adjudicatedLabel = "SAME";
    else if (counts.DIFF > half) adjudicatedLabel = "DIFF";
    else {
      // Split / tied vote: consult adjudicator if available
      if (adjMap && adjMap.has(item)) {
        adjudicatedLabel = adjMap.get(item);
        adjudicationMethod = "adjudicator";
      } else {
        adjudicatedLabel = "UNRESOLVED_SPLIT";
        adjudicationMethod = "unresolved";
      }
    }

    const agreeWithConstructed = (adjudicatedLabel === meta.constructedLabel);
    if (adjudicatedLabel !== "UNRESOLVED_SPLIT" && !agreeWithConstructed) {
      flips.push({
        item,
        pairId: meta.pairId,
        stratum: meta.stratum,
        tool: meta.tool,
        constructed: meta.constructedLabel,
        humanAdjudicated: adjudicatedLabel,
        votes: counts,
      });
    }

    const rec = {
      item,
      pairId: meta.pairId,
      stratum: meta.stratum,
      tool: meta.tool,
      constructedLabel: meta.constructedLabel,
      votes: counts,
      adjudicatedLabel,
      adjudicationMethod,
      agrees: agreeWithConstructed,
    };
    adjudicatedItems.push(rec);

    // Stratum aggregation
    stratumStats[meta.stratum] ??= { n: 0, agree: 0, flips: 0, unresolved: 0 };
    stratumStats[meta.stratum].n += 1;
    if (adjudicatedLabel === "UNRESOLVED_SPLIT") stratumStats[meta.stratum].unresolved += 1;
    else if (agreeWithConstructed) stratumStats[meta.stratum].agree += 1;
    else stratumStats[meta.stratum].flips += 1;
  }

  const resolvedItems = adjudicatedItems.filter((i) => i.adjudicatedLabel !== "UNRESOLVED_SPLIT");
  const overallAgree = resolvedItems.filter((i) => i.agrees).length;
  console.log(`Overall Agreement with Construction: ${fmtRate(overallAgree, resolvedItems.length)} (${overallAgree}/${resolvedItems.length})`);
  console.log(`Total Flips against Construction   : ${flips.length}`);

  console.log("\nStratum Breakdown:");
  console.log(String("Stratum").padEnd(22) + String("Items").padEnd(8) + String("Agree % [95% CI]").padEnd(25) + "Status");
  console.log("-".repeat(70));

  const contestedStrata = [];
  for (const [sName, sData] of Object.entries(stratumStats)) {
    const rateStr = fmtRate(sData.agree, sData.n - sData.unresolved);
    const ci = wilson(sData.agree, sData.n - sData.unresolved);
    const isContested = ci && ci.hi < 0.80;
    if (isContested) contestedStrata.push(sName);
    const status = isContested ? "CONTESTED (CI upper < 80%)" : "Supported";
    console.log(sName.padEnd(22) + String(sData.n).padEnd(8) + rateStr.padEnd(25) + status);
  }

  // ── Step 4: Primary Endpoint Check ─────────────────────────────────────────
  console.log("\n--- STEP 4: DECISION ENDPOINTS (PREREGISTRATION §5) ---");
  console.log(`Contested Strata: ${contestedStrata.length > 0 ? contestedStrata.join(", ") : "None"}`);
  if (flips.length > 0) {
    console.log(`\nDetailed Disagreements / Flips (${flips.length} total):`);
    for (const fl of flips) {
      console.log(`  [${fl.item}] ${fl.pairId} (${fl.stratum}/${fl.tool}): Constructed=${fl.constructed} -> Human=${fl.humanAdjudicated} (Votes: S=${fl.votes.SAME}, D=${fl.votes.DIFF}, U=${fl.votes.UNSURE})`);
    }
  }

  const result = {
    status: "COMPLETE",
    timestamp: new Date().toISOString(),
    numRaters: validRaterIds.length,
    droppedRaters,
    interAnnotatorReliability: {
      krippendorffAlpha: kAlpha,
      fleissKappa: fKappa,
      pairwiseCohenKappa: pairwiseKappas,
    },
    constructionAgreement: {
      totalItems: itemIds.length,
      resolvedItems: resolvedItems.length,
      overallAgreement: {
        successes: overallAgree,
        n: resolvedItems.length,
        rate: fmtRate(overallAgree, resolvedItems.length),
        ci: wilson(overallAgree, resolvedItems.length),
      },
      strata: stratumStats,
      contestedStrata,
    },
    flips,
    adjudicatedItems,
  };

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`\nResults written to: ${outPath}`);
  }

  return result;
}

// Direct execution from CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  runAnalysis();
}
