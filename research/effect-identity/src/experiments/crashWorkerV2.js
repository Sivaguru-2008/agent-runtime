import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SemanticFence } from "../fence.js";
import { TOOLS } from "../tools.js";
import { lexicalScores, judgeScores, extractNumbers, newJudgeDiagnostics } from "../judge.js";
import { canonicalize, canonicalString, semanticProjection, tightenedProjection } from "../canonicalize.js";
import { GroqClient, groqAvailable, DEFAULT_JUDGE } from "../groq.js";
import { CRASH_POINTS } from "./crashPoints.js";

/**
 * One OS process of the crash/replay experiment, v2.
 *
 *   node crashWorkerV2.js <phase seed|crash|replay> <dir> <mode> [--live]
 *
 * What changed from v1, and why each change was necessary rather than tidy.
 *
 * 1. THE JUDGE IS THE DEPLOYED ONE. v1's reported run scored with the offline
 *    lexical scorer, so it measured the plumbing and not the mechanism: the
 *    prediction it was built to test (at-most-once at `after_local_commit`,
 *    which only a semantic decision can deliver) came back 0/6 because the
 *    scorer's threshold sat above almost every paraphrase score. That is a
 *    measurement of the stand-in. v2 runs the judge and the calibrated
 *    threshold the corpus evaluation actually produced.
 *
 * 2. THERE IS A DISTINCT ARM. v1 only ever replayed a TRUE duplicate, so it
 *    could not observe a wrong suppression even in principle — the safety-
 *    critical direction was unmeasurable by construction. v2 adds an arm whose
 *    replay is a genuinely DIFFERENT act (installment 2 of 2 against the same
 *    payee for the same amount: identical on every declared field of the loose
 *    wire schema, distinguished only in prose). Suppressing it is a missed
 *    legitimate effect, and that is the number a reader should most want.
 *
 * 3. RETRIES ARE CLASSIFIED. Each replay is recorded as `lexical` (canonically
 *    identical to what is committed — L0's fragment) or `semantic` (canonically
 *    different, so only the judge can recognise it). Averaging over the two
 *    hides which layer did the work.
 *
 * 4. THE PROJECTION IS A PARAMETER. `--projection tightened` runs the same
 *    trial under a schema that lifts the numbers out of prose, so the refuter's
 *    effect on the distinct arm is measured end-to-end under process death
 *    rather than inferred from the corpus.
 */

const [, , phase, dir, mode] = process.argv;
const live = process.argv.includes("--live");
const worldPath = resolve(dir, "world.json");
const logPath = resolve(dir, `fence-${mode}.json`);
const RUN_ID = "order-88213";

const trial = JSON.parse(readFileSync(resolve(dir, "trial.json"), "utf8"));
if (!CRASH_POINTS.includes(trial.crashPoint)) throw new Error(`unknown crashPoint ${trial.crashPoint}`);

const world = {
  read: () => (existsSync(worldPath) ? JSON.parse(readFileSync(worldPath, "utf8")) : { wires: [], receipts: [] }),
  write: (w) => writeFileSync(worldPath, JSON.stringify(w, null, 2)),
};

/**
 * The mock provider. It records every application of the effect, tagged with
 * the phase and the amount, so the ledger at the end is the ground truth for
 * "what actually happened in the world" — independent of anything the fence
 * believes. No idempotency key is presented: this is deliberately guarantee (C)
 * absent, which is the configuration T5 Case B describes.
 */
async function wireMoneyReal(input, ctx) {
  const w = world.read();
  const amountUSD = [...extractNumbers(input.amount_text)][0] ?? 0;
  w.wires.push({
    wireId: "wire_" + String(w.wires.length + 1).padStart(3, "0"),
    pid: process.pid, phase, amountUSD, act: trial.actOf?.[phase] ?? "unknown", input,
  });
  world.write(w);
  ctx?.duringExec?.();
  return { wireId: `wire_${w.wires.length}`, status: "SENT", amountUSD };
}

/**
 * The judge, with its non-answers counted.
 *
 * A judge that fails to reply is not a judge that said "different". The fence
 * treats an abstention as unjudgeable and escalates — execute, but flag — which
 * is the correct safety behaviour and is also indistinguishable, in the final
 * ledger, from a judge that answered and was wrong. The first run of this
 * experiment hit an eleven-trial provider outage and the two causes were mixed
 * together in the outcome column. Counting abstentions separately is what lets
 * a reader tell "the mechanism failed to recognise a paraphrase" from "the
 * oracle was unreachable", and those have opposite implications.
 */
