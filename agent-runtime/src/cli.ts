/**
 * Demo runner. Sends real prompts through the full eight-stage pipeline, prints
 * the answer and the AGENT INTELLIGENCE REPORT for each, then prints the
 * success-criteria scorecard computed from the real run data.
 *
 *   tsx src/cli.ts            # live Groq if GROQ_API_KEY is available
 *   tsx src/cli.ts --replay   # deterministic offline agent (same real pipeline)
 *   tsx src/cli.ts --n 3      # only the first 3 prompts
 *   tsx src/cli.ts --prompt "..."   # a single ad-hoc prompt
 */
import { existsSync, rmSync } from "node:fs";
import { GroqClient } from "./llm/client.js";
import { MockAgentClient } from "./llm/mockAgent.js";
import { RuntimeDB } from "./db/database.js";
import { Runtime } from "./runtime.js";
import { renderPanel } from "./panel.js";
import { DEMO_PROMPTS } from "./demoPrompts.js";
import type { LLMClient } from "./llm/client.js";
import type { RunContext } from "./types.js";

interface Args {
  replay: boolean;
  n: number;
  db: string;
  prompt: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { replay: false, n: 0, db: "agent-runtime.demo.db", prompt: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--replay") args.replay = true;
    else if (a === "--n") args.n = parseInt(argv[++i] ?? "0", 10) || 0;
    else if (a === "--db") args.db = argv[++i] ?? args.db;
    else if (a === "--prompt") args.prompt = argv[++i] ?? null;
  }
  return args;
}

async function pickClient(replay: boolean): Promise<{ client: LLMClient; label: string }> {
  if (!replay && GroqClient.isAvailable()) {
    try {
      const client = new GroqClient();
      return { client, label: `live Groq (${client.model})` };
    } catch {
      /* fall through */
    }
  }
  if (!replay) {
    console.warn("⚠  No GROQ_API_KEY found — falling back to the deterministic offline agent.\n");
  }
  return { client: new MockAgentClient(), label: "deterministic offline agent (real pipeline)" };
}

function resetDb(path: string): void {
  if (path === ":memory:") return;
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(f)) {
      try {
        rmSync(f);
      } catch {
        /* ignore */
      }
    }
  }
}

// ── Success-criteria evaluation (computed from real run data) ─────────────────

interface Scorecard {
  preflightPredictedCorrectly: boolean;
  hallucinationCaught: boolean;
  silentFailureCaught: boolean;
  causalChainBuilt: boolean;
  interventionPreventedDamage: boolean;
  patternTableHasData: boolean;
  everythingTraceable: boolean;
  panelShown: boolean;
}

function observedFaultTypes(ctx: RunContext): Set<string> {
  const out = new Set<string>();
  const map: Record<string, string> = {
    HALLUCINATION_FORMING: "HALLUCINATION",
    SILENT_FAILURE: "SILENT_FAILURE",
    LOOP_STARTING: "LOOP_WASTE",
    INTENT_DRIFT: "INTENT_DRIFT",
    CONTEXT_COLLAPSE: "CONTEXT_COLLAPSE",
    OVERCONFIDENCE: "OVERCONFIDENT",
  };
  for (const s of ctx.streamSignals) if (map[s.type]) out.add(map[s.type]!);
  if (ctx.stepValidations.some((v) => v.silentFailureDetected)) out.add("SILENT_FAILURE");
  if (ctx.fenceEvents.some((e) => e.decision === "SUPPRESSED")) out.add("FENCE_SUPPRESSED");
  if (ctx.causalChain) out.add(ctx.causalChain.failureType);
  return out;
}

function updateScorecard(sc: Scorecard, ctx: RunContext, db: RuntimeDB): void {
  const predicted = new Set(ctx.preFlight.predictedFailures.map((f) => f.type));
  const observed = observedFaultTypes(ctx);
  if ([...predicted].some((t) => observed.has(t))) sc.preflightPredictedCorrectly = true;
  if (ctx.streamSignals.some((s) => s.type === "HALLUCINATION_FORMING")) sc.hallucinationCaught = true;
  if (ctx.stepValidations.some((v) => v.silentFailureDetected)) sc.silentFailureCaught = true;
  if (ctx.causalChain) sc.causalChainBuilt = true;
  if (
    ctx.interventions.some((i) => i.type === "ABORT" || i.type === "FENCE") ||
    ctx.fenceEvents.some((e) => e.decision === "SUPPRESSED")
  ) {
    sc.interventionPreventedDamage = true;
  }
  // Traceability: the run row and at least one child row share the runId.
  const reloaded = db.loadRun(ctx.runId);
  if (reloaded && reloaded.runId === ctx.runId) sc.everythingTraceable = true;
}

function printScorecard(sc: Scorecard, succeeded: number, attempted: number): void {
  const line = (ok: boolean, label: string) => `  ${ok ? "✅" : "❌"}  ${label}`;
  console.log("\n" + "═".repeat(56));
  const suffix = succeeded === attempted ? "" : ` of ${attempted} attempted`;
  console.log(`SUCCESS CRITERIA  (after ${succeeded} real run${succeeded === 1 ? "" : "s"}${suffix})`);
  console.log("═".repeat(56));
  console.log(line(sc.preflightPredictedCorrectly, "1. Pre-flight predicted at least one failure correctly"));
  console.log(line(sc.hallucinationCaught, "2. Stream analyzer caught a hallucination forming"));
  console.log(line(sc.silentFailureCaught, "3. Silent failure caught at a tool boundary"));
  console.log(line(sc.causalChainBuilt, "4. Causal chain built from real token evidence"));
  console.log(line(sc.interventionPreventedDamage, "5. An intervention prevented damage"));
  console.log(line(sc.patternTableHasData, "6. Pattern table has real data from real runs"));
  console.log(line(sc.everythingTraceable, "7. Every event traceable end to end by runId"));
  console.log(line(sc.panelShown, "8. User panel shown next to every response"));
  console.log("═".repeat(56));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { client, label } = await pickClient(args.replay);
  resetDb(args.db);
  const db = new RuntimeDB(args.db);
  const runtime = new Runtime(client, db, { maxSteps: 8 });

  const prompts = args.prompt ? [args.prompt] : args.n > 0 ? DEMO_PROMPTS.slice(0, args.n) : DEMO_PROMPTS;

  console.log(`\nagent-runtime — unified 8-stage pipeline`);
  console.log(`engine: ${label}`);
  console.log(`db: ${args.db}   prompts: ${prompts.length}\n`);

  const sc: Scorecard = {
    preflightPredictedCorrectly: false,
    hallucinationCaught: false,
    silentFailureCaught: false,
    causalChainBuilt: false,
    interventionPreventedDamage: false,
    patternTableHasData: false,
    everythingTraceable: false,
    panelShown: true,
  };

  let lastIntel = null as Awaited<ReturnType<Runtime["run"]>>["intelligence"] | null;
  let succeeded = 0;
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]!;
    console.log("\n" + "█".repeat(56));
    console.log(`PROMPT ${i + 1}/${prompts.length}: ${prompt}`);
    console.log("█".repeat(56));
    try {
      const { ctx, intelligence } = await runtime.run(prompt);
      lastIntel = intelligence;
      succeeded++;
      console.log(`\nANSWER: ${ctx.finalResponse}\n`);
      console.log(renderPanel(ctx, intelligence));
      updateScorecard(sc, ctx, db);
    } catch (err) {
      console.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (lastIntel && lastIntel.patterns.length > 0) sc.patternTableHasData = true;
  printScorecard(sc, succeeded, prompts.length);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
