import type { RoleAgent, RoleContext, RoleResult } from "../roles.js";
import type { ModelProvider } from "../../../domain/ports.js";
import type { Agent, Execution } from "../../../domain/model.js";
import { seededRandom } from "../../../shared/determinism.js";

/**
 * Planner: decomposes the goal + task into an ordered plan of executor steps.
 *
 * Two modes:
 *   • Heuristic (default) — deterministic: same seed + same task → same plan.
 *     Used whenever no ModelProvider is wired (all unit fixtures, and the
 *     `MODEL_PROVIDER=deterministic` runtime path), so existing behaviour and
 *     deterministic replay are byte-for-byte preserved.
 *   • Model-backed — when a ModelProvider is supplied the planner prompts the
 *     model for a real decomposition, capturing real token confidences. Any
 *     failure (provider error, unparseable output) falls back to the heuristic
 *     so a run can never be blocked by a flaky model.
 */
export class PlannerAgent implements RoleAgent {
  readonly role = "PLANNER" as const;

  constructor(private readonly modelProvider?: ModelProvider) {}

  async invoke(context: RoleContext): Promise<RoleResult> {
    if (this.modelProvider) {
      try {
        return await this.modelBackedPlan(context);
      } catch {
        // Resilience: never let a model hiccup stall the cognition — fall back
        // to the deterministic heuristic plan.
      }
    }
    return this.heuristicPlan(context);
  }

  private async heuristicPlan(context: RoleContext): Promise<RoleResult> {
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

  private async modelBackedPlan(context: RoleContext): Promise<RoleResult> {
    const goal = context.goal || String(context.task.goal ?? "Unspecified goal");
    const { agent, execution } = roleStubs(context, "planner", "planner-v1");

    const streamed: number[] = [];
    const result = await this.modelProvider!.complete({
      agent,
      execution,
      prompt: buildPlanPrompt(goal, context.task),
      context: context.memories,
      onToken: (_text, confidence) => streamed.push(confidence)
    });

    // Prefer model-produced steps; fall back to the heuristic decomposition so
    // the executor always receives a usable, well-shaped plan.
    const rand = seededRandom(`${context.seed}:planner:${context.task ? JSON.stringify(context.task) : ""}`);
    const steps = coerceSteps(result.output) ?? this.deriveSteps(goal, context.task, rand);

    // Real providers stream confidence ≈ 1.0; default high when none streamed.
    const confidence = streamed.length > 0 ? clamp01(mean(streamed)) : 0.8;
    const lowConfidenceTokens = streamed.filter((c) => c < 0.55).length;

    return {
      output: {
        objective: goal,
        steps,
        riskAssessment: steps.length > 4 ? "MEDIUM" : "LOW",
        memoryNeeded: context.memories.length > 0,
        modelBacked: true,
        modelOutput: result.output
      },
      tokens: steps.map((step, i) => ({
        sequence: i,
        text: `step:${step.id}`,
        confidence,
        emittedAt: new Date(0).toISOString()
      })),
      uncertainty: {
        overall: clamp01(1 - confidence),
        variance: 0.02,
        lowConfidenceTokens,
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

// ─── helpers (shared shape with executorAgent's provider usage) ───────────────

function buildPlanPrompt(goal: string, task: Record<string, unknown>): string {
  return JSON.stringify({
    role: "planner",
    instruction:
      "Decompose the goal into an ordered list of concrete executor steps. " +
      "Respond as JSON: { \"steps\": [{ \"id\": string, \"description\": string }] }.",
    goal,
    task
  });
}

/** Extract a well-shaped step array from arbitrary model output, or undefined. */
function coerceSteps(output: Record<string, unknown>): Array<{ id: string; description: string }> | undefined {
  const raw = (output?.steps ?? output?.plan ?? (output as Record<string, unknown>)?.["actions"]) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const steps = raw
    .map((s, i) => {
      if (typeof s === "string") return { id: `step-${i + 1}`, description: s };
      if (s && typeof s === "object") {
        const obj = s as Record<string, unknown>;
        const description = String(obj.description ?? obj.step ?? obj.text ?? obj.name ?? "").trim();
        if (!description) return undefined;
        const id = String(obj.id ?? obj.name ?? `step-${i + 1}`);
        return { id, description };
      }
      return undefined;
    })
    .filter((s): s is { id: string; description: string } => !!s);
  return steps.length > 0 ? steps : undefined;
}

function roleStubs(context: RoleContext, name: string, model: string): { agent: Agent; execution: Execution } {
  const agent: Agent = {
    id: context.agentId,
    name,
    goal: context.goal,
    state: "RUNNING",
    runtimeStatus: "BUSY",
    model: { provider: "runtime", model },
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

function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number(n.toFixed(3))));
}
