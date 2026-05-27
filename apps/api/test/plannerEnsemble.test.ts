import { describe, expect, it } from "vitest";
import type { RoleAgent, RoleContext, RoleResult } from "../src/runtime/cognition/roles.js";
import { PlannerEnsemble } from "../src/runtime/planning/plannerEnsemble.js";

// Utility to create a basic mock role context
function createMockContext(seed = "test-seed", goal = "Solve global warming"): RoleContext {
  return {
    cognitionId: "cog-123",
    executionId: "exec-123",
    agentId: "agent-123",
    goal,
    task: { prompt: "Save the world", requiresVerification: true },
    seed,
    history: [],
    memories: [],
    carryOver: {}
  };
}

// Helper to construct a Mock Planner RoleAgent
function createMockPlanner(
  steps: Array<{ id: string; description: string }>,
  confidence = 0.8,
  shouldFail = false
): RoleAgent {
  return {
    role: "PLANNER" as const,
    invoke: async (context: RoleContext): Promise<RoleResult> => {
      if (shouldFail) {
        throw new Error("Transient model provider timeout");
      }
      return {
        output: {
          objective: context.goal,
          steps,
          riskAssessment: steps.length > 4 ? "MEDIUM" : "LOW"
        },
        tokens: steps.map((s, i) => ({
          sequence: i,
          text: `step:${s.id}`,
          confidence,
          emittedAt: new Date(0).toISOString()
        })),
        uncertainty: {
          overall: 1 - confidence,
          variance: 0.02,
          lowConfidenceTokens: 0,
          selfReport: 1 - confidence
        },
        nextPhase: "EXECUTE",
        reason: "plan-ready"
      };
    }
  };
}

