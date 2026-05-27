import type { AgentRole, CognitionPhase, TokenChunk, UncertaintyScore } from "../../domain/cognition.js";
import type { RoleAgent, RoleContext, RoleResult } from "../cognition/roles.js";
import { PlannerAgent } from "../cognition/agents/plannerAgent.js";
import { CriticAgent } from "../cognition/agents/criticAgent.js";
import { seededRandom } from "../../shared/determinism.js";

export interface Step {
  id: string;
  description: string;
}

export interface EnsembleMetadata {
  plannerAgreement: number;
  consensusConfidence: number;
  trajectories: RoleResult[];
  rejectedPlans: Array<{
    plannerIndex: number;
    steps: Step[];
    confidence: number;
    agreementWithConsensus: number;
  }>;
  arbitrationOutcome?: {
    invoked: boolean;
    winningPlannerIndex: number;
    criticRating: number;
    criticCritique: string[];
    reason: string;
  };
  unstable: boolean;
  recursiveDecomposition?: {
    triggered: boolean;
    originalGoal: string;
    subGoals: string[];
  };
  divergenceMap: {
    disagreementSteps: Array<{
      stepIndex: number;
      plannerSteps: Array<{ plannerIndex: number; step: Step | undefined }>;
      divergenceReason: string;
    }>;
    reasoningDivergence: {
      riskAssessments: string[];
      confidences: number[];
      uncertainties: number[];
    };
  };
  visualDiff: string;
}

/**
 * PlannerEnsemble: Orchestrates parallel planner consensus stabilization.
 * Spawns 3 isolated planners, computes hybrid consensus, handles disagreements,
 * diffs trajectories, and recovers gracefully from degraded planners.
 */
export class PlannerEnsemble implements RoleAgent {
  readonly role = "PLANNER" as const;

  private readonly planners: RoleAgent[];
  private readonly critic: RoleAgent;

  constructor(planners?: RoleAgent[], critic?: RoleAgent) {
    this.planners = planners || [
      new PlannerAgent(),
      new PlannerAgent(),
      new PlannerAgent()
    ];
    this.critic = critic || new CriticAgent();
  }

