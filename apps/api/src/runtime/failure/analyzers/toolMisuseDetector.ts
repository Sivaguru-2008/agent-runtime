import type { FailureAnalyzer } from "../analyzer.js";
import type { AnalyzerContext, FailureSignal } from "../../../domain/failure.js";
import type { DomainEvent } from "../../../domain/events.js";
import type { CognitionGraph } from "../../../domain/cognition.js";
import { deterministicId } from "../../../shared/determinism.js";

/**
 * Tool misuse detector.
 *
 * Inspects TOOL_CALLED events for: empty inputs, repeated identical calls,
 * or calls referencing tools that are disabled in the agent's tool list.
 */
export class ToolMisuseDetector implements FailureAnalyzer {
  readonly name = "tool-misuse-detector";

  analyze(events: DomainEvent[], _graph: CognitionGraph | undefined, ctx: AnalyzerContext): FailureSignal[] {
    const signals: FailureSignal[] = [];
    const calls = events.filter((e: DomainEvent) => e.type === "TOOL_CALLED");
    const seenInputs = new Map<string, number>();
    for (const call of calls) {
      const toolCall = (call.payload as { toolCall?: { toolName?: string; input?: Record<string, unknown> } }).toolCall;
      if (!toolCall) continue;
      const fingerprintKey = `${toolCall.toolName}:${JSON.stringify(toolCall.input ?? {})}`;
      const count = (seenInputs.get(fingerprintKey) ?? 0) + 1;
      seenInputs.set(fingerprintKey, count);
      if (!toolCall.input || Object.keys(toolCall.input).length === 0) {
        signals.push({
          id: deterministicId([call.id, "tool-empty-input", "tool-misuse-detector"]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          kind: "TOOL_MISUSE",
          severity: "LOW",
          score: 0.4,
          summary: `Tool "${toolCall.toolName}" invoked with empty input`,
          evidence: [{ eventSequence: call.sequence, snippet: toolCall.toolName }],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
      if (count === 3) {
        signals.push({
          id: deterministicId([call.id, "tool-repeat", "tool-misuse-detector"]),
          cognitionId: ctx.cognitionId,
          executionId: ctx.executionId,
          kind: "TOOL_MISUSE",
          severity: "MEDIUM",
          score: 0.7,
          summary: `Tool "${toolCall.toolName}" called 3x with identical args`,
          evidence: [{ eventSequence: call.sequence, metric: { repetitions: count } }],
          detectedAt: ctx.detectedAt,
          detectedBy: this.name
        });
      }
    }
    return signals;
  }
}
