/**
 * ──────────────────────────────────────────────────────────────────────────
 *  DEMO: the double-charge your agent makes — and the guardrail that stops it.
 * ──────────────────────────────────────────────────────────────────────────
 *
 *  Run it:   cd apps/api && npm run demo
 *
 *  What's real here vs. mocked:
 *    REAL  → DedupingToolExecutor          (apps/api/src/runtime/toolDedupExecutor.ts)
 *    REAL  → IdempotencyPolicyEnforcer      (apps/api/src/runtime/policyEnforcer.ts)
 *    REAL  → side-effect capability registry (apps/api/src/runtime/canonicalSemantics.ts)
 *    mock  → the Stripe API (a counter, so nobody gets charged for real)
 *    mock  → the dedup store backing (in-memory; production uses Postgres)
 *
 *  The point: a retry / queue redelivery fires the SAME logical charge twice.
 *  Without the guardrail the customer is billed twice. With it, the second
 *  call never reaches Stripe — it returns the first call's recorded result.
 */

import { DedupingToolExecutor } from "../src/runtime/toolDedupExecutor.js";
import type {
  ToolCallDedupStore,
  ToolCallDedupBegin,
  ToolCallDedupRecord,
  BeginCallMode
} from "../src/domain/toolDedup.js";
import { sideEffectCapabilityRegistry } from "../src/runtime/canonicalSemantics.js";
import type { ToolExecutor } from "../src/domain/ports.js";

// ── A charge is a real-money side effect: safe to RETRY, never safe to DUPLICATE.
sideEffectCapabilityRegistry.register("payment.charge", "NON_IDEMPOTENT");

// ── Mock "Stripe": every real execution moves money. We count the money moved.
let stripeChargesFired = 0;
let ledgerCents = 0;

const stripe: ToolExecutor = {
  async execute(input) {
    stripeChargesFired += 1;
    const amountCents = Number(input.args.amountCents);
    ledgerCents += amountCents;
    console.log(
      `   💳  Stripe: CHARGING $${(amountCents / 100).toFixed(2)} to ${input.args.customerId}  ` +
        `(this call actually hit the payment API)`
    );
    return {
      chargeId: `ch_${stripeChargesFired}_${Date.now()}`,
      amountCents,
      status: "succeeded"
    };
  }
};

// ── In-memory dedup store — same contract as the production Postgres store
//    (apps/api/src/infrastructure/persistence/postgres/postgresToolCallDedupStore.ts).
class InMemoryDedupStore implements ToolCallDedupStore {
  private rows = new Map<string, ToolCallDedupRecord>();

  async beginCall(input: ToolCallDedupBegin): Promise<BeginCallMode> {
    const existing = this.rows.get(input.idempotencyKey);
    if (!existing) {
      this.rows.set(input.idempotencyKey, {
        idempotencyKey: input.idempotencyKey,
        executionId: input.executionId,
        agentId: input.agentId,
        toolName: input.toolName,
        attempt: input.attempt,
        status: "IN_FLIGHT",
        createdAt: new Date().toISOString(),
        tenantId: input.tenantId
      });
      return { mode: "FIRST_CALL" };
    }
    if ((existing.status === "COMPLETED" || existing.status === "SUCCEEDED") && existing.output) {
      return { mode: "RETURN_CACHED", output: existing.output };
    }
    return { mode: "POLL_FOR_RESULT", sinceMs: 0 };
  }

  async markCompleted(idempotencyKey: string, output: Record<string, unknown>): Promise<void> {
    const row = this.rows.get(idempotencyKey);
    if (row) {
      row.status = "COMPLETED";
      row.output = output;
      row.completedAt = new Date().toISOString();
    }
  }

  async markFailed(idempotencyKey: string, errorMessage: string): Promise<void> {
    const row = this.rows.get(idempotencyKey);
    if (row) {
      row.status = "FAILED";
      row.lastError = errorMessage;
    }
  }

  async get(idempotencyKey: string): Promise<ToolCallDedupRecord | undefined> {
    return this.rows.get(idempotencyKey);
  }
}

function banner(title: string): void {
  console.log("\n" + "─".repeat(74));
  console.log(title);
  console.log("─".repeat(74));
}

function resetLedger(): void {
  stripeChargesFired = 0;
  ledgerCents = 0;
}

// The logical charge the agent decided to make. A retry produces the SAME
// idempotency key — that identity is what the guardrail keys on.
const charge = {
  toolName: "payment.charge",
  args: { customerId: "cus_ada_lovelace", amountCents: 50_000 }, // $500.00
  executionId: "exec_refund_run_0042",
  agentId: "agent_billing_bot",
  idempotencyKey: "exec_refund_run_0042:step3:payment.charge",
  attempt: 1
};

async function main(): Promise<void> {
  console.log("\n  FleetView — duplicate side-effect guardrail (live demo)\n");
  console.log("  Scenario: a billing agent charges a customer $500. The job queue");
  console.log("  redelivers the message (crash + retry) so the SAME charge fires twice.");

  // ── 1. WITHOUT the guardrail: the agent calls Stripe directly. ──────────────
  banner("  1.  WITHOUT the guardrail  (agent → Stripe directly)");
  resetLedger();
  await stripe.execute(charge);            // first delivery
  await stripe.execute(charge);            // queue redelivery of the same charge
  console.log(
    `\n   ❌  Stripe was hit ${stripeChargesFired} times.  ` +
      `Customer billed $${(ledgerCents / 100).toFixed(2)} — DOUBLE CHARGED.`
  );

  // ── 2. WITH the guardrail: the same agent, wrapped. ─────────────────────────
  banner("  2.  WITH the guardrail  (agent → FleetView → Stripe)");
  resetLedger();
  const guarded = new DedupingToolExecutor(stripe, new InMemoryDedupStore());

  const first = await guarded.execute(charge);   // FIRST_CALL → Stripe fires once
  const second = await guarded.execute(charge);  // redelivery → returns cached, Stripe NOT hit

  console.log(
    `\n   ✅  Stripe was hit ${stripeChargesFired} time.  ` +
      `Customer billed $${(ledgerCents / 100).toFixed(2)} — charged exactly once.`
  );
  console.log(
    `   ↩  The redelivered call returned the recorded result instead of re-charging:`
  );
  console.log(`        first  charge id: ${(first as any).chargeId}`);
  console.log(`        second charge id: ${(second as any).chargeId}   ← identical, no new charge`);

  // ── Summary ─────────────────────────────────────────────────────────────────
  banner("  What just happened");
  console.log("   • Same code, same retry. The only difference was one wrapper.");
  console.log("   • The guardrail keyed on the call's idempotency identity, saw the");
  console.log("     charge had already committed, and returned the recorded result —");
  console.log("     the payment API was never touched a second time.");
  console.log("   • In production the store is durable (Postgres) and survives the");
  console.log("     crash that caused the retry in the first place.\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