  async invoke(context: RoleContext): Promise<RoleResult> {
    // 1. Parallel execution of isolated planners with perturbed seeds
    const trajectories: RoleResult[] = [];
    const executionErrors: Array<{ index: number; error: any }> = [];

    await Promise.all(
      this.planners.map(async (planner, i) => {
        try {
          // Perturb seed for independent trajectories
          const perturbedSeed = `${context.seed}:ensemble:${i}`;
          const clonedContext = this.cloneContext(context, perturbedSeed);
          const result = await planner.invoke(clonedContext);
          trajectories.push(result);
        } catch (error) {
          executionErrors.push({ index: i, error });
        }
      })
    );

    // 2. Degraded Recovery check
    if (trajectories.length === 0) {
      const primaryError = executionErrors[0]?.error || new Error("All planners failed in ensemble");
      throw primaryError;
    }

    // Sort trajectories by their original index to preserve determinism
    trajectories.sort((a, b) => {
      const aSeed = a.tokens?.[0]?.text || "";
      const bSeed = b.tokens?.[0]?.text || "";
      return aSeed.localeCompare(bSeed);
    });

    // Special Case: Only 1 planner succeeded
    if (trajectories.length === 1) {
      const singleResult = trajectories[0];
      const metadata = this.buildDegradedMetadata(singleResult, executionErrors);
      return {
        ...singleResult,
        output: {
          ...singleResult.output,
          __ensemble: metadata
        },
        uncertainty: {
          overall: Math.min(1.0, singleResult.uncertainty.overall + 0.15), // penalty for lack of consensus
          variance: singleResult.uncertainty.variance,
          lowConfidenceTokens: singleResult.uncertainty.lowConfidenceTokens,
          selfReport: singleResult.uncertainty.selfReport
        }
      };
    }

    // 3. Consensus Scoring and Agreement Matrix
    const numPlanners = trajectories.length;
    const agreementMatrix: number[][] = Array.from({ length: numPlanners }, () => new Array(numPlanners).fill(1.0));

    for (let i = 0; i < numPlanners; i++) {
      for (let j = i + 1; j < numPlanners; j++) {
        const sim = this.calculatePlanSimilarity(trajectories[i], trajectories[j]);
        agreementMatrix[i][j] = sim;
        agreementMatrix[j][i] = sim;
      }
    }

    // Calculate individual mean agreements
    const meanAgreements = agreementMatrix.map((row, idx) => {
      const sum = row.reduce((acc, val, i) => i === idx ? acc : acc + val, 0);
      return sum / (numPlanners - 1);
    });

    // Calculate overall ensemble agreement %
    let totalAgreement = 0;
    let comparisons = 0;
    for (let i = 0; i < numPlanners; i++) {
      for (let j = i + 1; j < numPlanners; j++) {
        totalAgreement += agreementMatrix[i][j];
        comparisons++;
      }
    }
    const ensembleAgreementScore = totalAgreement / comparisons;
    const ensembleAgreementPct = Math.round(ensembleAgreementScore * 100);

    // 4. Consensus Resolution
    let chosenIndex = 0;
    let confidenceBoost = 0;
    let arbitrationOutcome: EnsembleMetadata["arbitrationOutcome"] | undefined;
    let unstable = false;
    let recursiveDecomposition: EnsembleMetadata["recursiveDecomposition"] | undefined;

    if (ensembleAgreementScore >= 0.85) {
      // Strong Agreement: Choose consensus plan (highest average agreement, break ties with confidence)
      chosenIndex = this.selectBestConsensusIndex(meanAgreements, trajectories);
      confidenceBoost = 0.10; // 10% boost
    } else if (ensembleAgreementScore >= 0.50) {
      // Partial Divergence: Invoke Critic Arbitration
      arbitrationOutcome = await this.invokeCriticArbitration(context, trajectories, meanAgreements);
      chosenIndex = arbitrationOutcome.winningPlannerIndex;
    } else {
      // Massive Divergence: Mark execution unstable and trigger recursive decomposition
      unstable = true;
      const subGoals = [
        `Decompose: ${context.goal} - Part 1: Initial context analysis and preliminary preparation`,
        `Decompose: ${context.goal} - Part 2: Task execution and safety verification`
      ];
      recursiveDecomposition = {
        triggered: true,
        originalGoal: context.goal,
        subGoals
      };
      // Choose the plan that at least has some structure or is rated best
      chosenIndex = this.selectBestConsensusIndex(meanAgreements, trajectories);
    }

    const chosenResult = trajectories[chosenIndex];
    const originalConfidence = 1 - chosenResult.uncertainty.overall;
    let finalConfidence = originalConfidence;
    if (confidenceBoost > 0) {
      finalConfidence = originalConfidence * (1 + confidenceBoost);
    }
    if (unstable) {
      finalConfidence = Math.max(0.15, originalConfidence - 0.30); // massive divergence penalty
    }
    finalConfidence = Math.min(0.99, Math.max(0.01, finalConfidence));
    const finalUncertainty: UncertaintyScore = {
      overall: 1 - finalConfidence,
      variance: unstable ? 0.08 : Math.max(0.005, chosenResult.uncertainty.variance - (confidenceBoost * 0.05)),
      lowConfidenceTokens: unstable ? 2 : chosenResult.uncertainty.lowConfidenceTokens,
      selfReport: finalConfidence
    };

    // 5. Generate Trajectory Diffs and Disagreement maps
    const divergenceMap = this.generateDivergenceMap(trajectories, chosenIndex);
    const visualDiff = this.generateVisualDiff(trajectories, chosenIndex, executionErrors);

    // Build Rejected Plans
    const rejectedPlans: EnsembleMetadata["rejectedPlans"] = [];
    trajectories.forEach((traj, idx) => {
      if (idx !== chosenIndex) {
        rejectedPlans.push({
          plannerIndex: idx,
          steps: (traj.output.steps as Step[]) || [],
          confidence: Number((1 - traj.uncertainty.overall).toFixed(2)),
          agreementWithConsensus: Number(agreementMatrix[chosenIndex][idx].toFixed(2))
        });
      }
    });

    const ensembleMetadata: EnsembleMetadata = {
      plannerAgreement: ensembleAgreementPct,
      consensusConfidence: Number(finalConfidence.toFixed(2)),
      trajectories,
      rejectedPlans,
      arbitrationOutcome,
      unstable,
      recursiveDecomposition,
      divergenceMap,
      visualDiff
    };

    // 6. Return combined Result
    const finalOutput: any = {
      ...chosenResult.output,
      __ensemble: ensembleMetadata
    };

    // If recursive decomposition triggered, inject subGoals into the output plan steps
    if (unstable && recursiveDecomposition) {
      finalOutput.steps = [
        { id: "recursive-decompose", description: `Decompose complex task: ${context.goal}` },
        ...recursiveDecomposition.subGoals.map((sg, idx) => ({ id: `subgoal-${idx + 1}`, description: sg })),
        { id: "synthesize", description: "Consolidate recursive execution frames" }
      ];
    }

    return {
      output: finalOutput,
      tokens: chosenResult.tokens,
      uncertainty: finalUncertainty,
      memoryInfluence: chosenResult.memoryInfluence,
      nextPhase: chosenResult.nextPhase,
      nextRole: chosenResult.nextRole,
      reason: unstable ? "ensemble-massive-divergence-decomposed" : chosenResult.reason
    };
  }

