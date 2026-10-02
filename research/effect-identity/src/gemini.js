import { loadEnv } from "./groq.js";

/**
 * Minimal non-streaming Gemini client (generativelanguage v1beta
 * generateContent). Zero dependencies. Reads GEMINI_API_KEY from the repo root
 * .env or apps/api/.env through the same loader as the Groq client. The key
 * travels in the x-goog-api-key header, never in the URL.
 *
 * Experiment 2's generator (PREREG_EXP2.md, Amendment 3). No retries beyond a
 * bounded backoff on 429/5xx, and no fallback model: a failed call fails.
 */

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GeminiClient {
  constructor(opts = {}) {
    loadEnv();
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    if (!this.apiKey) throw new Error("GeminiClient: no GEMINI_API_KEY available (checked .env and apps/api/.env).");
    if (!this.model) throw new Error("GeminiClient: a model id is required; there is no default.");
  }

  /** One generateContent call. Returns the parsed text, the raw body, and the HTTP status. */
  async generate({ system, prompt, temperature = 0, maxOutputTokens = 2048, responseMimeType }) {
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens, ...(responseMimeType ? { responseMimeType } : {}) },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const maxAttempts = 5;
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${GEMINI_BASE}/models/${this.model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const raw = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        await sleep(Math.min(60_000, 2000 * 2 ** (attempt - 1)));
        continue;
      }
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${raw.slice(0, 400)}`);
      const parsed = JSON.parse(raw);
      const text = (parsed.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      return { text, raw, status: res.status, usage: parsed.usageMetadata ?? {}, modelVersion: parsed.modelVersion };
    }
  }
}
