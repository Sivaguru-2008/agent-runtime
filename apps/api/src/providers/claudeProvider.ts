/**
 * Anthropic Claude provider — implements the ModelProvider domain port via
 * direct HTTP calls to the Messages API (no SDK dependency required).
 *
 * Operational impact  : every complete() call opens an SSE stream to
 *   api.anthropic.com, drains it token-by-token, and resolves when `done`
 *   is received. Each token fires `input.onToken` in real time.
 * Replay implications : token text is non-deterministic across real API calls;
 *   however, the collected token array is persisted in the cognition graph so
 *   replay reconstructs the exact token sequence that was produced.
 * Failure modes       :
 *   - 401 → ProviderAuthError (not retried)
 *   - 429 → ProviderRateLimitError (retried with Retry-After backoff)
 *   - 5xx → ProviderServerError (retried up to maxAttempts)
 *   - network → ProviderNetworkError (retried)
 *   - timeout → ProviderTimeoutError (retried)
 * Observability       : every call records prompt/completion token counts that
 *   are written to the EXECUTION_COMPLETED event payload.
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

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface ClaudeProviderConfig {
  apiKey: string;
  /** Model ID. Defaults to claude-sonnet-4-6. */
  model?: string;
  /** Maximum completion tokens. Default 4096. */
  maxTokens?: number;
  /** Sampling temperature [0, 1]. Default 0.7. */
  temperature?: number;
  /** Per-attempt wall-clock timeout in ms. Default 120 000. */
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
}

interface StreamResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export class ClaudeProvider implements ModelProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly retryOpts: RetryOptions;

  constructor(config: ClaudeProviderConfig) {
    if (!config.apiKey) throw new Error("ClaudeProvider: apiKey is required");
    this.apiKey = config.apiKey;
    this.model = config.model ?? "claude-sonnet-4-6";
    this.maxTokens = config.maxTokens ?? 4_096;
    this.temperature = config.temperature ?? 0.7;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.retryOpts = { ...defaultRetryOptions, ...config.retry };
  }

  async complete(input: Parameters<ModelProvider["complete"]>[0]): ReturnType<ModelProvider["complete"]> {
    const system = buildSystemPrompt(input.agent, input.context);

    const streamResult = await withRetry(
      async () => {
        const attemptController = new AbortController();
        const timeoutTimer = setTimeout(() => {
          attemptController.abort(new ProviderTimeoutError("claude", this.timeoutMs));
        }, this.timeoutMs);

        const { signal: attemptSignal, cleanup: cleanupComposition } = composeAbortSignals(
          input.signal,
          attemptController.signal
        );

        try {
          return await this.callApi(system, input.prompt, input.onToken, attemptSignal);
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
        prompt: streamResult.inputTokens,
        completion: streamResult.outputTokens,
        total: streamResult.inputTokens + streamResult.outputTokens
      }
    };
  }

  private async callApi(
    system: string,
    userMessage: string,
    onToken: ((token: string, confidence: number) => void) | undefined,
    signal: AbortSignal | undefined
  ): Promise<StreamResult> {
    let response: Response;
    try {
      response = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          temperature: this.temperature,
          system,
          messages: [{ role: "user", content: userMessage }],
          stream: true
        }),
        signal
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new ProviderNetworkError("claude", err);
    }

    if (response.status === 401) throw new ProviderAuthError("claude");
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new ProviderRateLimitError(
        "claude",
        retryAfter ? Math.round(parseFloat(retryAfter) * 1_000) : undefined
      );
    }
    if (response.status === 400) {
      const body = await safeText(response);
      if (body.includes("context_length_exceeded") || body.includes("too many tokens")) {
        throw new ProviderContextLengthError("claude");
      }
      throw new ProviderServerError("claude", response.status);
    }
    if (response.status >= 500) throw new ProviderServerError("claude", response.status);
    if (!response.ok || !response.body) throw new ProviderServerError("claude", response.status);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let buf = "";
    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        throwIfAborted(signal);
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const ev = JSON.parse(data) as AnthropicSSEEvent;
            if (ev.type === "message_start") {
              inputTokens = ev.message?.usage?.input_tokens ?? 0;
            } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
              const text = ev.delta.text ?? "";
              fullText += text;
              // Guarded dispatch: refuses to invoke onToken if the signal
              // fired between the read() resolving and this point.
              emitTokenIfLive(signal, onToken, text, 1.0);
            } else if (ev.type === "message_delta") {
              outputTokens = ev.usage?.output_tokens ?? 0;
            }
          } catch (err) {
            if (err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"))) {
              throw err;
            }
          }
        }
      }
      // Flush decoder remainder.
      const tail = buf.trim();
      if (tail.startsWith("data: ")) {
        try {
          const ev = JSON.parse(tail.slice(6)) as AnthropicSSEEvent;
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            fullText += ev.delta.text ?? "";
          }
        } catch {
          /* ignore */
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Fallback token count estimation when the API didn't send usage events.
    if (inputTokens === 0) inputTokens = Math.ceil(fullText.length / 4);
    if (outputTokens === 0) outputTokens = Math.ceil(fullText.length / 4);

    return { text: fullText, inputTokens, outputTokens };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildSystemPrompt(agent: Agent, context: MemoryRecord[]): string {
  const memorySection =
    context.length > 0
      ? `\n\nRelevant memory context (use if applicable):\n${context
          .slice(0, 6)
          .map((m, i) => `[${i + 1}] ${m.content}`)
          .join("\n")}`
      : "";

  return `You are an AI agent assistant.

Agent goal: ${agent.goal}

You MUST respond with valid JSON only — no prose, no code fences. The JSON must have this shape:
{
  "thinking": "<your step-by-step reasoning>",
  "plan": ["<step 1>", "<step 2>"],
  "toolCalls": [{"name": "<tool>", "args": {<args>}}],
  "result": "<your final answer>",
  "confidence": <0.0–1.0>
}

If no tools are needed, set toolCalls to an empty array [].
Available tools: web.search, file.read, code.execute, memory.summarize.${memorySection}`;
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return ""; }
}

// Minimal Anthropic SSE event shape for type safety.
interface AnthropicSSEEvent {
  type: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  delta?: { type?: string; text?: string };
  usage?: { output_tokens?: number };
}
