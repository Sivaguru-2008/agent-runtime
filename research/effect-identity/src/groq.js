import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal non-streaming Groq client (OpenAI-compatible /chat/completions).
 * Zero dependencies. Reads GROQ_API_KEY from apps/api/.env or the repo root
 * .env, same convention as agent-runtime. Retries on 429/5xx with backoff.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let loaded = false;
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  for (const file of [resolve(repoRoot, "apps", "api", ".env"), resolve(repoRoot, ".env")]) {
    if (!existsSync(file)) continue;
    try {
      for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
    } catch {
      /* unreadable env file — skip */
    }
  }
}

export function groqAvailable() {
  loadEnv();
  return Boolean(process.env.GROQ_API_KEY);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseRetryMs(res, body) {
  const header = res.headers.get("retry-after");
  if (header) {
    const secs = parseFloat(header);
    if (Number.isFinite(secs)) return clampWait(secs * 1000);
  }
  // Groq states the wait in the body, and states it in several shapes:
  // "try again in 412ms", "try again in 7.66s", "try again in 4m18.5s".
  // The minutes form matters most — it is what a drained per-day allowance
  // returns — and reading only its leading number waits 4 seconds for a
  // 4-minute quota, retries into the same wall, and exhausts the attempts.
  // `(\d+)m` must not swallow the "m" of "ms": without the negative lookahead
  // "try again in 412ms" parses as 412 MINUTES, and every rate-limit reply
  // sleeps the 15-minute ceiling instead of 0.4 seconds. That converts a
  // healthy quota into an apparent outage — the scoring pass stalls after a
  // handful of batches while the API is answering normally.
  const m = body.match(/try again in\s+(?:(\d+)m(?!s))?\s*([\d.]+)?\s*(ms|s)?/i);
  if (m && (m[1] || m[2])) {
    const minutes = m[1] ? parseFloat(m[1]) * 60_000 : 0;
    const rest = m[2] ? parseFloat(m[2]) : 0;
    const restMs = m[3]?.toLowerCase() === "ms" ? rest : rest * 1000;
    const ms = minutes + restMs;
    if (Number.isFinite(ms) && ms > 0) return clampWait(ms);
  }
  return 5000;
}

/**
 * Honour the server's stated wait, up to a generous ceiling.
 *
 * Free-tier quotas are per-DAY as well as per-minute, so a saturated key
 * legitimately answers "try again in 4m18s". Clamping that to 60s does not
 * make the quota refill faster — it just burns the retry budget on requests
 * that cannot succeed and then drops the batch. Waiting as asked is what lets
 * a long scoring pass finish rather than fail.
 */
const clampWait = (ms) => Math.max(500, Math.min(15 * 60_000, Math.ceil(ms) + 250));

/**
 * Is this status a *transient capacity* refusal rather than a permanent one?
 *
 * 413 belongs here and its absence cost a whole experiment. Groq answers a
 * request that would breach the per-minute or per-day token allowance with
 * **413 Request too large**, not 429 — the body literally reads "Limit 8000,
 * Requested 24718 ... try again in ...". Treating 413 as permanent meant the
 * client threw on the first quota breach with no backoff, so the two judges
 * scheduled after a long run (which had drained the allowance) failed all 288
 * of their attempts in 2 seconds and recorded 955 abstentions each. The scoring
 * pass then reported "3 judges" while holding usable scores for exactly one.
 * A capacity refusal must be waited out, not surfaced as an answer of "none".
 */
const isTransientStatus = (status) => status === 429 || status === 413 || status === 408 || status >= 500;

/**
 * Strip reasoning-model scratchpad blocks. Qwen-family models emit
 * `<think>…</think>` before the answer, and that scratchpad routinely quotes
 * JSON while deliberating — so extracting "the first balanced JSON" from the
 * raw text can silently return the model's musing rather than its answer.
 * Removing the block first is what keeps the extractor honest.
 */
export function stripReasoning(raw) {
  return String(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "") // unterminated block (hit the token cap)
    .trim();
}

/** Pull the first balanced JSON object/array out of a model response. */
export function extractJson(raw) {
  let text = stripReasoning(raw);
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) text = fence[1].trim();
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error(`No JSON found in model output: ${text.slice(0, 120)}`);
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
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
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`Unbalanced JSON in model output: ${text.slice(0, 120)}`);
}

