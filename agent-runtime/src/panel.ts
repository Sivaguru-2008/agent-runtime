/**
 * The unified panel — one AGENT INTELLIGENCE REPORT next to every response,
 * showing all eight stages plus the cross-run pattern intelligence. Rendered
 * purely from a finished RunContext, so what you see is exactly what was
 * recorded in the database.
 */
import type {
  FenceEvent,
  Intervention,
  PatternIntelligence,
  RunContext,
  StepValidation,
  StreamSignal,
} from "./types.js";

const RULE = "═".repeat(56);
const THIN = "─".repeat(44);

export function renderPanel(ctx: RunContext, intel: PatternIntelligence): string {
  const L: string[] = [];
  L.push(RULE);
  L.push("AGENT INTELLIGENCE REPORT");
  L.push(`run ${ctx.runId}`);
  L.push(RULE);

  // ── Stage 1 ───────────────────────────────────────────────────────────────
  L.push("");
  L.push(`PRE-FLIGHT${pad(`Risk: ${ctx.preFlight.riskScore}/100 ${riskMark(ctx.preFlight.riskScore)}`, 56 - "PRE-FLIGHT".length)}`);
  L.push(THIN);
  if (ctx.preFlight.predictedFailures.length === 0) {
    L.push("Predicted:  (none)");
  } else {
    for (const f of ctx.preFlight.predictedFailures.slice(0, 4)) {
      L.push(`Predicted:  ${f.type} at step ${f.atStep}  (${Math.round(f.probability * 100)}% likely)`);
    }
  }
  const fenced = Object.entries(ctx.preFlight.recommendedFenceConfig).filter(([, v]) => v === "IRREVERSIBLE");
  if (fenced.length) {
    L.push(`Auto-fenced: ${fenced.map(([k]) => k).join(", ")} → IRREVERSIBLE`);
  } else {
    L.push("Auto-fenced: (no irreversible tools)");
  }

  // ── Stage 2 ───────────────────────────────────────────────────────────────
  L.push("");
  const steps = ctx.stepValidations.length;
  L.push(`RUNTIME STREAM${pad(`${steps} steps / ${(ctx.durationMs / 1000).toFixed(1)}s`, 56 - "RUNTIME STREAM".length)}`);
  L.push(THIN);
  if (ctx.streamSignals.length === 0) {
    L.push("(no risk signals detected in the token stream)");
  } else {
    for (const s of ctx.streamSignals) {
      L.push(`Token ${String(s.tokenIndex).padEnd(5)} ${s.type} → ${signalOutcome(s, ctx.interventions)}`);
    }
  }

  // ── Stage 3 ───────────────────────────────────────────────────────────────
  L.push("");
  L.push("STEP VALIDATION");
  L.push(THIN);
  if (ctx.stepValidations.length === 0) {
    L.push("(no tool calls)");
  } else {
    for (const v of ctx.stepValidations) L.push(...renderStep(v));
  }

  // ── Stage 4 ───────────────────────────────────────────────────────────────
  L.push("");
  L.push("FENCE EVENTS");
  L.push(THIN);
  if (ctx.fenceEvents.length === 0) {
    L.push("(no irreversible effects reached the fence)");
  } else {
    for (const e of ctx.fenceEvents) L.push(...renderFence(e));
  }

  // ── Stage 5 ───────────────────────────────────────────────────────────────
  L.push("");
  if (ctx.causalChain) {
    L.push(`CAUSAL CHAIN (${ctx.causalChain.failureType})`);
    L.push(THIN);
    L.push(`Root:  ${ctx.causalChain.rootCause.label}`);
    for (const node of ctx.causalChain.chain.slice(1)) {
      L.push(`→      ${node.label}${node.at.tokenIndex !== undefined ? `  (token ${node.at.tokenIndex})` : node.at.step ? `  (step ${node.at.step})` : ""}`);
    }
    L.push(`Preventable at: ${ctx.causalChain.preventableAt.label}`);
  } else {
    L.push("CAUSAL CHAIN");
    L.push(THIN);
    L.push("(no failure — no causal chain needed)");
  }

  // ── Stage 6 ───────────────────────────────────────────────────────────────
  L.push("");
  L.push("INTERVENTIONS");
  L.push(THIN);
  if (ctx.interventions.length === 0) {
    L.push("(none required)");
  } else {
    ctx.interventions.forEach((iv, i) => L.push(`${i + 1}. ${iv.type} @step${iv.step} — ${iv.action}`));
  }

  // ── Damage prevented ──────────────────────────────────────────────────────
  L.push("");
  L.push("DAMAGE PREVENTED");
  L.push(THIN);
  if (ctx.finalEvaluation.preventedFailures.length === 0 && ctx.finalEvaluation.damagePrevented.length === 0) {
    L.push("(nothing needed preventing)");
  } else {
    for (const p of ctx.finalEvaluation.preventedFailures) L.push(`✓ ${p}`);
    for (const d of ctx.finalEvaluation.damagePrevented) L.push(`✓ ${d.description} ($${d.estimatedCostUSD.toFixed(2)})`);
  }
  L.push(`Estimated damage prevented: $${ctx.damagePreventedUSD.toFixed(2)}`);

  // ── Stage 8 ───────────────────────────────────────────────────────────────
  L.push("");
  L.push("FINAL VERDICT");
  L.push(THIN);
  L.push(`User got what they asked:  ${ctx.finalEvaluation.userGotWhatTheyAsked ? "✅ YES" : "❌ NO"}  (${ctx.finalEvaluation.overallVerdict})`);
  L.push(`Completeness:              ${ctx.finalEvaluation.completenessScore}/100`);
  L.push(`Accuracy:                  ${ctx.finalEvaluation.accuracyScore}/100`);
  L.push(`Failures prevented:        ${ctx.finalEvaluation.preventedFailures.length}`);
  L.push(`Cost:                      $${ctx.totalCostUSD.toFixed(4)}`);
  if (ctx.finalEvaluation.missingElements.length) {
    L.push(`Missing:                   ${ctx.finalEvaluation.missingElements.slice(0, 5).join(", ")}`);
  }
  L.push(`Verdict:                   ${ctx.finalEvaluation.verdictReason}`);

  // ── Stage 7: cross-run intelligence ───────────────────────────────────────
  L.push("");
  L.push(RULE);
  L.push(`PATTERN INTELLIGENCE (across ${intel.totalRuns} run${intel.totalRuns === 1 ? "" : "s"})`);
  L.push(RULE);
  if (intel.patterns.length === 0) {
    L.push("(no faults recorded yet)");
  } else {
    for (const p of intel.patterns.slice(0, 8)) {
      L.push(
        `${p.faultType.padEnd(18)} ${String(p.occurrences).padStart(3)}x  ${arrow(p.trend)}  ` +
          `avg damage $${p.avgDamageUSD.toFixed(2)}  fence ${(p.fenceHelpRate * 100).toFixed(0)}%`
      );
    }
  }
  L.push(`Pre-flight accuracy: ${(intel.preFlightAccuracy * 100).toFixed(0)}% ${arrow(intel.preFlightAccuracyTrend)} improving`);
  L.push(
    `Fence:               ${intel.fenceCommitted} committed exactly-once · ${intel.fenceSuppressed} suppressed ` +
      `(${(intel.fenceSaveRate * 100).toFixed(0)}% suppressed)`
  );
  L.push(RULE);

  return L.join("\n");
}

