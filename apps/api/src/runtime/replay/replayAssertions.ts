import type { Execution } from "../../domain/model.js";
import type { FencingToken } from "../../domain/clusterPorts.js";
import {
  assertRuntimeInvariant,
  validateFencingToken,
  validateReplayAction,
  type ReplaySafetyStatus
} from "../canonicalSemantics.js";
import type { ReplayLifecycleStatus } from "./replayLifecycle.js";
import {
  assertReplayLifecycleTransition,
  isReplayTerminalLifecycle
} from "./replayLifecycle.js";

/**
 * Replay legality: only child executions with a parent may enter replay mode.
 */
export function assertReplayLegality(execution: Execution): void {
  assertRuntimeInvariant(
    "RP2",
    Boolean(execution.parentExecutionId),
    "Replay legality violation: execution must reference parentExecutionId",
    { executionId: execution.id }
  );
}

/**
 * Replay isolation: mutations target the replay child aggregate only.
 */
export function assertReplayIsolation(input: {
  replayExecutionId: string;
  parentExecutionId: string;
  aggregateId: string;
}): void {
  assertRuntimeInvariant(
    "RP3",
    input.aggregateId === input.replayExecutionId,
    "Replay isolation violation: cannot mutate parent or foreign aggregate during replay",
    input
  );
  assertRuntimeInvariant(
    "RP3",
    input.aggregateId !== input.parentExecutionId,
    "Replay isolation violation: aggregateId must not equal parentExecutionId",
    input
  );
}

/**
 * Deterministic reconstruction boundary: equivalent replay must not invoke live APIs.
 */
export function assertDeterministicReconstructionBoundary(input: {
  executionId: string;
  lifecycle: ReplayLifecycleStatus;
  boundary: "LLM" | "TOOL" | "RNG" | "CLOCK";
  liveInvocationAttempted: boolean;
}): void {
  const equivalent =
    input.lifecycle === "REPLAY_EQUIVALENT" ||
    input.lifecycle === "REPLAY_PENDING" ||
    (input.lifecycle === "REPLAYING" && !input.liveInvocationAttempted);
  if (!equivalent) return;
  assertRuntimeInvariant(
    "CAP3",
    !input.liveInvocationAttempted,
    `Deterministic boundary violation: live ${input.boundary} invocation attempted during replay-equivalent reconstruction`,
    input
  );
}

/**
 * Side-effect suppression during replay.
 */
export function assertSideEffectSuppressed(input: {
  executionId: string;
  diverged: boolean;
  safety: ReplaySafetyStatus;
  toolName?: string;
}): void {
  validateReplayAction({
    executionId: input.executionId,
    stepType: "TOOL_CALL",
    activeReplayState: { diverged: input.diverged, safety: input.safety },
    toolName: input.toolName
  });
}

/**
 * Fence and ownership must remain active during replay — never bypassed.
 *
 * When `currentAttempt` (the authoritative lease attempt from the durable
 * lease store) is supplied, the fence must be at least that fresh — a token
 * minted under a reclaimed lease carries a lower attempt and is rejected
 * before it can authorize any replay action (L2).
 */
export function assertReplayFenceContext(input: {
  execution: Execution;
  fence?: FencingToken;
  phase: string;
  currentAttempt?: number;
}): void {
  if (!input.fence) return;
  validateFencingToken({
    executionId: input.fence.executionId,
    workerId: input.fence.workerId,
    attempt: input.fence.attempt,
    currentStatus: input.execution.status,
    phase: input.phase
  });
  assertRuntimeInvariant(
    "F6",
    input.fence.executionId === input.execution.id,
    "Replay fence violation: fence executionId must match replay child execution",
    { executionId: input.execution.id, fenceExecutionId: input.fence.executionId }
  );
  if (input.currentAttempt !== undefined) {
    assertRuntimeInvariant(
      "L2",
      input.fence.attempt >= input.currentAttempt,
      `Replay fence violation: stale fence attempt ${input.fence.attempt} is below the authoritative lease attempt ${input.currentAttempt} during '${input.phase}'`,
      {
        executionId: input.execution.id,
        workerId: input.fence.workerId,
        fenceAttempt: input.fence.attempt,
        currentAttempt: input.currentAttempt,
        phase: input.phase
      }
    );
  }
}

/**
 * Concurrent replay: one active replay coordinator entry per execution id.
 */
export function assertNoConcurrentReplay(input: {
  executionId: string;
  activeReplayIds: ReadonlySet<string>;
}): void {
  assertRuntimeInvariant(
    "RP3",
    !input.activeReplayIds.has(input.executionId),
    "Concurrent replay violation: execution already has an active replay session",
    { executionId: input.executionId }
  );
}

export { assertReplayLifecycleTransition as assertReplayLifecycleAdvance };

export function assertReplayNotTerminal(
  executionId: string,
  lifecycle: ReplayLifecycleStatus
): void {
  assertRuntimeInvariant(
    "RP1",
    !isReplayTerminalLifecycle(lifecycle),
    `Replay already terminal (${lifecycle}); cannot continue live side effects`,
    { executionId, lifecycle }
  );
}

export function assertReplayPersistenceGap(executionId: string, actualSeq: number, expectedSeq: number): void {
  assertRuntimeInvariant(
    "RP2",
    actualSeq === expectedSeq,
    `Replay persistence gap violation: detected missing or unpersisted steps. Expected step sequence ${expectedSeq}, got ${actualSeq}.`,
    { executionId, actualSeq, expectedSeq }
  );
}

