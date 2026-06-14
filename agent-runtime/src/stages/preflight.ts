/**
 * STAGE 1 — Pre-flight predictor (+ Stage 0 intent extraction).
 *
 * Before the agent runs, a second LLM call predicts exactly what will go wrong.
 * The result drives the fence config and the human-gate decision. A
 * deterministic heuristic backs the LLM up, so the runtime still predicts and
 * fences even if the analyzer call fails or returns junk.
 */
import type { LLMClient } from "../llm/client.js";
import { estimateCostUSD } from "../llm/client.js";
import type { ExtractedIntent, FaultType, PreFlightAnalysis, PredictedFailure } from "../types.js";
import { TOOLS, toolCatalogText } from "../tools/registry.js";

const FAULT_TYPES: FaultType[] = [
  "WRONG_ANSWER",
  "INCOMPLETE_ANSWER",
  "HALLUCINATION",
  "TOOL_FAILURE",
  "SILENT_FAILURE",
  "CONTEXT_LOST",
  "FORMAT_WRONG",
  "OVERCONFIDENT",
  "LOOP_WASTE",
  "INTENT_DRIFT",
  "FENCE_SUPPRESSED",
  "COST_EXCEEDED",
  "CONTEXT_COLLAPSE",
];

const PREFLIGHT_SYSTEM = `You are a pre-flight risk analyzer for AI agents.
Analyze this prompt and predict exactly what will go wrong before the agent runs. Be specific. Be harsh.
Return only valid JSON. No explanation outside JSON.

The JSON must match:
{
  "riskScore": number (0-100),
  "complexity": "SIMPLE" | "MEDIUM" | "COMPLEX" | "DANGEROUS",
  "predictedFailures": [{ "type": FaultType, "probability": number (0-1), "atStep": number, "reason": string, "prevention": string }],
  "irreversibleActionsDetected": string[],
  "loopRiskFactors": string[],
  "hallucinationRiskFactors": string[],
  "recommendedFenceConfig": { "<toolName>": "IRREVERSIBLE" | "IDEMPOTENT" },
  "estimatedSteps": number,
  "estimatedCostUSD": number,
  "shouldProceed": boolean,
  "proceedWithWarnings": string[]
}
FaultType is one of: ${FAULT_TYPES.join(", ")}.`;

const INTENT_SYSTEM = `You extract the user's intent from a prompt for an AI agent. Return only valid JSON:
{ "goal": string, "successCriteria": string, "requiredElements": string[], "expectedFormat": string }`;

export async function extractIntent(
  client: LLMClient,
  prompt: string
): Promise<{ intent: ExtractedIntent; costUSD: number }> {
  try {
    const res = await client.jsonChat<Partial<ExtractedIntent>>({
      system: INTENT_SYSTEM,
      prompt,
      temperature: 0,
    });
    return {
      intent: normalizeIntent(res.json, prompt),
      costUSD: estimateCostUSD(res.inputTokens, res.outputTokens),
    };
  } catch {
    return { intent: heuristicIntent(prompt), costUSD: 0 };
  }
}

export async function runPreFlight(
  client: LLMClient,
  prompt: string,
  intent: ExtractedIntent
): Promise<{ analysis: PreFlightAnalysis; costUSD: number }> {
  const userPrompt = `Available tools the agent may call:\n${toolCatalogText()}\n\nUser prompt to analyze:\n"""${prompt}"""`;
  try {
    const res = await client.jsonChat<Partial<PreFlightAnalysis>>({
      system: PREFLIGHT_SYSTEM,
      prompt: userPrompt,
      temperature: 0,
    });
    const analysis = mergeWithHeuristic(normalizeAnalysis(res.json), prompt, intent);
    return { analysis, costUSD: estimateCostUSD(res.inputTokens, res.outputTokens) };
  } catch {
    return { analysis: heuristicPreFlight(prompt, intent), costUSD: 0 };
  }
}

// ─── Normalization ───────────────────────────────────────────────────────────

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(lo, Math.min(hi, x));
}

function asFaultType(x: unknown): FaultType {
  const s = String(x ?? "").toUpperCase();
  return (FAULT_TYPES as string[]).includes(s) ? (s as FaultType) : "WRONG_ANSWER";
}

function asStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.map((v) => String(v)).filter(Boolean);
}

