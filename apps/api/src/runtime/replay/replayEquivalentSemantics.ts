/**
 * Canonical replay-equivalent execution semantics.
 *
 * Replay guarantees observable equivalence at persisted event boundaries —
 * not bitwise reproduction of process memory, RNG draws, or live LLM sampling.
 */

import type { DomainEvent } from "../../domain/events.js";
import type { ExecutionStep, ExecutionStepType } from "../../domain/model.js";
import type { ReplayLifecycleStatus } from "./replayLifecycle.js";

/** What replay guarantees (enforced at event boundary). */
export const REPLAY_GUARANTEES = {
  VERBATIM_PERSISTED_STEPS:
    "Steps with EXECUTION_STEP_COMPLETED in the parent log replay without live LLM/tool calls.",
  CLOCK_FREEZE:
    "Replayed steps preserve startedAt, completedAt, and durationMs from the parent step payload.",
  PREFIX_EVENT_ORDER:
    "Until divergence, nested events (MEMORY_RETRIEVED, MODEL_COMPLETED, TOOL_CALLED) emit in parent order.",
  SIDE_EFFECT_SUPPRESSION:
    "Non-safe tools never execute live during replay-equivalent prefix reconstruction.",
  ISOLATION:
    "Replay writes only to the child execution aggregate; parent production state is read-only.",
  FENCE_OWNERSHIP:
    "Replay obeys fence validation and lease ownership — never bypasses fencing."
} as const;

/** What replay explicitly does NOT guarantee. */
export const REPLAY_NON_GUARANTEES = {
  LLM_API_DETERMINISM: "Live model APIs are never re-queried for equivalence; recorded MODEL_COMPLETED is used.",
  WALL_CLOCK_METADATA:
    "Execution-level DB timestamps on the child execution reflect replay time, not original wall time.",
  UNRECORDED_MEMORY: "In-process variables and unlogged filesystem writes are not reconstructed.",
  POST_DIVERGENCE_EQUIVALENCE:
    "After REPLAY_DIVERGED, remaining steps may run live under sandbox policy — not byte-identical to parent."
} as const;

/** Deterministic boundaries — must reconstruct from persistence only. */
export const DETERMINISTIC_BOUNDARIES = [
  "LLM completion (MODEL_COMPLETED)",
  "Tool outcome (TOOL_CALLED / tool_call_dedup)",
  "Step timing (EXECUTION_STEP_COMPLETED timestamps)",
  "Memory retrieval payload (MEMORY_RETRIEVED)",
  "Recorded RNG/CLOCK reads when present in event log"
] as const;

/** Probabilistic boundaries — never recomputed during equivalent replay. */
export const PROBABILISTIC_BOUNDARIES = [
  "Live LLM sampling",
  "Math.random() without persisted draw",
  "External API latency and ordering",
  "Network partition outcomes",
  "Concurrent worker interleaving"
] as const;

/**
 * Observable-equivalence rule: for each replayed step index i, the emitted
 * EXECUTION_STEP_COMPLETED payload must match the parent's step at i for
 * { type, input, output, startedAt, completedAt, durationMs }.
 */
export function stepsObservablyEquivalent(
  parentStep: ExecutionStep | undefined,
  replayed: Pick<ExecutionStep, "type" | "input" | "output" | "startedAt" | "completedAt" | "durationMs">
): boolean {
  if (!parentStep) return false;
  return (
    parentStep.type === replayed.type &&
    JSON.stringify(parentStep.input) === JSON.stringify(replayed.input) &&
    JSON.stringify(parentStep.output) === JSON.stringify(replayed.output) &&
    parentStep.startedAt === replayed.startedAt &&
    parentStep.completedAt === replayed.completedAt &&
    parentStep.durationMs === replayed.durationMs
  );
}

export interface ReplayEquivalenceContext {
  executionId: string;
  parentExecutionId: string;
  lifecycle: ReplayLifecycleStatus;
  parentEvents: DomainEvent[];
  replayStepCount: number;
  parentEventSequenceWatermark: number;
}

export function extractCompletedSteps(events: DomainEvent[]): ExecutionStep[] {
  return events
    .filter((e) => e.type === "EXECUTION_STEP_COMPLETED")
    .map((e) => e.payload.step as ExecutionStep);
}

export function findParentStepAtIndex(
  events: DomainEvent[],
  stepIndex: number
): { event: DomainEvent | undefined; step: ExecutionStep | undefined } {
  const completed = events.filter((e) => e.type === "EXECUTION_STEP_COMPLETED");
  const event = completed[stepIndex];
  const step = event?.payload?.step as ExecutionStep | undefined;
  return { event, step };
}

export function matchStepForReplay(
  expected: ExecutionStep | undefined,
  type: ExecutionStepType,
  stepInput: Record<string, unknown>
): { match: boolean; reason?: "INPUT_MISMATCH" | "MISSING_STEP" | "ORDER_MISMATCH" } {
  if (!expected) return { match: false, reason: "MISSING_STEP" };
  if (expected.type !== type) return { match: false, reason: "ORDER_MISMATCH" };
  if (JSON.stringify(expected.input) !== JSON.stringify(stepInput)) {
    return { match: false, reason: "INPUT_MISMATCH" };
  }
  return { match: true };
}

export function parentLogStale(
  parentEvents: DomainEvent[],
  watermark: number
): boolean {
  const maxSeq = parentEvents.reduce((max, e) => {
    const seq = Number(e.sequence ?? 0);
    return seq > max ? seq : max;
  }, 0);
  return maxSeq > watermark;
}
