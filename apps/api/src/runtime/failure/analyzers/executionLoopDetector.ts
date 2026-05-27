import type { FailureAnalyzer } from "../analyzer.js";
import type { AnalyzerContext, FailureSignal } from "../../../domain/failure.js";
import type { DomainEvent } from "../../../domain/events.js";
import type { CognitionGraph } from "../../../domain/cognition.js";
import { deterministicId } from "../../../shared/determinism.js";

/**
 * Execution Loop Detector — Phase 3 new analyzer.
 *
 * WHAT IT DETECTS:
 *   Execution-level spinning: when the outer execution engine is consuming
 *   resources (retries, tokens) without making forward progress. This is
 *   distinct from the RecursionDetector's cognition-level cycle detection:
 *   an execution loop is about the *execution wrapper* — retries, step
 *   repetitions, and identical error conditions — not the cognition graph
 *   topology. It catches: agents retrying with identical errors, model calls
 *   producing identical outputs, and tool call sequences that don't advance
 *   the execution state.
 *
 * OPERATIONAL USEFULNESS:
 *   Execution loops waste tokens and money at the infrastructure level. Early
 *   detection lets operators abort the execution before token limits are hit,
 *   inspect what the agent keeps trying, and branch replay with a different
 *   strategy (different model, different tool permission, injected hint memory).
 *
 * REPLAY/DEBUGGING VALUE:
 *   - `evidence` surfaces the event sequences of the repeated events so
 *     operators can scrub the replay timeline to each retry
 *   - `metric.wasted_tokens_estimate` gives a cost proxy so triage can
 *     prioritize high-spend loops over low-spend ones
 *
 * FALSE-POSITIVE RISKS:
 *   - Legitimate polling tools (health-check, status-wait) intentionally call
 *     the same tool with the same args repeatedly; consider filtering by tool
 *     name in the allowlist
 *   - A task that genuinely requires many similar steps (e.g., processing a
 *     list of items one at a time) may trigger the step-similarity heuristic
 *
 * DETECTION STRATEGIES:
 *   1. Identical retry error: RETRY_TRIGGERED events with matching error strings
 *   2. Model output stagnation: MODEL_COMPLETED events with identical output fingerprints
 *   3. Step count ceiling: execution step count exceeds threshold with no completion
 *   4. Tool thrash: same tool + args called many times in sequence
 */
export class ExecutionLoopDetector implements FailureAnalyzer {
  readonly name = "execution-loop-detector";

  private static readonly RETRY_ERROR_THRESHOLD = 3;
  private static readonly MODEL_STAGNATION_THRESHOLD = 3;
  private static readonly TOOL_THRASH_THRESHOLD = 4;
  private static readonly STEP_CEILING = 20;