function normalizeIntent(raw: Partial<ExtractedIntent>, prompt: string): ExtractedIntent {
  const h = heuristicIntent(prompt);
  return {
    goal: String(raw.goal ?? h.goal).slice(0, 400),
    successCriteria: String(raw.successCriteria ?? h.successCriteria).slice(0, 400),
    requiredElements: asStringArray(raw.requiredElements).length ? asStringArray(raw.requiredElements) : h.requiredElements,
    expectedFormat: String(raw.expectedFormat ?? h.expectedFormat).slice(0, 80),
  };
}

function normalizeAnalysis(raw: Partial<PreFlightAnalysis>): PreFlightAnalysis {
  const failures: PredictedFailure[] = Array.isArray(raw.predictedFailures)
    ? raw.predictedFailures.map((f) => ({
        type: asFaultType((f as PredictedFailure)?.type),
        probability: clamp((f as PredictedFailure)?.probability, 0, 1, 0.5),
        atStep: clamp((f as PredictedFailure)?.atStep, 0, 50, 1),
        reason: String((f as PredictedFailure)?.reason ?? "").slice(0, 300),
        prevention: String((f as PredictedFailure)?.prevention ?? "").slice(0, 300),
      }))
    : [];
  const fenceConfig: Record<string, "IRREVERSIBLE" | "IDEMPOTENT"> = {};
  if (raw.recommendedFenceConfig && typeof raw.recommendedFenceConfig === "object") {
    for (const [k, v] of Object.entries(raw.recommendedFenceConfig)) {
      fenceConfig[k] = v === "IRREVERSIBLE" ? "IRREVERSIBLE" : "IDEMPOTENT";
    }
  }
  return {
    riskScore: clamp(raw.riskScore, 0, 100, 50),
    complexity: (["SIMPLE", "MEDIUM", "COMPLEX", "DANGEROUS"].includes(String(raw.complexity))
      ? raw.complexity
      : "MEDIUM") as PreFlightAnalysis["complexity"],
    predictedFailures: failures,
    irreversibleActionsDetected: asStringArray(raw.irreversibleActionsDetected),
    loopRiskFactors: asStringArray(raw.loopRiskFactors),
    hallucinationRiskFactors: asStringArray(raw.hallucinationRiskFactors),
    recommendedFenceConfig: fenceConfig,
    estimatedSteps: clamp(raw.estimatedSteps, 1, 50, 4),
    estimatedCostUSD: clamp(raw.estimatedCostUSD, 0, 100, 0.01),
    shouldProceed: raw.shouldProceed !== false,
    proceedWithWarnings: asStringArray(raw.proceedWithWarnings),
  };
}

/**
 * Always union the LLM's fence recommendations with what we can detect
 * statically (any IRREVERSIBLE tool named or implied by the prompt). The fence
 * must never under-protect just because the analyzer missed something.
 */
function mergeWithHeuristic(a: PreFlightAnalysis, prompt: string, intent: ExtractedIntent): PreFlightAnalysis {
  const h = heuristicPreFlight(prompt, intent);
  for (const [tool, eff] of Object.entries(h.recommendedFenceConfig)) {
    if (eff === "IRREVERSIBLE") a.recommendedFenceConfig[tool] = "IRREVERSIBLE";
  }
  // Guarantee every genuinely-irreversible tool is fenced.
  for (const t of Object.values(TOOLS)) {
    if (t.effect === "IRREVERSIBLE" && mentionsTool(prompt, t.name)) {
      a.recommendedFenceConfig[t.name] = "IRREVERSIBLE";
      if (!a.irreversibleActionsDetected.includes(t.name)) a.irreversibleActionsDetected.push(t.name);
    }
  }
  if (a.predictedFailures.length === 0) a.predictedFailures = h.predictedFailures;
  if (a.hallucinationRiskFactors.length === 0) a.hallucinationRiskFactors = h.hallucinationRiskFactors;
  return a;
}

// ─── Heuristic (deterministic safety net) ────────────────────────────────────

function mentionsTool(prompt: string, tool: string): boolean {
  const p = prompt.toLowerCase();
  const aliases: Record<string, string[]> = {
    send_email: ["email", "e-mail", "notify", "send a mail"],
    charge_card: ["charge", "payment", "bill", "stripe", "invoice"],
    save_to_database: ["save", "store", "persist", "database", "record it"],
    generate_report: ["report", "document", "write up"],
  };
  if (p.includes(tool.replace(/_/g, " ")) || p.includes(tool)) return true;
  return (aliases[tool] ?? []).some((a) => p.includes(a));
}

