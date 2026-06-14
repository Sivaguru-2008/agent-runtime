/**
 * The unified runtime. Every prompt goes through all eight stages, in order,
 * with one runId threading through every event:
 *
 *   1 PRE-FLIGHT  → 2 STREAM  → 3 STEP  → 4 FENCE
 *   5 CAUSAL      ← 6 INTERVENTION (real-time)      ← (2/3/4 emit signals)
 *   7 PATTERN LEARNING  → 8 QUALITY EVALUATION
 *
 * The agent loop itself is a JSON-action ReAct loop: each turn the model streams
 * one JSON object (thought / expect / action / input / final_answer). Stage 2
 * reads every streamed token; Stages 3 and 4 run at each tool boundary; Stage 6
 * can abort the stream, redirect the model, or hold an irreversible effect.
 */
import { randomUUID } from "node:crypto";
import { hashInput } from "../../agent-fence/dist/index.js";
import type { LLMClient } from "./llm/client.js";
import { estimateCostUSD } from "./llm/client.js";
import { RuntimeDB } from "./db/database.js";
import { TOOLS, toolCatalogText, defaultEffectMap } from "./tools/registry.js";
import type { ToolResult } from "./tools/registry.js";
import { extractIntent, runPreFlight } from "./stages/preflight.js";
import { StreamAnalyzer } from "./stages/streamAnalyzer.js";
import { validateStep, scoreQuality, isEmptyResult } from "./stages/stepValidator.js";
import { FenceEnforcer } from "./stages/fenceEnforcement.js";
import { buildCausalChain, hasFailure } from "./stages/causalAttribution.js";
import { InterventionEngine } from "./stages/intervention.js";
import { PatternLearner } from "./stages/patternLearner.js";
import { evaluateFinal } from "./stages/qualityEvaluator.js";
import type {
  FenceEvent,
  Intervention,
  PatternIntelligence,
  RunContext,
  StepValidation,
  StreamSignal,
  TokenEvent,
} from "./types.js";

const AGENT_SYSTEM = `You are an autonomous agent that solves the user's task using tools.
On EACH turn respond with EXACTLY ONE JSON object and nothing else:
{
  "thought": "<brief reasoning>",
  "expect": "<what you expect this action to return>",
  "action": "<tool_name> or \\"final\\"",
  "input": { ...tool input... },
  "final_answer": "<the answer, only when action is final>"
}
Available tools:
__TOOLS__
Rules:
- Ground every factual claim with a tool result. NEVER state a specific number or fact you did not get from a tool.
- If a tool returns an empty result or an error, do NOT pretend you got data. Try a different input, or report that you could not find it.
- Do not call the same tool with the same input twice.
- When you can answer, set "action" to "final" and put the answer in "final_answer".
Respond with JSON only — no prose, no markdown fences.`;

export interface RuntimeOptions {
  maxSteps?: number;
  temperature?: number;
  /** Called when pre-flight wants a human gate (risk > 80 and shouldProceed=false).
   *  Return true to proceed. Default: proceed (fence still protects effects). */
  onHumanGate?: (reason: string) => boolean | Promise<boolean>;
}

export interface RunResult {
  ctx: RunContext;
  intelligence: PatternIntelligence;
}

export class Runtime {
  private readonly client: LLMClient;
  private readonly db: RuntimeDB;
  private readonly intervention = new InterventionEngine();
  private readonly learner: PatternLearner;
  private readonly maxSteps: number;
  private readonly temperature: number;
  private readonly onHumanGate: NonNullable<RuntimeOptions["onHumanGate"]>;

  constructor(client: LLMClient, db: RuntimeDB, options: RuntimeOptions = {}) {
    this.client = client;
    this.db = db;
    this.learner = new PatternLearner(db);
    this.maxSteps = options.maxSteps ?? 8;
    this.temperature = options.temperature ?? 0.3;
    this.onHumanGate = options.onHumanGate ?? (() => true);
  }

