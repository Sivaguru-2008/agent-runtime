/**
 * Replay — re-run a previous execution and list an agent's recent executions.
 *
 *   AGENT_API_URL=... AGENT_API_KEY=... AGENT_ID=... EXECUTION_ID=... \
 *   npx tsx examples/replay.ts
 */
import { AgentRuntimeClient, NotFoundError } from "../src/index.js";

const client = new AgentRuntimeClient({
  baseUrl: process.env.AGENT_API_URL ?? "http://localhost:4000",
  apiKey: process.env.AGENT_API_KEY
});

async function main(): Promise<void> {
  const agentId = process.env.AGENT_ID;
  const executionId = process.env.EXECUTION_ID;
  if (!agentId || !executionId) throw new Error("Set AGENT_ID and EXECUTION_ID.");

  // List the agent's completed and failed executions.
  const recent = await client.listExecutions({
    agentId,
    status: ["COMPLETED", "FAILED"],
    limit: 10
  });
  console.log(`Found ${recent.length} terminal executions for ${agentId}:`);
  for (const e of recent) console.log(`  ${e.id} — ${e.status}`);

  // Replay a specific execution.
  try {
    const replay = await client.replayExecution(executionId);
    console.log(`Replay started: ${replay.id} (parent: ${replay.parentExecutionId ?? executionId})`);
  } catch (err) {
    if (err instanceof NotFoundError) {
      console.error(`Execution ${executionId} not found (or not owned by this key).`);
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