function makeScorer() {
  if (live && groqAvailable()) {
    const client = new GroqClient({ model: trial.judgeModel ?? DEFAULT_JUDGE });
    const diag = newJudgeDiagnostics();
    return {
      name: `groq:${client.model}`, client, diag,
      scorer: (pairs) => judgeScores(client, pairs, { batchSize: 6, diagnostics: diag }),
    };
  }
  return { name: "lexical-offline", client: null, diag: null, scorer: (pairs) => lexicalScores(pairs, TOOLS) };
}

const SCHEMAS = { ...TOOLS };
const projectionFn = trial.projection === "tightened"
  ? (input, schema) => tightenedProjection(input, schema, extractNumbers)
  : semanticProjection;

async function main() {
  const { name, scorer, client, diag } = makeScorer();
  const events = [];
  const decisions = [];
  let reached = false;

  const writeOut = (extra = {}) => {
    writeFileSync(resolve(dir, `phase-${phase}-${mode}.json`), JSON.stringify({
      phase, pid: process.pid, scorer: name, mode, projection: trial.projection ?? "declared",
      crashPoint: trial.crashPoint, reachedCrashPoint: reached, events, decisions,
      judgeCalls: client?.stats?.calls ?? 0,
      judgeTokens: (client?.stats?.inputTokens ?? 0) + (client?.stats?.outputTokens ?? 0),
      judgeLatencyMs: client?.stats?.totalLatencyMs ?? 0,
      judgeAbstentions: diag?.abstentions ?? 0,
      judgeTransportFailures: diag?.transportFailures ?? 0,
      judgeBatchAttempts: diag?.batchAttempts ?? 0,
      ...extra,
    }, null, 2));
  };

  /**
   * A hard kill, and it has to be a real one.
   *
   * `process.exit()` runs libuv's teardown, which on Windows asserts and aborts
   * when a live judge's undici handles are still unwinding — the process dies,
   * but with an abort code, and worse, it dies through a path a crashing
   * process would not take. `SIGKILL` maps to TerminateProcess: the process
   * stops where it stands, which is the event being simulated. The durable
   * state is already written by the time we get here, so the parent can still
   * see that the crash point was reached.
   */
  const crashAt = (point) => {
    if (phase !== "crash" || trial.crashPoint !== point) return;
    reached = true;
    writeOut();
    process.kill(process.pid, "SIGKILL");
    // Unreachable in practice; a belt-and-braces stop in case a platform
    // declines the signal, so execution can never continue past a crash point.
    process.exit(1);
  };
  const hooks = phase === "crash" ? {
    afterL0: () => crashAt("after_L0"),
    afterWitness: () => crashAt("after_witness"),
    afterJudge: ({ scores }) => { decisions.push({ kind: "judge_scores", scores }); crashAt("after_judge"); },
    beforeExec: () => crashAt("before_external_effect"),
    duringExec: () => crashAt("during_external_commit_window"),
    afterExec: () => crashAt("after_external_effect_before_local_commit"),
    afterCommit: () => crashAt("after_local_commit"),
  } : { afterJudge: ({ scores }) => decisions.push({ kind: "judge_scores", scores }) };

  const fence = new SemanticFence({
    schemas: SCHEMAS, runId: RUN_ID, logPath, scorer,
    tHi: trial.thresholds.tHi, tLo: trial.thresholds.tLo,
    semantic: mode === "semantic",
    witness: mode === "semantic",
    windowGuard: mode === "semantic" && trial.windowGuard !== false,
    projection: projectionFn,
    onEvent: (e) => events.push(e),
    hooks,
  });

  const inputFor = { seed: trial.seedInput, crash: trial.crashInput, replay: trial.replayInput }[phase];
  if (phase === "seed") { await fence.dispatch("wire_money", inputFor, (ctx) => wireMoneyReal(inputFor, ctx)); writeOut(); process.exitCode = 0; return; }
  if (phase === "crash" || phase === "replay") {
    crashAt("before_fence");
    // Classify the retry BEFORE dispatching: is it canonically identical to the
    // seed (L0's fragment) or only semantically identical (the judge's)?
    const canonSeed = canonicalString(canonicalize(trial.seedInput, SCHEMAS.wire_money));
    const canonNow = canonicalString(canonicalize(inputFor, SCHEMAS.wire_money));
    decisions.push({ kind: "retry_class", retry: canonSeed === canonNow ? "lexical" : "semantic" });
    await fence.dispatch("wire_money", inputFor, (ctx) => wireMoneyReal(inputFor, ctx));
    writeOut();
    process.exitCode = 0;
    return;
  }
  throw new Error(`unknown phase ${phase}`);
}

main().catch((err) => { console.error(err); process.exit(2); });
