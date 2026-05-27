import type { DomainEvent } from "../../domain/events.js";
import type { CognitionGraph } from "../../domain/cognition.js";
import type { AnalyzerContext, FailureSignal } from "../../domain/failure.js";

/**
 * Each Failure Analyzer is a pure function over (events, graph) → signals.
 * They are intentionally cheap and side-effect-free so they can run on the
 * replay timeline as well as the live event stream.
 */
export interface FailureAnalyzer {
  readonly name: string;
  analyze(events: DomainEvent[], graph: CognitionGraph | undefined, ctx: AnalyzerContext): FailureSignal[];
}
