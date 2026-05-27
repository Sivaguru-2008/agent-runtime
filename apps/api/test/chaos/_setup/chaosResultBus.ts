/**
 * chaosResultBus — process-shared sink that each phase test writes to.
 *
 * Phase 6 reads the JSON file at the end of a run and produces the
 * certification report. Using a file (not just in-memory) lets the report
 * survive a vitest fork crash mid-suite — partial coverage is still useful
 * data when something goes wrong.
 *
 * Schema (chaos-results.json):
 *   {
 *     "startedAt": "...",
 *     "phases": {
 *       "phase1.redis.latencyRecovery": { ok: true, metrics: {...}, ... },
 *       ...
 *     }
 *   }
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// _setup → chaos → test → api
const API_ROOT = resolve(HERE, "..", "..", "..");
const RESULTS_PATH = resolve(API_ROOT, "chaos-results.json");

export interface PhaseResult {
  ok: boolean;
  metrics: Record<string, number | string | boolean | null>;
  thresholds: Record<string, { observed: number | string; required: string; pass: boolean }>;
  notes?: string;
  durationMs: number;
}

interface ResultsFile {
  startedAt: string;
  updatedAt: string;
  phases: Record<string, PhaseResult>;
}

async function readResults(): Promise<ResultsFile> {
  try {
    const raw = await readFile(RESULTS_PATH, "utf8");
    return JSON.parse(raw) as ResultsFile;
  } catch {
    return { startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phases: {} };
  }
}

export async function recordPhase(key: string, result: PhaseResult): Promise<void> {
  await mkdir(dirname(RESULTS_PATH), { recursive: true });
  const current = await readResults();
  current.phases[key] = result;
  current.updatedAt = new Date().toISOString();
  await writeFile(RESULTS_PATH, JSON.stringify(current, null, 2), "utf8");
}

export async function loadResults(): Promise<ResultsFile> {
  return readResults();
}

export function resultsPath(): string {
  return RESULTS_PATH;
}

/**
 * Compute a single pass/fail across an arbitrary set of named threshold
 * checks. A check passes iff `predicate(observed)` is true.
 */
export function evaluateThresholds<T extends number | string>(
  checks: Record<string, { observed: T; required: string; predicate: (v: T) => boolean }>
): { ok: boolean; thresholds: PhaseResult["thresholds"] } {
  const thresholds: PhaseResult["thresholds"] = {};
  let ok = true;
  for (const [name, c] of Object.entries(checks)) {
    const pass = c.predicate(c.observed);
    thresholds[name] = { observed: c.observed, required: c.required, pass };
    if (!pass) ok = false;
  }
  return { ok, thresholds };
}
