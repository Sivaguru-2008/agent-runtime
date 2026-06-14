/*
 * LangChain agent, fenced at the tool boundary.
 *
 *   npm run example:langchain       (or: npx tsx examples/langchain-agent.ts)
 *
 * Run it ONCE  -> the irreversible tools print [COMMITTED].
 * Run it AGAIN -> the same calls print [SUPPRESSED].
 *   --reset     starts over with a fresh log.
 *
 * LangChain tools expose `.invoke(input)`. We wrap each tool's invoke with the
 * fence; the tools here are minimal stand-ins so the example runs offline. In
 * your project these are real `DynamicStructuredTool`s and the wrapping is the
 * same one line: `f.wrapTool(name, (input) => tool.invoke(input))`.
 */
import { rmSync } from "node:fs";
import { createFence } from "../src"; // in your project: import { createFence } from "agent-fence"

const DB = "./.fence-langchain.db";
const RUN = "booking-3310";

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

// --- minimal LangChain-style tools (real ones: new DynamicStructuredTool(...)) -
interface StructuredTool {
  name: string;
  invoke: (input: any) => Promise<unknown>;
}
function makeTool(name: string, fn: (input: any) => unknown): StructuredTool {
  return {
    name,
    invoke: async (input: any) => {
      log(name, input);
      return fn(input);
    },
  };
}

const searchTool = makeTool("searchFlights", (i) => ({
  from: i.from,
  to: i.to,
  options: ["UA-100", "DL-200"],
}));
const bookTool = makeTool("bookFlight", (i) => ({
  bookingId: "bk_" + rand(),
  flightId: i.flightId,
  price: i.price,
}));
const itineraryTool = makeTool("sendItinerary", (i) => ({
  messageId: "itin_" + rand(),
  to: i.to,
}));

// --- one fence, used to wrap each tool's invoke ------------------------------
const f = createFence({
  effects: {
    searchFlights: "IDEMPOTENT",
    bookFlight: "IRREVERSIBLE",
    sendItinerary: "IRREVERSIBLE",
  },
  storage: "sqlite",
  connectionString: DB,
  runId: RUN,
  logger: { sink: (line) => console.log("   " + line) },
});

const searchFlights = f.wrapTool("searchFlights", (i) => searchTool.invoke(i));
const bookFlight = f.wrapTool("bookFlight", (i) => bookTool.invoke(i));
const sendItinerary = f.wrapTool("sendItinerary", (i) => itineraryTool.invoke(i));

async function main() {
  console.log("=== LangChain agent (run again to see [SUPPRESSED]) ===\n");

  // The plan the AgentExecutor would carry out:
  await searchFlights({ from: "SFO", to: "JFK" });
  await bookFlight({ flightId: "UA-100", price: 412 });
  await sendItinerary({ to: "traveler@acme.com" });

  await f.close();
  console.log(
    "\nFirst run? You saw [COMMITTED]. Run it again to watch bookFlight +" +
      " sendItinerary get [SUPPRESSED] (searchFlights re-runs — it's idempotent)."
  );
}

// helpers ---------------------------------------------------------------------
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
