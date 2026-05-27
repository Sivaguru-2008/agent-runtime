import { createHash } from "node:crypto";
import type { FailureSignal, FailureSignalKind } from "./failure.js";
import type { AgentRole } from "./cognition.js";

/**
 * Deterministic failure signature derivation — used by FailureSignatureStore
 * and FailureLearning. Two signals describing the same failure pattern must
 * produce the same signatureId regardless of:
 *   - executionId / cognitionId / nodeId (instance-specific)
 *   - score (varies by run)
 *   - dynamic substrings in the summary (numbers, IDs, names)
 *   - severity (varies based on context)
 *
 * Signature inputs:
 *   1. kind (HALLUCINATION, CONTRADICTION, ...)
 *   2. detectedBy (analyzer name — disambiguates same-kind from different analyzers)
 *   3. normalized summary (tokens replaced with <var>)
 *   4. sorted list of metric keys present on evidence (the "shape" of evidence)
 *   5. role (when inferable from evidence) so EXECUTOR hallucinations cluster
 *      separately from PLANNER hallucinations
 */

const KNOWN_ROLES: AgentRole[] = [
  "PLANNER", "EXECUTOR", "VERIFIER", "CRITIC", "MEMORY_MANAGER"
];

export interface SignaturePayload {
  id: string;
  kind: FailureSignalKind;
  role?: AgentRole;
  summaryTemplate: string;
  metricKeys: string[];
}

export function deriveSignaturePayload(signal: FailureSignal): SignaturePayload {
  const summaryTemplate = normalizeSummary(signal.summary);
  const metricKeys = collectMetricKeys(signal);
  const role = inferRole(signal);

  // Hash the four signature dimensions into a stable id.
  const canonical = [
    signal.kind,
    signal.detectedBy,
    role ?? "ANY",
    summaryTemplate,
    metricKeys.join(",")
  ].join("|");
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);

  return {
    id: `sig:${signal.kind.toLowerCase()}:${hash}`,
    kind: signal.kind,
    role,
    summaryTemplate,
    metricKeys
  };
}

/**
 * Strip dynamic tokens from a summary so two instances of the same failure
 * collapse to one template.
 *
 * Replacements:
 *   - numbers (with optional units like ms, %, x) → <n>
 *   - 8+ hex / id-like tokens → <id>
 *   - quoted strings → <str>
 *   - ISO timestamps → <ts>
 *   - whitespace normalized
 */
export function normalizeSummary(summary: string): string {
  return summary
    .replace(/"[^"]{1,80}"/g, '<str>')
    .replace(/'[^']{1,80}'/g, '<str>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|%|x|×|MB|GB|KB)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function collectMetricKeys(signal: FailureSignal): string[] {
  const keys = new Set<string>();
  for (const ev of signal.evidence) {
    if (ev.metric) {
      for (const k of Object.keys(ev.metric)) keys.add(k);
    }
  }
  return Array.from(keys).sort();
}

function inferRole(signal: FailureSignal): AgentRole | undefined {
  // Roles appear in summaries: "PLANNER (seq 3) self-reported..." etc.
  for (const role of KNOWN_ROLES) {
    if (signal.summary.includes(role)) return role;
  }
  return undefined;
}
