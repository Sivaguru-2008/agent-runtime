import type { DomainEvent } from "../../domain/events.js";
import type { Execution, ExecutionStep, ExecutionStepType } from "../../domain/model.js";
import type { EventStore, ExecutionRepository, MemoryRepository, ToolExecutor } from "../../domain/ports.js";
import type { FencingToken } from "../../domain/clusterPorts.js";
import { PersistedEventPublisher } from "../../infrastructure/events/persistedEventPublisher.js";
import {
  assertRuntimeInvariant,
  validateFencingToken,
  validateReplayAction,
  type ReplaySafetyStatus
} from "../canonicalSemantics.js";
import {
  SandboxedEventStore,
  SandboxedExecutionRepository,
  SandboxedMemoryRepository,
  SandboxedEventPublisher,
  SandboxedToolExecutor,
  ReplayPolicyViolationError
} from "./replaySandbox.js";
import {
  UnsafeReplayDivergenceError,
  NonReconstructableReplayError,
  assertReplayLegality,
  assertNoConcurrentReplay,
  assertReplayFenceContext,
  assertDeterministicReconstructionBoundary,
  assertSideEffectSuppressed,
  assertSafeReplayReconstruction,
  assertUnsafeRandomnessUsage,
  assertReplayPersistenceGap
} from "./replayAssertions.js";
import {
  mapLifecycleToSafetyClassification,
  type ReplayLifecycleStatus,
  type ReplayDivergenceReason
} from "./replayLifecycle.js";
import type { ReplayDivergenceClassification } from "../../domain/replay.js";
import { IdempotencyPolicyEnforcer } from "../policyEnforcer.js";

export interface SandboxContext {
  publisher: PersistedEventPublisher;
  executions: ExecutionRepository;
  memory: MemoryRepository;
  tools: ToolExecutor;
}

export interface ValidationCheckpointResult {
  classification: ReplayDivergenceClassification;
  reason: ReplayDivergenceReason;
  narrative: string;
}

export class CentralizedReplayEnforcer {
  /**
   * Enforces replay legality. Ensures execution has a parent and that no concurrent sessions run.
   */
  static validateLegality(execution: Execution, activeReplayIds: ReadonlySet<string>): void {
    assertReplayLegality(execution);
    assertNoConcurrentReplay({
      executionId: execution.id,
      activeReplayIds
    });
  }

  /**
   * Enforces fence and ownership validation. Never bypassed.
   *
   * `currentAttempt` is the authoritative lease attempt read from the durable
   * lease store. When the caller holds it (recovery, replay re-drive, any path
   * where the fence may have outlived its lease), a fence below it is stale
   * and rejected (L2). Without it only shape and ownership-identity are
   * checked — freshness requires an authority to compare against.
   */
  static validateFence(
    execution: Execution,
    fence?: FencingToken,
    phase: string = "replay",
    currentAttempt?: number
  ): void {
    assertRuntimeInvariant(
      "RP1",
      fence !== undefined && fence !== null,
      `Replay fence violation: replay execution '${execution.id}' cannot bypass ownership or fence validation during '${phase}'`,
      { executionId: execution.id }
    );
    assertReplayFenceContext({
      execution,
      fence,
      phase,
      ...(currentAttempt !== undefined ? { currentAttempt } : {})
    });
  }

  /**
   * Constructs an isolated, secure Sandboxed context for execution.
   */
  static enterSandbox(input: {
    executionId: string;
    parentExecutionId: string;
    events: EventStore;
    executions: ExecutionRepository;
    memory: MemoryRepository;
    tools: ToolExecutor;
    isDiverged: () => boolean;
    isOperatorApproved: () => boolean;
  }): SandboxContext {
    const sandboxedStore = new SandboxedEventStore(input.events, input.executionId, input.parentExecutionId);
    const sandboxedRepo = new SandboxedExecutionRepository(input.executions, input.executionId, input.parentExecutionId);
    const sandboxedMemory = new SandboxedMemoryRepository(input.memory, input.executionId);
    const sandboxedPub = new SandboxedEventPublisher(sandboxedStore, input.executionId);
    const sandboxedTools = new SandboxedToolExecutor(
      input.tools,
      input.executionId,
      input.isDiverged,
      input.isOperatorApproved
    );

    return {
      publisher: sandboxedPub,
      executions: sandboxedRepo,
      memory: sandboxedMemory,
      tools: sandboxedTools
    };
  }

