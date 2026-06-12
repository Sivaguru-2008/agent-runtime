/**
 * ──────────────────────────────────────────────────────────────────────────
 *  DEMO: the agent stuck in a loop burning money — caught live, not on the bill.
 * ──────────────────────────────────────────────────────────────────────────
 *
 *  Run it:   cd apps/api && npm run demo:loop
 *
 *  What's real here vs. mocked:
 *    REAL  → ExecutionLoopDetector  (apps/api/src/runtime/failure/analyzers/executionLoopDetector.ts)
 *    REAL  → the FailureSignal it emits (severity, score, summary, evidence)
 *    mock  → the agent run (a synthetic event stream of a refund agent that
 *            keeps retrying the same failing gateway call)
 *
 *  The point: an agent that loops keeps re-sending its whole context to the
 *  model every iteration. Nobody watches it at 2am. Without detection it spins
 *  until a human sees the billing spike the next morning. Your detector trips
 *  on the SAME event stream in a handful of iterations — automatically, on
 *  every execution in the fleet.
 */

import { ExecutionLoopDetector } from "../src/runtime/failure/analyzers/executionLoopDetector.js";
import type { DomainEvent, DomainEventType } from "../src/domain/events.js";
import type { AnalyzerContext, FailureSignal } from "../src/domain/failure.js";

// ── Cost model (stated, directional — not a guarantee). A looping agent
//    re-sends its full context every turn, so each wasted turn is real spend.
const TOKENS_PER_TURN = 6_000;
const USD_PER_1K_TOKENS = 0.015; // ~blended frontier rate

const dollars = (tokens: number): string =>
  `$${((tokens / 1000) * USD_PER_1K_TOKENS).toFixed(2)}`;

const EXEC_ID = "exec_refund_bot_2025_11_03";
const CTX: AnalyzerContext = { executionId: EXEC_ID, detectedAt: "2025-11-03T02:14:00.000Z" };

let seq = 0;
function makeEvent(type: DomainEventType, payload: Record<string, unknown>): DomainEvent {
  seq += 1;
  return {
    id: `evt_${seq}`,
    type,
    aggregateId: EXEC_ID,
    aggregateType: "EXECUTION",
    version: seq,
    timestamp: new Date(Date.parse(CTX.detectedAt) + seq * 1000).toISOString(),
    payload,
    metadata: {
      traceId: "trace_refund_bot",
      correlationId: EXEC_ID,
      schemaVersion: 1,
      source: "demo",
      idempotencyKey: `idem_${type}_${seq}`
    },
    sequence: seq
  };
}

// One turn of the runaway loop: the gateway times out, the model re-plans with
// the exact same output, and nothing advances. (normalizeError strips the txn
// id so every retry collapses to the same error class — that's the signal.)
function appendRunawayTurn(events: DomainEvent[], turn: number): void {
  events.push(
    makeEvent("TOOL_CALLED", {
      toolCall: { toolName: "payment.refund", input: { orderId: "ord_8841", amountCents: 4200 } }
    })
  );
  events.push(
    makeEvent("RETRY_TRIGGERED", {
      error: `PaymentGatewayError: gateway timeout (txn 7f3a9c${turn}d2e1)`
    })
  );
  events.push(
    makeEvent("MODEL_COMPLETED", {
      output: { plan: "retry refund for order ord_8841 via primary gateway" },
      tokenUsage: { total: TOKENS_PER_TURN }
    })
  );
}

function highestSeverity(signals: FailureSignal[]): FailureSignal | undefined {
  const rank = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as const;
  return signals
    .slice()
    .sort((a, b) => rank[b.severity] - rank[a.severity])[0];
}

function banner(title: string): void {
  console.log("\n" + "─".repeat(74));
  console.log(title);
  console.log("─".repeat(74));
}

async function main(): Promise<void> {
  const detector = new ExecutionLoopDetector();

  console.log("\n  FleetView — runaway-loop guardrail (live demo)\n");
  console.log("  Scenario: a refund agent's payment gateway keeps timing out. The agent");
  console.log("  retries the identical call and re-plans with the identical output, 2am,");
  console.log("  nobody watching. Each turn re-sends the full context to the model.\n");

  // ── 1. WITHOUT detection: it spins until a human notices the bill. ──────────
  banner("  1.  WITHOUT detection  (spins until someone sees the billing spike)");
  const TURNS_UNTIL_HUMAN = 60;
  const blind: DomainEvent[] = [];
  for (let t = 1; t <= TURNS_UNTIL_HUMAN; t++) appendRunawayTurn(blind, t);
  const wastedBlind = TURNS_UNTIL_HUMAN * TOKENS_PER_TURN;
  console.log(`   🔁  Agent looped ${TURNS_UNTIL_HUMAN} times overnight before anyone looked.`);
  console.log(`   💸  Burned ~${wastedBlind.toLocaleString("en-US")} tokens (~${dollars(wastedBlind)}) on one stuck run.`);
  console.log(`   🕑  Time to detection: the next morning, by hand, from the cost alert.`);

  // ── 2. WITH detection: the real detector trips after a few turns. ───────────
  banner("  2.  WITH detection  (ExecutionLoopDetector runs on the live stream)");
  const live: DomainEvent[] = [];
  let trippedAt = 0;
  let firing: FailureSignal | undefined;

  for (let t = 1; t <= TURNS_UNTIL_HUMAN; t++) {
    appendRunawayTurn(live, t);
    const signals = detector.analyze(live, undefined, CTX);
    const sev = highestSeverity(signals);
    if (sev && (sev.severity === "HIGH" || sev.severity === "CRITICAL")) {
      trippedAt = t;
      firing = sev;
      break;
    }
  }

  const wastedLive = trippedAt * TOKENS_PER_TURN;
  if (firing) {
    console.log(`   🚨  Detector fired at turn ${trippedAt} — execution aborted automatically.`);
    console.log(`        kind:     ${firing.kind}`);
    console.log(`        severity: ${firing.severity}   score: ${firing.score.toFixed(2)}`);
    console.log(`        summary:  ${firing.summary}`);
    console.log(`   💸  Spend on this run: ~${wastedLive.toLocaleString("en-US")} tokens (~${dollars(wastedLive)}).`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const saved = wastedBlind - wastedLive;
  banner("  What just happened");
  console.log(`   • Same stuck agent, same event stream. The detector caught it at`);
  console.log(`     turn ${trippedAt} instead of turn ${TURNS_UNTIL_HUMAN}.`);
  console.log(`   • ~${saved.toLocaleString("en-US")} tokens (~${dollars(saved)}) saved on a single run —`);
  console.log(`     and it fires the same way on every execution in the fleet, with no`);
  console.log(`     human watching at 2am.`);
  console.log(`   • The signal carries evidence (which turns repeated, est. wasted tokens)`);
  console.log(`     so triage knows exactly what the agent kept trying.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