  analyze(events: DomainEvent[], _graph: CognitionGraph | undefined, ctx: AnalyzerContext): FailureSignal[] {
    const signals: FailureSignal[] = [];

    const retryEvents = events.filter((e) => e.type === "RETRY_TRIGGERED");
    const modelEvents = events.filter((e) => e.type === "MODEL_COMPLETED");
    const toolEvents = events.filter((e) => e.type === "TOOL_CALLED");
    const stepEvents = events.filter(
      (e) => e.type === "EXECUTION_STEP_STARTED" || e.type === "EXECUTION_STEP_COMPLETED"
    );

    // ── Strategy 1: Identical retry error ────────────────────────────────────
    // If the same error message (or same error type) is repeated across retries,
    // the agent is not learning from its failures — it's retrying blindly.
    const retryErrorCounts = new Map<string, number[]>();
    for (const e of retryEvents) {
      const payload = e.payload as { error?: string; reason?: string; errorType?: string };
      const errorKey = normalizeError(payload.error ?? payload.reason ?? "unknown");
      const seqs = retryErrorCounts.get(errorKey) ?? [];
      seqs.push(e.sequence ?? 0);
      retryErrorCounts.set(errorKey, seqs);
    }
    for (const [errorKey, seqs] of retryErrorCounts) {
      if (seqs.length >= ExecutionLoopDetector.RETRY_ERROR_THRESHOLD) {
        const estimatedWastedTokens = seqs.length * 500;  // rough per-retry estimate
        signals.push({
          id: deterministicId([ctx.executionId, errorKey, "retry-loop"]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          kind: "EXECUTION_LOOP",
          severity: seqs.length >= 5 ? "CRITICAL" : "HIGH",
          score: Math.min(1, 0.5 + seqs.length * 0.1),
          summary: `Execution retried ${seqs.length}× with identical error: "${errorKey.slice(0, 80)}"`,
          evidence: [
            ...seqs.map((seq) => ({ eventSequence: seq })),
            { eventSequence: -1, metric: { retryCount: seqs.length, estimatedWastedTokens } }
          ],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    // ── Strategy 2: Model output stagnation ──────────────────────────────────
    // If the model keeps producing the same output fingerprint across calls,
    // it's stuck on the same response — likely the prompt is broken or the
    // context isn't updating between retries.
    const modelOutputMap = new Map<string, number[]>();
    for (const e of modelEvents) {
      const payload = e.payload as { output?: Record<string, unknown>; tokenUsage?: { total?: number } };
      if (!payload.output) continue;
      const fp = roughFingerprint(payload.output);
      const seqs = modelOutputMap.get(fp) ?? [];
      seqs.push(e.sequence ?? 0);
      modelOutputMap.set(fp, seqs);
    }
    for (const [, seqs] of modelOutputMap) {
      if (seqs.length >= ExecutionLoopDetector.MODEL_STAGNATION_THRESHOLD) {
        signals.push({
          id: deterministicId([ctx.executionId, seqs[0].toString(), "model-stagnation"]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          kind: "EXECUTION_LOOP",
          severity: "HIGH",
          score: 0.78,
          summary: `Model produced identical output ${seqs.length}× — context not updating between calls`,
          evidence: [
            ...seqs.map((seq) => ({ eventSequence: seq })),
            { metric: { identicalOutputCount: seqs.length } }
          ],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    // ── Strategy 3: Tool thrash ───────────────────────────────────────────────
    // A tool called with identical args N+ times in sequence (not just total)
    // indicates the agent is not using the tool's output to make progress.
    // We look for *consecutive* identical calls, not just total counts.
    if (toolEvents.length >= ExecutionLoopDetector.TOOL_THRASH_THRESHOLD) {
      const thrashGroups = findConsecutiveRepeats(toolEvents, ExecutionLoopDetector.TOOL_THRASH_THRESHOLD);
      for (const group of thrashGroups) {
        signals.push({
          id: deterministicId([ctx.executionId, group.key, "tool-thrash"]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          kind: "EXECUTION_LOOP",
          severity: "MEDIUM",
          score: 0.68,
          summary: `Tool "${group.toolName}" called ${group.count}× consecutively with identical args — output not used`,
          evidence: [
            ...group.sequences.map((seq) => ({ eventSequence: seq })),
            { metric: { consecutiveCallCount: group.count } }
          ],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    // ── Strategy 4: Step count ceiling ───────────────────────────────────────
    // Executions with many steps and no EXECUTION_COMPLETED event are likely
    // stuck. The ceiling is conservative: real tasks rarely need more than 20
    // distinct steps without reaching a terminal state.
    const hasCompleted = events.some(
      (e) => e.type === "EXECUTION_COMPLETED" || e.type === "COGNITION_COMPLETED"
    );
    if (!hasCompleted && stepEvents.length >= ExecutionLoopDetector.STEP_CEILING) {
      signals.push({
        id: deterministicId([ctx.executionId, stepEvents.length.toString(), "step-ceiling"]),
        cognitionId: ctx.cognitionId,
        executionId: ctx.executionId,
        kind: "EXECUTION_LOOP",
        severity: "MEDIUM",
        score: 0.55,
        summary: `Execution has ${stepEvents.length} steps with no completion — possible runaway loop`,
        evidence: [{ metric: { stepCount: stepEvents.length, stepCeiling: ExecutionLoopDetector.STEP_CEILING } }],
        detectedAt: ctx.detectedAt,
        detectedBy: this.name
      });
    }

    return signals;
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function normalizeError(error: string): string {
  // Strip dynamic parts (IDs, timestamps, counts) so two instances of the
  // same error class match each other.
  return error
    .replace(/[0-9a-f]{8,}/gi, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}T[^"]+/g, "<ts>")
    .replace(/\d+ms/g, "<ms>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function roughFingerprint(output: Record<string, unknown>): string {
  const keys = Object.keys(output).sort();
  return keys.map((k) => `${k}=${String(output[k]).slice(0, 48)}`).join("|").slice(0, 256);
}

interface ThrashGroup {
  toolName: string;
  key: string;
  count: number;
  sequences: number[];
}

function findConsecutiveRepeats(toolEvents: DomainEvent[], threshold: number): ThrashGroup[] {
  const groups: ThrashGroup[] = [];
  let runKey = "";
  let runCount = 0;
  let runTool = "";
  let runSequences: number[] = [];

  const flush = (): void => {
    if (runCount >= threshold) {
      groups.push({ toolName: runTool, key: runKey, count: runCount, sequences: runSequences });
    }
  };

  for (const e of toolEvents) {
    const p = e.payload as { toolCall?: { toolName?: string; input?: Record<string, unknown> } };
    if (!p.toolCall) continue;
    const toolName = p.toolCall.toolName ?? "unknown";
    const argsKey = `${toolName}:${JSON.stringify(p.toolCall.input ?? {})}`;
    if (argsKey === runKey) {
      runCount++;
      runSequences.push(e.sequence ?? 0);
    } else {
      flush();
      runKey = argsKey;
      runTool = toolName;
      runCount = 1;
      runSequences = [e.sequence ?? 0];
    }
  }
  flush();
  return groups;
}