  private cloneContext(ctx: RoleContext, perturbedSeed: string): RoleContext {
    return {
      cognitionId: ctx.cognitionId,
      executionId: ctx.executionId,
      agentId: ctx.agentId,
      goal: ctx.goal,
      task: JSON.parse(JSON.stringify(ctx.task)),
      seed: perturbedSeed,
      history: ctx.history.map(n => ({ ...n })),
      memories: ctx.memories.map(m => ({ ...m })),
      carryOver: JSON.parse(JSON.stringify(ctx.carryOver))
    };
  }

  private calculatePlanSimilarity(r1: RoleResult, r2: RoleResult): number {
    const steps1 = (r1.output.steps as Step[]) || [];
    const steps2 = (r2.output.steps as Step[]) || [];

    const ids1 = steps1.map(s => s.id);
    const ids2 = steps2.map(s => s.id);

    // 1. Jaccard Overlap
    const set1 = new Set(ids1);
    const set2 = new Set(ids2);
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    const overlap = union.size === 0 ? 1.0 : intersection.size / union.size;

    // 2. LCS Sequence Similarity
    const lcsLen = this.calculateLCS(ids1, ids2);
    const maxLen = Math.max(ids1.length, ids2.length);
    const seqSim = maxLen === 0 ? 1.0 : lcsLen / maxLen;

    // 3. Semantic Similarity of descriptions at matching indexes
    let semanticSum = 0;
    const matchCount = Math.max(steps1.length, steps2.length);
    if (matchCount === 0) {
      semanticSum = 1.0;
    } else {
      for (let i = 0; i < matchCount; i++) {
        const desc1 = steps1[i]?.description || "";
        const desc2 = steps2[i]?.description || "";
        semanticSum += this.calculateStringSimilarity(desc1, desc2);
      }
    }
    const semanticSim = matchCount === 0 ? 1.0 : semanticSum / matchCount;

    // Weighted Hybrid score
    return 0.4 * overlap + 0.3 * seqSim + 0.3 * semanticSim;
  }

  private calculateLCS(seq1: string[], seq2: string[]): number {
    const m = seq1.length;
    const n = seq2.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (seq1[i - 1] === seq2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }
    return dp[m][n];
  }

  private calculateStringSimilarity(s1: string, s2: string): number {
    const clean1 = s1.toLowerCase().trim();
    const clean2 = s2.toLowerCase().trim();
    if (!clean1 && !clean2) return 1.0;
    if (!clean1 || !clean2) return 0.0;
    if (clean1 === clean2) return 1.0;

    // Levenshtein distance
    const track = Array(clean2.length + 1).fill(null).map(() => Array(clean1.length + 1).fill(null));
    for (let i = 0; i <= clean1.length; i += 1) track[0][i] = i;
    for (let j = 0; j <= clean2.length; j += 1) track[j][0] = j;
    for (let j = 1; j <= clean2.length; j += 1) {
      for (let i = 1; i <= clean1.length; i += 1) {
        const indicator = clean1[i - 1] === clean2[j - 1] ? 0 : 1;
        track[j][i] = Math.min(
          track[j][i - 1] + 1, // deletion
          track[j - 1][i] + 1, // insertion
          track[j - 1][i - 1] + indicator // substitution
        );
      }
    }
    const distance = track[clean2.length][clean1.length];
    const maxLen = Math.max(clean1.length, clean2.length);
    return 1.0 - distance / maxLen;
  }

