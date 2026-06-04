import { describe, expect, it } from "vitest";
import { PlannerAgent } from "../src/runtime/cognition/agents/plannerAgent.js";
import { VerifierAgent } from "../src/runtime/cognition/agents/verifierAgent.js";
import type { ModelProvider } from "../src/domain/ports.js";
import type { RoleContext } from "../src/runtime/cognition/roles.js";

/**
 * Model-backed planner/verifier. Proves:
 *   • a wired ModelProvider drives a real (model-backed) plan/verdict,
 *   • provider failure or unparseable output falls back to the deterministic
 *     heuristic so a run can never be blocked,
 *   • with NO provider the heuristic is unchanged + deterministic (the default
 *     and test path — guarantees existing behaviour/replay is preserved),
 *   • the verifier never re-introduces the selfReport inversion.
 */

function stubProvider(
  output: Record<string, unknown>,
  opts?: { throws?: boolean; confidence?: number }
): ModelProvider {
  return {
    async complete({ onToken }) {
      if (opts?.throws) throw new Error("provider down");
      onToken?.("tok", opts?.confidence ?? 1.0);
      return { output, tokenUsage: { prompt: 1, completion: 1, total: 2 } };
    }
  };
}

function ctx(overrides: Partial<RoleContext> = {}): RoleContext {
  return {
    cognitionId: "cog-1",
    executionId: "exec-1",
    agentId: "agent-1",
    goal: "Summarise the incident and propose a fix",
    task: { prompt: "Summarise the incident" },
    seed: "seed-1",
    history: [],
    memories: [],
    carryOver: {},
    ...overrides
  };
}

describe("PlannerAgent — model-backed vs heuristic", () => {
  it("uses model-produced steps when a provider is wired", async () => {
    const planner = new PlannerAgent(
      stubProvider({ steps: [{ id: "a", description: "do a" }, { id: "b", description: "do b" }] })
    );
    const res = await planner.invoke(ctx());
    expect(res.output.modelBacked).toBe(true);
    expect((res.output.steps as unknown[]).length).toBe(2);
    expect(res.uncertainty.selfReport).toBeGreaterThan(0.5);
    expect(res.nextPhase).toBe("EXECUTE");
  });

  it("falls back to the heuristic plan when the provider throws", async () => {
    const planner = new PlannerAgent(stubProvider({}, { throws: true }));
    const res = await planner.invoke(ctx());
    expect(res.output.modelBacked).toBeUndefined();
    expect((res.output.steps as unknown[]).length).toBeGreaterThan(0);
    expect(res.nextPhase).toBe("EXECUTE");
  });

  it("falls back to the heuristic plan when the model output has no steps", async () => {
    const planner = new PlannerAgent(stubProvider({ commentary: "I think we should..." }));
    const res = await planner.invoke(ctx());
    // model-backed envelope, but steps came from the heuristic decomposition
    expect((res.output.steps as unknown[]).length).toBeGreaterThan(0);
  });

  it("is deterministic and unchanged with no provider", async () => {
    const a = await new PlannerAgent().invoke(ctx());
    const b = await new PlannerAgent().invoke(ctx());
    expect(a.output.steps).toEqual(b.output.steps);
    expect(a.output.modelBacked).toBeUndefined();
  });
});

describe("VerifierAgent — model-backed vs heuristic", () => {
  it("adjudicates PASS via the model and routes to CRITIQUE", async () => {
    const verifier = new VerifierAgent(stubProvider({ verdict: "PASS", score: 0.92 }));
    const res = await verifier.invoke(ctx({ carryOver: { modelOutput: { ok: true } } }));
    expect(res.output.modelBacked).toBe(true);
    expect(res.output.verdict).toBe("PASS");
    expect(res.uncertainty.selfReport).toBeCloseTo(0.92, 2);
    expect(res.nextPhase).toBe("CRITIQUE");
  });

  it("adjudicates FAIL via the model and routes back to EXECUTE", async () => {
    const verifier = new VerifierAgent(stubProvider({ verdict: "FAIL", score: 0.3 }));
    const res = await verifier.invoke(ctx({ carryOver: { modelOutput: { ok: true } } }));
    expect(res.output.verdict).toBe("FAIL");
    expect(res.nextPhase).toBe("EXECUTE");
  });

  it("falls back to heuristic checks when model output is unparseable", async () => {
    const verifier = new VerifierAgent(stubProvider({ rambling: "not a verdict" }));
    const res = await verifier.invoke(ctx({ carryOver: { modelOutput: { ok: true, data: 1 } } }));
    expect(res.output.multiVerifierMode).toBe(false);
    expect(res.output.modelBacked).toBeUndefined();
  });

  it("with no provider, a passing verification reports HIGH confidence (not inverted)", async () => {
    const verifier = new VerifierAgent();
    const res = await verifier.invoke(ctx({ carryOver: { modelOutput: { ok: true, data: 1 } } }));
    expect(res.output.verdict).toBe("PASS");
    // Regression guard: selfReport must equal the score (confidence), so a PASS
    // never collapses to 0 and force-HALTS the run.
    expect(res.uncertainty.selfReport).toBeGreaterThan(0.5);
  });
});
