import type { FailureAnalyzer } from "../analyzer.js";
import type { AnalyzerContext, FailureEvidence, FailureSignal } from "../../../domain/failure.js";
import type { DomainEvent } from "../../../domain/events.js";
import type { CognitionGraph } from "../../../domain/cognition.js";
import { deterministicId } from "../../../shared/determinism.js";

/**
 * Contradiction Detector — Phase 3 production implementation.
 *
 * WHAT IT DETECTS:
 *   Cases where sequential execution steps assert opposing facts: a key that
 *   flips between PASS/FAIL, a VERIFIER that explicitly rejects what the EXECUTOR
 *   produced, a PLANNER plan that the EXECUTOR silently ignored, or a CRITIC that
 *   flags as unresolved something the EXECUTOR declared fixed.
 *
 * OPERATIONAL USEFULNESS:
 *   Contradictions indicate the agent is arguing with itself — retrying without
 *   understanding why the previous attempt failed. Operators can branch at the
 *   first contradiction frame and inject corrected input (e.g., a more specific
 *   goal or a memory record that resolves the conflict) to short-circuit the loop.
 *
 * REPLAY/DEBUGGING VALUE:
 *   - Each signal includes both `nodeId` (the contradicting node) and the prior
 *     node ID in evidence so operators can scrub to exactly the conflict frame
 *   - Field name and value pair is surfaced so the UI can highlight the flip
 *
 * FALSE-POSITIVE RISKS:
 *   - Legitimate plan revision: PLANNER refining its output intentionally
 *   - Numeric rating that naturally decreases (progress percentage, retry count)
 *     — filtered by only checking *boolean-like* and *categorical* values
 *   - Multi-agent systems where two agents intentionally hold different views;
 *     this detector only looks within a single cognition graph
 *
 * DETECTION STRATEGIES:
 *   1. Verdict-key flip: structured output key with boolean/categorical value reversal
 *   2. VERIFIER rejection chain: VERIFIER node failed immediately after EXECUTOR
 *   3. Plan divergence: EXECUTOR output missing keys that PLANNER explicitly listed
 *   4. CRITIC-EXECUTOR conflict: CRITIC flags issue that EXECUTOR claimed resolved
 */
export class ContradictionDetector implements FailureAnalyzer {
  readonly name = "contradiction-detector";

  private static readonly VERDICT_KEYS = new Set([
    "verdict", "passed", "valid", "rating", "approved", "success",
    "accepted", "confirmed", "verified", "resolved", "fixed", "done",
    "complete", "satisfied", "status", "result", "outcome"
  ]);

