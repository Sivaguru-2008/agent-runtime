/**
 * STAGE 3 — Step validator.
 *
 * Runs after EVERY tool call. Compares what the model said it would get
 * (its pre-tool `expect`) against the raw tool output, scores data quality, and
 * flags silent failures and duplicate calls.
 *
 * Critical rule (from the spec): if a silent failure is detected AND the model
 * was confident, the step recommends ABORT with the exact evidence.
 */
import type { StepValidation } from "../types.js";
import type { ToolResult } from "../tools/registry.js";

export interface ValidateArgs {
  stepNumber: number;
  toolCalled: string;
  inputHash: string;
  claim: string;
  result: ToolResult;
  duplicate: boolean;
  fenceDecision: "COMMIT" | "SUPPRESS";
}

/** Score 0-100 for how usable a tool result is. */
export function scoreQuality(result: ToolResult): number {
  if (!result.ok) return 10;
  const d = result.data;
  if (d === null || d === undefined) return 18;
  if (Array.isArray(d)) {
    if (d.length === 0) return 12; // empty result set — classic silent failure
    return Math.min(96, 80 + d.length * 4);
  }
  if (typeof d === "object") {
    const keys = Object.keys(d as Record<string, unknown>);
    if (keys.length === 0) return 20;
    const meaningful = keys.filter((k) => {
      const v = (d as Record<string, unknown>)[k];
      return v !== null && v !== undefined && v !== "" && v !== false;
    }).length;
    return meaningful === 0 ? 24 : Math.min(96, 82 + meaningful * 4);
  }
  if (typeof d === "string") return d.trim() ? 88 : 14;
  return 86;
}

export function isEmptyResult(result: ToolResult): boolean {
  if (!result.ok) return true;
  const d = result.data;
  if (d === null || d === undefined) return true;
  if (Array.isArray(d)) return d.length === 0;
  if (typeof d === "object") return Object.keys(d as Record<string, unknown>).length === 0;
  if (typeof d === "string") return d.trim().length === 0;
  return false;
}

/** Did the model's claim expect to receive data of substance? */
function claimExpectedData(claim: string): boolean {
  const c = claim.toLowerCase();
  if (!c.trim()) return false;
  return /\b(find|get|return|value|result|price|number|data|answer|amount|list|details?|info)/.test(c) || c.length > 12;
}

export function validateStep(args: ValidateArgs): StepValidation {
  const quality = scoreQuality(args.result);
  const empty = isEmptyResult(args.result);
  const expectedData = claimExpectedData(args.claim);

  const silentFailureDetected = empty && expectedData;
  const silentFailureEvidence = silentFailureDetected
    ? `tool "${args.toolCalled}" returned ${args.result.ok ? "an empty result" : `error: ${args.result.error ?? "unknown"}`}, ` +
      `but the model expected: "${args.claim.slice(0, 120)}"`
    : "";

  const claimMatchesResult = !empty && quality >= 50;

  let continueRecommendation = true;
  let abortReason = "";
  if (silentFailureDetected) {
    continueRecommendation = false;
    abortReason = `SILENT_FAILURE at step ${args.stepNumber}: ${silentFailureEvidence}`;
  } else if (args.duplicate) {
    continueRecommendation = false;
    abortReason = `DUPLICATE call: "${args.toolCalled}" repeated with identical input (hash ${args.inputHash.slice(0, 8)})`;
  }

  return {
    stepNumber: args.stepNumber,
    toolCalled: args.toolCalled,
    inputHash: args.inputHash,
    llmClaimedItWouldGet: args.claim,
    actualToolResult: safeStringify(args.result),
    claimMatchesResult,
    dataQualityScore: quality,
    silentFailureDetected,
    silentFailureEvidence,
    duplicateCallDetected: args.duplicate,
    fenceDecision: args.fenceDecision,
    continueRecommendation,
    abortReason,
  };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 500);
  } catch {
    return String(v);
  }
}