function renderStep(v: StepValidation): string[] {
  const mark = v.silentFailureDetected ? "⚠️ " : v.duplicateCallDetected ? "🔁" : v.fenceDecision === "SUPPRESS" ? "🛑" : "✅";
  const head = `Step ${v.stepNumber} ${mark} ${v.toolCalled.padEnd(16)} quality: ${v.dataQualityScore}`;
  const lines = [head];
  if (v.silentFailureDetected) lines.push(`        SILENT_FAILURE → ${v.silentFailureEvidence}`);
  else if (v.duplicateCallDetected) lines.push(`        duplicate input hash ${v.inputHash.slice(0, 8)}`);
  return lines;
}

function renderFence(e: FenceEvent): string[] {
  const head = `Step ${e.step} [${e.decision}] ${e.tool}`;
  return [head, `        reason: ${e.reason}`];
}

function signalOutcome(s: StreamSignal, interventions: Intervention[]): string {
  const iv = interventions.find((i) => i.step === s.detectedAtStep);
  if (!iv) return s.severity;
  return iv.type === "ABORT" ? "ABORTED" : iv.type === "REDIRECT" ? "REDIRECTED" : iv.type === "FENCE" ? "FENCED" : iv.type;
}

function riskMark(score: number): string {
  return score >= 80 ? "⛔" : score >= 55 ? "⚠" : "✓";
}

function arrow(t: "UP" | "DOWN" | "FLAT"): string {
  return t === "UP" ? "↑" : t === "DOWN" ? "↓" : "→";
}

function pad(text: string, width: number): string {
  const space = Math.max(1, width - text.length);
  return " ".repeat(space) + text;
}