  async run(prompt: string): Promise<RunResult> {
    const runId = randomUUID();
    const startMs = Date.now();
    const startedAt = new Date().toISOString();

    // ── Stage 0: intent ──────────────────────────────────────────────────────
    const { intent, costUSD: intentCost } = await extractIntent(this.client, prompt);
    this.db.startRun(runId, prompt, JSON.stringify(intent), startedAt);

    // ── Stage 1: pre-flight ──────────────────────────────────────────────────
    const { analysis: preFlight, costUSD: preflightCost } = await runPreFlight(this.client, prompt, intent);

    // Shared run accumulators.
    const streamSignals: StreamSignal[] = [];
    const interventions: Intervention[] = [];
    const fenceEvents: FenceEvent[] = [];
    const stepValidations: StepValidation[] = [];
    const tokenStream: TokenEvent[] = [];
    let totalCostUSD = intentCost + preflightCost;

    // Human gate for dangerous, do-not-proceed prompts. The fence still protects
    // every irreversible effect regardless of the answer.
    if (preFlight.riskScore > 80 && !preFlight.shouldProceed) {
      const reason = `pre-flight risk ${preFlight.riskScore}/100 with shouldProceed=false: ${preFlight.proceedWithWarnings.join("; ")}`;
      const proceed = await this.onHumanGate(reason);
      interventions.push({
        runId,
        step: 0,
        type: "HUMAN",
        action: proceed ? "human approved proceeding with fence protection" : "human blocked the run",
        reason,
        outcome: proceed ? "RESOLVED" : "RESOLVED",
      });
      if (!proceed) {
        return this.finalizeBlocked(runId, prompt, intent, preFlight, interventions, startedAt, startMs, totalCostUSD);
      }
    }

    // ── Stage 4 wiring: auto-apply the recommended fence config. ──────────────
    // Start from each tool's real classification; pre-flight may only ESCALATE a
    // tool to IRREVERSIBLE, never downgrade one — the fence must never
    // under-protect because the analyzer was wrong.
    const effects: Record<string, "IRREVERSIBLE" | "IDEMPOTENT"> = { ...defaultEffectMap() };
    for (const [tool, eff] of Object.entries(preFlight.recommendedFenceConfig)) {
      if (eff === "IRREVERSIBLE") effects[tool] = "IRREVERSIBLE";
    }
    const fence = new FenceEnforcer({
      db: this.db.handle,
      runId,
      effects,
      onEvent: (e) => fenceEvents.push(e),
    });

    // ── Stage 6 wiring: every signal is evaluated the instant it fires. ───────
    let pendingAbort: Intervention | null = null;
    const pendingCorrections: string[] = [];
    const analyzer = new StreamAnalyzer({
      runId,
      intent,
      onSignal: (signal) => {
        streamSignals.push(signal);
        const iv = this.intervention.evaluate(signal, { runId, intent });
        interventions.push(iv);
        if (iv.type === "ABORT" && !pendingAbort) pendingAbort = iv;
        if (iv.correction) pendingCorrections.push(iv.correction);
      },
    });

    // ── Stages 2/3/4/6: the agent loop. ──────────────────────────────────────
    const transcript: string[] = [`Task: ${prompt}`];
    const priorHashes = new Map<string, number[]>();
    let globalTokenIndex = 0;
    let finalResponse = "";
    let aborted = false;
    let abortReason = "";

    for (let step = 1; step <= this.maxSteps && !aborted; step++) {
      const controller = new AbortController();
      analyzer.startTurn(step, globalTokenIndex);

      const out = await this.client.streamChat(
        { system: AGENT_SYSTEM.replace("__TOOLS__", toolCatalogText()), prompt: transcript.join("\n\n"), temperature: this.temperature, signal: controller.signal },
        (tok) => {
          const gIdx = globalTokenIndex++;
          tokenStream.push({ index: gIdx, step, text: tok, atMs: Date.now() - startMs });
          analyzer.observeToken(tok, gIdx);
          if (analyzer.abortSignal && !controller.signal.aborted) controller.abort();
        }
      );
      totalCostUSD += estimateCostUSD(out.inputTokens, out.outputTokens);

      if (pendingAbort) {
        ({ aborted, abortReason, finalResponse } = this.applyAbort(pendingAbort));
        break;
      }

      const action = tryParseAction(out.text);
      if (!action) {
        transcript.push(`System: your last reply was not a single valid JSON object. Reply with JSON only.`);
        continue;
      }

      const isFinal = action.action === "final" || action.action === undefined || action.action === "";
      analyzer.finishTurn(isFinal ? String(action.final_answer ?? "") : out.text, isFinal);
      if (pendingAbort) {
        ({ aborted, abortReason, finalResponse } = this.applyAbort(pendingAbort));
        break;
      }
      if (isFinal) {
        finalResponse = String(action.final_answer ?? action.answer ?? out.text).trim();
        break;
      }

      // ── A tool call. ────────────────────────────────────────────────────────
      const tool = String(action.action);
      const toolDef = TOOLS[tool];
      if (!toolDef) {
        transcript.push(`Observation (step ${step}): unknown tool "${tool}". Available: ${Object.keys(TOOLS).join(", ")}.`);
        continue;
      }
      const input = action.input && typeof action.input === "object" ? (action.input as Record<string, unknown>) : {};
      const claim = String(action.expect ?? action.thought ?? "");
      const inputHash = hashInput(input);
      const key = `${tool}:${inputHash}`;
      const priors = priorHashes.get(key) ?? [];
      const duplicate = priors.length > 0;

      // Loop detection (may raise a HIGH signal -> ABORT).
      analyzer.observeToolCall(step, tool, inputHash, globalTokenIndex);
      priorHashes.set(key, [...priors, step]);
      if (pendingAbort) {
        ({ aborted, abortReason, finalResponse } = this.applyAbort(pendingAbort));
        break;
      }

      // Stage 6: hold an irreversible effect if upstream data is unreliable.
      if (toolDef.effect === "IRREVERSIBLE") {
        const hold = this.intervention.evaluateFenceHold(tool, step, stepValidations, { runId, intent });
        if (hold) {
          interventions.push(hold);
          fence.hold(step, tool, hold.reason);
          const held: ToolResult = { ok: false, data: null, error: "held by fence for human approval" };
          stepValidations.push(
            validateStep({ stepNumber: step, toolCalled: tool, inputHash, claim, result: held, duplicate, fenceDecision: "SUPPRESS" })
          );
          transcript.push(`Observation (step ${step}): ${tool} was SUPPRESSED by the fence (${hold.reason}). Do not retry it; finish without it.`);
          continue;
        }
      }

      // Stage 4: run through the real fence.
      const disp = await fence.dispatch(step, tool, input, () => toolDef.run(input));
      const result = disp.result as ToolResult;
      const fenceDecision: "COMMIT" | "SUPPRESS" = disp.decision === "SUPPRESSED" ? "SUPPRESS" : "COMMIT";

      // Stage 3: validate.
      const v = validateStep({ stepNumber: step, toolCalled: tool, inputHash, claim, result, duplicate, fenceDecision });
      stepValidations.push(v);
      const quality = scoreQuality(result);
      const empty = isEmptyResult(result);
      analyzer.observeToolResult(quality, empty, !empty && quality >= 50);

      // Feed the observation back to the model.
      if (fenceDecision === "SUPPRESS" && disp.decision === "SUPPRESSED") {
        transcript.push(
          `Observation (step ${step}): ${tool} was SUPPRESSED (already executed). Recorded response: ${truncate(JSON.stringify(result))}. Do not retry this tool.`
        );
      } else {
        transcript.push(`Observation (step ${step}): ${truncate(JSON.stringify(result))}`);
      }

      if (v.silentFailureDetected) {
        // A silent failure at the tool boundary does NOT hard-abort: we redirect
        // (give the model a chance to broaden the query or admit it found
        // nothing). If it instead streams a confident claim next turn, Stage 2
        // catches the hallucination and aborts then — exactly per the spec.
        const iv: Intervention = {
          runId,
          step,
          type: "REDIRECT",
          action: "redirect after a silent tool failure",
          reason: v.abortReason,
          correction:
            `The tool at step ${step} returned an empty/error result. Do NOT state a value you did not get. ` +
            `Broaden the query and retry, or report that you could not find it.`,
          outcome: "PENDING",
        };
        interventions.push(iv);
        transcript.push(`System correction: ${iv.correction}`);
        continue;
      }
      if (!v.continueRecommendation && v.duplicateCallDetected && !pendingAbort) {
        // Duplicate call the stream analyzer didn't already abort on.
        const iv: Intervention = {
          runId,
          step,
          type: "ABORT",
          action: "stop on duplicate-call recommendation",
          reason: v.abortReason,
          returnToUser: `Stopped at step ${step}: ${v.abortReason}`,
          outcome: "PENDING",
        };
        interventions.push(iv);
        ({ aborted, abortReason, finalResponse } = this.applyAbort(iv));
        break;
      }

      if (pendingCorrections.length) {
        transcript.push(`System correction: ${pendingCorrections.join(" ")}`);
        pendingCorrections.length = 0;
      }
    }

    if (!finalResponse && !aborted) {
      finalResponse = "(no final answer produced within the step budget)";
    }

    // ── Stage 8: quality evaluation. ─────────────────────────────────────────
    const { evaluation, costUSD: evalCost } = await evaluateFinal(this.client, {
      prompt,
      intent,
      stepLog: stepValidations,
      fenceLog: fenceEvents,
      interventions,
      signals: streamSignals,
      finalResponse,
      aborted,
      abortReason,
    });
    totalCostUSD += evalCost;

    // ── Stage 5: causal attribution (only when there was a failure). ─────────
    const causalInput = {
      signals: streamSignals,
      stepLog: stepValidations,
      fenceLog: fenceEvents,
      interventions,
      tokenStream,
      aborted,
      verdictFailure: evaluation.overallVerdict === "FAILURE",
    };
    const causalChain = hasFailure(causalInput) ? buildCausalChain(causalInput) : null;

    // Mark intervention outcomes now that we know how the run ended.
    for (const iv of interventions) {
      if (iv.outcome !== "PENDING") continue;
      if (iv.type === "ABORT" || iv.type === "FENCE" || iv.type === "REDIRECT" || iv.type === "HUMAN") iv.outcome = "RESOLVED";
    }

    const damagePreventedUSD = causalChain ? causalChain.damagePreventedUSD : sumSuppressedDamage(fenceEvents);
    const completedAt = new Date().toISOString();
    const ctx: RunContext = {
      runId,
      prompt,
      intent,
      preFlight,
      streamSignals,
      stepValidations,
      fenceEvents,
      interventions,
      causalChain,
      finalEvaluation: evaluation,
      finalResponse,
      totalCostUSD: round(totalCostUSD),
      damagePreventedUSD: round(damagePreventedUSD),
      durationMs: Date.now() - startMs,
      startedAt,
      completedAt,
      aborted,
      abortReason,
    };

    await fence.close();
    this.persist(ctx);
    this.learner.recordRun(ctx);
    this.db.finishRun(ctx);

    return { ctx, intelligence: this.learner.getIntelligence() };
  }

