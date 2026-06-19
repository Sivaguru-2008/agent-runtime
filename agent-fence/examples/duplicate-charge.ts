/*
 * agent-fence — the duplicate-charge demo.
 *
 *   npm run demo        (or: npx tsx examples/duplicate-charge.ts)
 *
 * A payment agent charges a card, the call times out, and the agent retries the
 * SAME charge — exactly what every retrying/replaying agent does. We run it
 * twice:
 *
 *   1. WITHOUT the fence  -> the card is charged TWICE (the bug).
 *   2. WITH the fence     -> the retry is [SUPPRESSED]; the ledger records ONE
 *                            charge (the fix).
 *
 * The "ledger" is the bank: a tool only appends to it when it *really* moves
 * money. The script asserts the invariant at the end, so it doubles as a smoke
 * test of the core guarantee.
 */
import { fence } from "../src"; // in your project: import { fence } from "agent-fence"

// ---- the real side effect: a ledger that records money actually moved --------
interface LedgerEntry {
  chargeId: string;
  amountCents: number;
}

/** Build a payment "tool" that appends to `ledger` every time it truly fires. */
function makePaymentTool(ledger: LedgerEntry[]) {
  return async (_tool: string, input: { invoice: string; amountCents: number }) => {
    console.log(
      `   > 💳 REALLY charging card: ${usd(input.amountCents)}  (invoice ${input.invoice})`
    );
    const entry: LedgerEntry = { chargeId: "ch_" + rand(), amountCents: input.amountCents };
    ledger.push(entry); // <-- the irreversible effect
    return entry;
  };
}

const CHARGE = { invoice: "INV-4242", amountCents: 8484 }; // $84.84
const RUN = "order-4242"; // stable id for this logical run (survives retries)

async function withoutFence(): Promise<LedgerEntry[]> {
  banner("WITHOUT agent-fence");
  console.log("  The agent charges, times out, and retries the same charge.\n");

  const ledger: LedgerEntry[] = [];
  const charge = makePaymentTool(ledger);

  await charge("chargeCard", CHARGE); // first attempt
  await charge("chargeCard", CHARGE); // retry after a timeout — fires AGAIN

  printLedger(ledger);
  const total = ledger.reduce((s, e) => s + e.amountCents, 0);
  console.log(
    `  ❌ Customer was charged ${ledger.length} times — ${usd(total)} instead of ${usd(CHARGE.amountCents)}\n`
  );
  return ledger;
}

async function withFence(): Promise<LedgerEntry[]> {
  banner("WITH agent-fence");
  console.log("  Same agent, same retry — but every charge goes through the fence.\n");

  const ledger: LedgerEntry[] = [];
  // One wrap(): declare chargeCard IRREVERSIBLE and the fence dedups the retry.
  const charge = fence.wrap(makePaymentTool(ledger), {
    effects: { chargeCard: "IRREVERSIBLE" },
    storage: "sqlite",
    connectionString: ":memory:", // in prod: a file path or your Postgres URL
    runId: RUN,
    logger: { sink: (line) => console.log("   " + line) },
  });

  await charge("chargeCard", CHARGE); // first attempt -> [COMMITTED]
  await charge("chargeCard", CHARGE); // retry -> [SUPPRESSED], tool never re-fires
  await charge.close();

  printLedger(ledger);
  console.log(
    `  ✅ Exactly ONE charge — ${usd(CHARGE.amountCents)}. The retry was suppressed.\n`
  );
  return ledger;
}

async function main(): Promise<void> {
  rule();
  console.log("  agent-fence — duplicate charge demo");
  console.log("  A payment agent retries the SAME charge. Watch the ledger.");
  rule();
  console.log();

  const broken = await withoutFence();
  const fenced = await withFence();

  rule();
  console.log(
    `  Result: ${broken.length} charges → ${fenced.length} charge. Same code, one wrap().`
  );
  rule();

  // Self-check: the whole pitch is this invariant. Fail loudly if it ever breaks.
  if (broken.length !== 2) throw new Error(`expected 2 unguarded charges, got ${broken.length}`);
  if (fenced.length !== 1) throw new Error(`expected 1 fenced charge, got ${fenced.length}`);
}

// ---- tiny presentation helpers ----------------------------------------------
function usd(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}
function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}
function printLedger(ledger: LedgerEntry[]): void {
  console.log("  Ledger (money actually moved):");
  if (ledger.length === 0) console.log("     (empty)");
  for (const e of ledger) console.log(`     - ${e.chargeId}  ${usd(e.amountCents)}`);
}
function banner(title: string): void {
  console.log(`▌ ${title}`);
}
function rule(): void {
  console.log("══════════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
