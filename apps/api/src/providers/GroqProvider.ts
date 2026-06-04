/**
 * GroqProvider — concrete LLMProvider backed by Groq's OpenAI-compatible API.
 *
 * Endpoint  : https://api.groq.com/openai/v1/chat/completions  (streaming)
 *             https://api.groq.com/openai/v1/models             (health/list)
 * Auth      : Authorization: Bearer ${GROQ_API_KEY}
 *
 * This single class fills the two seams the platform depends on:
 *   1. The LLMProvider interface (chat/health/listModels) — the canonical
 *      abstraction every new caller should use.
 *   2. The streaming generator surface (runPrompt/isAvailable/modelName) that
 *      the LiveExecutionEngine already consumes for real-time SSE token
 *      streaming. Keeping the generator here means the live tracing, token
 *      accounting and replay capture paths are untouched by the provider swap.
 *
 * Operational impact  : streams each assistant delta in real time, invoking the
 *   onToken sink per chunk so live SSE to the UI is preserved.
 * Replay implications : the final usage object is mapped to the standard token
 *   accounting fields, so the cognition graph records provider-agnostic counts.
 * Failure modes       : every HTTP/network/timeout condition is mapped to the
 *   typed ProviderError hierarchy so the shared retry policy and the
 *   /api/health/llm error envelope behave identically.
 * Observability       : `provider` is always "groq" so structured logs and
 *   metrics group cleanly without parsing messages.
 */

import {
  ProviderAuthError,
  ProviderContextLengthError,
  ProviderForbiddenError,
  ProviderModelNotFoundError,
  ProviderNetworkError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError
} from "./errors.js";
import { throwIfAborted, emitTokenIfLive } from "./retry.js";
import type {
  LLMChatRequest,
  LLMChatResponse,
  LLMHealth,
  LLMProvider
} from "./interfaces/LLMProvider.js";

/** Canonical provider id used in logs, metrics and error envelopes. */
export const GROQ_PROVIDER = "groq" as const;

export const GROQ_DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

/** Default model when none is configured/requested. */
export const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";

/**
 * Models this platform officially supports / surfaces in the model selector.
 * listModels() falls back to this list when the live /models call is
 * unreachable so the UI selector is never empty.
 */
export const GROQ_SUPPORTED_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "deepseek-r1-distill-llama-70b",
  "qwen-qwq-32b"
] as const;

export interface GroqConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  requestTimeoutMs?: number;
}

/** One parsed streaming chunk. Shape is stable across providers. */
export interface GroqStreamChunk {
  /** Raw token text emitted by the model. */
  token: string;
  /** Whether this chunk represents the final stream packet. */
  done: boolean;
  /** Prompt evaluation tokens (only present on the final usage chunk). */
  promptEvalCount?: number;
  /** Completion tokens generated (only present on the final usage chunk). */
  evalCount?: number;
  /** Total nanoseconds the request took (parity field; Groq does not emit this). */
  totalDurationNs?: number;
  /** Provider-issued model id, useful for telemetry. */
  model?: string;
}

export interface GroqRunOptions {
  prompt: string;
  /** Optional system prompt prepended as the system message. */
  system?: string;
  /** Sampling temperature; 0 = deterministic. */
  temperature?: number;
  /** Abort signal so callers can cancel mid-stream. */
  signal?: AbortSignal;
  /** Override the configured model for this single call. */
  model?: string;
}

/** Network/HTTP reachability failure surfaced to the live engine. */
export class GroqUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "GroqUnavailableError";
  }
}

/**
 * Normalised provider-failure envelope (migration Step 8). Every provider
 * failure that crosses an HTTP boundary is reduced to this shape so dashboards,
 * the operator UI and clients see one consistent structure regardless of which
 * status code or transport condition produced it.
 */
export interface NormalizedProviderError {
  provider: string;
  runtimeId?: string;
  executionId?: string;
  traceId?: string;
  status: number | string;
  error: string;
  timestamp: string;
}

export interface NormalizeContext {
  runtimeId?: string;
  executionId?: string;
  traceId?: string;
}

