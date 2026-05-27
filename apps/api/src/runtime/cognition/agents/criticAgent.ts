import type { RoleAgent, RoleContext, RoleResult } from "../roles.js";
import { seededRandom } from "../../../shared/determinism.js";

/**
 * Critic: stylistic/strategic review. Looks for plan-drift, missed memories,
 * and weak phrasing. Always advances; never blocks.
 */
export class CriticAgent implements RoleAgent {
  readonly role = "CRITIC" as const;

  async invoke(context: RoleContext): Promise<RoleResult> {
    const rand = seededRandom(`${context.seed}:critic`);
    const verifierVerdict = (context.carryOver.verdict ?? "PASS") as "PASS" | "FAIL";
    const notes: string[] = [];
    if (verifierVerdict !== "PASS") notes.push("Verifier flagged issues — recommend retry budget");
    if (context.memories.length === 0) notes.push("No memory consulted — risk of context loss");
    if (context.history.length > 12) notes.push("Long cognition graph — consider summarization");
    if (rand() > 0.7) notes.push("Consider alternative phrasing for clarity");

    return {
      output: { critique: notes, rating: Number((0.7 + rand() * 0.3).toFixed(2)) },
      uncertainty: { overall: 0.15, variance: 0.005, lowConfidenceTokens: 0 },
      nextPhase: "MEMORY_COMMIT",
      nextRole: "MEMORY_MANAGER",
      reason: "critique-complete"
    };
  }
}