describe("PlannerEnsemble Consensus System", () => {
  it("validates deterministic consensus with identical inputs", async () => {
    const steps = [
      { id: "retrieve-context", description: "Gather memories relevant to task" },
      { id: "tool-call", description: "Invoke primary tool if enabled" },
      { id: "synthesize", description: "Compose model response" }
    ];

    const p0 = createMockPlanner(steps, 0.8);
    const p1 = createMockPlanner(steps, 0.8);
    const p2 = createMockPlanner(steps, 0.8);

    const ensemble = new PlannerEnsemble([p0, p1, p2]);
    const ctx = createMockContext("stable-seed");

    const res1 = await ensemble.invoke(ctx);
    const res2 = await ensemble.invoke(ctx);

    // Verify determinism
    expect(res1.output.__ensemble).toBeDefined();
    const ens1 = res1.output.__ensemble as any;
    const ens2 = res2.output.__ensemble as any;

    expect(ens1.plannerAgreement).toBe(100);
    expect(ens1.consensusConfidence).toBe(0.88); // 0.8 * 1.10 = 0.88 (strong agreement boost)
    expect(ens1.unstable).toBe(false);
    expect(ens1.arbitrationOutcome).toBeUndefined();

    // Structural similarity check
    expect(JSON.stringify(ens1.divergenceMap)).toBe(JSON.stringify(ens2.divergenceMap));
    expect(ens1.visualDiff).toBe(ens2.visualDiff);
  });

  it("handles Strong Agreement and applies a confidence boost", async () => {
    const steps = [
      { id: "retrieve-context", description: "Gather memories" },
      { id: "tool-call", description: "Invoke tool" },
      { id: "synthesize", description: "Compose response" }
    ];

    // Perfect alignment
    const p0 = createMockPlanner(steps, 0.75);
    const p1 = createMockPlanner(steps, 0.75);
    const p2 = createMockPlanner(steps, 0.75);

    const ensemble = new PlannerEnsemble([p0, p1, p2]);
    const ctx = createMockContext();

    const res = await ensemble.invoke(ctx);
    const ensembleMeta = res.output.__ensemble as any;

    expect(ensembleMeta.plannerAgreement).toBe(100);
    expect(ensembleMeta.consensusConfidence).toBe(0.83); // 0.75 * 1.10 = 0.825 rounded to 0.83
    expect(res.uncertainty.overall).toBeCloseTo(0.17, 2); // 1.0 - 0.83 = 0.17
    expect(ensembleMeta.unstable).toBe(false);
  });

  it("handles Partial Divergence by invoking Critic Arbitration", async () => {
    // Planner 0 has a complete logic layout
    const steps0 = [
      { id: "retrieve-context", description: "Gather memories relevant to task" },
      { id: "tool-call", description: "Invoke primary tool if enabled" },
      { id: "verify", description: "Verifier gate" },
      { id: "synthesize", description: "Compose model response" }
    ];

    // Planner 1 misses context retrieval
    const steps1 = [
      { id: "tool-call", description: "Invoke primary tool if enabled" },
      { id: "synthesize", description: "Compose model response" }
    ];

    // Planner 2 has extra steps
    const steps2 = [
      { id: "retrieve-context", description: "Gather memories relevant to task" },
      { id: "tool-call", description: "Invoke primary tool if enabled" },
      { id: "synthesize", description: "Compose model response" }
    ];

    const p0 = createMockPlanner(steps0, 0.80);
    const p1 = createMockPlanner(steps1, 0.70);
    const p2 = createMockPlanner(steps2, 0.75);

    const ensemble = new PlannerEnsemble([p0, p1, p2]);
    const ctx = createMockContext();

    const res = await ensemble.invoke(ctx);
    const ensembleMeta = res.output.__ensemble as any;

    // Check if Critic Arbitration was triggered and recorded
    expect(ensembleMeta.plannerAgreement).toBeGreaterThanOrEqual(50);
    expect(ensembleMeta.plannerAgreement).toBeLessThan(85);
    expect(ensembleMeta.arbitrationOutcome).toBeDefined();

    const arb = ensembleMeta.arbitrationOutcome;
    expect(arb.invoked).toBe(true);
    // Planner 0 should win as it has the full structured layout (retrieve-context AND verify)
    expect(arb.winningPlannerIndex).toBe(0);
    expect(arb.criticRating).toBeGreaterThanOrEqual(0.70);
    expect(arb.reason).toContain("Critic selected Plan 0");

    // The output steps must match the winning plan's steps (Planner 0)
    const finalSteps = res.output.steps as any[];
    expect(finalSteps.length).toBe(4);
    expect(finalSteps[0].id).toBe("retrieve-context");
    expect(finalSteps[2].id).toBe("verify");
  });

  it("handles Massive Divergence by marking execution unstable and triggering recursive decomposition", async () => {
    // 3 completely divergent plan structures
    const steps0 = [
      { id: "retrieve-context", description: "Gather context" }
    ];
    const steps1 = [
      { id: "tool-call", description: "Execute tools" },
      { id: "verify", description: "Verification gate" }
    ];
    const steps2 = [
      { id: "synthesize", description: "Write solution" },
      { id: "critique", description: "Self critique" },
      { id: "memory-commit", description: "Save to memory" }
    ];

    const p0 = createMockPlanner(steps0, 0.80);
    const p1 = createMockPlanner(steps1, 0.80);
    const p2 = createMockPlanner(steps2, 0.80);

    const ensemble = new PlannerEnsemble([p0, p1, p2]);
    const ctx = createMockContext("divergent-seed", "Complex multi-step database refactoring task");

    const res = await ensemble.invoke(ctx);
    const ensembleMeta = res.output.__ensemble as any;

    expect(ensembleMeta.plannerAgreement).toBeLessThan(50);
    expect(ensembleMeta.unstable).toBe(true);
    expect(ensembleMeta.recursiveDecomposition).toBeDefined();
    expect(ensembleMeta.recursiveDecomposition.triggered).toBe(true);

    // Verify that steps were restructured with recursive sub-goals
    const finalSteps = res.output.steps as any[];
    expect(finalSteps[0].id).toBe("recursive-decompose");
    expect(finalSteps[1].id).toBe("subgoal-1");
    expect(finalSteps[2].id).toBe("subgoal-2");
    expect(finalSteps[3].id).toBe("synthesize");

    // Uncertainty score should be heavily penalized
    expect(res.uncertainty.overall).toBeGreaterThanOrEqual(0.40); // uncertainty goes high
    expect(res.reason).toBe("ensemble-massive-divergence-decomposed");
  });

  it("ensures isolated planner execution to prevent state leakage", async () => {
    const steps = [{ id: "retrieve-context", description: "Clean context" }];

    // Mutator mock planner
    const mutatorPlanner: RoleAgent = {
      role: "PLANNER" as const,
      invoke: async (context: RoleContext): Promise<RoleResult> => {
        // Attempt state leakage by mutating shared carryOver and task objects
        context.task.prompt = "MUTATED PROMPT";
        context.carryOver.leaked = "YES";
        return {
          output: { steps },
          uncertainty: { overall: 0.1, variance: 0, lowConfidenceTokens: 0 },
          nextPhase: "EXECUTE"
        };
      }
    };

    const ensemble = new PlannerEnsemble([mutatorPlanner, mutatorPlanner, mutatorPlanner]);
    const ctx = createMockContext();
    ctx.task.prompt = "ORIGINAL PROMPT";
    ctx.carryOver.leaked = "NO";

    await ensemble.invoke(ctx);

    // Assert original context is absolutely untouched (prevents state leakage)
    expect(ctx.task.prompt).toBe("ORIGINAL PROMPT");
    expect(ctx.carryOver.leaked).toBe("NO");
  });

  it("handles Degraded Planner Recovery gracefully if one planner fails", async () => {
    const steps = [
      { id: "retrieve-context", description: "Context search" },
      { id: "synthesize", description: "Synthesis" }
    ];

    const healthyPlanner = createMockPlanner(steps, 0.85);
    const brokenPlanner = createMockPlanner([], 0.80, true); // will throw error

    // 2 healthy, 1 broken
    const ensemble = new PlannerEnsemble([healthyPlanner, brokenPlanner, healthyPlanner]);
    const ctx = createMockContext();

    const res = await ensemble.invoke(ctx);
    const ensembleMeta = res.output.__ensemble as any;

    // Consensus should still complete using the 2 healthy planners
    expect(ensembleMeta.plannerAgreement).toBe(100); // 2 identical healthy planners align perfectly
    expect(ensembleMeta.consensusConfidence).toBe(0.94); // 0.85 * 1.10 = 0.935 rounded to 0.94
    expect(res.output.steps).toBeDefined();

    // Disagreement maps and diffs should reflect the degraded state
    expect(ensembleMeta.visualDiff).toContain("Ensemble degraded: 1 planner instance(s) failed during execution.");
  });

  it("validates concurrency safety for concurrent ensemble calls", async () => {
    const steps = [{ id: "retrieve-context", description: "Safety first" }];
    const planner = createMockPlanner(steps, 0.9);
    const ensemble = new PlannerEnsemble([planner, planner, planner]);

    const ctx1 = createMockContext("seed-A");
    const ctx2 = createMockContext("seed-B");

    // Invoke concurrently
    const [res1, res2] = await Promise.all([
      ensemble.invoke(ctx1),
      ensemble.invoke(ctx2)
    ]);

    expect(res1.output.__ensemble).toBeDefined();
    expect(res2.output.__ensemble).toBeDefined();
    // They ran concurrently without cross-talk
    expect(res1.output.objective).toBe("Solve global warming");
  });
});
