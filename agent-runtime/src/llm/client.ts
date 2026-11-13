/**
 * LLM seam. The runtime depends only on `LLMClient`; Stage 2 needs to see every
 * token, so the contract is "stream tokens, invoke onToken per delta, resolve
 * with the full text + usage".
 *
 * Two implementations:
 *   - GroqClient    : real Groq (Llama 3.3 70B), OpenAI-compatible streaming.
 *   - ScriptedClient: deterministic token streams for tests (no network).
 */
import { readGroqEnv } from "./env.js";

export interface ChatRequest {
  system?: string;
  prompt: string;
  temperature?: number;
  model?: string;
  /** External abort. When fired, streaming stops gracefully and returns the
   *  partial text gathered so far (used by Stage 6 to halt generation). */
  signal?: AbortSignal;
}

export interface StreamResult {
  text: string;
  /** Raw token deltas, in arrival order. */
  tokens: string[];
  inputTokens: number;
  outputTokens: number;
}

export interface JsonResult<T = unknown> {
  raw: string;
  json: T;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMClient {
  readonly model: string;
  readonly live: boolean;
  streamChat(req: ChatRequest, onToken?: (token: string, index: number) => void): Promise<StreamResult>;
  jsonChat<T = unknown>(req: ChatRequest): Promise<JsonResult<T>>;
}

// ─── Cost model (approx. Groq published pricing for llama-3.3-70b) ────────────

const INPUT_USD_PER_TOKEN = 0.59 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 0.79 / 1_000_000;

export function estimateCostUSD(inputTokens: number, outputTokens: number): number {
  return inputTokens * INPUT_USD_PER_TOKEN + outputTokens * OUTPUT_USD_PER_TOKEN;
}

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Raised on HTTP 429 so streamChat can back off and retry. */
export class RateLimitError extends Error {
  constructor(public readonly retryMs: number, message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pull a wait time from the retry-after header or the "try again in Xs" body. */
function parseRetryMs(res: Response, body: string): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const secs = parseFloat(header);
    if (Number.isFinite(secs)) return clampWait(secs * 1000);
  }
  const m = body.match(/try again in\s+([\d.]+)\s*(ms|s)?/i);
  if (m && m[1]) {
    const n = parseFloat(m[1]);
    const ms = m[2]?.toLowerCase() === "ms" ? n : n * 1000;
    if (Number.isFinite(ms)) return clampWait(ms);
  }
  return 5000;
}

function clampWait(ms: number): number {
  return Math.max(500, Math.min(45_000, Math.ceil(ms) + 250));
}

/** Pull the first balanced JSON object/array out of a model response. */
export function extractJson<T = unknown>(raw: string): T {
  let text = raw.trim();
  // Strip ```json fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) text = fence[1].trim();
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error(`No JSON found in model output: ${raw.slice(0, 120)}`);
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        return JSON.parse(slice) as T;
      }
    }
  }
  throw new Error(`Unbalanced JSON in model output: ${raw.slice(0, 120)}`);
}

// ─── Groq (real) ─────────────────────────────────────────────────────────────