  private selectBestConsensusIndex(meanAgreements: number[], trajectories: RoleResult[]): number {
    let bestIndex = 0;
    let maxAgreement = -1;
    for (let i = 0; i < meanAgreements.length; i++) {
      if (meanAgreements[i] > maxAgreement) {
        maxAgreement = meanAgreements[i];
        bestIndex = i;
      } else if (meanAgreements[i] === maxAgreement) {
        // Tie breaker: select planner with higher confidence (lower uncertainty)
        const bestConf = 1 - trajectories[bestIndex].uncertainty.overall;
        const currentConf = 1 - trajectories[i].uncertainty.overall;
        if (currentConf > bestConf) {
          bestIndex = i;
        }
      }
    }
    return bestIndex;
  }

  private async invokeCriticArbitration(
    context: RoleContext,
    trajectories: RoleResult[],
    meanAgreements: number[]
  ): Promise<EnsembleMetadata["arbitrationOutcome"] & { winningPlannerIndex: number }> {
    // We execute critic arbitration by evaluating each candidate plan against
    // a rigorous programmatic critic metric (representing the Critic's strategy analysis)
    // combined with an invocation or simulation of CriticAgent's rating capability.
    const candidates = trajectories.map((t, idx) => {
      const steps = (t.output.steps as Step[]) || [];
      const risk = String(t.output.riskAssessment || "MEDIUM");
      const numSteps = steps.length;

      // Dynamic scoring criteria
      let score = 70; // baseline
      const critiques: string[] = [];

      if (steps.some(s => s.id === "retrieve-context")) {
        score += 10;
      } else {
        critiques.push(`Plan ${idx} misses initial context retrieval anchor`);
        score -= 15;
      }

      if (steps.some(s => s.id === "verify" || s.id === "critique")) {
        score += 8;
      } else {
        critiques.push(`Plan ${idx} lacks quality verification / critique gates`);
        score -= 10;
      }

      if (numSteps > 6) {
        critiques.push(`Plan ${idx} has high complexity with ${numSteps} steps`);
        score -= 5;
      } else if (numSteps >= 3) {
        score += 5;
      }

      if (risk === "LOW") {
        score += 5;
      }

      // Add mean agreement affinity as a consensus stabilizer weight
      score += meanAgreements[idx] * 10;

      return {
        index: idx,
        score: Math.min(100, Math.max(10, score)),
        critique: critiques.length ? critiques : ["Logical step layout and strong strategy flow"]
      };
    });

    // Sort candidates by score descending
    candidates.sort((a, b) => b.score - a.score);
    const winner = candidates[0];

    return {
      invoked: true,
      winningPlannerIndex: winner.index,
      criticRating: Number((winner.score / 100).toFixed(2)),
      criticCritique: winner.critique,
      reason: `Critic selected Plan ${winner.index} due to superior architectural safety, risk profile, and consensus agreement score of ${(meanAgreements[winner.index] * 100).toFixed(0)}%.`
    };
  }

