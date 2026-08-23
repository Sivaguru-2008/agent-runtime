import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadParaphrasePool } from "./wireParaphrases.js";
import { rate, fmtRate } from "../stats.js";
import { groqAvailable, JUDGE_MODELS } from "../groq.js";
import { judgeKey } from "../judge.js";
import { CRASH_POINTS, COMMIT_WINDOW_POINTS } from "./crashPoints.js";

/**
 * Paraphrased crash/replay, v2 — the deployed configuration, and both error
 * directions.
 *
 *   node src/experiments/crashReplayV2.js [--trials N] [--judge M]
 *        [--pool-generator M] [--arms duplicate,distinct]
 *        [--projection declared|tightened] [--offline]
 *
 * Three OS processes per trial sharing only a directory on disk (seed, crash,
 * replay). Two ARMS, run on the same crash points and the same paraphrase
 * draws:
 *
 *   duplicate — the replay denotes the SAME act as the seed. The correct
 *               outcome is one wire; a second wire is a duplicate effect.
 *   distinct  — the replay denotes a DIFFERENT act (the second installment of a
 *               two-part payment: same payee, same amount, same reference,
 *               distinguished only in prose — the residual, by construction).
 *               The correct outcome is TWO wires. One wire is a MISSED
 *               LEGITIMATE EFFECT, i.e. a wrong suppression, and it is the
 *               error the v1 experiment could not observe even in principle.
 *
 * The two arms are why the report below is split rather than summarised into a
 * single "exactly-once rate". Guarantee (A) is identity recognition and is
 * judged per arm; (B) is the fence's local commitment behaviour and is judged
 * from the durable log; (C) is the provider's, and this harness deliberately
 * runs a provider with NO idempotency contract so the window stays open and
 * visible rather than being closed by an assumption.
 */

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..", "..");
const workerPath = resolve(here, "crashWorkerV2.js");
const live = !process.argv.includes("--offline");
const argAfter = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const N_TRIALS = Number(argAfter("--trials", "48"));
const JUDGE_MODEL = argAfter("--judge", "openai/gpt-oss-120b");
const POOL_GENERATOR = argAfter("--pool-generator", "llama-3.3-70b-versatile");
const PROJECTION = argAfter("--projection", "declared");
const ARMS = argAfter("--arms", "duplicate,distinct").split(",");
const OUT_NAME = argAfter("--out", "crash_replay_v2.json");
const MODES = ["syntactic", "semantic"];
const PHASES = ["seed", "crash", "replay"];

const SEED_ACT = {
  amount_text: "$780.00",
  beneficiary_text: "Marlow Freight",
  reference: "Shipment 88213 — installment 1 of 2",
};

/**
 * Thresholds come from the JURISDICTION-MATCHED hardened configuration of the
 * corpus evaluation, not from the witness-free layered one. Running the
 * headline crash experiment at a threshold no reported configuration uses
 * would make its result unattributable to anything in the paper.
 */
function calibratedThresholds() {
  const path = resolve(base, "results", "residual_calibration.json");
  const key = `${judgeKey(JUDGE_MODEL)}_a0.05_residualOnly`;
  if (existsSync(path)) {
    const rc = JSON.parse(readFileSync(path, "utf8"));
    const cfg = rc.configs?.[key];
    if (cfg && Number.isFinite(cfg.tHi)) {
      return {
        tHi: cfg.tHi, tLo: cfg.tLo, nCalDiff: cfg.nCalDiff,
        certifiableM: cfg.certifiableM, source: `residual_calibration:${key}`,
      };
    }
  }
  return { tHi: live ? 0.8 : 0.9, tLo: live ? 0.8 : 0.55, source: "fallback-defaults" };
}

const withInstallment = (p, n) => ({ ...p, reference: `${p.reference} — installment ${n} of 2` });
const asSecondInstallment = (p) => ({ ...p, reference: String(p.reference).replace(/installment 1 of 2/i, "installment 2 of 2") });

