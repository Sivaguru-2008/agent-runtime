import type { RoleAgent, RoleContext, RoleResult } from "../roles.js";
import { seededRandom } from "../../../shared/determinism.js";

/**
 * Verifier: structurally validates the executor's output. Emits a pass/fail
 * with a confidence score; on fail, routes back to the Critic for revision.
 */
export class VerifierAgent implements RoleAgent {
  readonly role = "VERIFIER" as const;

  async invoke(context: RoleContext): Promise<RoleResult> {
    const isMultiVerifier =
      context.carryOver.enableMultiVerifier === true ||
      context.history.some((node) => node.confidenceScore !== undefined && node.confidenceScore < 30);

    const executorOutput = context.carryOver.modelOutput as Record<string, unknown> | undefined;

    if (isMultiVerifier) {
      // Run three independent verifier checkers with distinct seeds to build consensus
      const v1Rand = seededRandom(`${context.seed}:verifier:v1`);
      const v2Rand = seededRandom(`${context.seed}:verifier:v2`);
      const v3Rand = seededRandom(`${context.seed}:verifier:v3`);

      const v1Checks = this.runChecks(executorOutput, v1Rand);
      const v2Checks = this.runChecks(executorOutput, v2Rand);
      const v3Checks = this.runChecks(executorOutput, v3Rand);

      const v1Score = v1Checks.length ? v1Checks.filter((c) => c.passed).length / v1Checks.length : 1;
      const v2Score = v2Checks.length ? v2Checks.filter((c) => c.passed).length / v2Checks.length : 1;
      const v3Score = v3Checks.length ? v3Checks.filter((c) => c.passed).length / v3Checks.length : 1;

      const avgScore = (v1Score + v2Score + v3Score) / 3;

      // Stricter consensus: PASS only if average score >= 0.85 and at least 2 verifiers pass
      const v1Passed = v1Score >= 0.75;
      const v2Passed = v2Score >= 0.75;
      const v3Passed = v3Score >= 0.75;
      const passes = [v1Passed, v2Passed, v3Passed].filter(Boolean).length;

      const verdict: "PASS" | "FAIL" = avgScore >= 0.85 && passes >= 2 ? "PASS" : "FAIL";

      const combinedChecks = [
        ...v1Checks.map((c) => ({ ...c, name: `v1:${c.name}` })),
        ...v2Checks.map((c) => ({ ...c, name: `v2:${c.name}` })),
        ...v3Checks.map((c) => ({ ...c, name: `v3:${c.name}` }))
      ];

      return {
        output: {
          verdict,
          score: Number(avgScore.toFixed(2)),
          multiVerifierMode: true,
          verifiersCount: 3,
          verifiersPassedCount: passes,
          verifiers: [
            { id: "verifier-1", score: Number(v1Score.toFixed(2)), passed: v1Passed, checks: v1Checks },
            { id: "verifier-2", score: Number(v2Score.toFixed(2)), passed: v2Passed, checks: v2Checks },
            { id: "verifier-3", score: Number(v3Score.toFixed(2)), passed: v3Passed, checks: v3Checks }
          ],
          checks: combinedChecks
        },
        uncertainty: {
          overall: Number((1 - avgScore).toFixed(2)),
          variance: Number(
            (((v1Score - avgScore) ** 2 + (v2Score - avgScore) ** 2 + (v3Score - avgScore) ** 2) / 3).toFixed(4)
          ),
          lowConfidenceTokens: 0,
          selfReport: 1 - avgScore
        },
        nextPhase: verdict === "PASS" ? "CRITIQUE" : "EXECUTE",
        nextRole: verdict === "PASS" ? "CRITIC" : "EXECUTOR",
        reason: verdict === "PASS" ? "multi-verifier-pass" : "multi-verifier-consensus-rejected"
      };
    } else {
      // Normal single verifier mode
      const rand = seededRandom(`${context.seed}:verifier`);
      const checks = this.runChecks(executorOutput, rand);
      const passed = checks.filter((c) => c.passed).length;
      const score = checks.length ? passed / checks.length : 1;
      const verdict: "PASS" | "FAIL" = score >= 0.75 ? "PASS" : "FAIL";

      return {
        output: { verdict, checks, score: Number(score.toFixed(2)), multiVerifierMode: false },
        uncertainty: {
          overall: Number((1 - score).toFixed(2)),
          variance: 0.01,
          lowConfidenceTokens: 0,
          selfReport: 1 - score
        },
        nextPhase: verdict === "PASS" ? "CRITIQUE" : "EXECUTE",
        nextRole: verdict === "PASS" ? "CRITIC" : "EXECUTOR",
        reason: verdict === "PASS" ? "verifier-pass" : "verifier-rejected"
      };
    }
  }

  private runChecks(output: Record<string, unknown> | undefined, rand: () => number) {
    const checks: Array<{ name: string; passed: boolean; note?: string }> = [];
    checks.push({
      name: "shape:object",
      passed: Boolean(output && typeof output === "object"),
      note: "Executor must produce a structured object"
    });
    checks.push({
      name: "non-empty",
      passed: Boolean(output && Object.keys(output).length > 0)
    });
    checks.push({
      name: "no-error-field",
      passed: !output || !("error" in (output as Record<string, unknown>))
    });
    checks.push({
      name: "stochastic-quality-probe",
      passed: rand() > 0.1
    });
    return checks;
  }
}
