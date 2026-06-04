import type { RoleAgent, RoleContext, RoleResult } from "../roles.js";
import type { ModelProvider } from "../../../domain/ports.js";
import type { Agent, Execution } from "../../../domain/model.js";
import { seededRandom } from "../../../shared/determinism.js";

/**
 * Verifier: structurally validates the executor's output. Emits a pass/fail
 * with a confidence score; on fail, routes back to the Critic for revision.
 *
 * Heuristic mode (default, no ModelProvider) is unchanged and deterministic.
 * Model-backed mode (provider wired) asks the model to adjudicate the executor
 * output, falling back to the heuristic checks on any failure.
 */
export class VerifierAgent implements RoleAgent {
  readonly role = "VERIFIER" as const;

  constructor(private readonly modelProvider?: ModelProvider) {}

  async invoke(context: RoleContext): Promise<RoleResult> {
    if (this.modelProvider) {
      try {
        return await this.modelBackedVerify(context);
      } catch {
        // Never let a model failure block verification — fall back to heuristic.
      }
    }
    return this.heuristicVerify(context);
  }

  private async heuristicVerify(context: RoleContext): Promise<RoleResult> {
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
          // selfReport is the verifier's CONFIDENCE (0..1, higher = more
          // confident), consumed by calculateConfidenceScore as the node score.
          // It must equal the consensus score, NOT its inverse: a passing
          // verification (avgScore≈1) previously reported selfReport≈0, which
          // calculateConfidenceScore read as a 0/100 confidence and the
          // orchestrator halted (<15) → every successful run was force-FAILED.
          selfReport: avgScore
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
          // selfReport = the verifier's confidence (= score), NOT its inverse.
          // See the multi-verifier branch above: an inverted value made every
          // passing run halt at the VERIFY node and surface as FAILED.
          selfReport: score
        },
        nextPhase: verdict === "PASS" ? "CRITIQUE" : "EXECUTE",
        nextRole: verdict === "PASS" ? "CRITIC" : "EXECUTOR",
        reason: verdict === "PASS" ? "verifier-pass" : "verifier-rejected"
      };
    }
  }

  private async modelBackedVerify(context: RoleContext): Promise<RoleResult> {
    const executorOutput = context.carryOver.modelOutput as Record<string, unknown> | undefined;
    const { agent, execution } = roleStubs(context);

    const streamed: number[] = [];
    const result = await this.modelProvider!.complete({
      agent,
      execution,
      prompt: buildVerifyPrompt(context.goal, executorOutput),
      context: context.memories,
      onToken: (_text, confidence) => streamed.push(confidence)
    });

    const adjudication = coerceVerdict(result.output);
    if (!adjudication) {
      // Model gave nothing parseable — defer to the deterministic checks.
      return this.heuristicVerify(context);
    }

    const { verdict, score } = adjudication;
    const lowConfidenceTokens = streamed.filter((c) => c < 0.55).length;

    return {
      output: {
        verdict,
        score: Number(score.toFixed(2)),
        multiVerifierMode: false,
        modelBacked: true,
        modelOutput: result.output
      },
      uncertainty: {
        overall: Number((1 - score).toFixed(2)),
        variance: 0.01,
        lowConfidenceTokens,
        // Confidence, not its inverse (see heuristic notes above).
        selfReport: score
      },
      nextPhase: verdict === "PASS" ? "CRITIQUE" : "EXECUTE",
      nextRole: verdict === "PASS" ? "CRITIC" : "EXECUTOR",
      reason: verdict === "PASS" ? "model-verifier-pass" : "model-verifier-rejected"
    };
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

// ─── helpers ──────────────────────────────────────────────────────────────────

function buildVerifyPrompt(goal: string, executorOutput: Record<string, unknown> | undefined): string {
  return JSON.stringify({
    role: "verifier",
    instruction:
      "Judge whether the executor output satisfies the goal. Respond as JSON: " +
      "{ \"verdict\": \"PASS\" | \"FAIL\", \"score\": number between 0 and 1 }.",
    goal,
    executorOutput: executorOutput ?? null
  });
}

/** Pull a {verdict, score} adjudication from arbitrary model output. */
function coerceVerdict(
  output: Record<string, unknown>
): { verdict: "PASS" | "FAIL"; score: number } | undefined {
  if (!output || typeof output !== "object") return undefined;
  const rawVerdict = output.verdict ?? output.result ?? output.status;
  const rawScore = output.score ?? output.confidence;

  let score: number | undefined;
  if (typeof rawScore === "number" && Number.isFinite(rawScore)) {
    score = rawScore > 1 ? rawScore / 100 : rawScore;
  }

  let verdict: "PASS" | "FAIL" | undefined;
  if (typeof rawVerdict === "string") {
    const v = rawVerdict.toUpperCase();
    if (v.includes("PASS") || v.includes("TRUE") || v.includes("OK")) verdict = "PASS";
    else if (v.includes("FAIL") || v.includes("REJECT") || v.includes("FALSE")) verdict = "FAIL";
  } else if (typeof output.passed === "boolean") {
    verdict = output.passed ? "PASS" : "FAIL";
  }

  if (verdict === undefined && score === undefined) return undefined;
  if (score === undefined) score = verdict === "PASS" ? 0.9 : 0.4;
  if (verdict === undefined) verdict = score >= 0.75 ? "PASS" : "FAIL";

  return { verdict, score: Math.max(0, Math.min(1, score)) };
}

function roleStubs(context: RoleContext): { agent: Agent; execution: Execution } {
  const agent: Agent = {
    id: context.agentId,
    name: "verifier",
    goal: context.goal,
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "runtime", model: "verifier-v1" },
    tools: [],
    memoryPolicy: { episodicEnabled: true, semanticEnabled: true, maxRetrievedItems: 8 },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const execution: Execution = {
    id: context.executionId,
    agentId: context.agentId,
    status: "RUNNING",
    input: context.task,
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  return { agent, execution };
}
