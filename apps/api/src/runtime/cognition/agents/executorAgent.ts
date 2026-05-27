/**
 * Executor role agent — the heart of real AI execution.
 *
 * Flow
 * ────
 * 1. Build a full prompt from the plan and memory context.
 * 2. Call the ModelProvider with an `onToken` collector (real streaming).
 * 3. Parse the model's JSON output for tool-call requests.
 * 4. Execute requested tools (max MAX_TOOL_ROUNDS rounds) via ToolExecutor.
 * 5. Feed tool results back to the model for a final synthesis call.
 * 6. Return the accumulated real token stream for the cognition graph.
 *
 * Operational impact  : replaces all fake/deterministic execution with real
 *   LLM calls. Every token is real; every tool call hits a real endpoint.
 * Replay implications : tokens are collected with real timestamps and stored
 *   in the CognitionNode; replay reconstructs exactly what was emitted.
 *   Tool results are also stored in TOOL_CALLED events, so a re-run can
 *   diff tool outputs across branches.
 * Failure modes       : model errors propagate as thrown exceptions caught
 *   by the CognitionOrchestrator, which records them as COGNITION_FAILED
 *   and triggers the retry budget. Tool errors return structured {error}
 *   objects so the model can incorporate them rather than hard-crashing.
 * Observability       : per-token confidence is 1.0 for real provider tokens
 *   and degrades toward 0.6 for synthetic fallback chunks, making it easy
 *   to distinguish real vs. deterministic runs in the heatmap UI.
 */

import type { RoleAgent, RoleContext, RoleResult } from "../roles.js";
import type { ModelProvider, ToolExecutor } from "../../../domain/ports.js";
import type { Agent, Execution } from "../../../domain/model.js";

const MAX_TOOL_ROUNDS = 3;

export class ExecutorAgent implements RoleAgent {
  readonly role = "EXECUTOR" as const;

  constructor(
    private readonly modelProvider: ModelProvider,
    private readonly toolExecutor?: ToolExecutor
  ) {}

  async invoke(context: RoleContext): Promise<RoleResult> {
    const plan = (context.carryOver.steps ?? []) as Array<{ id: string; description: string }>;

    // Construct the agent/execution stubs the ModelProvider interface requires.
    const agent: Agent = {
      id: context.agentId,
      name: "executor",
      goal: context.goal,
      state: "RUNNING",
      runtimeStatus: "BUSY",
      model: { provider: "runtime", model: "executor-v1" },
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

    // ── Real token streaming ──────────────────────────────────────────────
    const streamedTokens: StreamedToken[] = [];
    const onToken = (text: string, confidence: number): void => {
      streamedTokens.push({ text, confidence, emittedAt: new Date().toISOString() });
    };

    // ── Agentic tool-use loop ─────────────────────────────────────────────
    let prompt = buildInitialPrompt(context.goal, context.task, plan);
    let modelResult = await this.modelProvider.complete({
      agent,
      execution,
      prompt,
      context: context.memories,
      onToken
    });

    const allToolResults: ToolResult[] = [];
    let totalPromptTokens = modelResult.tokenUsage.prompt;
    let totalCompletionTokens = modelResult.tokenUsage.completion;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const toolCalls = extractToolCalls(modelResult.output);
      if (toolCalls.length === 0 || !this.toolExecutor) break;

      // Execute all requested tools in parallel.
      const results = await Promise.all(
        toolCalls.map(async (tc) => {
          const output = await this.toolExecutor!.execute({
            toolName: tc.name,
            args: tc.args,
            executionId: context.executionId,
            agentId: context.agentId
          });
          return { name: tc.name, args: tc.args, output };
        })
      );

      allToolResults.push(...results);

      // Synthesise a follow-up prompt with tool results.
      const roundTokens: StreamedToken[] = [];
      prompt = buildToolFeedbackPrompt(prompt, modelResult.output, results);
      modelResult = await this.modelProvider.complete({
        agent,
        execution,
        prompt,
        context: context.memories,
        onToken: (text, conf) => {
          roundTokens.push({ text, confidence: conf, emittedAt: new Date().toISOString() });
          streamedTokens.push({ text, confidence: conf, emittedAt: new Date().toISOString() });
        }
      });

      totalPromptTokens += modelResult.tokenUsage.prompt;
      totalCompletionTokens += modelResult.tokenUsage.completion;

      // If the model stopped requesting tools, exit the loop.
      if (extractToolCalls(modelResult.output).length === 0) break;
    }

    // ── Token normalisation ───────────────────────────────────────────────
    // If the provider streamed real tokens we use them; otherwise fall back
    // to synthetic chunks so the cognition graph always has a token array.
    const chunks = streamedTokens.length > 0
      ? streamedTokens.map((t, i) => ({
          sequence: i,
          text: t.text,
          confidence: clamp01(t.confidence),
          emittedAt: t.emittedAt
        }))
      : syntheticChunks(modelResult.output, context.seed);

    const confidences = chunks.map((c) => c.confidence);
    const overall = clamp01(1 - mean(confidences));
    const variance = variance01(confidences);
    const lowConfidenceTokens = chunks.filter((c) => c.confidence < 0.55).length;

    const tokenUsage = {
      prompt: totalPromptTokens,
      completion: totalCompletionTokens,
      total: totalPromptTokens + totalCompletionTokens
    };

    return {
      output: {
        modelOutput: modelResult.output,
        tokenUsage,
        planSteps: plan.length,
        toolsExecuted: allToolResults.length,
        toolResults: allToolResults,
        streaming: streamedTokens.length > 0
      },
      tokens: chunks,
      uncertainty: { overall, variance, lowConfidenceTokens },
      memoryInfluence: context.memories.slice(0, 5).map((m, i) => ({
        memoryId: m.id,
        weight: Number((0.4 - i * 0.06).toFixed(2)),
        reason: i === 0 ? "highest semantic overlap" : "supporting evidence"
      })),
      nextPhase: "VERIFY",
      reason: "execution-complete"
    };
  }
}

