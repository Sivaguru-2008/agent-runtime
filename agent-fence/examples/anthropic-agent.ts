/*
 * Anthropic tool_use agent, fenced.
 *
 *   npm run example:anthropic       (or: npx tsx examples/anthropic-agent.ts)
 *
 * Run it ONCE  -> the irreversible tools print [COMMITTED].
 * Run it AGAIN -> the same calls print [SUPPRESSED].
 *   --reset     starts over with a fresh log.
 *
 * The Anthropic response is mocked so the example runs offline with no API key.
 * Swap `mockMessage()` for a real `anthropic.messages.create(...)`; the fence
 * wiring is unchanged.
 */
import { rmSync } from "node:fs";
import { fence } from "../src"; // in your project: import { fence } from "agent-fence"

const DB = "./.fence-anthropic.db";
const RUN = "refund-5523";

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

// --- the tools the agent can call --------------------------------------------
const tools: Record<string, (input: any) => Promise<unknown>> = {
  async lookupOrder(input) {
    log("lookupOrder", input);
    return { orderId: input.orderId, total: 1999, status: "shipped" };
  },
  async issueRefund(input) {
    log("issueRefund", input);
    return { refundId: "re_" + rand(), amount: input.amount };
  },
  async emailCustomer(input) {
    log("emailCustomer", input);
    return { messageId: "msg_" + rand(), to: input.to };
  },
};

// --- fence the tool dispatch -------------------------------------------------
const dispatch = fence.wrap((name: string, input: any) => tools[name](input), {
  effects: {
    lookupOrder: "IDEMPOTENT",
    issueRefund: "IRREVERSIBLE",
    emailCustomer: "IRREVERSIBLE",
  },
  storage: "sqlite",
  connectionString: DB,
  runId: RUN,
  logger: { sink: (line) => console.log("   " + line) },
});

// --- Anthropic message content shape -----------------------------------------
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function mockMessage(): { role: "assistant"; content: ContentBlock[] } {
  // In production:
  //   const message = await anthropic.messages.create({ model, max_tokens, tools, messages });
  //   for (const block of message.content) { ... }
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Processing the refund and notifying the customer." },
      toolUse("lookupOrder", { orderId: "ORD-5523" }),
      toolUse("issueRefund", { orderId: "ORD-5523", amount: 1999 }),
      toolUse("emailCustomer", { to: "customer@acme.com" }),
    ],
  };
}

async function main() {
  console.log("=== Anthropic agent (run again to see [SUPPRESSED]) ===\n");
  const message = mockMessage();

  for (const block of message.content) {
    if (block.type !== "tool_use") continue;
    const result = await dispatch(block.name, block.input);
    // return `result` as a tool_result block in a real loop
    void result;
  }

  await dispatch.close();
  console.log(
    "\nFirst run? You saw [COMMITTED]. Run it again to watch issueRefund +" +
      " emailCustomer get [SUPPRESSED] (lookupOrder re-runs — it's idempotent)."
  );
}

// helpers ---------------------------------------------------------------------
function toolUse(name: string, input: Record<string, unknown>): ContentBlock {
  return { type: "tool_use", id: "toolu_" + rand(), name, input };
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