/** Reduce any thrown provider error to the canonical envelope. */
export function normalizeProviderError(
  err: unknown,
  ctx: NormalizeContext = {}
): NormalizedProviderError {
  let status: number | string = "unknown";
  let message: string;

  if (err instanceof ProviderRateLimitError) status = 429;
  else if (err instanceof ProviderAuthError) status = 401;
  else if (err instanceof ProviderForbiddenError) status = 403;
  else if (err instanceof ProviderModelNotFoundError) status = 404;
  else if (err instanceof ProviderServerError) status = err.statusCode;
  else if (err instanceof ProviderTimeoutError) status = "timeout";
  else if (err instanceof ProviderNetworkError) status = "network";
  else if (err instanceof GroqUnavailableError) status = "network";

  if (err instanceof Error) message = err.message;
  else message = String(err);

  return {
    provider: GROQ_PROVIDER,
    ...(ctx.runtimeId ? { runtimeId: ctx.runtimeId } : {}),
    ...(ctx.executionId ? { executionId: ctx.executionId } : {}),
    ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    status,
    error: message,
    timestamp: new Date().toISOString()
  };
}

export class GroqProvider implements LLMProvider {
  readonly provider = GROQ_PROVIDER;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;

  constructor(config: GroqConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.GROQ_API_KEY ?? "";
    this.baseUrl = (config.baseUrl ?? process.env.GROQ_BASE_URL ?? GROQ_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = config.model ?? process.env.GROQ_MODEL ?? GROQ_DEFAULT_MODEL;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 120_000;
  }

  get modelName(): string {
    return this.model;
  }

  get selectedModel(): string {
    return this.model;
  }

  // ─── LLMProvider surface ────────────────────────────────────────────────

  /**
   * Run a chat completion. Streams via request.onToken when supplied and
   * resolves with the aggregated text + token usage.
   */
  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const system = request.messages.find((m) => m.role === "system")?.content;
    // Concatenate the remaining (non-system) turns into the prompt. Most
    // callers send a single user turn; multi-turn callers get a faithful
    // role-tagged transcript.
    const prompt = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => (m.role === "assistant" ? `Assistant: ${m.content}` : m.content))
      .join("\n\n");

    const tokens: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    const model = request.model ?? this.model;

    for await (const chunk of this.runPrompt({
      prompt,
      system,
      temperature: request.temperature,
      signal: request.signal,
      model
    })) {
      if (chunk.token) {
        tokens.push(chunk.token);
        emitTokenIfLive(request.signal, request.onToken, chunk.token, 1.0);
      }
      if (chunk.done) {
        // Guard against the trailing usage-less [DONE] / finish chunks
        // overwriting counts captured from the usage chunk.
        if (chunk.promptEvalCount !== undefined) inputTokens = chunk.promptEvalCount;
        if (chunk.evalCount !== undefined) outputTokens = chunk.evalCount;
      }
    }

    const text = tokens.join("");
    if (inputTokens === 0) inputTokens = Math.ceil(text.length / 4);
    if (outputTokens === 0) outputTokens = Math.ceil(text.length / 4);