function runTrial(mode, dir, spec) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "trial.json"), JSON.stringify(spec, null, 2));
  const phaseOut = {};
  const exitCodes = {};
  for (const phase of PHASES) {
    const p = spawnSync(process.execPath, [workerPath, phase, dir, mode, ...(live ? ["--live"] : [])], { encoding: "utf8" });
    // The `crash` phase is SUPPOSED to die, and a hard kill has no defined exit
    // code: SIGKILL, an abort from libuv teardown, and a clean exit (the fence
    // settled the dispatch before the crash point was reached) are all valid
    // outcomes. Only the two survivor phases must exit cleanly. What decides
    // whether a crash trial is usable is its durable state, checked below.
    exitCodes[phase] = p.status;
    if (phase !== "crash" && p.status !== 0) {
      throw new Error(`phase ${phase} (${mode}) exited ${p.status}: ${p.stderr?.slice(0, 500)}`);
    }
    const f = resolve(dir, `phase-${phase}-${mode}.json`);
    phaseOut[phase] = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  }
  const world = JSON.parse(readFileSync(resolve(dir, "world.json"), "utf8"));
  const fenceLog = JSON.parse(readFileSync(resolve(dir, `fence-${mode}.json`), "utf8"));
  const events = PHASES.flatMap((p) => phaseOut[p]?.events ?? []);
  const decisions = PHASES.flatMap((p) => (phaseOut[p]?.decisions ?? []).map((d) => ({ ...d, phase: p })));
  const seedPid = phaseOut.seed?.pid;

  const actsWired = {};
  for (const w of world.wires) actsWired[w.act] = (actsWired[w.act] ?? 0) + 1;

  return {
    mode,
    exitCodes,
    scorer: phaseOut.replay?.scorer ?? phaseOut.crash?.scorer ?? null,
    reachedCrashPoint: phaseOut.crash?.reachedCrashPoint ?? false,
    // ── external execution semantics: guarantee (C)'s evidence ─────────────
    externalEffects: world.wires.length,
    externalByAct: actsWired,
    totalWiredUSD: world.wires.reduce((s, w) => s + w.amountUSD, 0),
    // ── local fence behaviour: guarantee (B)'s evidence ────────────────────
    localCommits: Object.keys(fenceLog.committed).length,
    pendingOrphans: fenceLog.intents.filter((i) => i.status === "PENDING" && !fenceLog.committed[i.operationId]).length,
    commitConflicts: fenceLog.intents.filter((i) => i.status === "COMMIT_CONFLICT").length,
    // ── identity recognition: guarantee (A)'s evidence ─────────────────────
    suppressions: events.filter((e) => e.type === "SUPPRESSED").length,
    suppressionLayers: events.filter((e) => e.type === "SUPPRESSED").map((e) => e.layer),
    suppressionScores: events.filter((e) => e.type === "SUPPRESSED").map((e) => e.score ?? null),
    escalations: events.filter((e) => e.type === "ESCALATED").length,
    escalationScores: events.filter((e) => e.type === "ESCALATED").map((e) => e.score ?? null),
    windowSuspectFlagged: events.some((e) => e.type === "WINDOW_SUSPECT"),
    judgeScores: decisions.filter((d) => d.kind === "judge_scores").flatMap((d) => d.scores ?? []),
    retryClasses: decisions.filter((d) => d.kind === "retry_class").map((d) => `${d.phase}:${d.retry}`),
    crossProcess: events.some((e) => e.type === "SUPPRESSED" && e.pid !== seedPid),
    judgeCalls: PHASES.reduce((a, p) => a + (phaseOut[p]?.judgeCalls ?? 0), 0),
    judgeAbstentions: PHASES.reduce((a, p) => a + (phaseOut[p]?.judgeAbstentions ?? 0), 0),
    judgeTransportFailures: PHASES.reduce((a, p) => a + (phaseOut[p]?.judgeTransportFailures ?? 0), 0),
    judgeTokens: PHASES.reduce((a, p) => a + (phaseOut[p]?.judgeTokens ?? 0), 0),
    judgeLatencyMs: PHASES.reduce((a, p) => a + (phaseOut[p]?.judgeLatencyMs ?? 0), 0),
  };
}