export class GroqClient implements LLMClient {
  readonly model: string;
  readonly live = true;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts?: { apiKey?: string; baseUrl?: string; model?: string; timeoutMs?: number }) {
    const env = readGroqEnv();
    this.apiKey = opts?.apiKey ?? env?.apiKey ?? "";
    this.baseUrl = (opts?.baseUrl ?? env?.baseUrl ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
    this.model = opts?.model ?? env?.model ?? "llama-3.3-70b-versatile";
    this.timeoutMs = opts?.timeoutMs ?? 60_000;
    if (!this.apiKey) throw new Error("GroqClient: no GROQ_API_KEY available (checked apps/api/.env).");
  }

  static isAvailable(): boolean {
    return readGroqEnv() !== null;
  }

  /** Retry the request on rate-limit (429), honouring Groq's retry-after. */
  async streamChat(req: ChatRequest, onToken?: (token: string, index: number) => void): Promise<StreamResult> {
    const maxAttempts = 6;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.streamOnce(req, onToken);
      } catch (err) {
        const retryMs = err instanceof RateLimitError ? err.retryMs : null;
        if (retryMs !== null && attempt < maxAttempts && !req.signal?.aborted) {
          await sleep(retryMs);
          continue;
        }
        throw err;
      }
    }
  }

  private async streamOnce(req: ChatRequest, onToken?: (token: string, index: number) => void): Promise<StreamResult> {
    const controller = new AbortController();
    let externallyAborted = false;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (req.signal) {
      const onAbort = () => {
        externallyAborted = true;
        controller.abort();
      };
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }
    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });

    const tokens: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let index = 0;

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: req.model ?? this.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: req.temperature ?? 0.7,
        }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        const detail = await safeText(res);
        clearTimeout(timer);
        throw new RateLimitError(parseRetryMs(res, detail), `Groq HTTP 429: ${detail.slice(0, 160)}`);
      }
      if (!res.ok || !res.body) {
        const detail = await safeText(res);
        throw new Error(`Groq HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!externallyAborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(line.indexOf(":") + 1).trim();
          if (data === "[DONE]") continue;
          let chunk: GroqChunk;
          try {
            chunk = JSON.parse(data) as GroqChunk;
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            tokens.push(delta);
            onToken?.(delta, index);
            index += 1;
          }
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
            outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          }
          if (externallyAborted) break;
        }
      }
    } catch (err) {
      // An external abort (Stage 6 stopping generation) is graceful: keep the
      // partial text. Anything else (timeout, network) propagates.
      if (!externallyAborted) throw err;
    } finally {
      clearTimeout(timer);
    }

    const text = tokens.join("");
    if (!inputTokens) inputTokens = approxTokens((req.system ?? "") + req.prompt);
    if (!outputTokens) outputTokens = approxTokens(text);
    return { text, tokens, inputTokens, outputTokens };
  }

  async jsonChat<T = unknown>(req: ChatRequest): Promise<JsonResult<T>> {
    const out = await this.streamChat({ ...req, temperature: req.temperature ?? 0 });
    return {
      raw: out.text,
      json: extractJson<T>(out.text),
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
    };
  }
}

interface GroqChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ─── Scripted (tests / offline replay) ───────────────────────────────────────

export type ScriptedResponder = (req: ChatRequest) => string;

/**
 * Deterministic client. Each call pops the next script entry (a fixed string or
 * a function of the request) and streams it token-by-token so Stage 2 sees a
 * real token sequence — just without the network.
 */
export class ScriptedClient implements LLMClient {
  readonly model = "scripted-llm";
  readonly live = false;
  private queue: ScriptedResponder[];
  private fallback: ScriptedResponder | null;

  constructor(scripts: Array<string | ScriptedResponder>, fallback?: string | ScriptedResponder) {
    this.queue = scripts.map(toResponder);
    this.fallback = fallback === undefined ? null : toResponder(fallback);
  }

  private next(req: ChatRequest): string {
    const r = this.queue.shift();
    if (r) return r(req);
    if (this.fallback) return this.fallback(req);
    throw new Error("ScriptedClient: ran out of scripted responses");
  }

  async streamChat(req: ChatRequest, onToken?: (token: string, index: number) => void): Promise<StreamResult> {
    const full = this.next(req);
    const allTokens = tokenize(full);
    const emitted: string[] = [];
    for (let i = 0; i < allTokens.length; i++) {
      if (req.signal?.aborted) break; // Stage 6 stopped generation mid-stream.
      const t = allTokens[i]!;
      emitted.push(t);
      onToken?.(t, i);
    }
    const text = emitted.join("");
    return {
      text,
      tokens: emitted,
      inputTokens: approxTokens((req.system ?? "") + req.prompt),
      outputTokens: approxTokens(text),
    };
  }

  async jsonChat<T = unknown>(req: ChatRequest): Promise<JsonResult<T>> {
    const out = await this.streamChat(req);
    return { raw: out.text, json: extractJson<T>(out.text), inputTokens: out.inputTokens, outputTokens: out.outputTokens };
  }
}

function toResponder(s: string | ScriptedResponder): ScriptedResponder {
  return typeof s === "function" ? s : () => s;
}

/** Split into word-ish tokens, preserving whitespace, to mimic streaming. */
export function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [text];
}
