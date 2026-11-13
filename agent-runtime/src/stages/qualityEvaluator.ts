/**
 * STAGE 8 — Quality evaluator.
 *
 * After the response is complete, a second LLM judges whether the user got
 * exactly what they asked for. We keep the model honest by overriding the
 * "what was prevented" fields with the real run ledger (fence events +
 * interventions) — the verdict is the model's, the prevention facts are ours.
 */
import type { LLMClient } from "../llm/client.js";
import { estimateCostUSD } from "../llm/client.js";
import type {
  DamagePrevented,
  ExtractedIntent,
  FenceEvent,
  FinalEvaluation,
  Intervention,
  StepValidation,
  StreamSignal,
} from "../types.js";
import { TOOLS } from "../tools/registry.js";

const EVAL_SYSTEM = `You are a ruthless quality evaluator for AI agents.
Given: original prompt, extracted intent, full step log, fence events, interventions taken, and final response.
Evaluate whether the user got exactly what they asked for.
80% correct is a failure if critical elements are missing.
Return only valid JSON. Never explain outside JSON. Be harsh. Users deserve correct answers.

JSON shape:
{
  "userGotWhatTheyAsked": boolean,
  "completenessScore": number (0-100),
  "accuracyScore": number (0-100),
  "confidenceScore": number (0-100),
  "missingElements": string[],
  "hallucinations": string[],
  "overallVerdict": "SUCCESS" | "PARTIAL" | "FAILURE",
  "verdictReason": string
}`;

export interface EvaluateArgs {
  prompt: string;
  intent: ExtractedIntent;
  stepLog: StepValidation[];
  fenceLog: FenceEvent[];
  interventions: Intervention[];
  signals: StreamSignal[];
  finalResponse: string;
  aborted: boolean;
  abortReason: string;
}

export async function evaluateFinal(
  client: LLMClient,
  args: EvaluateArgs
): Promise<{ evaluation: FinalEvaluation; costUSD: number }> {
  const prevented = realPreventedFailures(args);
  const damage = realDamagePrevented(args);

  let judged: Partial<FinalEvaluation> | null = null;
  let costUSD = 0;
  try {
    const res = await client.jsonChat<Partial<FinalEvaluation>>({
      system: EVAL_SYSTEM,
      prompt: buildEvalPrompt(args),
      temperature: 0,
    });
    judged = res.json;
    costUSD = estimateCostUSD(res.inputTokens, res.outputTokens);
  } catch {
    judged = null;
  }

  const heur = heuristicEvaluation(args);
  const evaluation: FinalEvaluation = {
    userGotWhatTheyAsked: judged?.userGotWhatTheyAsked ?? heur.userGotWhatTheyAsked,
    completenessScore: clamp(judged?.completenessScore, heur.completenessScore),
    accuracyScore: clamp(judged?.accuracyScore, heur.accuracyScore),
    confidenceScore: clamp(judged?.confidenceScore, heur.confidenceScore),
    missingElements: arr(judged?.missingElements, heur.missingElements),
    hallucinations: arr(judged?.hallucinations, heur.hallucinations),
    // Prevention facts always come from the real ledger, never the model.
    preventedFailures: prevented,
    damagePrevented: damage,
    overallVerdict: verdict(judged, heur, args),
    verdictReason: String(judged?.verdictReason ?? heur.verdictReason).slice(0, 300),
  };
  return { evaluation, costUSD };
}

