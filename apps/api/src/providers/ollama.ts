import { throwIfAborted } from "./retry.js";

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  requestTimeoutMs?: number;
}

export interface OllamaStreamChunk {
  /** Raw token text emitted by the model. */
  token: string;
  /** Whether this chunk represents the final stream packet. */
  done: boolean;
  /** Total prompt evaluation tokens (only present on the final chunk). */
  promptEvalCount?: number;
  /** Total completion tokens generated (only present on the final chunk). */
  evalCount?: number;
  /** Total nanoseconds the request took (only on the final chunk). */
  totalDurationNs?: number;
  /** Provider-issued model id, useful for telemetry. */
  model?: string;
}

export interface OllamaProviderOptions {
  prompt: string;
  /** Optional system prompt prepended on the Ollama side. */
  system?: string;
  /** Sampling temperature; 0 = deterministic. */
  temperature?: number;
  /** Abort signal so callers can cancel mid-stream. */
  signal?: AbortSignal;
}

export class OllamaUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "OllamaUnavailableError";
  }
}

export class OllamaProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;

  constructor(config: Partial<OllamaConfig> = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
    this.model = config.model ?? process.env.OLLAMA_MODEL ?? "llama3";
    this.requestTimeoutMs = config.requestTimeoutMs ?? 120_000;
  }

  get modelName(): string {
    return this.model;
  }

  /** Lightweight health probe. Returns true if the Ollama daemon answered. */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Streams tokens from Ollama. Each yielded chunk is one parsed JSON line from
   * the `/api/generate` newline-delimited JSON stream.
   */
  async *runPrompt(options: OllamaProviderOptions): AsyncGenerator<OllamaStreamChunk, void, void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: options.prompt,
          system: options.system,
          stream: true,
          options: {
            temperature: options.temperature ?? 0.7
          }
        }),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      throw new OllamaUnavailableError(
        `Unable to reach Ollama at ${this.baseUrl}. Is the daemon running?`,
        error
      );
    }

    if (!response.ok || !response.body) {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      const detail = await safeReadText(response);
      throw new OllamaUnavailableError(
        `Ollama responded with HTTP ${response.status}: ${detail || response.statusText}`
      );
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

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            const parsed = parseLine(line);
            if (parsed) {
              throwIfAborted(options.signal);
              yield parsed;
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }

      const trailing = buffer.trim();
      if (trailing.length > 0) {
        const parsed = parseLine(trailing);
        if (parsed) yield parsed;
      }
    } finally {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  }
}

function parseLine(line: string): OllamaStreamChunk | null {
  try {
    const json = JSON.parse(line) as {
      response?: string;
      done?: boolean;
      prompt_eval_count?: number;
      eval_count?: number;
      total_duration?: number;
      model?: string;
    };
    return {
      token: json.response ?? "",
      done: json.done === true,
      promptEvalCount: json.prompt_eval_count,
      evalCount: json.eval_count,
      totalDurationNs: json.total_duration,
      model: json.model
    };
  } catch {
    return null;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
