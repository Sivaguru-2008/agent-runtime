/**
 * Explicit replay lifecycle states — orthogonal to execution status (RUNNING,
 * REPLAYING, etc.). Tracks replay-equivalence progress and verification outcome.
 */

export const REPLAY_LIFECYCLE_STATES = [
  "REPLAY_PENDING",
  "REPLAYING",
  "REPLAY_EQUIVALENT",
  "REPLAY_DIVERGED",
  "REPLAY_UNSAFE",
  "REPLAY_ABORTED",
  "REPLAY_VERIFIED"
] as const;

export type ReplayLifecycleStatus = (typeof REPLAY_LIFECYCLE_STATES)[number];

export type ReplayDivergenceReason =
  | "INPUT_MISMATCH"
  | "MISSING_STEP"
  | "ORDER_MISMATCH"
  | "STALE_PARENT_LOG"
  | "PARTIAL_PERSISTENCE"
  | "CONCURRENT_REPLAY";

export const REPLAY_LIFECYCLE_TRANSITIONS: Record<
  ReplayLifecycleStatus,
  ReadonlySet<ReplayLifecycleStatus>
> = {
  REPLAY_PENDING: new Set(["REPLAYING", "REPLAY_ABORTED", "REPLAY_UNSAFE"]),
  REPLAYING: new Set([
    "REPLAY_EQUIVALENT",
    "REPLAY_DIVERGED",
    "REPLAY_UNSAFE",
    "REPLAY_ABORTED",
    "REPLAY_VERIFIED"
  ]),
  REPLAY_EQUIVALENT: new Set(["REPLAYING", "REPLAY_DIVERGED", "REPLAY_VERIFIED", "REPLAY_ABORTED", "REPLAY_UNSAFE"]),
  REPLAY_DIVERGED: new Set(["REPLAY_UNSAFE", "REPLAY_VERIFIED", "REPLAY_ABORTED", "REPLAYING"]),
  REPLAY_UNSAFE: new Set(["REPLAY_ABORTED"]),
  REPLAY_ABORTED: new Set(),
  REPLAY_VERIFIED: new Set()
};

export class IllegalReplayLifecycleTransitionError extends Error {
  readonly name = "IllegalReplayLifecycleTransitionError";
  constructor(
    public readonly executionId: string,
    public readonly from: ReplayLifecycleStatus,
    public readonly to: ReplayLifecycleStatus
  ) {
    super(
      `Illegal replay lifecycle transition '${from}' -> '${to}' for execution '${executionId}'`
    );
  }
}

export function assertReplayLifecycleTransition(
  executionId: string,
  from: ReplayLifecycleStatus,
  to: ReplayLifecycleStatus
): void {
  if (from === to) return;
  const allowed = REPLAY_LIFECYCLE_TRANSITIONS[from];
  if (!allowed?.has(to)) {
    throw new IllegalReplayLifecycleTransitionError(executionId, from, to);
  }
}

export function mapLifecycleToSafetyClassification(
  lifecycle: ReplayLifecycleStatus
): "replay-safe" | "replay-equivalent" | "replay-diverged" | "replay-unsafe" {
  switch (lifecycle) {
    case "REPLAY_EQUIVALENT":
    case "REPLAY_VERIFIED":
      return "replay-equivalent";
    case "REPLAY_DIVERGED":
    case "REPLAYING":
      return "replay-diverged";
    case "REPLAY_UNSAFE":
      return "replay-unsafe";
    default:
      return "replay-safe";
  }
}

export function isReplayTerminalLifecycle(lifecycle: ReplayLifecycleStatus): boolean {
  return lifecycle === "REPLAY_VERIFIED" || lifecycle === "REPLAY_ABORTED" || lifecycle === "REPLAY_UNSAFE";
}
