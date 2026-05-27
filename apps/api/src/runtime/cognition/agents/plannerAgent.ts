import type { RoleAgent, RoleContext, RoleResult } from "../roles.js";
import { seededRandom } from "../../../shared/determinism.js";

/**
 * Planner: decomposes the goal + task into an ordered plan of executor steps.
 * Deterministic: same seed + same task → same plan.
 */
export class PlannerAgent implements RoleAgent {
  readonly role = "PLANNER" as const;

  async invoke(context: RoleContext): Promise<RoleResult> {
    const rand = seededRandom(`${context.seed}:planner:${context.task ? JSON.stringify(context.task) : ""}`);
    const goal = context.goal || String(context.task.goal ?? "Unspecified goal");
    const steps = this.deriveSteps(goal, context.task, rand);
    const confidence = 0.7 + rand() * 0.25;

    return {
      output: {
        objective: goal,
        steps,
        riskAssessment: steps.length > 4 ? "MEDIUM" : "LOW",
        memoryNeeded: context.memories.length > 0
      },
      tokens: steps.map((step, i) => ({
        sequence: i,
        text: `step:${step.id}`,
        confidence,
        emittedAt: new Date(0).toISOString()
      })),
      uncertainty: {
        overall: 1 - confidence,
        variance: 0.02,
        lowConfidenceTokens: 0,
        selfReport: confidence
      },
      memoryInfluence: context.memories.slice(0, 3).map((m, i) => ({
        memoryId: m.id,
        weight: Number((0.5 - i * 0.12).toFixed(2)),
        reason: i === 0 ? "primary plan anchor" : "supporting context"
      })),
      nextPhase: "EXECUTE",
      reason: "plan-ready"
    };
  }

  private deriveSteps(goal: string, task: Record<string, unknown>, rand: () => number) {
    const base = [
      { id: "retrieve-context", description: "Gather memories relevant to task" },
      { id: "tool-call", description: "Invoke primary tool if enabled" },
      { id: "synthesize", description: "Compose model response" }
    ];
    if (goal.toLowerCase().includes("verify") || task.requiresVerification) {
      base.push({ id: "verify", description: "Run verifier on intermediate output" });
    }
    if (rand() > 0.6) base.push({ id: "critique", description: "Critic review" });
    return base;
  }
}