export function heuristicIntent(prompt: string): ExtractedIntent {
  const required = (prompt.match(/[A-Za-z][A-Za-z0-9'-]{3,}/g) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => !STOPWORDS.has(w))
    .slice(0, 8);
  const wantsJson = /\bjson\b/i.test(prompt);
  const wantsTable = /\btable\b/i.test(prompt);
  return {
    goal: prompt.trim().slice(0, 200),
    successCriteria: `Answer that addresses: ${prompt.trim().slice(0, 160)}`,
    requiredElements: Array.from(new Set(required)),
    expectedFormat: wantsJson ? "JSON" : wantsTable ? "table" : "prose",
  };
}

export function heuristicPreFlight(prompt: string, intent: ExtractedIntent): PreFlightAnalysis {
  const p = prompt.toLowerCase();
  const failures: PredictedFailure[] = [];
  const halluc: string[] = [];
  const loop: string[] = [];
  const irreversible: string[] = [];
  const fenceConfig: Record<string, "IRREVERSIBLE" | "IDEMPOTENT"> = {};

  for (const t of Object.values(TOOLS)) {
    if (t.effect === "IRREVERSIBLE" && mentionsTool(prompt, t.name)) {
      fenceConfig[t.name] = "IRREVERSIBLE";
      irreversible.push(t.name);
    }
  }

  const realTime = /\b(latest|current|real-?time|today|now|live|price|stock|weather)\b/.test(p);
  if (realTime) {
    halluc.push("asks for real-time/current data the agent cannot reliably ground");
    failures.push({
      type: "OVERCONFIDENT",
      probability: 0.6,
      atStep: 2,
      reason: "Prompt requests live data; the model may state a confident value with no tool grounding.",
      prevention: "Require a successful tool result before any numeric claim; hedge otherwise.",
    });
  }

  const specific = /\b(exact|precise|specific|find the|how many|number of)\b/.test(p);
  if (specific) {
    failures.push({
      type: "SILENT_FAILURE",
      probability: 0.5,
      atStep: 1,
      reason: "Narrow lookup may return no results while the model proceeds confidently.",
      prevention: "Validate tool output is non-empty before using it; broaden the query on empty.",
    });
  }

  const multiStep = /\band\b|then|after|also/.test(p) || intent.requiredElements.length > 4;
  if (multiStep) {
    loop.push("multi-constraint task can cause repeated retries of the same lookup");
    failures.push({
      type: "LOOP_WASTE",
      probability: 0.35,
      atStep: 3,
      reason: "Multi-step task with retries risks re-calling the same tool with identical input.",
      prevention: "Detect identical input hashes across steps and abort the loop.",
    });
  }

  if (irreversible.length) {
    failures.push({
      type: "FENCE_SUPPRESSED",
      probability: 0.4,
      atStep: 4,
      reason: `Irreversible effects (${irreversible.join(", ")}) may fire on low-quality or duplicated data.`,
      prevention: "Fence irreversible tools; hold for approval when upstream data quality is low.",
    });
  }

  if (failures.length === 0) {
    failures.push({
      type: "INCOMPLETE_ANSWER",
      probability: 0.3,
      atStep: 1,
      reason: "Simple prompt; main risk is an incomplete answer missing a required element.",
      prevention: "Check all required elements appear before finalizing.",
    });
  }

  const riskScore = Math.min(
    100,
    (realTime ? 30 : 0) + (specific ? 20 : 0) + (multiStep ? 15 : 0) + irreversible.length * 20 + 10
  );
  const complexity: PreFlightAnalysis["complexity"] =
    riskScore >= 80 ? "DANGEROUS" : riskScore >= 55 ? "COMPLEX" : riskScore >= 30 ? "MEDIUM" : "SIMPLE";

  return {
    riskScore,
    complexity,
    predictedFailures: failures,
    irreversibleActionsDetected: irreversible,
    loopRiskFactors: loop,
    hallucinationRiskFactors: halluc,
    recommendedFenceConfig: fenceConfig,
    estimatedSteps: Math.max(2, intent.requiredElements.length),
    estimatedCostUSD: 0.01,
    shouldProceed: !(riskScore > 80 && irreversible.length > 0),
    proceedWithWarnings: failures.map((f) => `${f.type}: ${f.reason}`),
  };
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "what", "which", "your", "about", "into", "then",
  "have", "will", "should", "would", "could", "please", "give", "tell", "find", "make", "want", "need",
  "them", "they", "their", "there", "here", "when", "where", "also", "after",
]);
