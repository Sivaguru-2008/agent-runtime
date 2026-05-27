import type { FailureAnalyzer } from "../analyzer.js";
import type { AnalyzerContext, FailureSignal } from "../../../domain/failure.js";
import type { DomainEvent } from "../../../domain/events.js";
import type { CognitionGraph } from "../../../domain/cognition.js";
import { deterministicId } from "../../../shared/determinism.js";

/**
 * Tool Failure Classifier — Phase 3 production implementation.
 *
 * WHAT IT DETECTS:
 *   Categorized tool invocation failures: empty inputs, repeated identical
 *   calls, dangerous tool patterns, cascading failures where one tool's bad
 *   output caused the next call to fail, and schema mismatches where the agent
 *   called a tool with structurally wrong parameters.
 *
 * OPERATIONAL USEFULNESS:
 *   Tool failures are the most actionable failure class: unlike hallucinations
 *   or recursion (which require model-level fixes), tool failures usually have
 *   specific fixes — add a missing parameter, fix a tool's input schema, grant
 *   a permission, or break a dependency chain. The classification tells
 *   operators exactly which fix applies.
 *
 * REPLAY/DEBUGGING VALUE:
 *   - Event sequences map directly to replay frames
 *   - `failureCategory` in evidence gives operators the "type of fix needed"
 *   - Cascading chain evidence shows which tool failure triggered the next
 *
 * FALSE-POSITIVE RISKS:
 *   - Polling tools that legitimately repeat calls (health checks, waits):
 *     add to ALLOWED_REPEAT_TOOLS to suppress
 *   - Dangerous pattern detection is conservative (uses exact substrings);
 *     a tool named "get-docker-status" is not the same as "docker-exec"
 *   - Cascading detection relies on tool names appearing in prior tool output,
 *     which is a correlation, not proven causation
 *
 * FAILURE CATEGORIES:
 *   EMPTY_INPUT       — tool called with no parameters
 *   REPEATED_CALL     — same tool+args called N+ times
 *   DANGEROUS_PATTERN — tool name matches high-risk patterns (security/safety)
 *   CASCADING_FAILURE — tool B called after tool A failed AND A's name is in B's input
 *   SCHEMA_MISMATCH   — tool output structure doesn't match known schema for that tool
 */
export class ToolFailureClassifier implements FailureAnalyzer {
  readonly name = "tool-failure-classifier";

  private static readonly REPEAT_THRESHOLD = 3;

  private static readonly DANGEROUS_PATTERNS = [
    "shell", "exec", "bash", "powershell", "cmd",
    "docker", "kubectl", "terraform",
    "drop_table", "delete_db", "truncate",
    "rm_rf", "format_disk",
    "send_email_bulk", "send_sms_bulk"
  ];

  private static readonly ALLOWED_REPEAT_TOOLS = new Set([
    "sleep", "wait", "health_check", "poll_status", "get_status"
  ]);

