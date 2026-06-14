/**
 * Full-pipeline integration test. Runs the ten demo prompts through the real
 * eight-stage Runtime using the deterministic offline agent — the tools, fence,
 * analyzers, and database are all real. Asserts every success criterion holds
 * across the batch, end to end by runId.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Runtime } from "../src/runtime.js";
import { RuntimeDB } from "../src/db/database.js";
import { MockAgentClient } from "../src/llm/mockAgent.js";
import { renderPanel } from "../src/panel.js";
import { DEMO_PROMPTS } from "../src/demoPrompts.js";
import type { RunContext, PatternIntelligence } from "../src/types.js";

const SIGNAL_TO_FAULT: Record<string, string> = {
  HALLUCINATION_FORMING: "HALLUCINATION",
  SILENT_FAILURE: "SILENT_FAILURE",
  LOOP_STARTING: "LOOP_WASTE",
  INTENT_DRIFT: "INTENT_DRIFT",
  CONTEXT_COLLAPSE: "CONTEXT_COLLAPSE",
  OVERCONFIDENCE: "OVERCONFIDENT",
};

function observed(ctx: RunContext): Set<string> {
  const s = new Set<string>();
  for (const sig of ctx.streamSignals) if (SIGNAL_TO_FAULT[sig.type]) s.add(SIGNAL_TO_FAULT[sig.type]!);
  if (ctx.stepValidations.some((v) => v.silentFailureDetected)) s.add("SILENT_FAILURE");
  if (ctx.fenceEvents.some((e) => e.decision === "SUPPRESSED")) s.add("FENCE_SUPPRESSED");
  if (ctx.causalChain) s.add(ctx.causalChain.failureType);
  return s;
}

describe("Full 8-stage pipeline (10 real prompts, deterministic agent)", () => {
  const contexts: RunContext[] = [];
  let db: RuntimeDB;
  let intel: PatternIntelligence;

  beforeAll(async () => {
    db = new RuntimeDB(":memory:");
    const runtime = new Runtime(new MockAgentClient(), db, { maxSteps: 8 });
    for (const prompt of DEMO_PROMPTS) {
      const { ctx, intelligence } = await runtime.run(prompt);
      contexts.push(ctx);
      intel = intelligence;
    }
  });

  it("ran pre-flight on every prompt before the agent (Non-Negotiable #1)", () => {
    for (const ctx of contexts) {
      expect(ctx.preFlight).toBeTruthy();
      expect(typeof ctx.preFlight.riskScore).toBe("number");
      expect(ctx.preFlight.predictedFailures.length).toBeGreaterThan(0);
    }
  });

  it("gave every run a unique runId connecting all stages (Non-Negotiable #10)", () => {
    const ids = new Set(contexts.map((c) => c.runId));
    expect(ids.size).toBe(contexts.length);
    for (const ctx of contexts) {
      for (const s of ctx.streamSignals) expect(s.runId).toBe(ctx.runId);
      for (const e of ctx.fenceEvents) expect(e.runId).toBe(ctx.runId);
      for (const iv of ctx.interventions) expect(iv.runId).toBe(ctx.runId);
    }
  });

  it("Criterion 1: pre-flight predicted at least one failure correctly", () => {
    const hit = contexts.some((ctx) => {
      const predicted = new Set(ctx.preFlight.predictedFailures.map((f) => f.type));
      const obs = observed(ctx);
      return [...predicted].some((t) => obs.has(t));
    });
    expect(hit).toBe(true);
  });

  it("Criterion 2: stream analyzer caught at least one hallucination forming", () => {
    expect(contexts.some((c) => c.streamSignals.some((s) => s.type === "HALLUCINATION_FORMING"))).toBe(true);
  });

  it("Criterion 3: at least one silent failure caught at a tool boundary", () => {
    expect(contexts.some((c) => c.stepValidations.some((v) => v.silentFailureDetected))).toBe(true);
  });

  it("Criterion 4: at least one causal chain built from real evidence", () => {
    const withChain = contexts.find((c) => c.causalChain);
    expect(withChain).toBeTruthy();
    expect(withChain!.causalChain!.chain.length).toBeGreaterThan(1);
    // Root cause anchored to a real step or token.
    const at = withChain!.causalChain!.rootCause.at;
    expect(at.step !== undefined || at.tokenIndex !== undefined).toBe(true);
  });

  it("Criterion 5: at least one intervention prevented damage", () => {
    const prevented = contexts.some(
      (c) => c.interventions.some((i) => i.type === "ABORT" || i.type === "FENCE") || c.fenceEvents.some((e) => e.decision === "SUPPRESSED")
    );
    expect(prevented).toBe(true);
  });

  it("Criterion 6: pattern table has real data from real runs", () => {
    expect(intel.totalRuns).toBe(DEMO_PROMPTS.length);
    expect(intel.patterns.length).toBeGreaterThan(0);
    const rows = db.aggregateFaults();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.reduce((s, r) => s + r.occurrences, 0)).toBeGreaterThan(0);
  });

  it("Criterion 7: every event is traceable end to end by runId (reload from DB)", () => {
    for (const ctx of contexts) {
      const reloaded = db.loadRun(ctx.runId);
      expect(reloaded).toBeTruthy();
      expect(reloaded!.runId).toBe(ctx.runId);
      expect(reloaded!.finalEvaluation.overallVerdict).toBe(ctx.finalEvaluation.overallVerdict);
    }
  });

  it("Criterion 8: the panel renders a complete report for every response", () => {
    for (const ctx of contexts) {
      const panel = renderPanel(ctx, intel);
      expect(panel).toContain("AGENT INTELLIGENCE REPORT");
      expect(panel).toContain("PRE-FLIGHT");
      expect(panel).toContain("STEP VALIDATION");
      expect(panel).toContain("FENCE EVENTS");
      expect(panel).toContain("FINAL VERDICT");
      expect(panel).toContain("PATTERN INTELLIGENCE");
      expect(panel).toContain(ctx.runId);
    }
  });

  it("Quality evaluation ran for every response (Non-Negotiable #7)", () => {
    for (const ctx of contexts) {
      expect(["SUCCESS", "PARTIAL", "FAILURE"]).toContain(ctx.finalEvaluation.overallVerdict);
    }
  });

  it("the fence both COMMITS good effects and SUPPRESSES effects on bad data", () => {
    const decisions = contexts.flatMap((c) => c.fenceEvents.map((e) => e.decision));
    expect(decisions).toContain("COMMITTED");
    expect(decisions).toContain("SUPPRESSED");
  });
});
