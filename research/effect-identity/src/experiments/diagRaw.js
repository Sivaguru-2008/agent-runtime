import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, JUDGE_MODELS } from "../groq.js";
import { JUDGE_SYSTEM } from "../judge.js";

/**
 * ONE raw request per (model, batch size), no retry loop, no abort timer.
 *
 * The client retries transient statuses and honours the server's stated wait,
 * which is right for a scoring pass and useless for diagnosis: a rate-limited
 * batch becomes silence rather than a status code. This prints the status, the
 * rate-limit headers and the body verbatim.
 *
 *   node src/experiments/diagRaw.js [model] [sizes]
 */
loadEnv();
const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..", "..");
const [, , model = "llama-3.3-70b-versatile", sizesArg = "1,3,5,10"] = process.argv;
const sizes = sizesArg.split(",").map(Number);

const pairs = readFileSync(resolve(base, "corpus", "pairs.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

const buildPrompt = (batch) => {
  const lines = ["Judge the following tool-call pairs.\n"];
  batch.forEach((p, i) => {
    lines.push(`### Pair ${i}`);
    lines.push(`tool: ${p.tool}`);
    lines.push(`A: ${JSON.stringify(p.a)}`);
    lines.push(`B: ${JSON.stringify(p.b)}`);
    lines.push("");
  });
  lines.push(`Return the JSON array now (${batch.length} entries, field "p_same_pct", integer 0-100).`);
  return lines.join("\n");
};

for (const size of sizes) {
  const batch = pairs.slice(0, size);
  const spec = JUDGE_MODELS[model] ?? { reasoningFactor: 1, maxCompletionTokens: 32000 };
  const budget = Math.min(spec.maxCompletionTokens, Math.ceil((40 * size + 200) * spec.reasoningFactor));
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: buildPrompt(batch) }],
        temperature: 0,
        max_tokens: budget,
        stream: false,
      }),
    });
    const body = await res.text();
    const h = res.headers;
    console.log(
      `size=${String(size).padStart(2)} reserve=${String(budget).padStart(5)} -> ${res.status} in ${Date.now() - t0}ms  ` +
      `remTok=${h.get("x-ratelimit-remaining-tokens")} resetTok=${h.get("x-ratelimit-reset-tokens")} ` +
      `remReq=${h.get("x-ratelimit-remaining-requests")}`
    );
    if (res.status !== 200) console.log(`   body: ${body.slice(0, 300)}`);
  } catch (err) {
    console.log(`size=${size} -> THREW after ${Date.now() - t0}ms: ${String(err?.message ?? err).slice(0, 300)}`);
  }
}
process.exit(0);
