/*
 * OpenAI function-calling agent, fenced.
 *
 *   npm run example:openai          (or: npx tsx examples/openai-agent.ts)
 *
 * Run it ONCE  -> the irreversible tools print [COMMITTED].
 * Run it AGAIN -> the same calls print [SUPPRESSED] (the recorded response is
 *                 returned instead of charging the card / emailing again).
 *   --reset     starts over with a fresh log.
 *
 * The OpenAI response is mocked so the example runs offline with no API key.
 * The fence wiring (the part that matters) is exactly what you use in prod —
 * swap `mockCompletion()` for a real `openai.chat.completions.create(...)`.
 */
import { rmSync } from "node:fs";
import { fence } from "../src"; // in your project: import { fence } from "agent-fence"

const DB = "./.fence-openai.db";
const RUN = "checkout-7781"; // stable across restarts (e.g. your thread/order id)

if (process.argv.includes("--reset")) {
  for (const s of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + s, { force: true });
    } catch {
      /* ignore */
    }
  }
  console.log("Reset: committed-effects log cleared.\n");
}

// --- the tools the agent can call (your real side effects live here) ---------
const tools: Record<string, (input: any) => Promise<unknown>> = {
  async checkInventory(input) {
    log("checkInventory", input);
    return { sku: input.sku, inStock: 12 };
  },
  async chargeCard(input) {
    log("chargeCard", input);
    return { chargeId: "ch_" + rand(), amount: input.amount };
  },
  async sendReceipt(input) {
    log("sendReceipt", input);
    return { messageId: "rcpt_" + rand(), to: input.to };
  },
};

// --- fence the tool-execution layer (one wrap) -------------------------------
const dispatch = fence.wrap((name: string, input: any) => tools[name](input), {
  effects: {
    checkInventory: "IDEMPOTENT", // safe to repeat on every retry
    chargeCard: "IRREVERSIBLE", // must fire at most once
    sendReceipt: "IRREVERSIBLE",
  },
  storage: "sqlite",
  connectionString: DB,
  runId: RUN,
  logger: { sink: (line) => console.log("   " + line) },
});

// --- what the model "decided" to call (real OpenAI tool_calls shape) ---------
function mockCompletion() {
  // In production:
  //   const completion = await openai.chat.completions.create({ model, messages, tools });
  //   const calls = completion.choices[0].message.tool_calls;
  return {
    choices: [
      {
        message: {
          role: "assistant",
          tool_calls: [
            fnCall("checkInventory", { sku: "WIDGET-1" }),
            fnCall("chargeCard", { amount: 4242, currency: "usd" }),
            fnCall("sendReceipt", { to: "buyer@acme.com" }),
          ],
        },
      },
    ],
  };
}

async function main() {
  console.log("=== OpenAI agent (run again to see [SUPPRESSED]) ===\n");
  const calls = mockCompletion().choices[0].message.tool_calls;

  for (const call of calls) {
    const args = JSON.parse(call.function.arguments);
    const result = await dispatch(call.function.name, args);
    // feed `result` back to the model as a tool message in a real loop
    void result;
  }

  await dispatch.close();
  console.log(
    "\nFirst run? You saw [COMMITTED]. Run it again to watch chargeCard +" +
      " sendReceipt get [SUPPRESSED] (checkInventory re-runs — it's idempotent)."
  );
}

// helpers ---------------------------------------------------------------------
function fnCall(name: string, input: Record<string, unknown>) {
  return {
    id: "call_" + rand(),
    type: "function" as const,
    function: { name, arguments: JSON.stringify(input) },
  };
}
function log(tool: string, input: unknown) {
  console.log(`   > REALLY executing ${tool}(${JSON.stringify(input)})`);
}
function rand() {
  return Math.random().toString(36).slice(2, 8);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
