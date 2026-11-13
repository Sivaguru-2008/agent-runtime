/**
 * Tiny zero-dependency .env loader. We pull the Groq key from the existing
 * apps/api/.env (the only place a real key lives in this repo) without adding a
 * dotenv dependency or mutating that file.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// agent-runtime/src/llm -> repo root is three levels up.
const repoRoot = resolve(here, "..", "..", "..");

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
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

/**
 * Populate process.env (without overwriting anything already set) from the
 * repo's known .env files. Idempotent.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const candidates = [resolve(repoRoot, "apps", "api", ".env"), resolve(repoRoot, ".env")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}

export interface GroqEnv {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function readGroqEnv(): GroqEnv | null {
  loadEnv();
  const apiKey = process.env.GROQ_API_KEY ?? "";
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, ""),
    model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
  };
}