export function assertExternalityMetadata(executionId: string, type: string, record: any): void {
  assertRuntimeInvariant(
    "RP2",
    record !== null && record !== undefined,
    `Replay externality metadata violation: missing metadata for step type ${type}.`,
    { executionId, type }
  );
  if (type === "MODEL_GENERATION") {
    const prompt = record.input?.prompt;
    const output = record.output;
    assertRuntimeInvariant(
      "RP2",
      Boolean(prompt) && Boolean(output),
      `Replay externality metadata violation: missing LLM prompt or output for model generation.`,
      { executionId, record }
    );
  } else if (type === "TOOL_CALL") {
    const toolName = record.input?.toolName;
    const toolInput = record.input?.args ?? record.input;
    const toolOutput = record.output;
    assertRuntimeInvariant(
      "RP2",
      Boolean(toolName) && toolInput !== undefined && toolOutput !== undefined,
      `Replay externality metadata violation: missing tool name, input or output for tool call.`,
      { executionId, record }
    );
  }
}

export function assertOrderingReconstruction(executionId: string, actualType: string, expectedType: string): void {
  assertRuntimeInvariant(
    "RP2",
    actualType === expectedType,
    `Replay ordering reconstruction violation: step order mismatch. Expected type ${expectedType}, got ${actualType}.`,
    { executionId, actualType, expectedType }
  );
}

export function assertSafeReplayReconstruction(executionId: string, status: ReplayLifecycleStatus): void {
  assertRuntimeInvariant(
    "RP1",
    status !== "REPLAY_UNSAFE" && status !== "REPLAY_ABORTED",
    `Replay safety reconstruction violation: attempt to execute under unsafe or aborted replay lifecycle status '${status}'`,
    { executionId, status }
  );
}

export class UnsafeReplayDivergenceError extends Error {
  readonly name = "UnsafeReplayDivergenceError";
  constructor(
    public readonly executionId: string,
    public readonly reason: string,
    public readonly metadata?: Record<string, unknown>
  ) {
    super(`Unsafe replay divergence detected on execution '${executionId}': ${reason}`);
  }
}

export class NonReconstructableReplayError extends Error {
  readonly name = "NonReconstructableReplayError";
  constructor(
    public readonly executionId: string,
    public readonly reason: string,
    public readonly metadata?: Record<string, unknown>
  ) {
    super(`Non-reconstructable replay state on execution '${executionId}': ${reason}`);
  }
}

export function assertReplayTimingMonotonicity(
  executionId: string,
  replayedStartedAt: string,
  replayedCompletedAt: string,
  originalStartedAt: string,
  originalCompletedAt: string,
  thresholdMs: number = 10000
): void {
  const repStart = new Date(replayedStartedAt).getTime();
  const repComp = new Date(replayedCompletedAt).getTime();
  const origStart = new Date(originalStartedAt).getTime();
  const origComp = new Date(originalCompletedAt).getTime();

  const repDur = repComp - repStart;
  const origDur = origComp - origStart;

  const diff = Math.abs(repDur - origDur);
  if (diff > thresholdMs) {
    throw new UnsafeReplayDivergenceError(
      executionId,
      `Timing drift exceeded threshold of ${thresholdMs}ms: original duration was ${origDur}ms, replayed duration was ${repDur}ms.`,
      { originalDurationMs: origDur, replayedDurationMs: repDur, thresholdMs }
    );
  }
}

export function assertToolOutputEquivalence(
  executionId: string,
  replayedArgs: Record<string, unknown>,
  replayedOutput: Record<string, unknown> | undefined,
  originalArgs: Record<string, unknown>,
  originalOutput: Record<string, unknown> | undefined
): void {
  if (JSON.stringify(replayedArgs) !== JSON.stringify(originalArgs)) {
    throw new UnsafeReplayDivergenceError(
      executionId,
      "Tool call arguments diverged from original execution.",
      { originalArgs, replayedArgs }
    );
  }
  if (JSON.stringify(replayedOutput) !== JSON.stringify(originalOutput)) {
    throw new UnsafeReplayDivergenceError(
      executionId,
      "Tool call output diverged from original execution.",
      { originalOutput, replayedOutput }
    );
  }
}

export function assertNoUntrackedNondeterminism(
  executionId: string,
  stepType: string,
  allowed: boolean
): void {
  assertRuntimeInvariant(
    "S_UNSAFE_REPLAY",
    allowed,
    `Untracked nondeterminism detected inside execution '${executionId}' during step '${stepType}'. Direct Math.random() or global Date usage is forbidden.`,
    { executionId, stepType }
  );
}

export function assertUnsafeRandomnessUsage(
  executionId: string,
  seed: string | null | undefined
): void {
  assertRuntimeInvariant(
    "CAP3",
    typeof seed === "string" && seed.length > 0,
    `Unsafe randomness usage: execution '${executionId}' randomness seed is missing or empty.`,
    { executionId, seed }
  );
}

export function assertNondeterministicReplayLeakage(
  executionId: string,
  action: string,
  isLeak: boolean
): void {
  assertRuntimeInvariant(
    "RP1",
    !isLeak,
    `Nondeterministic replay leakage detected: execution '${executionId}' attempted prohibited action '${action}' during replay equivalence checks.`,
    { executionId, action }
  );
}

export function assertTimingReconstruction(
  executionId: string,
  expectedDurationMs: number,
  actualDurationMs: number,
  thresholdMs: number = 10000
): void {
  const drift = Math.abs(expectedDurationMs - actualDurationMs);
  if (drift > thresholdMs) {
    throw new UnsafeReplayDivergenceError(
      executionId,
      `Timing reconstruction failure: replayed step duration drifted by ${drift}ms (expected ${expectedDurationMs}ms, got ${actualDurationMs}ms).`,
      { expectedDurationMs, actualDurationMs, drift, thresholdMs }
    );
  }
}



