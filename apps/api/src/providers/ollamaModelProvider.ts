/**
 * Adapts the existing OllamaProvider streaming generator to the
 * ModelProvider domain port.
 *
 * Operational impact  : streams tokens in real time from a local Ollama
 *   daemon and fires `onToken` per chunk, enabling live SSE to the UI.
 * Replay implications : token sequence captured in cognition graph for exact
 *   replay even though Ollama output is non-deterministic across calls.
 * Failure modes       : OllamaUnavailableError is re-thrown as
 *   ProviderNetworkError so the shared retry policy handles it uniformly.
 * Observability       : final chunk carries Ollama's own eval counts which
 *   are used for token accounting; falls back to character-based estimate.
 */

import type { ModelProvider } from "../domain/ports.js";
import type { Agent, MemoryRecord } from "../domain/model.js";
import { OllamaProvider, OllamaUnavailableError } from "./ollama.js";
import { ProviderNetworkError } from "./errors.js";
import { withRetry, defaultRetryOptions, type RetryOptions, throwIfAborted, emitTokenIfLive } from "./retry.js";
import { extractStructuredOutput } from "./structuredOutput.js";

export interface OllamaModelProviderConfig {
  retry?: Partial<RetryOptions>;
}

export class OllamaModelProvider implements ModelProvider {
  private readonly retryOpts: RetryOptions;

  constructor(
    private readonly ollama: OllamaProvider,
    config: OllamaModelProviderConfig = {}
  ) {
    this.retryOpts = { ...defaultRetryOptions, ...config.retry };
  }

  async complete(input: Parameters<ModelProvider["complete"]>[0]): ReturnType<ModelProvider["complete"]> {
    const system = buildSystemPrompt(input.agent, input.context);

    const result = await withRetry(
      () => this.streamPrompt(system, input.prompt, input.onToken, input.signal),
      this.retryOpts,
      undefined,
      input.signal
    );

    throwIfAborted(input.signal);

    const output = extractStructuredOutput(result.text, {
      agentId: input.agent.id,
      executionId: input.execution.id,
      model: this.ollama.modelName,
      result: result.text
    });

    return {
      output,
      tokenUsage: {
        prompt: result.inputTokens,
        completion: result.outputTokens,
        total: result.inputTokens + result.outputTokens
      }
    };
  }

  private async streamPrompt(
    system: string,
    prompt: string,
    onToken: ((token: string, confidence: number) => void) | undefined,
    signal: AbortSignal | undefined
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const tokens: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const chunk of this.ollama.runPrompt({ prompt, system, signal })) {
        if (chunk.token) {
          tokens.push(chunk.token);
          // Guarded dispatch closes the for-await microtask-boundary window
          // between the generator's pre-yield throwIfAborted and the
          // consumer-side onToken call.
          emitTokenIfLive(signal, onToken, chunk.token, 1.0);
        }
        if (chunk.done) {
          inputTokens = chunk.promptEvalCount ?? 0;
          outputTokens = chunk.evalCount ?? 0;
        }
      }
    } catch (err) {
      if (err instanceof OllamaUnavailableError) {
        throw new ProviderNetworkError("ollama", err);
      }
      throw err;
    }

    const text = tokens.join("");
    if (inputTokens === 0) inputTokens = Math.ceil(text.length / 4);
    if (outputTokens === 0) outputTokens = Math.ceil(text.length / 4);

    return { text, inputTokens, outputTokens };
  }
}

function buildSystemPrompt(agent: Agent, context: MemoryRecord[]): string {
  const memSection =
    context.length > 0
      ? `\n\nMemory context:\n${context.slice(0, 6).map((m, i) => `[${i + 1}] ${m.content}`).join("\n")}`
      : "";

  return `You are an AI agent assistant. Agent goal: ${agent.goal}

Respond with valid JSON only. Shape:
{"thinking":"...","plan":["..."],"toolCalls":[{"name":"...","args":{}}],"result":"...","confidence":0.9}

If no tools needed set toolCalls to []. Available tools: web.search, file.read, code.execute, memory.summarize.${memSection}`;
}
