export {
  REPLAY_LIFECYCLE_STATES,
  REPLAY_LIFECYCLE_TRANSITIONS,
  type ReplayLifecycleStatus,
  type ReplayDivergenceReason,
  IllegalReplayLifecycleTransitionError,
  assertReplayLifecycleTransition,
  mapLifecycleToSafetyClassification,
  isReplayTerminalLifecycle
} from "./replayLifecycle.js";

export {
  REPLAY_GUARANTEES,
  REPLAY_NON_GUARANTEES,
  DETERMINISTIC_BOUNDARIES,
  PROBABILISTIC_BOUNDARIES,
  stepsObservablyEquivalent,
  extractCompletedSteps,
  matchStepForReplay,
  parentLogStale
} from "./replayEquivalentSemantics.js";

export {
  assertReplayLegality,
  assertReplayIsolation,
  assertDeterministicReconstructionBoundary,
  assertSideEffectSuppressed,
  assertReplayFenceContext,
  assertNoConcurrentReplay,
  assertReplayLifecycleAdvance,
  UnsafeReplayDivergenceError,
  NonReconstructableReplayError
} from "./replayAssertions.js";

export {
  ReplayExecutionCoordinator,
  type ReplaySessionState,
  type ReconstructedStep,
  type ReplayDivergencePayload
} from "./replayExecutionCoordinator.js";

export {
  ReplayComparisonTool,
  type ReplayComparisonReport
} from "./replayComparisonTool.js";