  /** Persist every stage's output. Called once, after the run completes. */
  private persist(ctx: RunContext): void {
    this.db.storePreflight(ctx.runId, ctx.preFlight);
    for (const s of ctx.streamSignals) this.db.storeSignal(s);
    for (const v of ctx.stepValidations) this.db.storeStepValidation(ctx.runId, v);
    for (const e of ctx.fenceEvents) this.db.storeFenceEvent(e);
    for (const iv of ctx.interventions) this.db.storeIntervention(iv);
    if (ctx.causalChain) this.db.storeCausalChain(ctx.runId, ctx.causalChain);
    this.db.storeFinalEvaluation(ctx.runId, ctx.finalEvaluation);
  }

  private applyAbort(iv: Intervention): { aborted: true; abortReason: string; finalResponse: string } {
    return {
      aborted: true,
      abortReason: iv.reason,
      finalResponse: iv.returnToUser ?? `Stopped: ${iv.reason}`,
    };
  }

  private finalizeBlocked(
    runId: string,
    prompt: string,
    intent: RunContext["intent"],
    preFlight: RunContext["preFlight"],
    interventions: Intervention[],
    startedAt: string,
    startMs: number,
    totalCostUSD: number
  ): RunResult {
    const ctx: RunContext = {
      runId,
      prompt,
      intent,
      preFlight,
      streamSignals: [],
      stepValidations: [],
      fenceEvents: [],
      interventions,
      causalChain: null,
      finalEvaluation: {
        userGotWhatTheyAsked: false,
        completenessScore: 0,
        accuracyScore: 0,
        confidenceScore: 0,
        missingElements: intent.requiredElements,
        hallucinations: [],
        preventedFailures: ["Run blocked by human gate before any effect could fire"],
        damagePrevented: [],
        overallVerdict: "FAILURE",
        verdictReason: "Blocked at the human gate; no agent execution occurred.",
      },
      finalResponse: "(blocked at human gate)",
      totalCostUSD: round(totalCostUSD),
      damagePreventedUSD: 0,
      durationMs: Date.now() - startMs,
      startedAt,
      completedAt: new Date().toISOString(),
      aborted: true,
      abortReason: "human gate blocked the run",
    };
    this.persist(ctx);
    this.learner.recordRun(ctx);
    this.db.finishRun(ctx);
    return { ctx, intelligence: this.learner.getIntelligence() };
  }
}

interface ParsedAction {
  thought?: string;
  expect?: string;
  action?: string;
  input?: unknown;
  final_answer?: unknown;
  answer?: unknown;
}

function tryParseAction(text: string): ParsedAction | null {
  // Reuse the balanced-JSON extractor by importing lazily would create a cycle;
  // inline a tolerant parse here.
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as ParsedAction;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function sumSuppressedDamage(fenceEvents: FenceEvent[]): number {
  return round(
    fenceEvents
      .filter((e) => e.decision === "SUPPRESSED")
      .reduce((sum, e) => sum + (TOOLS[e.tool]?.damageIfWrongUSD ?? 0), 0)
  );
}

function truncate(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