function buildEvalPrompt(args: EvaluateArgs): string {
  const steps = args.stepLog
    .map(
      (s) =>
        `  step ${s.stepNumber}: ${s.toolCalled} quality=${s.dataQualityScore} silentFailure=${s.silentFailureDetected} fence=${s.fenceDecision}`
    )
    .join("\n");
  const fence = args.fenceLog.map((f) => `  ${f.decision} ${f.tool}: ${f.reason}`).join("\n");
  const iv = args.interventions.map((i) => `  ${i.type} @step${i.step}: ${i.reason}`).join("\n");
  return [
    `ORIGINAL PROMPT:\n${args.prompt}`,
    `EXTRACTED INTENT:\n  goal: ${args.intent.goal}\n  successCriteria: ${args.intent.successCriteria}\n  requiredElements: ${args.intent.requiredElements.join(", ")}\n  expectedFormat: ${args.intent.expectedFormat}`,
    `STEP LOG:\n${steps || "  (none)"}`,
    `FENCE EVENTS:\n${fence || "  (none)"}`,
    `INTERVENTIONS:\n${iv || "  (none)"}`,
    args.aborted ? `NOTE: run was ABORTED — ${args.abortReason}` : "",
    `FINAL RESPONSE:\n${args.finalResponse || "(no final response — run was stopped)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ─── Real prevention ledger (not the model's opinion) ────────────────────────

function realPreventedFailures(args: EvaluateArgs): string[] {
  const out: string[] = [];
  for (const i of args.interventions) {
    if (i.type === "ABORT") out.push(`ABORTED at step ${i.step}: ${i.action}`);
    if (i.type === "FENCE") out.push(`FENCED at step ${i.step}: ${i.action}`);
    if (i.type === "REDIRECT") out.push(`REDIRECTED at step ${i.step}: ${i.action}`);
  }
  for (const f of args.fenceLog) {
    if (f.decision === "SUPPRESSED") out.push(`SUPPRESSED ${f.tool}: ${f.reason}`);
  }
  return out;
}

function realDamagePrevented(args: EvaluateArgs): DamagePrevented[] {
  const out: DamagePrevented[] = [];
  for (const f of args.fenceLog) {
    if (f.decision !== "SUPPRESSED") continue;
    const cost = TOOLS[f.tool]?.damageIfWrongUSD ?? 0;
    out.push({
      type: "FENCE_SUPPRESSED",
      estimatedCostUSD: cost,
      description: `${f.tool} blocked — ${f.reason}`,
    });
  }
  if (args.interventions.some((i) => i.type === "ABORT")) {
    out.push({
      type: "BAD_OUTPUT_BLOCKED",
      estimatedCostUSD: 0.1,
      description: "hallucinated/empty data blocked from reaching the user",
    });
  }
  return out;
}

// ─── Heuristic backstop ──────────────────────────────────────────────────────

function heuristicEvaluation(args: EvaluateArgs): FinalEvaluation {
  const resp = args.finalResponse.toLowerCase();
  const required = args.intent.requiredElements;
  const present = required.filter((e) => resp.includes(e.toLowerCase()));
  const missingElements = required.filter((e) => !resp.includes(e.toLowerCase()));
  const completenessScore = required.length ? Math.round((present.length / required.length) * 100) : args.finalResponse.trim() ? 80 : 0;

  const hadSilent = args.stepLog.some((s) => s.silentFailureDetected);
  const hadHalluc = args.signals.some((s) => s.type === "HALLUCINATION_FORMING");
  const accuracyScore = args.aborted ? 40 : Math.max(0, 95 - (hadSilent ? 30 : 0) - (hadHalluc ? 25 : 0));
  const confidenceScore = Math.round((completenessScore + accuracyScore) / 2);

  const hallucinations = hadHalluc ? ["model formed a confident claim without tool grounding"] : [];
  const userGotWhatTheyAsked = !args.aborted && completenessScore >= 80 && accuracyScore >= 80;
  const overallVerdict: FinalEvaluation["overallVerdict"] = userGotWhatTheyAsked
    ? "SUCCESS"
    : completenessScore >= 50 && !args.aborted
      ? "PARTIAL"
      : "FAILURE";

  return {
    userGotWhatTheyAsked,
    completenessScore,
    accuracyScore,
    confidenceScore,
    missingElements,
    hallucinations,
    preventedFailures: [],
    damagePrevented: [],
    overallVerdict,
    verdictReason: args.aborted
      ? `Run was stopped early: ${args.abortReason}`
      : `Covered ${present.length}/${required.length} required elements; accuracy ${accuracyScore}/100.`,
  };
}

function verdict(
  judged: Partial<FinalEvaluation> | null,
  heur: FinalEvaluation,
  args: EvaluateArgs
): FinalEvaluation["overallVerdict"] {
  // An aborted run is never a clean SUCCESS regardless of the model's opinion.
  if (args.aborted) return judged?.overallVerdict === "FAILURE" ? "FAILURE" : "PARTIAL";
  const v = judged?.overallVerdict;
  if (v === "SUCCESS" || v === "PARTIAL" || v === "FAILURE") return v;
  return heur.overallVerdict;
}

function clamp(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : fallback;
}

function arr(x: unknown, fallback: string[]): string[] {
  if (Array.isArray(x)) return x.map((v) => String(v)).filter(Boolean);
  return fallback;
}