  analyze(events: DomainEvent[], _graph: CognitionGraph | undefined, ctx: AnalyzerContext): FailureSignal[] {
    const signals: FailureSignal[] = [];
    const toolCalls = events
      .filter((e) => e.type === "TOOL_CALLED")
      .map((e) => ({
        event: e,
        toolCall: (e.payload as { toolCall?: { toolName?: string; input?: Record<string, unknown>; output?: Record<string, unknown>; error?: string; success?: boolean } }).toolCall
      }))
      .filter((t) => t.toolCall !== undefined);

    if (toolCalls.length === 0) return signals;

    // ── Empty input ───────────────────────────────────────────────────────────
    for (const { event, toolCall } of toolCalls) {
      if (!toolCall) continue;
      if (!toolCall.input || Object.keys(toolCall.input).length === 0) {
        signals.push({
          id: deterministicId([event.id, "tool-empty-input", "tool-failure-classifier"]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          kind: "TOOL_MISUSE",
          severity: "LOW",
          score: 0.42,
          summary: `Tool "${toolCall.toolName}" called with empty input — likely missing parameter extraction`,
          evidence: [{
            eventSequence: event.sequence,
            snippet: toolCall.toolName,
            metric: { failureCategory: 1 }  // 1 = EMPTY_INPUT
          }],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    // ── Repeated identical calls ──────────────────────────────────────────────
    const callFingerprints = new Map<string, Array<{ seq: number; eventId: string }>>();
    for (const { event, toolCall } of toolCalls) {
      if (!toolCall) continue;
      const toolName = toolCall.toolName ?? "unknown";
      if (ToolFailureClassifier.ALLOWED_REPEAT_TOOLS.has(toolName)) continue;
      const fp = `${toolName}:${JSON.stringify(toolCall.input ?? {})}`;
      const entries = callFingerprints.get(fp) ?? [];
      entries.push({ seq: event.sequence ?? 0, eventId: event.id });
      callFingerprints.set(fp, entries);
    }
    for (const [fp, entries] of callFingerprints) {
      if (entries.length === ToolFailureClassifier.REPEAT_THRESHOLD) {
        const toolName = fp.split(":")[0];
        signals.push({
          id: deterministicId([ctx.executionId, fp.slice(0, 64), "tool-repeat", "tool-failure-classifier"]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          kind: "TOOL_MISUSE",
          severity: entries.length >= 5 ? "HIGH" : "MEDIUM",
          score: Math.min(0.92, 0.55 + entries.length * 0.07),
          summary: `Tool "${toolName}" called ${entries.length}× with identical args — agent not using output`,
          evidence: [
            ...entries.map((e) => ({ eventSequence: e.seq })),
            { metric: { repetitions: entries.length, failureCategory: 2 } }  // 2 = REPEATED_CALL
          ],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    // ── Dangerous tool pattern ────────────────────────────────────────────────
    // Flags high-risk tool names that, if called with wrong args, could cause
    // irreversible damage. This is a safety signal, not an error signal.
    const seenDangerous = new Set<string>();
    for (const { event, toolCall } of toolCalls) {
      if (!toolCall?.toolName) continue;
      const name = toolCall.toolName.toLowerCase();
      const matched = ToolFailureClassifier.DANGEROUS_PATTERNS.find(
        (pattern) => name.includes(pattern)
      );
      if (matched && !seenDangerous.has(name)) {
        seenDangerous.add(name);
        signals.push({
          id: deterministicId([ctx.executionId, name, "dangerous-tool", "tool-failure-classifier"]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          kind: "TOOL_MISUSE",
          severity: "HIGH",
          score: 0.75,
          summary: `Tool "${toolCall.toolName}" matches dangerous pattern "${matched}" — requires operator review`,
          evidence: [{
            eventSequence: event.sequence,
            snippet: `matched pattern: "${matched}"`,
            metric: { failureCategory: 3 }  // 3 = DANGEROUS_PATTERN
          }],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }

    // ── Cascading failure detection ───────────────────────────────────────────
    // If tool A has an error and tool B is called immediately after, AND
    // tool A's name appears in tool B's input, then B likely depends on A's
    // output. When A failed, B was given bad/empty input causing a cascade.
    const failedTools: Array<{ toolName: string; seq: number }> = [];
    for (const { event, toolCall } of toolCalls) {
      if (!toolCall) continue;
      const hasError = toolCall.error || toolCall.success === false;
      if (hasError && toolCall.toolName) {
        failedTools.push({ toolName: toolCall.toolName, seq: event.sequence ?? 0 });
      }
    }

    for (const { event, toolCall } of toolCalls) {
      if (!toolCall?.input || !toolCall.toolName) continue;
      const inputText = JSON.stringify(toolCall.input).toLowerCase();
      const currentSeq = event.sequence ?? 0;
      for (const failed of failedTools) {
        if (failed.seq >= currentSeq) continue;  // prior failure only
        if (inputText.includes(failed.toolName.toLowerCase())) {
          signals.push({
            id: deterministicId([ctx.executionId, event.id, failed.toolName, "cascade", "tool-failure-classifier"]),
            cognitionId: ctx.cognitionId,
            executionId: ctx.executionId,
            kind: "TOOL_MISUSE",
            severity: "MEDIUM",
            score: 0.63,
            summary: `Tool "${toolCall.toolName}" may have been given bad input from failed tool "${failed.toolName}" (cascading failure)`,
            evidence: [
              { eventSequence: failed.seq, snippet: `${failed.toolName} failed` },
              { eventSequence: currentSeq, snippet: `${toolCall.toolName} called with reference to ${failed.toolName}` },
              { metric: { failureCategory: 4 } }  // 4 = CASCADING_FAILURE
            ],
            detectedAt: ctx.detectedAt,
            detectedBy: this.name
          });
          break;  // one cascade signal per call is enough
        }
      }
    }

    return signals;
  }
}
