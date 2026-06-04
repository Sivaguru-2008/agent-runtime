/**
 * Streaming — start an execution and follow its events live over SSE.
 *
 *   AGENT_API_URL=... AGENT_API_KEY=... AGENT_ID=... npx tsx examples/streaming.ts
 */
import { AgentRuntimeClient } from "../src/index.js";

const client = new AgentRuntimeClient({
  baseUrl: process.env.AGENT_API_URL ?? "http://localhost:4000",
  apiKey: process.env.AGENT_API_KEY
});

async function main(): Promise<void> {
  const agentId = process.env.AGENT_ID;
  if (!agentId) throw new Error("Set AGENT_ID to an existing agent.");

  const execution = await client.createExecution({
    agentId,
    prompt: "Plan a rollout for the new caching layer."
  });
  console.log(`Streaming events for execution ${execution.id} (Ctrl-C to stop)…`);

  // Stop the stream automatically once the execution finishes.
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());

  const terminal = new Set(["COGNITION_COMPLETED", "COGNITION_FAILED", "EXECUTION_COMPLETED"]);

  for await (const event of client.streamExecution({
    executionId: execution.id,
    signal: ac.signal
  })) {
    console.log(`[seq ${event.sequence ?? "—"}] ${event.type}`);
    if (terminal.has(event.type)) {
      ac.abort();
      break;
    }
  }

  // Fetch the final state once the stream closes.
  const { execution: final } = await client.getExecution(execution.id);
  console.log(`Done — final status: ${final.status}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
