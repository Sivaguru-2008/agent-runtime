import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..");

const pairs = readFileSync(resolve(base, "corpus", "authz-pairs.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);

const p120 = JSON.parse(readFileSync(resolve(base, "results", "partial-authz-pairs-openai_gpt_oss_120b.json"), "utf8")).scores;
const p20 = JSON.parse(readFileSync(resolve(base, "results", "partial-authz-pairs-openai_gpt_oss_20b.json"), "utf8")).scores;
const pqwen = JSON.parse(readFileSync(resolve(base, "results", "partial-authz-pairs-qwen_qwen3_8_27b.json"), "utf8")).scores;

const lines = pairs.map((p) => {
  const row = {
    id: p.id,
    judges: {
      openai_gpt_oss_120b: p120[p.id] ?? null,
      openai_gpt_oss_20b: p20[p.id] ?? null,
      qwen_qwen3_8_27b: pqwen[p.id] ?? null,
      qwen_qwen3_6_27b: pqwen[p.id] ?? null, // alias for backwards compatibility
    },
  };
  return JSON.stringify(row);
});

writeFileSync(resolve(base, "corpus", "authz-scores.jsonl"), lines.join("\n") + "\n");
console.log(`Merged ${lines.length} rows into corpus/authz-scores.jsonl`);
