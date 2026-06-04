/**
 * Explainability system — public surface.
 *
 * Five layers + visual/empty/global helpers, all reading from the single
 * knowledge base in `lib/explain`. Import what you need:
 *
 *   import { ExplainLabel, StatusPill, GraphGuide, ExplainedEmptyState,
 *            WhyChip, RunNarration, ExplainModeToggle } from "@/components/explain";
 */

export { ExplainModeProvider, useExplainMode } from "./explain-mode";
export { ExplainModeToggle } from "./explain-mode-toggle";
export { ExplainPanel } from "./explain-panel";
export { ExplainLabel, MicroExplanation } from "./explain-label";
export { StatusPill } from "./status-pill";
export { GraphGuide } from "./graph-guide";
export { ExplainedEmptyState } from "./empty-state";
export { WhyChip } from "./why-chip";
export { RunNarration } from "./run-narration";
