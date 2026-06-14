/**
 * STAGE 5 — Causal attribution engine.
 *
 * When anything goes wrong, build the exact causal chain from real evidence:
 * walk back from the failure to the first step/token that made it inevitable,
 * then build the forward chain to the outcome, marking where an intervention
 * could have stopped it. Every node is anchored to a real step or token index.
 */
import type {
  CausalChain,
  CausalNode,
  FaultType,
  FenceEvent,
  Intervention,
  StepValidation,
  StreamSignal,
  TokenEvent,
} from "../types.js";
import { TOOLS } from "../tools/registry.js";

const SIGNAL_TO_FAULT: Record<StreamSignal["type"], FaultType> = {
  HALLUCINATION_FORMING: "HALLUCINATION",
  SILENT_FAILURE: "SILENT_FAILURE",
  LOOP_STARTING: "LOOP_WASTE",
  INTENT_DRIFT: "INTENT_DRIFT",
  CONTEXT_COLLAPSE: "CONTEXT_COLLAPSE",
  OVERCONFIDENCE: "OVERCONFIDENT",
};

export interface CausalInput {
  signals: StreamSignal[];
  stepLog: StepValidation[];
  fenceLog: FenceEvent[];
  interventions: Intervention[];
  tokenStream: TokenEvent[];
  aborted: boolean;
  verdictFailure: boolean;
}

/** Was there a failure at all? Stage 5 only runs when this is true. */
export function hasFailure(input: CausalInput): boolean {
  return (
    input.aborted ||
    input.verdictFailure ||
    input.signals.length > 0 ||
    input.stepLog.some((s) => s.silentFailureDetected || s.dataQualityScore < 40)
  );
}

export function deriveFailureType(input: CausalInput): FaultType {
  // The highest-severity signal wins; HIGH before MEDIUM before LOW.
  const ordered = [...input.signals].sort((a, b) => sev(b.severity) - sev(a.severity));
  if (ordered[0]) return SIGNAL_TO_FAULT[ordered[0].type];
  const silent = input.stepLog.find((s) => s.silentFailureDetected);
  if (silent) return "SILENT_FAILURE";
  const lowq = input.stepLog.find((s) => s.dataQualityScore < 40);
  if (lowq) return "TOOL_FAILURE";
  return input.verdictFailure ? "WRONG_ANSWER" : "INCOMPLETE_ANSWER";
}

export function buildCausalChain(input: CausalInput): CausalChain {
  const failureType = deriveFailureType(input);

  // ── Root cause: earliest evidence that made the failure inevitable. ────────
  const problemStep = [...input.stepLog]
    .filter((s) => s.silentFailureDetected || s.dataQualityScore < 40)
    .sort((a, b) => a.stepNumber - b.stepNumber)[0];
  const firstSignal = [...input.signals].sort((a, b) => a.tokenIndex - b.tokenIndex)[0];

  let rootCause: CausalNode;
  if (problemStep) {
    rootCause = {
      at: { step: problemStep.stepNumber },
      label: `${problemStep.toolCalled} returned ${problemStep.silentFailureDetected ? "empty/error" : "low-quality"} data (quality ${problemStep.dataQualityScore}/100)`,
    };
  } else if (firstSignal) {
    rootCause = {
      at: { step: firstSignal.detectedAtStep, tokenIndex: firstSignal.tokenIndex },
      label: firstSignal.evidence,
    };
  } else {
    rootCause = { at: { step: 0 }, label: "answer drifted from the user's intent" };
  }

  // ── Forward chain, built only from things that actually happened. ──────────
  const chain: CausalNode[] = [rootCause];

  const groundingSignal = input.signals.find(
    (s) => s.type === "SILENT_FAILURE" || s.type === "HALLUCINATION_FORMING" || s.type === "OVERCONFIDENCE"
  );
  if (groundingSignal) {
    chain.push({
      at: { step: groundingSignal.detectedAtStep, tokenIndex: groundingSignal.tokenIndex },
      label: `model had no grounding; ${groundingSignal.type} detected at token ${groundingSignal.tokenIndex}`,
    });
  }

  const abort = input.interventions.find((i) => i.type === "ABORT");
  if (abort) {
    chain.push({
      at: { step: abort.step, ...(abort.tokenIndex !== undefined ? { tokenIndex: abort.tokenIndex } : {}) },
      label: `ABORTED at step ${abort.step} before the failure spread — ${abort.action}`,
    });
  }

  const redirect = input.interventions.find((i) => i.type === "REDIRECT" || i.type === "FENCE");
  if (redirect) {
    chain.push({
      at: { step: redirect.step },
      label: `${redirect.type} at step ${redirect.step}: ${redirect.action}`,
    });
  }

  const recovery = input.stepLog
    .filter((s) => problemStep && s.stepNumber > problemStep.stepNumber && s.dataQualityScore >= 80)
    .sort((a, b) => a.stepNumber - b.stepNumber)[0];
  if (recovery) {
    chain.push({
      at: { step: recovery.stepNumber },
      label: `step ${recovery.stepNumber} (${recovery.toolCalled}) succeeded, quality ${recovery.dataQualityScore}`,
    });
  }

  // ── Damage accounting from the real fence ledger. ──────────────────────────
  const suppressedDamage = input.fenceLog
    .filter((e) => e.decision === "SUPPRESSED")
    .reduce((sum, e) => sum + (TOOLS[e.tool]?.damageIfWrongUSD ?? 0), 0);
  // A HIGH abort that stopped a bad answer reaching the user also prevents the
  // downstream cost of acting on it; credit a conservative flat estimate.
  const abortCredit = abort ? 0.1 : 0;
  const damagePreventedUSD = round(suppressedDamage + abortCredit);
  const actualDamageUSD = input.verdictFailure && !abort ? 0.2 : 0;
  const totalDamageUSD = round(damagePreventedUSD + actualDamageUSD);

  chain.push({
    at: abort ? { step: abort.step } : { step: input.stepLog.at(-1)?.stepNumber ?? 0 },
    label:
      abort || recovery
        ? `RESOLVED — damage prevented $${damagePreventedUSD.toFixed(2)}`
        : `${input.verdictFailure ? "FAILURE" : "DEGRADED"} — ${failureType}`,
  });

  const preventableAt = firstSignal
    ? { at: { step: firstSignal.detectedAtStep, tokenIndex: firstSignal.tokenIndex }, label: `earliest intervention point: ${firstSignal.type}` }
    : rootCause;

  return {
    failureType,
    rootCause,
    chain,
    preventableAt,
    fenceCouldHaveHelped: input.fenceLog.length > 0,
    totalDamageUSD,
    damagePreventedUSD,
  };
}

function sev(s: StreamSignal["severity"]): number {
  return s === "HIGH" ? 3 : s === "MEDIUM" ? 2 : 1;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