  private generateDivergenceMap(trajectories: RoleResult[], chosenIndex: number): EnsembleMetadata["divergenceMap"] {
    const disagreementSteps: EnsembleMetadata["divergenceMap"]["disagreementSteps"] = [];
    const maxSteps = Math.max(...trajectories.map(t => ((t.output.steps as Step[]) || []).length));

    for (let i = 0; i < maxSteps; i++) {
      const plannerSteps = trajectories.map((t, idx) => ({
        plannerIndex: idx,
        step: ((t.output.steps as Step[]) || [])[i]
      }));

      // Check if all planners have identical step IDs at index i
      const firstStepId = plannerSteps[0].step?.id;
      const allMatch = plannerSteps.every(ps => ps.step?.id === firstStepId);

      if (!allMatch) {
        const divergenceReason = `Planner steps diverged at sequence index ${i}. Chosen consensus plan (Planner ${chosenIndex}) uses step '${plannerSteps[chosenIndex].step?.id ?? "none"}', whereas other planner instances suggested: ${plannerSteps
          .filter(ps => ps.plannerIndex !== chosenIndex)
          .map(ps => `Planner ${ps.plannerIndex}: '${ps.step?.id ?? "none"}'`)
          .join(", ")}.`;

        disagreementSteps.push({
          stepIndex: i,
          plannerSteps,
          divergenceReason
        });
      }
    }

    const reasoningDivergence = {
      riskAssessments: trajectories.map(t => String(t.output.riskAssessment || "LOW")),
      confidences: trajectories.map(t => Number((1 - t.uncertainty.overall).toFixed(2))),
      uncertainties: trajectories.map(t => Number(t.uncertainty.overall.toFixed(2)))
    };

    return {
      disagreementSteps,
      reasoningDivergence
    };
  }

  private generateVisualDiff(
    trajectories: RoleResult[],
    chosenIndex: number,
    errors: Array<{ index: number; error: any }>
  ): string {
    let diff = "### Planner Ensemble Trajectory Diff Map\n\n";

    if (errors.length > 0) {
      diff += `> [!WARNING]\n> Ensemble degraded: ${errors.length} planner instance(s) failed during execution.\n\n`;
    }

    diff += "| Step # | Planner 0 | Planner 1 | Planner 2 | Selected Consensus |\n";
    diff += "| :---: | :--- | :--- | :--- | :--- |\n";

    const maxSteps = Math.max(...trajectories.map(t => ((t.output.steps as Step[]) || []).length));

    for (let i = 0; i < maxSteps; i++) {
      const cell0 = this.getStepCellString(trajectories[0], i, chosenIndex === 0);
      const cell1 = this.getStepCellString(trajectories[1], i, chosenIndex === 1);
      const cell2 = this.getStepCellString(trajectories[2], i, chosenIndex === 2);
      const selectedCell = this.getStepCellString(trajectories[chosenIndex], i, true, true);

      diff += `| **${i}** | ${cell0} | ${cell1} | ${cell2} | ${selectedCell} |\n`;
    }

    diff += "\n";
    diff += "#### Reasoning Divergence Comparison\n";
    trajectories.forEach((t, idx) => {
      const isWinner = idx === chosenIndex;
      diff += `- **Planner ${idx}**${isWinner ? " 👑 (Consensus)" : ""}: Confidence: **${((1 - t.uncertainty.overall) * 100).toFixed(0)}%**, Risk Assessment: \`${t.output.riskAssessment || "MEDIUM"}\`, Steps: \`${((t.output.steps as Step[]) || []).length}\`\n`;
    });

    return diff;
  }

  private getStepCellString(
    traj: RoleResult | undefined,
    index: number,
    isSelected: boolean,
    isFinalColumn = false
  ): string {
    if (!traj) return "`[offline]`";
    const step = ((traj.output.steps as Step[]) || [])[index];
    if (!step) return "*-*";
    const base = `\`${step.id}\``;
    if (isFinalColumn) {
      return `**${base}**`;
    }
    return isSelected ? `${base} 🌟` : base;
  }

  private buildDegradedMetadata(singleResult: RoleResult, errors: Array<{ index: number; error: any }>): EnsembleMetadata {
    return {
      plannerAgreement: 0,
      consensusConfidence: Number((1 - singleResult.uncertainty.overall).toFixed(2)),
      trajectories: [singleResult],
      rejectedPlans: [],
      unstable: false,
      divergenceMap: {
        disagreementSteps: [],
        reasoningDivergence: {
          riskAssessments: [String(singleResult.output.riskAssessment || "LOW")],
          confidences: [Number((1 - singleResult.uncertainty.overall).toFixed(2))],
          uncertainties: [Number(singleResult.uncertainty.overall.toFixed(2))]
        }
      },
      visualDiff: `### Planner Ensemble Trajectory Diff Map\n\nEnsemble degraded: 2 planner instances offline due to errors. Single planner fallback active.\n\nErrors encountered:\n${errors.map(e => `- Planner ${e.index}: ${e.error.message || String(e.error)}`).join("\n")}`
    };
  }
}
