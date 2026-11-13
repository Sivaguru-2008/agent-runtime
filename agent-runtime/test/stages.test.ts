import { describe, it, expect } from "vitest";
import { StreamAnalyzer } from "../src/stages/streamAnalyzer.js";
import { validateStep, scoreQuality, isEmptyResult } from "../src/stages/stepValidator.js";
import { heuristicPreFlight, heuristicIntent } from "../src/stages/preflight.js";
import { buildCausalChain, hasFailure } from "../src/stages/causalAttribution.js";
import { InterventionEngine } from "../src/stages/intervention.js";
import { tokenize } from "../src/llm/client.js";
import type { StreamSignal, ExtractedIntent } from "../src/types.js";

const intent: ExtractedIntent = {
  goal: "test",
  successCriteria: "answer the question",
  requiredElements: ["revenue", "acme", "division"],
  expectedFormat: "prose",
};

function analyzerWith(): { a: StreamAnalyzer; signals: StreamSignal[] } {
  const signals: StreamSignal[] = [];
  const a = new StreamAnalyzer({ runId: "r1", intent, onSignal: (s) => signals.push(s) });
  return { a, signals };
}

function feed(a: StreamAnalyzer, text: string, startIndex = 0): number {
  let i = startIndex;
  for (const t of tokenize(text)) {
    a.observeToken(t, i);
    i++;
  }
  return i;
}

describe("Stage 2: stream analyzer", () => {
  it("detects HALLUCINATION_FORMING on certainty with no grounding", () => {
    const { a, signals } = analyzerWith();
    a.startTurn(1, 0);
    feed(a, "The answer is definitely correct and final.");
    expect(signals.some((s) => s.type === "HALLUCINATION_FORMING" && s.severity === "HIGH")).toBe(true);
    expect(a.abortSignal?.type).toBe("HALLUCINATION_FORMING");
  });

  it("detects SILENT_FAILURE when prior tool was empty but model is confident", () => {
    const { a, signals } = analyzerWith();
    a.observeToolResult(12, true, false); // empty tool result
    a.startTurn(2, 10);
    feed(a, "The revenue value is 4200000 dollars.", 10);
    expect(signals.some((s) => s.type === "SILENT_FAILURE")).toBe(true);
  });

  it("detects LOOP_STARTING on identical tool input hash", () => {
    const { a, signals } = analyzerWith();
    a.observeToolCall(1, "search_web", "hashA", 5);
    a.observeToolCall(3, "search_web", "hashA", 40);
    const loop = signals.find((s) => s.type === "LOOP_STARTING");
    expect(loop).toBeTruthy();
    expect(loop?.priorSteps).toContain(1);
  });

  it("detects INTENT_DRIFT when a final answer misses required elements", () => {
    const { a, signals } = analyzerWith();
    a.observeToolResult(90, false, true); // grounded, so no hallucination
    a.startTurn(1, 0);
    a.finishTurn("I really enjoy turtles and sunny afternoons.", true);
    expect(signals.some((s) => s.type === "INTENT_DRIFT")).toBe(true);
  });

  it("detects OVERCONFIDENCE on certainty after a low-quality result", () => {
    const { a, signals } = analyzerWith();
    a.observeToolResult(30, false, true);
    a.startTurn(2, 0);
    feed(a, "This is certainly the exact figure.");
    expect(signals.some((s) => s.type === "OVERCONFIDENCE")).toBe(true);
  });
});

describe("Stage 3: step validator", () => {
  it("scores empty arrays low and rich objects high", () => {
    expect(scoreQuality({ ok: true, data: [] })).toBeLessThan(20);
    expect(scoreQuality({ ok: false, data: null, error: "x" })).toBeLessThanOrEqual(10);
    expect(scoreQuality({ ok: true, data: { value: 42, label: "x" } })).toBeGreaterThan(80);
    expect(isEmptyResult({ ok: true, data: [] })).toBe(true);
    expect(isEmptyResult({ ok: true, data: { v: 1 } })).toBe(false);
  });

  it("flags a silent failure when an expecting claim meets an empty result", () => {
    const v = validateStep({
      stepNumber: 3,
      toolCalled: "search_web",
      inputHash: "abc12345",
      claim: "find the exact revenue figure",
      result: { ok: true, data: [] },
      duplicate: false,
      fenceDecision: "COMMIT",
    });
    expect(v.silentFailureDetected).toBe(true);
    expect(v.continueRecommendation).toBe(false);
    expect(v.abortReason).toContain("SILENT_FAILURE");
  });

  it("flags duplicate calls", () => {
    const v = validateStep({
      stepNumber: 4,
      toolCalled: "search_web",
      inputHash: "abc12345",
      claim: "get data",
      result: { ok: true, data: [{ x: 1 }] },
      duplicate: true,
      fenceDecision: "COMMIT",
    });
    expect(v.duplicateCallDetected).toBe(true);
  });
});

