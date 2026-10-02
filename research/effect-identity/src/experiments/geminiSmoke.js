#!/usr/bin/env node
/**
 * Smoke test for the Experiment 2 generator: exactly three calls, raw responses
 * printed. Generates no corpus data and writes nothing.
 *
 *   node src/experiments/geminiSmoke.js [--model gemini-3.8-flash]
 */
import { GeminiClient, GEMINI_BASE } from "../gemini.js";

const i = process.argv.indexOf("--model");
const model = i >= 0 ? process.argv[i + 1] : "gemini-3.8-flash";
const client = new GeminiClient({ model });

// Call 1: the model's metadata, to record the exact id and version.
const meta = await fetch(`${GEMINI_BASE}/models/${model}`, {
  headers: { "x-goog-api-key": client.apiKey },
  signal: AbortSignal.timeout(30_000),
});
console.log(`=== call 1: GET models/${model} — HTTP ${meta.status} — ${new Date().toISOString()}`);
console.log(await meta.text());

// Calls 2 and 3: trivial, content-free prompts (no corpus material).
const prompts = [
  { prompt: "Reply with the single word: ok" },
  { system: "You output JSON only.", prompt: 'Return exactly this JSON object: {"status":"ok","n":3}' },
];
for (const [k, p] of prompts.entries()) {
  const out = await client.generate({ ...p, temperature: 0, maxOutputTokens: 256 });
  console.log(`\n=== call ${k + 2}: generateContent — HTTP ${out.status} — ${new Date().toISOString()}`);
  console.log(out.raw);
}
