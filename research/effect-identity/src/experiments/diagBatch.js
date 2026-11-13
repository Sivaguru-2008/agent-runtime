import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GroqClient } from "../groq.js";
import { JUDGE_SYSTEM } from "../judge.js";

/**
 * Score one slice of the shuffled corpus with one judge, surfacing the raw
 * transport outcome instead of folding it into an abstention count.
 *
 *   node src/experiments/diagBatch.js <model> <from> <to> [timeoutMs]
 *
 * judgeScores() deliberately swallows transport errors so a scoring pass can
 * survive them; that makes a stalled pass indistinguishable from a slow one.
 * This reproduces a single batch with the error visible.
 */
const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..", "..");
const [, , model = "llama-3.3-70b-versatile", fromArg = "60", toArg = "70", timeoutArg = "25000"] = process.argv;

const pairs = readFileSync(resolve(base, "corpus", "pairs.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Same seeded shuffle as score.js, so slice indices refer to the same pairs.
let seed = 7;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const order = pairs.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
const shuffled = order.map((i) => pairs[i]);
const batch = shuffled.slice(Number(fromArg), Number(toArg));

const lines = ["Judge the following tool-call pairs.\n"];
batch.forEach((p, i) => {
  lines.push(`### Pair ${i}`);
  lines.push(`tool: ${p.tool}`);
  lines.push(`A: ${JSON.stringify(p.a)}`);
  lines.push(`B: ${JSON.stringify(p.b)}`);
  lines.push("");
});
lines.push(`Return the JSON array now (${batch.length} entries, field "p_same_pct", integer 0-100).`);
const prompt = lines.join("\n");

console.log(`model=${model} slice=[${fromArg},${toArg}) pairs=${batch.length}`);
console.log(`ids: ${batch.map((p) => p.id).join(",")}`);
console.log(`prompt chars=${prompt.length} (~${Math.round(prompt.length / 4)} tokens)`);

const client = new GroqClient({ model, timeoutMs: Number(timeoutArg) });
const t0 = Date.now();
try {
  const r = await client.chat({ system: JUDGE_SYSTEM, prompt, temperature: 0, maxTokens: 40 * batch.length + 200 });
  console.log(`OK in ${Date.now() - t0}ms  in=${r.inputTokens} out=${r.outputTokens}`);
  console.log(r.text.slice(0, 300));
} catch (err) {
  console.log(`FAIL after ${Date.now() - t0}ms: ${String(err?.message ?? err).slice(0, 400)}`);
}
process.exit(0);
