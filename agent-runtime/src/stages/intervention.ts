/**
 * STAGE 6 — Intervention engine.
 *
 * Turns signals (Stage 2) and step validations (Stage 3) into real-time
 * decisions: WARN, REDIRECT, ABORT, FENCE, REPLAY, HUMAN. The runtime applies
 * the decision immediately — aborting the loop, injecting a correction, or
 * holding an irreversible effect — so damage is prevented at the fence, not
 * explained after the fact.
 */
import type { ExtractedIntent, Intervention, StepValidation, StreamSignal } from "../types.js";

export interface InterventionContext {
  runId: string;
  intent: ExtractedIntent;
}

export class InterventionEngine {
  /** Decide what to do about a streaming signal. */
  evaluate(signal: StreamSignal, ctx: InterventionContext): Intervention {
    const base = { runId: ctx.runId, step: signal.detectedAtStep, tokenIndex: signal.tokenIndex, outcome: "PENDING" as const };

    switch (signal.type) {
      case "HALLUCINATION_FORMING":
        if (signal.severity === "HIGH") {
          return {
            ...base,
            type: "ABORT",
            action: "stop generation before the hallucinated claim reaches the user",
            reason: signal.evidence,
            returnToUser:
              `Stopped: detected a hallucination forming at step ${signal.detectedAtStep} (token ${signal.tokenIndex}). ` +
              `${signal.evidence}. Try: ${this.suggestAlternative(signal)}`,
          };
        }
        return { ...base, type: "WARN", action: "flag low-confidence claim", reason: signal.evidence };

      case "SILENT_FAILURE":
        return {
          ...base,
          type: "ABORT",
          action: "stop before the model uses data the tool never returned",
          reason: `Tool returned empty/error but the model is proceeding with confidence. Evidence: ${signal.evidence}`,
          returnToUser: `Stopped: silent tool failure at step ${signal.detectedAtStep}. ${signal.evidence}.`,
        };

      case "LOOP_STARTING":
        if (signal.severity === "HIGH") {
          return {
            ...base,
            type: "ABORT",
            action: "kill execution to stop the loop",
            reason: `Loop detected: ${signal.evidence}`,
            fenceAction: "suppress all further tool calls",
            returnToUser: `Stopped: loop detected at step ${signal.detectedAtStep}. ${signal.evidence}.`,
          };
        }
        return {
          ...base,
          type: "REDIRECT",
          action: "inject anti-loop instruction",
          reason: signal.evidence,
          correction: `You are repeating yourself (${signal.evidence}). Do NOT call the same tool with the same input again. Use what you already have or change approach.`,
        };

      case "INTENT_DRIFT":
        return {
          ...base,
          type: "REDIRECT",
          action: "inject correction into context to refocus on the question",
          reason: signal.evidence,
          correction: `Remember the user asked: "${ctx.intent.successCriteria}". Refocus on this specifically. Required: ${ctx.intent.requiredElements.join(", ")}.`,
        };

      case "CONTEXT_COLLAPSE":
        return {
          ...base,
          type: "REDIRECT",
          action: "re-supply context the model lost",
          reason: signal.evidence,
          correction: `The information you are asking for was already provided. Re-read the task: "${ctx.intent.goal}". Do not ask for details already in context.`,
        };

      case "OVERCONFIDENCE":
        return {
          ...base,
          type: "WARN",
          action: "inject a hedging instruction",
          reason: signal.evidence,
          correction: `The data behind this claim is weak. Hedge appropriately and state your uncertainty rather than asserting a definitive value.`,
        };
    }
  }

  /**
   * Decide whether an irreversible tool should be held before it fires, based
   * on the quality of the steps that produced its inputs.
   */
  evaluateFenceHold(
    tool: string,
    step: number,
    upstream: StepValidation[],
    ctx: InterventionContext
  ): Intervention | null {
    const bad = upstream.find((v) => v.silentFailureDetected || v.dataQualityScore < 30);
    if (!bad) return null;
    return {
      runId: ctx.runId,
      step,
      type: "FENCE",
      action: `hold irreversible tool "${tool}" for human approval`,
      reason: `upstream step ${bad.stepNumber} produced low-quality data (${bad.dataQualityScore}/100)${bad.silentFailureDetected ? " with a silent failure" : ""}`,
      fenceAction: `suppress ${tool} until data is verified`,
      correction: `Do not call ${tool}: the data it would act on is unreliable (step ${bad.stepNumber}, quality ${bad.dataQualityScore}/100).`,
      outcome: "PENDING",
    };
  }

  private suggestAlternative(signal: StreamSignal): string {
    switch (signal.type) {
      case "HALLUCINATION_FORMING":
        return "ground every factual claim with a successful tool call before stating it";
      case "SILENT_FAILURE":
        return "broaden the query or use a different tool, then verify the result is non-empty";
      case "LOOP_STARTING":
        return "change the approach instead of repeating the same call";
      default:
        return "refocus on the user's actual question";
    }
  }
}