describe("Stage 1: heuristic pre-flight", () => {
  it("fences irreversible tools implied by the prompt", () => {
    const i = heuristicIntent("charge the customer and email them a receipt");
    const pf = heuristicPreFlight("charge the customer and email them a receipt", i);
    expect(pf.recommendedFenceConfig["charge_card"]).toBe("IRREVERSIBLE");
    expect(pf.recommendedFenceConfig["send_email"]).toBe("IRREVERSIBLE");
    expect(pf.riskScore).toBeGreaterThan(0);
  });

  it("predicts overconfidence risk on real-time prompts", () => {
    const i = heuristicIntent("what is the current stock price right now");
    const pf = heuristicPreFlight("what is the current stock price right now", i);
    expect(pf.hallucinationRiskFactors.length).toBeGreaterThan(0);
    expect(pf.predictedFailures.some((f) => f.type === "OVERCONFIDENT")).toBe(true);
  });
});

describe("Stage 5: causal attribution", () => {
  it("builds a chain rooted at the empty tool result with damage accounting", () => {
    const input = {
      signals: [
        { runId: "r", type: "SILENT_FAILURE", tokenIndex: 47, detectedAtStep: 2, severity: "HIGH", evidence: "empty result used confidently" } as StreamSignal,
      ],
      stepLog: [
        validateStep({ stepNumber: 1, toolCalled: "search_web", inputHash: "h", claim: "find revenue", result: { ok: true, data: [] }, duplicate: false, fenceDecision: "COMMIT" }),
      ],
      fenceLog: [
        { runId: "r", step: 3, tool: "send_email", decision: "SUPPRESSED" as const, operationId: "op", reason: "held: low quality" },
      ],
      interventions: [
        { runId: "r", step: 2, type: "ABORT" as const, action: "stop", reason: "silent failure", outcome: "PENDING" as const },
      ],
      tokenStream: [],
      aborted: true,
      verdictFailure: false,
    };
    expect(hasFailure(input)).toBe(true);
    const chain = buildCausalChain(input);
    expect(chain.failureType).toBe("SILENT_FAILURE");
    expect(chain.rootCause.label).toContain("search_web");
    expect(chain.chain.length).toBeGreaterThan(1);
    expect(chain.damagePreventedUSD).toBeGreaterThan(0); // suppressed send_email + abort credit
    expect(chain.fenceCouldHaveHelped).toBe(true);
  });
});

describe("Stage 6: intervention engine", () => {
  const engine = new InterventionEngine();
  const ctx = { runId: "r", intent };

  it("ABORTs on a HIGH hallucination", () => {
    const iv = engine.evaluate(
      { runId: "r", type: "HALLUCINATION_FORMING", tokenIndex: 847, detectedAtStep: 3, severity: "HIGH", evidence: "no grounding" },
      ctx
    );
    expect(iv.type).toBe("ABORT");
    expect(iv.returnToUser).toContain("847");
  });

  it("REDIRECTs on intent drift with a refocus correction", () => {
    const iv = engine.evaluate(
      { runId: "r", type: "INTENT_DRIFT", tokenIndex: 10, detectedAtStep: 2, severity: "MEDIUM", evidence: "drifted" },
      ctx
    );
    expect(iv.type).toBe("REDIRECT");
    expect(iv.correction).toContain("answer the question");
  });

  it("holds an irreversible tool when upstream quality is low", () => {
    const upstream = [
      validateStep({ stepNumber: 1, toolCalled: "get_stock_price", inputHash: "h", claim: "live price", result: { ok: false, data: null, error: "n/a" }, duplicate: false, fenceDecision: "COMMIT" }),
    ];
    const hold = engine.evaluateFenceHold("charge_card", 2, upstream, ctx);
    expect(hold?.type).toBe("FENCE");
    expect(hold?.fenceAction).toContain("charge_card");
  });
});
