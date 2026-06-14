/*
 * Runnable demo of the agent-fence success criteria.
 *
 *   npm run demo                          # full walkthrough in one process
 *
 * Or simulate two real process restarts against the same DB file:
 *   npx tsx examples/crash-retry.ts --phase 1
 *   npx tsx examples/crash-retry.ts --phase 2
 */
import { rmSync } from "node:fs";
import { wrap } from "../src";

const DB = "./.agent-fence-demo.db";
const RUN = "order-4242";

const effects = {
  stripeCharge: "IRREVERSIBLE",
  sendEmail: "IRREVERSIBLE",
  readInventory: "IDEMPOTENT",
} as const;

// Send fence logs to stdout so the [COMMITTED]/[SUPPRESSED] badges interleave
// cleanly with the demo narration.
const logger = { sink: (line: string) => console.log("   " + line) };

// A toy agent: the function that dispatches tool calls. It prints whenever a
// tool *actually* executes a side effect.
function realAgent(label: string) {
  return async (tool: string, input: any) => {
    console.log(
      `   > ${label}: REALLY executing ${tool}(${JSON.stringify(input)})`
    );
    if (tool === "stripeCharge")
      return { chargeId: "ch_" + rand(), amount: input.amount };
    if (tool === "sendEmail") return { messageId: "msg_" + rand() };
    if (tool === "readInventory") return { sku: input.sku, inStock: 7 };
    return null;
  };
}

function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function phase1(): Promise<void> {
  console.log("\n=== PHASE 1: first run (then we 'crash') ===");
  const agent = wrap(realAgent("run-1"), {
    effects,
    storage: "sqlite",
    connectionString: DB,
    runId: RUN,
    logger,
  });
  await agent("stripeCharge", { amount: 4242 });
  await agent("sendEmail", { to: "buyer@acme.com" });
  console.log("   *** process crashes here — before the workflow finished ***");
  await agent.close();
}

async function phase2(): Promise<void> {
  console.log("\n=== PHASE 2: restart (same runId, same DB) ===");
  const agent = wrap(realAgent("run-2"), {
    effects,
    storage: "sqlite",
    connectionString: DB,
    runId: RUN,
    logger,
  });
  // The orchestrator replays the SAME steps after restart:
  await agent("stripeCharge", { amount: 4242 }); // expect [SUPPRESSED]
  await agent("sendEmail", { to: "buyer@acme.com" }); // expect [SUPPRESSED]
  await agent("readInventory", { sku: "ABC-1" }); // IDEMPOTENT -> really runs
  await agent.close();
  console.log(
    "\nDone. stripeCharge + sendEmail were SUPPRESSED; readInventory re-ran.\n"
  );
}

function cleanup(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
}

async function main(): Promise<void> {
  const idx = process.argv.indexOf("--phase");
  const phase = idx !== -1 ? process.argv[idx + 1] : null;

  if (phase === "1") return phase1();
  if (phase === "2") return phase2();

  // Default: full walkthrough against a fresh DB.
  cleanup();
  await phase1();
  await phase2();
  cleanup();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
