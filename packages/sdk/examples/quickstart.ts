/**
 * Quickstart — create an execution and wait for it to finish.
 *
 *   AGENT_API_URL=https://api.example.com \
 *   AGENT_API_KEY=sk_live_xxx \
 *   AGENT_ID=agent_123 \
 *   npx tsx examples/quickstart.ts
 */
import { AgentRuntimeClient, AgentRuntimeError } from "../src/index.js";

const client = new AgentRuntimeClient({
  baseUrl: process.env.AGENT_API_URL ?? "http://localhost:4000",
  apiKey: process.env.AGENT_API_KEY,
  // Optional: tune retries (these are also the defaults).
  retry: { maxRetries: 3, baseDelayMs: 250 }
});

async function main(): Promise<void> {
  const agentId = process.env.AGENT_ID;
  if (!agentId) throw new Error("Set AGENT_ID to an existing agent.");

  // 1. Start an execution.
  const execution = await client.createExecution({
    agentId,
    prompt: "Summarise the three most recent incidents and propose mitigations.",
    // Make the create safe to auto-retry on a network blip.
    idempotencyKey: crypto.randomUUID()
  });
  console.log(`Started execution ${execution.id} (status: ${execution.status})`);

  // 2. Wait for it to reach a terminal state.
  const final = await client.waitForExecution(execution.id, {
    onPoll: (e) => console.log(`  … ${e.status}`)
  });

  console.log(`Finished: ${final.status}`);
  console.log("Output:", JSON.stringify(final.output ?? final.failure, null, 2));
  console.log("Tokens:", final.tokenUsage.total);
}

main().catch((err) => {
  if (err instanceof AgentRuntimeError) {
    console.error(`[${err.name}] ${err.message}` + (err.status ? ` (HTTP ${err.status})` : ""));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