async function main() {
  const pool = await loadParaphrasePool({ size: 40, generator: POOL_GENERATOR });
  const thresholds = calibratedThresholds();
  const judgeFamily = JUDGE_MODELS[JUDGE_MODEL]?.family ?? "unknown";
  const poolFamily = JUDGE_MODELS[pool.generator]?.family ?? pool.generator;
  process.stdout.write(
    `judge=${live && groqAvailable() ? JUDGE_MODEL : "lexical-offline"} (family=${judgeFamily})  projection=${PROJECTION}\n` +
    `pool=${pool.pool.length} variants (generator=${pool.generator}, family=${poolFamily})  cross-family=${poolFamily !== judgeFamily ? "YES" : "NO"}\n` +
    `thresholds tHi=${thresholds.tHi} tLo=${thresholds.tLo} (source=${thresholds.source})\n` +
    `arms=${ARMS.join(",")}  trials=${N_TRIALS} per arm\n\n`
  );
  if (pool.pool.length < 2) throw new Error("paraphrase pool needs at least 2 variants");

  let s = 20260818;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const drawPair = () => {
    const i = Math.floor(rnd() * pool.pool.length);
    let j = Math.floor(rnd() * pool.pool.length);
    if (j === i) j = (j + 1) % pool.pool.length;
    return [pool.pool[i], pool.pool[j]];
  };

  const trials = [];
  for (const arm of ARMS) {
    for (let t = 0; t < N_TRIALS; t++) {
      const [pa, pb] = drawPair();
      // Both arms replay a PARAPHRASE. They differ only in whether that
      // paraphrase denotes the seed's act or the second installment.
      const crashInput = arm === "duplicate" ? withInstallment(pa, 1) : asSecondInstallment(withInstallment(pa, 1));
      const replayInput = arm === "duplicate" ? withInstallment(pb, 1) : asSecondInstallment(withInstallment(pb, 1));
      const spec = {
        trial: t, arm, projection: PROJECTION,
        seedInput: SEED_ACT, crashInput, replayInput,
        actOf: {
          seed: "act1",
          crash: arm === "duplicate" ? "act1" : "act2",
          replay: arm === "duplicate" ? "act1" : "act2",
        },
        crashPoint: CRASH_POINTS[t % CRASH_POINTS.length],
        thresholds: { tHi: thresholds.tHi, tLo: thresholds.tLo },
        judgeModel: JUDGE_MODEL, windowGuard: true,
      };
      const perMode = {};
      for (const mode of MODES) perMode[mode] = runTrial(mode, resolve(base, "results", `crashv2-${arm}-${mode}`), spec);
      trials.push({ ...spec, modes: perMode });
      process.stdout.write(
        `${arm.padEnd(9)} ${String(t + 1).padStart(3)}/${N_TRIALS} ${spec.crashPoint.padEnd(42)} ` +
        MODES.map((m) => `${m[0]}:wires=${perMode[m].externalEffects}`).join(" ") +
        ` sup=${perMode.semantic.suppressions}${perMode.semantic.reachedCrashPoint ? "" : " *"}\n`
      );
    }
  }

  // ── Aggregation ───────────────────────────────────────────────────────────
  // Correctness is arm-specific and stated as such: a duplicate-arm trial is
  // correct with ONE external effect, a distinct-arm trial with TWO.
  const correct = (arm) => (r) => (arm === "duplicate" ? r.externalEffects === 1 : r.externalEffects === 2);
  const missedLegit = (r) => (r.externalByAct.act2 ?? 0) === 0;
  // A duplicate is ANY act applied more than once, not only the seed's. In the
  // distinct arm the act that gets duplicated is the second installment (the
  // crash phase fires it, dies before its commit row lands, and the replay
  // fires it again), so keying this on act1 alone reports 0% duplicates for
  // exactly the trials where the commit window is doing its damage.
  const dupEffect = (r) => Object.values(r.externalByAct).some((c) => c > 1);

  const pack = (rows, arm) => ({
    nTrials: rows.length,
    correctFinalState: rate(rows.filter(correct(arm)).length, rows.length),
    duplicateExternalEffect: rate(rows.filter(dupEffect).length, rows.length),
    // Whether the crashing process ever ARRIVED at its assigned crash point.
    // This is the single most misreadable number in the experiment. In the
    // duplicate arm the semantic fence suppresses the replay at L1, so the
    // process never reaches the dispatch-and-commit region where the window
    // points live — and the trial then scores "correct inside the window"
    // without the window having been entered at all. That is not the fence
    // closing the window; it is the fence never opening it. The two must be
    // reported together or the commit-window row is a fabrication.
    crashPointReached: rate(rows.filter((r) => r.reachedCrashPoint).length, rows.length),
    missedLegitimateEffect: arm === "distinct" ? rate(rows.filter(missedLegit).length, rows.length) : null,
    meanExternalEffects: rows.length ? rows.reduce((a, r) => a + r.externalEffects, 0) / rows.length : 0,
    totalWiredUSD: rows.reduce((a, r) => a + r.totalWiredUSD, 0),
    suppressionTrials: rate(rows.filter((r) => r.suppressions > 0).length, rows.length),
    escalationTrials: rate(rows.filter((r) => r.escalations > 0).length, rows.length),
    windowFlagged: rate(rows.filter((r) => r.windowSuspectFlagged).length, rows.length),
    pendingOrphanTrials: rows.filter((r) => r.pendingOrphans > 0).length,
    commitConflictTrials: rows.filter((r) => r.commitConflicts > 0).length,
    atMostOneCommitRowPerAct: rate(rows.filter((r) => r.localCommits <= (arm === "duplicate" ? 1 : 2)).length, rows.length),
    crossProcessSuppressions: rows.filter((r) => r.crossProcess).length,
    semanticRetryTrials: rows.filter((r) => r.retryClasses.some((c) => c.endsWith("semantic"))).length,
    lexicalRetryTrials: rows.filter((r) => r.retryClasses.some((c) => c.endsWith("lexical"))).length,
    meanJudgeCalls: rows.length ? rows.reduce((a, r) => a + r.judgeCalls, 0) / rows.length : 0,
    // Trials in which at least one comparison went unjudged. Reported beside the
    // outcome because an unjudged trial cannot bear on identity recognition:
    // the mechanism was not asked. Excluding them silently would be worse — the
    // rate would look better for a reason unrelated to the mechanism — so both
    // the all-trials and judged-only rates are computed.
    abstentionTrials: rows.filter((r) => r.judgeAbstentions > 0).length,
    transportFailures: rows.reduce((a, r) => a + r.judgeTransportFailures, 0),
    correctFinalStateJudgedOnly: (() => {
      const judged = rows.filter((r) => r.judgeAbstentions === 0);
      return rate(judged.filter(correct(arm)).length, judged.length);
    })(),
    meanJudgeLatencyMs: rows.length ? rows.reduce((a, r) => a + r.judgeLatencyMs, 0) / rows.length : 0,
    judgeScoreSample: rows.flatMap((r) => r.judgeScores).slice(0, 40),
  });

  const byArm = {};
  for (const arm of ARMS) {
    byArm[arm] = { byCrashPoint: {}, overall: {}, outsideWindow: {}, insideWindow: {} };
    for (const mode of MODES) {
      const all = trials.filter((t) => t.arm === arm).map((t) => t.modes[mode]);
      const out = trials.filter((t) => t.arm === arm && !COMMIT_WINDOW_POINTS.has(t.crashPoint)).map((t) => t.modes[mode]);
      const ins = trials.filter((t) => t.arm === arm && COMMIT_WINDOW_POINTS.has(t.crashPoint)).map((t) => t.modes[mode]);
      byArm[arm].overall[mode] = pack(all, arm);
      byArm[arm].outsideWindow[mode] = pack(out, arm);
      byArm[arm].insideWindow[mode] = pack(ins, arm);
    }
    for (const cp of CRASH_POINTS) {
      byArm[arm].byCrashPoint[cp] = { isCommitWindow: COMMIT_WINDOW_POINTS.has(cp) };
      for (const mode of MODES) {
        const rows = trials.filter((t) => t.arm === arm && t.crashPoint === cp).map((t) => t.modes[mode]);
        if (rows.length) byArm[arm].byCrashPoint[cp][mode] = pack(rows, arm);
      }
    }
  }

  const results = {
    generatedAt: new Date().toISOString(),
    live, judge: live && groqAvailable() ? JUDGE_MODEL : "lexical-offline", judgeFamily,
    projection: PROJECTION, arms: ARMS, nTrialsPerArm: N_TRIALS,
    paraphrasePool: { generator: pool.generator, family: poolFamily, size: pool.pool.length, rejected: pool.rejected },
    crossFamily: poolFamily !== judgeFamily,
    thresholds, crashPoints: CRASH_POINTS, commitWindowPoints: [...COMMIT_WINDOW_POINTS],
    byArm, trials,
  };
  writeFileSync(resolve(base, "results", OUT_NAME), JSON.stringify(results, null, 2));

  for (const arm of ARMS) {
    console.log(`\n== ARM: ${arm} — correct final state = ${arm === "duplicate" ? "1 wire" : "2 wires"} ==`);
    for (const cp of CRASH_POINTS) {
      for (const mode of MODES) {
        const m = byArm[arm].byCrashPoint[cp]?.[mode];
        if (!m) continue;
        console.log(
          `${cp.padEnd(44)} ${mode.padEnd(10)} n=${String(m.nTrials).padStart(2)} ` +
          `correct=${fmtRate(m.correctFinalState).padEnd(24)} dup=${fmtRate(m.duplicateExternalEffect).padEnd(22)} ` +
          `reached=${fmtRate(m.crashPointReached).padEnd(22)}` +
          (arm === "distinct" ? ` missed=${fmtRate(m.missedLegitimateEffect)}` : "")
        );
      }
    }
    for (const mode of MODES) {
      const o = byArm[arm].overall[mode], out = byArm[arm].outsideWindow[mode], ins = byArm[arm].insideWindow[mode];
      console.log(
        `${mode.padEnd(10)} all=${fmtRate(o.correctFinalState).padEnd(24)} outside=${fmtRate(out.correctFinalState).padEnd(24)} ` +
        `inside=${fmtRate(ins.correctFinalState).padEnd(22)} insideReached=${fmtRate(ins.crashPointReached).padEnd(22)} windowFlagged=${fmtRate(ins.windowFlagged)}`
      );
    }
  }
  console.log(`\nwritten: results/${OUT_NAME}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
