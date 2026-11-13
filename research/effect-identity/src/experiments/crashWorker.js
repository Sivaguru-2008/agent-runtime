import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SemanticFence } from "../fence.js";
import { TOOLS } from "../tools.js";
import { lexicalScores, judgeScores } from "../judge.js";
import { GroqClient, groqAvailable, DEFAULT_JUDGE } from "../groq.js";
import { CRASH_POINTS } from "./crashPoints.js";

/**
 * One OS process of the paraphrased crash/replay experiment.
 *
 *   node crashWorker.js <phase seed|crash|replay> <dir> <mode> [--live]
 *
 * Three processes per trial, sharing only a directory on disk:
 *
 *   seed   — attempt 0. Wires $780 to Marlow Freight for shipment 88213 and
 *            commits it durably. Exits cleanly.
 *   crash  — attempt 1. A fresh process replays the run and, being a
 *            non-deterministic agent, re-emits the wire PARAPHRASED. It is
 *            hard-killed at the trial's crash point — if it gets there.
 *   replay — attempt 2. Another fresh process, another paraphrase, runs to
 *            completion.
 *
 * Exactly-once means ONE wire in the shared ledger after all three.
 *
 * Why three processes and not two. The crash points that matter most sit inside
 * the fence's own decision path (after the witness filters candidates, after
 * the judge scores them), and those layers only run when the dispatching
 * process has a non-empty candidate set — i.e. when it is already a replay.
 * A two-process design cannot reach them at all, so it cannot report them.
 *
 * A crash point may be UNREACHABLE in a given mode, and that is a result rather
 * than a gap: under the semantic fence a paraphrased replay is suppressed at
 * L1 and therefore never arrives at the dispatch-and-commit region where the
 * dangerous crash points live. The syntactic fence walks into every one of
 * them. The parent records reachability alongside the outcome.
 */

const [, , phase, dir, mode, liveFlag] = process.argv;
const live = liveFlag === "--live";
const worldPath = resolve(dir, "world.json");
const logPath = resolve(dir, `fence-${mode}.json`);
const RUN_ID = "order-88213"; // stable across all attempts — the application's order id
const WIRE_USD = 780;

const trial = JSON.parse(readFileSync(resolve(dir, "trial.json"), "utf8"));

if (!CRASH_POINTS.includes(trial.crashPoint)) throw new Error(`unknown crashPoint ${trial.crashPoint}`);

const world = {
  read: () => (existsSync(worldPath) ? JSON.parse(readFileSync(worldPath, "utf8")) : { wires: [], receipts: [] }),
  write: (w) => writeFileSync(worldPath, JSON.stringify(w, null, 2)),
};

/** The external effect: money leaves, once per call, recorded in a shared ledger. */
async function wireMoneyReal(input, ctx) {
  const w = world.read();
  const wireId = "wire_" + String(w.wires.length + 1).padStart(3, "0");
  w.wires.push({ wireId, pid: process.pid, phase, amountUSD: WIRE_USD, input });
  world.write(w);
  // The provider has applied the effect. A crash HERE — before the response is
  // returned to the caller — is the case the caller cannot distinguish from a
  // call that never landed.
  ctx?.duringExec?.();
  return { wireId, status: "SENT", amountUSD: WIRE_USD };
}

async function sendReceiptReal(input) {
  const w = world.read();
  const messageId = "rcpt_" + String(w.receipts.length + 1).padStart(3, "0");
  w.receipts.push({ messageId, pid: process.pid, to: input.to });
  world.write(w);
  return { messageId, status: "SENT" };
}

function makeScorer() {
  if (live && groqAvailable()) {
    const client = new GroqClient({ model: trial.judgeModel ?? DEFAULT_JUDGE });
    return {
      name: `groq:${client.model}`,
      client,
      scorer: (pairs) => judgeScores(client, pairs, { batchSize: 6 }),
    };
  }
  return { name: "lexical-offline", client: null, scorer: (pairs) => lexicalScores(pairs, TOOLS) };
}

const THRESHOLDS = trial.thresholds ?? (live ? { tHi: 0.5, tLo: 0.3 } : { tHi: 0.83, tLo: 0.55 });
const SCHEMAS = { ...TOOLS, send_receipt: { effect: "IRREVERSIBLE", fields: { to: "ci", note: "text" } } };

const WIRE_SEED_INPUT = {
  amount_text: "$780.00",
  beneficiary_text: "Marlow Freight",
  reference: "Shipment 88213",
};

async function main() {
  const { name, scorer, client } = makeScorer();
  const events = [];
  let reached = false;

  const writeOut = (extra = {}) => {
    writeFileSync(resolve(dir, `phase-${phase}-${mode}.json`), JSON.stringify({
      phase, pid: process.pid, scorer: name, mode,
      crashPoint: trial.crashPoint, reachedCrashPoint: reached, events,
      judgeCalls: client?.stats?.calls ?? 0,
      judgeTokens: (client?.stats?.inputTokens ?? 0) + (client?.stats?.outputTokens ?? 0),
      judgeLatencyMs: client?.stats?.totalLatencyMs ?? 0,
      ...extra,
    }, null, 2));
  };

  // Only the `crash` phase dies, and only at its assigned point.
  const crashAt = (point) => {
    if (phase !== "crash" || trial.crashPoint !== point) return;
    reached = true;
    writeOut();
    process.exit(1); // hard crash — no cleanup, no handshake
  };
  const hooks = phase === "crash"
    ? {
        afterL0: () => crashAt("after_L0"),
        afterWitness: () => crashAt("after_witness"),
        afterJudge: () => crashAt("after_judge"),
        beforeExec: () => crashAt("before_external_effect"),
        duringExec: () => crashAt("during_external_commit_window"),
        afterExec: () => crashAt("after_external_effect_before_local_commit"),
        afterCommit: () => crashAt("after_local_commit"),
      }
    : {};

  const fence = new SemanticFence({
    schemas: SCHEMAS,
    runId: RUN_ID,
    logPath,
    scorer,
    tHi: THRESHOLDS.tHi,
    tLo: THRESHOLDS.tLo,
    semantic: mode === "semantic",
    windowGuard: mode === "semantic" && trial.windowGuard !== false,
    onEvent: (e) => events.push(e),
    hooks,
  });

  if (phase === "seed") {
    await fence.dispatch("wire_money", WIRE_SEED_INPUT, (ctx) => wireMoneyReal(WIRE_SEED_INPUT, ctx));
    writeOut();
    process.exitCode = 0;
    return;
  }

  if (phase === "crash" || phase === "replay") {
    crashAt("before_fence");
    const input = phase === "crash" ? trial.paraphraseA : trial.paraphraseB;
    await fence.dispatch("wire_money", input, (ctx) => wireMoneyReal(input, ctx));
    if (phase === "replay") {
      const receiptInput = { to: "ops@example.com", note: "wire sent for shipment 88213" };
      await fence.dispatch("send_receipt", receiptInput, () => sendReceiptReal(receiptInput));
    }
    // Reaching here in the `crash` phase means the crash point was never
    // reached — the fence settled the dispatch before execution got there.
    writeOut();
    // Natural exit (no process.exit): avoids a libuv assertion on Windows when
    // undici's fetch handles are still unwinding after a live judge call.
    process.exitCode = 0;
    return;
  }

  throw new Error(`unknown phase ${phase}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