/**
 * Judge models used in the evaluation, spanning three independent model
 * families so that no single vendor's idiosyncrasies drive the headline.
 *
 * `reasoningFactor` scales the token budget: reasoning models spend most of
 * their completion budget on a scratchpad before emitting the answer, so a
 * budget sized for the answer alone truncates them to an empty response.
 *
 * `maxCompletionTokens` caps the result of that scaling. Two separate limits
 * make an unbounded scale-up fail rather than merely cost money: a per-model
 * ceiling on `max_tokens` (a 400), and a tokens-per-minute quota that counts
 * the tokens a request *reserves*, not the tokens it uses (a 413). A reasoning
 * factor applied to a generous budget silently multiplies past both, which is
 * how the multi-arm corpus generation came to produce zero pairs for two of
 * three model families while reporting success.
 */
export const JUDGE_MODELS = {
  // Ceilings measured against this key's on-demand tier (§Appendix A), not
  // guessed: llama accepts ≥12k, gpt-oss and qwen 413 above ~8k including the
  // prompt. Values sit below the observed cliff with room for the prompt.
  "llama-3.3-70b-versatile": { family: "llama", reasoningFactor: 1, maxCompletionTokens: 8000 },
  "openai/gpt-oss-120b": { family: "gpt-oss", reasoningFactor: 4, maxCompletionTokens: 5000 },
  "qwen/qwen3.6-27b": { family: "qwen", reasoningFactor: 8, maxCompletionTokens: 6000 },
  // Smaller siblings, carried for a reason that is about quota rather than
  // science and is disclosed as such in §6.2: tokens-per-day is enforced PER
  // MODEL, so a scoring pass that exhausts the 120B's allowance can still be
  // completed against the 20B. They also make the judge comparison span model
  // SIZE within a family, not only family — which turns out to matter (§7.8).
  "openai/gpt-oss-20b": { family: "gpt-oss", reasoningFactor: 4, maxCompletionTokens: 5000 },
  "llama-3.1-8b-instant": { family: "llama", reasoningFactor: 1, maxCompletionTokens: 6000 },
};

export const DEFAULT_JUDGE = "llama-3.3-70b-versatile";

export class GroqClient {
  constructor(opts = {}) {
    loadEnv();
    this.apiKey = opts.apiKey ?? process.env.GROQ_API_KEY ?? "";
    this.baseUrl = (opts.baseUrl ?? process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
    this.model = opts.model ?? process.env.GROQ_MODEL ?? DEFAULT_JUDGE;
    this.reasoningFactor = JUDGE_MODELS[this.model]?.reasoningFactor ?? 1;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.stats = { calls: 0, inputTokens: 0, outputTokens: 0, totalLatencyMs: 0 };
    if (!this.apiKey) throw new Error("GroqClient: no GROQ_API_KEY available (checked apps/api/.env and .env).");
  }

  async chat({ system, prompt, temperature = 0, maxTokens = 2048, model }) {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });
    // Reasoning models burn completion tokens on a scratchpad before the
    // answer; budget for both or the answer is truncated away entirely.
    const spec = JUDGE_MODELS[model ?? this.model];
    const factor = model ? (spec?.reasoningFactor ?? 1) : this.reasoningFactor;
    const budget = Math.min(spec?.maxCompletionTokens ?? 32_000, Math.ceil(maxTokens * factor));
    const maxAttempts = 8;
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const started = Date.now();
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model ?? this.model,
            messages,
            temperature,
            max_tokens: budget,
            stream: false,
          }),
          signal: controller.signal,
        });
        const bodyText = await res.text();
        if (isTransientStatus(res.status)) {
          if (attempt >= maxAttempts) throw new Error(`Groq HTTP ${res.status} after ${attempt} attempts: ${bodyText.slice(0, 160)}`);
          // 429 and 413 both state their own wait in the body/headers; honour it.
          const rateLimited = res.status === 429 || res.status === 413;
          await sleep(rateLimited ? parseRetryMs(res, bodyText) : clampWait(1000 * attempt));
          continue;
        }
        if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
        const parsed = JSON.parse(bodyText);
        const text = parsed.choices?.[0]?.message?.content ?? "";
        const usage = parsed.usage ?? {};
        this.stats.calls += 1;
        this.stats.inputTokens += usage.prompt_tokens ?? 0;
        this.stats.outputTokens += usage.completion_tokens ?? 0;
        this.stats.totalLatencyMs += Date.now() - started;
        return { text, inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 };
      } catch (err) {
        if (err?.name === "AbortError") {
          if (attempt >= maxAttempts) throw new Error(`Groq timeout after ${attempt} attempts`);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async jsonChat(req) {
    const out = await this.chat(req);
    return { ...out, json: extractJson(out.text) };
  }
}