    return {
      text,
      model,
      usage: { prompt: inputTokens, completion: outputTokens, total: inputTokens + outputTokens }
    };
  }

  /** Probe https://api.groq.com/openai/v1/models for reachability + latency. */
  async health(): Promise<LLMHealth> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: this.authHeaders()
      });
      const latency = Date.now() - start;
      if (!res.ok) {
        return {
          provider: this.provider,
          online: false,
          latency,
          selectedModel: this.model,
          error: `HTTP ${res.status}: ${res.statusText}`
        };
      }
      return { provider: this.provider, online: true, latency, selectedModel: this.model };
    } catch (err) {
      return {
        provider: this.provider,
        online: false,
        latency: Date.now() - start,
        selectedModel: this.model,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /**
   * Enumerate available models. Queries the live /models endpoint and falls
   * back to the curated supported list when the call fails so the UI selector
   * is never empty.
   */
  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: this.authHeaders()
      });
      if (!res.ok) return [...GROQ_SUPPORTED_MODELS];
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      return ids.length ? ids : [...GROQ_SUPPORTED_MODELS];
    } catch {
      return [...GROQ_SUPPORTED_MODELS];
    }
  }

  // ─── Live-engine streaming surface ──────────────────────────────────────

  /** Lightweight health probe. Returns true if the Groq API answered. */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { method: "GET", headers: this.authHeaders() });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Streams tokens from Groq's OpenAI-compatible chat completions endpoint.
   * Each yielded chunk carries one delta; the final chunk carries usage.
   */
  async *runPrompt(options: GroqRunOptions): AsyncGenerator<GroqStreamChunk, void, void> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new ProviderTimeoutError(GROQ_PROVIDER, this.requestTimeoutMs)),
      this.requestTimeoutMs
    );
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const model = options.model ?? this.model;
    const messages: Array<{ role: string; content: string }> = [];
    if (options.system) messages.push({ role: "system", content: options.system });
    messages.push({ role: "user", content: options.prompt });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: options.temperature ?? 0.7
        }),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      if ((error as Error)?.name === "AbortError") {
        // Timeout aborts carry our typed reason; surface it for the retry policy.
        const reason = (controller.signal as AbortSignal).reason;
        if (reason instanceof ProviderTimeoutError) throw reason;
        throw error;
      }
      throw new GroqUnavailableError(
        `Unable to reach Groq at ${this.baseUrl}. Check GROQ_BASE_URL / network.`,
        error
      );
    }

    if (!response.ok || !response.body) {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      await this.throwForStatus(response, model);
      // throwForStatus always throws; this is unreachable but satisfies types.
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        throwIfAborted(options.signal);
        throwIfAborted(controller.signal);
        const { value, done } = await reader.read();
        throwIfAborted(options.signal);
        throwIfAborted(controller.signal);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const raw of lines) {
          const line = raw.trim();
          if (!line || !line.startsWith("data:")) continue;
          const data = line.slice(line.indexOf(":") + 1).trim();
          if (data === "[DONE]") {
            yield { token: "", done: true, model };
            continue;
          }
          const parsed = parseSseData(data, model);
          if (parsed) {
            throwIfAborted(options.signal);
            yield parsed;
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  /** Map a non-OK HTTP response to the typed ProviderError hierarchy. */
  private async throwForStatus(response: Response, model: string): Promise<never> {
    const status = response.status;
    const detail = await safeReadText(response);
    if (status === 401) throw new ProviderAuthError(GROQ_PROVIDER);
    if (status === 403) throw new ProviderForbiddenError(GROQ_PROVIDER);
    if (status === 404) throw new ProviderModelNotFoundError(GROQ_PROVIDER, model);
    if (status === 429) {
      const ra = response.headers.get("retry-after");
      throw new ProviderRateLimitError(GROQ_PROVIDER, ra ? Math.round(parseFloat(ra) * 1_000) : undefined);
    }
    if (status === 400) {
      if (detail.includes("context_length") || detail.includes("maximum context length")) {
        throw new ProviderContextLengthError(GROQ_PROVIDER);
      }
      if (detail.includes("model") && (detail.includes("not found") || detail.includes("does not exist") || detail.includes("decommissioned"))) {
        throw new ProviderModelNotFoundError(GROQ_PROVIDER, model);
      }
      throw new ProviderServerError(GROQ_PROVIDER, status);
    }
    if (status >= 500) throw new ProviderServerError(GROQ_PROVIDER, status);
    throw new ProviderServerError(GROQ_PROVIDER, status);
  }
}

interface GroqSseChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

function parseSseData(data: string, fallbackModel: string): GroqStreamChunk | null {
  let chunk: GroqSseChunk;
  try {
    chunk = JSON.parse(data) as GroqSseChunk;
  } catch {
    return null;
  }
  const delta = chunk.choices?.[0]?.delta?.content ?? "";
  const finish = chunk.choices?.[0]?.finish_reason;
  const hasUsage = chunk.usage !== undefined;
  // Groq emits a trailing usage-only chunk (empty choices) when
  // include_usage is set. Surface it as a final chunk with the counts.
  if (hasUsage) {
    return {
      token: delta,
      done: true,
      promptEvalCount: chunk.usage?.prompt_tokens,
      evalCount: chunk.usage?.completion_tokens,
      model: chunk.model ?? fallbackModel
    };
  }
  return {
    token: delta,
    done: finish !== null && finish !== undefined,
    model: chunk.model ?? fallbackModel
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