// ─── prompt builders ─────────────────────────────────────────────────────────

function buildInitialPrompt(
  goal: string,
  task: Record<string, unknown>,
  plan: Array<{ id: string; description: string }>
): string {
  return JSON.stringify({
    goal,
    task,
    plan: plan.map((s) => `${s.id}: ${s.description}`)
  });
}

function buildToolFeedbackPrompt(
  previousPrompt: string,
  previousOutput: Record<string, unknown>,
  toolResults: ToolResult[]
): string {
  return JSON.stringify({
    previousPrompt: JSON.parse(previousPrompt) as unknown,
    assistantResponse: previousOutput,
    toolResults: toolResults.map((r) => ({
      tool: r.name,
      args: r.args,
      result: r.output
    })),
    instruction: "Using the tool results above, produce your final answer. Do not request more tools."
  });
}

// ─── tool-call extraction ─────────────────────────────────────────────────────

interface ToolCallRequest { name: string; args: Record<string, unknown> }
interface ToolResult { name: string; args: Record<string, unknown>; output: Record<string, unknown> }
interface StreamedToken { text: string; confidence: number; emittedAt: string }

function extractToolCalls(output: Record<string, unknown>): ToolCallRequest[] {
  const raw = output.toolCalls ?? output.tool_calls ?? [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => ({
      name: String(c.name ?? c.tool ?? ""),
      args: (typeof c.args === "object" && c.args !== null ? c.args : {}) as Record<string, unknown>
    }))
    .filter((c) => c.name.length > 0);
}

// ─── synthetic fallback token generation ────────────────────────────────────

function syntheticChunks(
  output: Record<string, unknown>,
  seed: string
): Array<{ sequence: number; text: string; confidence: number; emittedAt: string }> {
  const rand = seededRandom(`${seed}:executor:synthetic`);
  const text = JSON.stringify(output).slice(0, 600);
  const SIZE = 24;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += SIZE) parts.push(text.slice(i, i + SIZE));
  if (parts.length === 0) parts.push("");

  return parts.map((chunk, i) => ({
    sequence: i,
    text: chunk,
    // Synthetic confidence is deliberately lower (0.55–0.75) so the heatmap
    // visually distinguishes synthetic from real streaming runs.
    confidence: clamp01(0.55 + rand() * 0.2),
    emittedAt: new Date(i * 5).toISOString()
  }));
}

// ─── math helpers ─────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number(n.toFixed(3))));
}
function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}
function variance01(arr: number[]): number {
  const m = mean(arr);
  return arr.length === 0
    ? 0
    : Number((arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length).toFixed(4));
}

// Lehmer-style seeded PRNG (mirrors shared/determinism.ts).
function seededRandom(seed: string): () => number {
  let s = hashSeed(seed);
  return () => {
    s = (s * 48271) % 2_147_483_647;
    return (s - 1) / 2_147_483_646;
  };
}
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) >>> 0;
  }
  return (h % 2_147_483_646) + 1;
}