  analyze(_events: DomainEvent[], graph: CognitionGraph | undefined, ctx: AnalyzerContext): FailureSignal[] {
    if (!graph) return [];

    const signals: FailureSignal[] = [];
    const sorted = [...graph.nodes].sort((a, b) => a.sequence - b.sequence);
    const completed = sorted.filter((n) => n.status === "COMPLETED");

    // ── Strategy 1: Verdict-key flip ─────────────────────────────────────────
    // Track the last seen value for each verdict-like key across all completed
    // nodes. When a key's value changes in a semantically opposing direction,
    // flag it. We only flag *reversals* not simply changes (e.g., a boolean
    // true → false or a categorical PASS → FAIL, not a counter 1 → 2).
    const seenVerdicts = new Map<string, { value: string | boolean | number; nodeId: string }>();
    for (const node of completed) {
      const output = (node.output ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(output)) {
        if (!ContradictionDetector.VERDICT_KEYS.has(key.toLowerCase())) continue;
        if (typeof value !== "boolean" && typeof value !== "string") continue;
        const prior = seenVerdicts.get(key);
        if (prior && isReversal(prior.value, value)) {
          signals.push({
            id: deterministicId([node.id, key, "verdict-flip", ctx.executionId]),
            cognitionId: ctx.cognitionId,
            executionId: ctx.executionId,
            nodeId: node.id,
            kind: "CONTRADICTION",
            severity: "MEDIUM",
            score: 0.72,
            summary: `Field "${key}" reversed: ${String(prior.value)} → ${String(value)} (node ${prior.nodeId.slice(0, 8)} → ${node.id.slice(0, 8)})`,
            evidence: [
              { nodeId: prior.nodeId, snippet: `${key} = ${String(prior.value)}` },
              { nodeId: node.id, snippet: `${key} = ${String(value)}` }
            ],
            detectedAt: ctx.detectedAt,
            detectedBy: this.name
          });
        }
        seenVerdicts.set(key, { value: value as string | boolean, nodeId: node.id });
      }
    }

    // ── Strategy 2: VERIFIER rejection chain ─────────────────────────────────
    // A failed VERIFIER immediately after a completed EXECUTOR is a structural
    // contradiction: the executor asserted its output was good; the verifier
    // disagreed. Score is higher because this is an explicit architectural
    // contradiction, not just a key-value flip.
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (
        prev.role === "EXECUTOR" &&
        prev.status === "COMPLETED" &&
        curr.role === "VERIFIER" &&
        curr.status === "FAILED"
      ) {
        // Check if the verifier's failure mentions the executor's output keys —
        // if so, we have strong evidence the contradiction is about real content.
        const executorKeys = Object.keys(prev.output ?? {}).join(",");
        const evidence: FailureEvidence[] = [
          { nodeId: prev.id, snippet: `EXECUTOR completed: keys=[${executorKeys.slice(0, 120)}]` },
          { nodeId: curr.id, snippet: "VERIFIER failed immediately after" }
        ];
        signals.push({
          id: deterministicId([prev.id, curr.id, "verifier-rejection", ctx.executionId]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          nodeId: curr.id,
          kind: "CONTRADICTION",
          severity: "HIGH",
          score: 0.82,
          summary: `VERIFIER (seq ${curr.sequence}) explicitly rejected EXECUTOR output (seq ${prev.sequence})`,
          evidence,
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    // ── Strategy 3: Plan-execution divergence ─────────────────────────────────
    // The PLANNER often specifies required_outputs, steps, or deliverables.
    // If the EXECUTOR completes without producing those keys, it's a structural
    // divergence between what was planned and what was executed.
    const planner = completed.find((n) => n.role === "PLANNER");
    const executor = completed.find((n) => n.role === "EXECUTOR");
    if (planner && executor) {
      const planOutput = (planner.output ?? {}) as Record<string, unknown>;
      const execOutput = (executor.output ?? {}) as Record<string, unknown>;
      const requiredKeys = extractRequiredKeys(planOutput);
      const missingKeys = requiredKeys.filter((k) => !(k in execOutput));
      if (missingKeys.length > 0) {
        signals.push({
          id: deterministicId([planner.id, executor.id, "plan-divergence", ctx.executionId]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          nodeId: executor.id,
          kind: "CONTRADICTION",
          severity: "MEDIUM",
          score: 0.61,
          summary: `Executor output missing ${missingKeys.length} planned keys: [${missingKeys.slice(0, 4).join(", ")}]`,
          evidence: [
            { nodeId: planner.id, snippet: `Planned keys: [${requiredKeys.join(", ")}]` },
            { nodeId: executor.id, snippet: `Produced keys: [${Object.keys(execOutput).join(", ")}]` }
          ],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    // ── Strategy 4: CRITIC-EXECUTOR conflict ──────────────────────────────────
    // If CRITIC identifies unresolved issues that share key names with fields
    // the EXECUTOR declared as resolved/complete, that is a direct contradiction.
    const critic = completed.find((n) => n.role === "CRITIC");
    if (critic && executor) {
      const criticOutput = (critic.output ?? {}) as Record<string, unknown>;
      const execOutput = (executor.output ?? {}) as Record<string, unknown>;
      const criticIssues = extractIssueKeys(criticOutput);
      const executorClaims = extractResolvedKeys(execOutput);
      const conflicts = criticIssues.filter((k) => executorClaims.includes(k));
      if (conflicts.length > 0) {
        signals.push({
          id: deterministicId([critic.id, executor.id, "critic-conflict", ctx.executionId]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          nodeId: critic.id,
          kind: "CONTRADICTION",
          severity: "HIGH",
          score: 0.78,
          summary: `CRITIC flagged ${conflicts.length} issue(s) that EXECUTOR claimed resolved: [${conflicts.slice(0, 3).join(", ")}]`,
          evidence: [
            { nodeId: executor.id, snippet: `Executor claimed: [${executorClaims.join(", ")}]` },
            { nodeId: critic.id, snippet: `Critic issues: [${criticIssues.join(", ")}]` }
          ],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    return signals;
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function isReversal(prior: string | boolean | number, current: string | boolean | number): boolean {
  if (typeof prior === "boolean" && typeof current === "boolean") return prior !== current;
  const p = String(prior).toLowerCase();
  const c = String(current).toLowerCase();
  const positives = new Set(["pass", "true", "yes", "valid", "approved", "success", "resolved", "fixed", "done", "complete"]);
  const negatives = new Set(["fail", "false", "no", "invalid", "rejected", "failure", "unresolved", "broken", "incomplete"]);
  return (positives.has(p) && negatives.has(c)) || (negatives.has(p) && positives.has(c));
}

function extractRequiredKeys(planOutput: Record<string, unknown>): string[] {
  // Look for arrays under keys like "steps", "required_outputs", "deliverables", "outputs"
  const candidateKeys = ["steps", "required_outputs", "deliverables", "outputs", "tasks", "requirements"];
  const found: string[] = [];
  for (const key of candidateKeys) {
    const val = planOutput[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") found.push(item);
        else if (typeof item === "object" && item !== null && "key" in item) found.push(String((item as { key: string }).key));
        else if (typeof item === "object" && item !== null && "name" in item) found.push(String((item as { name: string }).name));
      }
    }
  }
  return found;
}

function extractIssueKeys(criticOutput: Record<string, unknown>): string[] {
  const issueKeys = ["issues", "problems", "failures", "errors", "violations", "concerns"];
  const found: string[] = [];
  for (const key of issueKeys) {
    const val = criticOutput[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") found.push(item.toLowerCase().slice(0, 40));
      }
    } else if (typeof val === "string") {
      found.push(val.toLowerCase().slice(0, 40));
    }
  }
  return found;
}

function extractResolvedKeys(execOutput: Record<string, unknown>): string[] {
  const resolvedKeys = ["resolved", "fixed", "completed", "done", "addressed", "handled"];
  const found: string[] = [];
  for (const key of resolvedKeys) {
    const val = execOutput[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") found.push(item.toLowerCase().slice(0, 40));
      }
    } else if (typeof val === "string") {
      found.push(val.toLowerCase().slice(0, 40));
    }
  }
  return found;
}
