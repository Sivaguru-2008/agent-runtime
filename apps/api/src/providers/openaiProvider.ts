/**
 * OpenAI provider — implements ModelProvider via the Chat Completions API
 * with streaming (text/event-stream).
 *
 * Operational impact  : streams each assistant token as a delta chunk,
 *   invoking `onToken` in real time. Resolves after the [DONE] sentinel.
 * Replay implications : like the Claude adapter, the token sequence emitted
 *   during execution is captured in the cognition graph, making replay exact.
 * Failure modes       :
 *   - 401 → ProviderAuthError (not retried)
 *   - 429 → ProviderRateLimitError (retried; honours Retry-After header)
 *   - 5xx → ProviderServerError (retried)
 *   - network → ProviderNetworkError (retried)
 *   - timeout → ProviderTimeoutError (retried)
 *   - context_length_exceeded → ProviderContextLengthError (not retried)
 * Observability       : usage object from the final SSE chunk is mapped to
 *   standard tokenUsage so dashboards see consistent fields.
 */

import type { ModelProvider } from "../domain/ports.js";
import type { Agent, MemoryRecord } from "../domain/model.js";
import {
  ProviderAuthError,
  ProviderContextLengthError,
  ProviderNetworkError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError
} from "./errors.js";
import {
  withRetry,
  throwIfAborted,
  composeAbortSignals,
  emitTokenIfLive,
  type RetryOptions,
  defaultRetryOptions
} from "./retry.js";
import { extractStructuredOutput } from "./structuredOutput.js";

const OPENAI_API = "https://api.openai.com/v1/chat/completions";

export interface OpenAIProviderConfig {
  apiKey: string;
  /** Model ID. Defaults to gpt-4o. */
  model?: string;
  /** Maximum completion tokens. Default 4096. */
  maxTokens?: number;
  /** Sampling temperature [0, 2]. Default 0.7. */
  temperature?: number;
  /** Per-attempt wall-clock timeout in ms. Default 120 000. */
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
}

interface StreamResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export class OpenAIProvider implements ModelProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly retryOpts: RetryOptions;

  constructor(config: OpenAIProviderConfig) {
    if (!config.apiKey) throw new Error("OpenAIProvider: apiKey is required");
    this.apiKey = config.apiKey;
    this.model = config.model ?? "gpt-4o";
    this.maxTokens = config.maxTokens ?? 4_096;
    this.temperature = config.temperature ?? 0.7;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.retryOpts = { ...defaultRetryOptions, ...config.retry };
  }

  async complete(input: Parameters<ModelProvider["complete"]>[0]): ReturnType<ModelProvider["complete"]> {
    const systemMsg = buildSystemPrompt(input.agent, input.context);

    const streamResult = await withRetry(
      async () => {
        const attemptController = new AbortController();
        const timeoutTimer = setTimeout(() => {
          attemptController.abort(new ProviderTimeoutError("openai", this.timeoutMs));
        }, this.timeoutMs);

        const { signal: attemptSignal, cleanup: cleanupComposition } = composeAbortSignals(
          input.signal,
          attemptController.signal
        );

        try {
          return await this.callApi(systemMsg, input.prompt, input.onToken, attemptSignal);
        } finally {
          clearTimeout(timeoutTimer);
          cleanupComposition();
        }
      },
      this.retryOpts,
      undefined,
      input.signal
    );

    throwIfAborted(input.signal);

    const output = extractStructuredOutput(streamResult.text, {
      agentId: input.agent.id,
      executionId: input.execution.id,
      model: this.model,
      result: streamResult.text
    });

    return {
      output,
      tokenUsage: {
        prompt: streamResult.promptTokens,
        completion: streamResult.completionTokens,
        total: streamResult.promptTokens + streamResult.completionTokens
      }
    };
  }

  private async callApi(
    systemMessage: string,
    userMessage: string,
    onToken: ((token: string, confidence: number) => void) | undefined,
    signal: AbortSignal | undefined
  ): Promise<StreamResult> {
    let response: Response;
    try {
      response = await fetch(OPENAI_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          temperature: this.temperature,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: "system", content: systemMessage },
            { role: "user", content: userMessage }
          ]
        }),
        signal
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new ProviderNetworkError("openai", err);
    }

    if (response.status === 401) throw new ProviderAuthError("openai");
    if (response.status === 429) {
      const ra = response.headers.get("retry-after");
      throw new ProviderRateLimitError("openai", ra ? Math.round(parseFloat(ra) * 1_000) : undefined);
    }
    if (response.status === 400) {
      const body = await safeText(response);
      if (body.includes("context_length_exceeded") || body.includes("maximum context length")) {
        throw new ProviderContextLengthError("openai");
      }
      throw new ProviderServerError("openai", response.status);
    }
    if (response.status >= 500) throw new ProviderServerError("openai", response.status);
    if (!response.ok || !response.body) throw new ProviderServerError("openai", response.status);

    return this.drainStream(response.body, onToken, signal);
  }

  private async drainStream(
    body: ReadableStream<Uint8Array>,
    onToken: ((token: string, confidence: number) => void) | undefined,
    signal: AbortSignal | undefined
  ): Promise<StreamResult> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let fullText = "";
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      for (;;) {
        throwIfAborted(signal);
        const { value, done } = await reader.read();
        throwIfAborted(signal);
        if (done) break;
        buf += dec.decode(value, { stream: true });

        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const raw of lines) {
          const line = raw.trim();
          if (!line || !line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          let chunk: OpenAIStreamChunk;
          try {
            chunk = JSON.parse(data) as OpenAIStreamChunk;
          } catch {
            continue;
          }

          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            fullText += delta;
            // Guarded dispatch: refuses to invoke onToken if the signal
            // fired between the read() resolving and this point.
            emitTokenIfLive(signal, onToken, delta, 1.0);
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? 0;
            completionTokens = chunk.usage.completion_tokens ?? 0;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (promptTokens === 0) promptTokens = Math.ceil(fullText.length / 4);
    if (completionTokens === 0) completionTokens = Math.ceil(fullText.length / 4);

    return { text: fullText, promptTokens, completionTokens };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildSystemPrompt(agent: Agent, context: MemoryRecord[]): string {
  const memSection =
    context.length > 0
      ? `\n\nRelevant memory:\n${context.slice(0, 6).map((m, i) => `[${i + 1}] ${m.content}`).join("\n")}`
      : "";

  return `You are an AI agent assistant. Agent goal: ${agent.goal}

Respond with valid JSON only — no prose, no fences. Shape:
{"thinking":"...","plan":["..."],"toolCalls":[{"name":"...","args":{}}],"result":"...","confidence":0.9}

Available tools: web.search, file.read, code.execute, memory.summarize.
If no tools are needed set toolCalls to [].${memSection}`;
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return ""; }
}

interface OpenAIStreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
