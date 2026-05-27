/**
 * PHASE 6 — Replay Experience component barrel.
 *
 * Each component answers a specific operator debugging question:
 *   - ExecutionTimelineViewer: where did failure begin?
 *   - TimeTravelDebugger: what was the state at frame X?
 *   - CognitionNodeExplorer: what did each agent decide and why?
 *   - FailureRootCausePanel: what caused this failure?
 *   - OperatorReplayConsole: how do I fix or replay this execution?
 *   - ReplayDeterminismPanel: can I trust this replay?
 *   - ReplayExperience: composes all of the above into a single workspace.
 */

export { ReplayExperience } from "./replay-experience";
export { ExecutionTimelineViewer } from "./execution-timeline-viewer";
export { CognitionNodeExplorer } from "./cognition-node-explorer";
export { FailureRootCausePanel } from "./failure-root-cause-panel";
export { OperatorReplayConsole } from "./operator-replay-console";
export { ReplayDeterminismPanel } from "./replay-determinism-panel";
export { TimeTravelDebugger } from "./time-travel-debugger";
export { ReplayTimelineScrubber } from "./replay-timeline-scrubber";
export { BranchDivergence } from "./branch-divergence";

export type { ExecutionTimelineViewerProps } from "./execution-timeline-viewer";
export type { CognitionNodeExplorerProps } from "./cognition-node-explorer";
export type { FailureRootCausePanelProps } from "./failure-root-cause-panel";
export type { OperatorReplayConsoleProps } from "./operator-replay-console";
export type { ReplayDeterminismPanelProps } from "./replay-determinism-panel";