  /**
   * Authoritative validation checkpoint for step reconstruction.
   * Unifies and aligns the validation rules between coordinator and comparison tools.
   */
  static runValidationCheckpoint(input: {
    executionId: string;
    replayStepCount: number;
    lifecycle: ReplayLifecycleStatus;
    expectedStep: ExecutionStep | undefined;
    parentExternalityEvent: DomainEvent | undefined;
    actualType: ExecutionStepType;
    actualInput: Record<string, unknown>;
  }): ValidationCheckpointResult {
    const { executionId, replayStepCount, expectedStep, parentExternalityEvent, actualType, actualInput } = input;

    // 1. Durability and Persistence Gap checks
    if (!expectedStep) {
      if (parentExternalityEvent) {
        const narrative = `Replay persistence gap violation: detected missing or unpersisted steps. Expected step sequence ${replayStepCount + 1}, got ${replayStepCount}.`;
        return { classification: "NON_RECONSTRUCTABLE", reason: "PARTIAL_PERSISTENCE", narrative };
      }
      const narrative = `Non-reconstructable replay: missing expected persisted step at step index ${replayStepCount}`;
      return { classification: "NON_RECONSTRUCTABLE", reason: "MISSING_STEP", narrative };
    }

    if (!parentExternalityEvent) {
      const narrative = `Replay persistence gap violation: detected missing or unpersisted steps. Expected step sequence ${replayStepCount + 1}, got ${replayStepCount}.`;
      return { classification: "NON_RECONSTRUCTABLE", reason: "PARTIAL_PERSISTENCE", narrative };
    }

    // 2. Step Ordering reconstruction checks
    if (expectedStep.type !== actualType) {
      const narrative = `Replay ordering reconstruction violation: step order mismatch. Expected type ${expectedStep.type}, got ${actualType}.`;
      return { classification: "UNSAFE_DIVERGENCE", reason: "ORDER_MISMATCH", narrative };
    }

    // 3. Inconsistent inputs / arguments (Tool calls and Model generations)
    if (actualType === "TOOL_CALL") {
      const expectedToolName = expectedStep.input?.toolName;
      const actualToolName = actualInput?.toolName;

      if (expectedToolName !== actualToolName) {
        const narrative = `Unsafe Divergence: expected tool '${expectedToolName}', but got '${actualToolName}'`;
        return { classification: "UNSAFE_DIVERGENCE", reason: "ORDER_MISMATCH", narrative };
      }

      const expectedArgs = expectedStep.input?.args ?? expectedStep.input;
      const actualArgs = actualInput?.args ?? actualInput;
      if (JSON.stringify(expectedArgs) !== JSON.stringify(actualArgs)) {
        const narrative = `Unsafe Divergence: tool '${actualToolName}' arguments mismatch.`;
        return { classification: "UNSAFE_DIVERGENCE", reason: "INPUT_MISMATCH", narrative };
      }
    }

    if (actualType === "MODEL_GENERATION") {
      const expectedPrompt = expectedStep.input?.prompt;
      const actualPrompt = actualInput?.prompt;
      if (expectedPrompt && actualPrompt && expectedPrompt !== actualPrompt) {
        const narrative = `LLM prompt inconsistency: expected '${expectedPrompt}', got '${actualPrompt}'`;
        return { classification: "UNSAFE_DIVERGENCE", reason: "INPUT_MISMATCH", narrative };
      }
    }

    // 4. Timing drift checks
    if (expectedStep.startedAt && expectedStep.completedAt) {
      const origStart = new Date(expectedStep.startedAt).getTime();
      const origComp = new Date(expectedStep.completedAt).getTime();
      const origDur = origComp - origStart;

      if (expectedStep.durationMs !== undefined) {
        const drift = Math.abs(expectedStep.durationMs - origDur);
        if (drift > 10000) {
          const narrative = `Timing inconsistency: recorded step duration is ${expectedStep.durationMs}ms, calculated was ${origDur}ms`;
          return { classification: "UNSAFE_DIVERGENCE", reason: "CONCURRENT_REPLAY", narrative };
        }
      }
    }

    // 5. General generic validation
    const expectedInputStr = JSON.stringify(expectedStep.input);
    const actualInputStr = JSON.stringify(actualInput);
    if (expectedInputStr !== actualInputStr) {
      const narrative = `Replay diverged due to input mismatch on step ${replayStepCount} (${actualType})`;
      return { classification: "DIVERGED", reason: "INPUT_MISMATCH", narrative };
    }

    return { classification: "EQUIVALENT", reason: "NONE" as any, narrative: "" };
  }

  /**
   * Validates tool call safety and enforces side-effect suppression policies.
   */
  static validateLiveTool(execution: Execution, toolName: string, lifecycle: ReplayLifecycleStatus, diverged: boolean): void {
    IdempotencyPolicyEnforcer.validateReplaySafety(toolName, {
      diverged,
      operatorApproved: execution.input?.operatorApproved === true
    });

    const safety = mapLifecycleToSafetyClassification(lifecycle);
    assertSideEffectSuppressed({
      executionId: execution.id,
      diverged,
      safety,
      toolName
    });
  }

  /**
   * Deterministic-boundary live invocation check.
   */
  static assertBoundary(executionId: string, lifecycle: ReplayLifecycleStatus, boundary: "LLM" | "TOOL" | "RNG" | "CLOCK", attempted: boolean): void {
    assertDeterministicReconstructionBoundary({
      executionId,
      lifecycle,
      boundary,
      liveInvocationAttempted: attempted
    });
  }
}
