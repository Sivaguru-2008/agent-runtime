import type { DomainEvent } from "../../domain/events.js";
import type { EventContext } from "../../infrastructure/events/eventFactory.js";
import type { Execution, ExecutionStep, ExecutionStepType, ReplayExternalityRecord } from "../../domain/model.js";
import type { EventStore } from "../../domain/ports.js";
import type { EventFactory } from "../../infrastructure/events/eventFactory.js";
import type { ExecutionRepository } from "../../domain/ports.js";
import type { PersistedEventPublisher } from "../../infrastructure/events/persistedEventPublisher.js";
import type { FencingToken } from "../../domain/clusterPorts.js";
import { createId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { sandboxStorage } from "../executionEngine.js";
import { CentralizedReplayEnforcer } from "./replayEnforcer.js";
import {
  assertNoConcurrentReplay,
  assertReplayFenceContext,
  assertReplayIsolation,
  assertReplayLegality,
  assertReplayLifecycleAdvance,
  assertSideEffectSuppressed,
  assertSafeReplayReconstruction,
  assertOrderingReconstruction,
  assertExternalityMetadata,
  assertReplayPersistenceGap,
  UnsafeReplayDivergenceError,
  NonReconstructableReplayError,
  assertNoUntrackedNondeterminism,
  assertUnsafeRandomnessUsage,
  assertNondeterministicReplayLeakage,
  assertTimingReconstruction
} from "./replayAssertions.js";
import {
  extractCompletedSteps,
  findParentStepAtIndex,
  matchStepForReplay,
  parentLogStale,
  type ReplayEquivalenceContext
} from "./replayEquivalentSemantics.js";
import {
  mapLifecycleToSafetyClassification,
  type ReplayDivergenceReason,
  type ReplayLifecycleStatus
} from "./replayLifecycle.js";
import { IdempotencyPolicyEnforcer } from "../policyEnforcer.js";
import { assertRuntimeInvariant } from "../canonicalSemantics.js";
import type { ReplayDivergenceClassification } from "../../domain/replay.js";

export interface ReplaySessionState extends ReplayEquivalenceContext {
  diverged: boolean;
  divergenceReason?: ReplayDivergenceReason;
  divergenceClassification?: ReplayDivergenceClassification;
  divergenceStepIndex?: number;
  verified: boolean;
  /** Trace context for lifecycle domain events. */
  eventContext?: EventContext;
}

export interface ReconstructedStep<TOutput extends Record<string, unknown>> {
  output: TOutput;
  completed: ExecutionStep;
  /** Nested events to emit before EXECUTION_STEP_COMPLETED */
  nestedEmitters: Array<
    (publish: (event: ReturnType<EventFactory["create"]>) => Promise<void>) => Promise<void>
  >;
}

export interface ReplayDivergencePayload {
  sourceExecutionId: string;
  replayExecutionId: string;
  divergenceStepIndex: number;
  reason: ReplayDivergenceReason;
  narrative: string;
  lifecycle: ReplayLifecycleStatus;
}

type PublishFn = (
  event: ReturnType<EventFactory["create"]>,
  fence?: FencingToken
) => Promise<void>;

/**
 * Coordinates replay-equivalent execution: reconstructs from persisted
 * externalities, tracks lifecycle, enforces isolation and sandbox policy.
 */
export class ReplayExecutionCoordinator {
  private readonly sessions = new Map<string, ReplaySessionState>();

  private readonly _events: EventStore;
  private readonly _executions: ExecutionRepository;
  private readonly _publisher: PersistedEventPublisher;

  private get events(): EventStore {
    return sandboxStorage.getStore()?.publisher.eventStore ?? this._events;
  }

  private get executions(): ExecutionRepository {
    return sandboxStorage.getStore()?.executions ?? this._executions;
  }

  private get publisher(): PersistedEventPublisher {
    return sandboxStorage.getStore()?.publisher ?? this._publisher;
  }

  constructor(
    events: EventStore,
    executions: ExecutionRepository,
    publisher: PersistedEventPublisher,
    private readonly eventFactory: EventFactory
  ) {
    this._events = events;
    this._executions = executions;
    this._publisher = publisher;
  }

  getSession(executionId: string): ReplaySessionState | undefined {
    const s = this.sessions.get(executionId);
    if (s) {
      assertSafeReplayReconstruction(executionId, s.lifecycle);
    }
    return s;
  }

  async getOrReconstructSession(
    executionId: string,
    execution?: Execution
  ): Promise<ReplaySessionState | undefined> {
    let session = this.sessions.get(executionId);
    if (session) {
      assertSafeReplayReconstruction(executionId, session.lifecycle);
      return session;
    }

    const exec = execution ?? await this.executions.getById(executionId);
    if (!exec || !exec.parentExecutionId) return undefined;

    const childEvents = await this.events.listByExecution(executionId);
    const lifecycleEvents = childEvents.filter((e) => e.type === "REPLAY_LIFECYCLE_TRANSITIONED");
    
    if (lifecycleEvents.length === 0) {
      return undefined;
    }

    const latestTransition = lifecycleEvents[lifecycleEvents.length - 1];
    const payload = latestTransition.payload as any;

    const parentEvents = [...(await this.events.listByExecution(exec.parentExecutionId))];
    
    const watermark = Number(payload.parentEventSequenceWatermark ?? parentEvents.reduce((max, e) => {
      const seq = Number(e.sequence ?? 0);
      return seq > max ? seq : max;
    }, 0));

    const filteredParentEvents = parentEvents.filter((e) => Number(e.sequence ?? 0) <= watermark);

    const diverged = childEvents.some((e) => e.type === "REPLAY_DIVERGENCE_DETECTED") || payload.diverged === true;
    const verified = payload.verified === true;

    // Strict validation of logs and dependencies during reconstruction to prevent unsafe execution path restore
    if (!diverged) {
      const parentSteps = extractCompletedSteps(filteredParentEvents);
      const childSteps = extractCompletedSteps(childEvents);
      const stepLimit = payload.replayStepCount ?? 0;
      
      for (let i = 0; i < stepLimit; i++) {
        const step = parentSteps[i];
        if (!step) {
          assertReplayPersistenceGap(executionId, i, parentSteps.length);
        }
        
        // Assert externality record is present in parent Events
        const extEvent = filteredParentEvents.find(
          (e) =>
            e.type === "EXTERNALITY_RECORDED" &&
            Number((e.payload as any)?.externality?.stepSequence ?? 0) === i + 1
        );
        assertRuntimeInvariant(
          "RP2",
          extEvent !== undefined,
          `Replay persistence gap violation: missing EXTERNALITY_RECORDED event for parent step sequence ${i + 1}`,
          { executionId, stepSequence: i + 1 }
        );
        
        // Assert child replayed steps match the parent steps in type and order
        const childStep = childSteps[i];
        if (childStep && step) {
          assertExternalityMetadata(executionId, childStep.type, step);
          if (childStep.type !== step.type) {
            assertOrderingReconstruction(executionId, childStep.type, step.type);
          }
        }
      }
    }

    session = {
      executionId,
      parentExecutionId: exec.parentExecutionId,
      lifecycle: payload.to ?? "REPLAY_PENDING",
      parentEvents: filteredParentEvents,
      replayStepCount: payload.replayStepCount ?? 0,
      parentEventSequenceWatermark: watermark,
      diverged,
      verified,
      eventContext: (latestTransition as any).context
    };

    if (diverged) {
      session.diverged = true;
      session.divergenceReason = payload.divergenceReason;
      session.divergenceStepIndex = payload.divergenceStepIndex;
    }

    assertSafeReplayReconstruction(executionId, session.lifecycle);
    this.sessions.set(executionId, session);
    return session;
  }

  activeExecutionIds(): ReadonlySet<string> {
    return new Set(this.sessions.keys());
  }

  /**
   * @internal Unit tests only — seeds coordinator state without loading parent events.
   */
  seedSessionForTest(session: ReplaySessionState): void {
    this.sessions.set(session.executionId, session);
  }

  /**
   * Initialize replay from parent execution event log.
   */
  async beginReplay(
    execution: Execution,
    fence?: FencingToken,
    eventContext?: EventContext
  ): Promise<ReplaySessionState | null> {
    if (!execution.parentExecutionId) return null;

    let existing = await this.getOrReconstructSession(execution.id, execution);
    if (existing) return existing;

    CentralizedReplayEnforcer.validateLegality(execution, this.activeExecutionIds());
    if (fence) {
      CentralizedReplayEnforcer.validateFence(execution, fence, "replay.begin");
    }

    // Snapshot — listByExecution returns a live bucket; replay lifecycle events
    // must not mutate the parent log view (see collectExecutionIds / parentExecutionId).
    const parentEvents = [...(await this.events.listByExecution(execution.parentExecutionId))];
    const watermark = parentEvents.reduce((max, e) => {
      const seq = Number(e.sequence ?? 0);
      return seq > max ? seq : max;
    }, 0);

    const session: ReplaySessionState = {
      executionId: execution.id,
      parentExecutionId: execution.parentExecutionId,
      lifecycle: "REPLAY_PENDING",
      parentEvents,
      replayStepCount: 0,
      parentEventSequenceWatermark: watermark,
      diverged: false,
      verified: false,
      eventContext
    };

    this.sessions.set(execution.id, session);
    await this.transitionLifecycle(session, "REPLAYING", execution, fence);
    return session;
  }

  endReplay(executionId: string): ReplaySessionState | undefined {
    const session = this.sessions.get(executionId);
    this.sessions.delete(executionId);
    return session;
  }

  /**
   * Attempt to reconstruct a step from parent persistence without live calls.
   * Returns undefined when live execution should proceed (diverged or non-replay).
   */
  async tryReconstructStep<TOutput extends Record<string, unknown>>(input: {
    execution: Execution;
    agentId: string;
    type: ExecutionStepType;
    stepInput: Record<string, unknown>;
    context: EventContext;
    publish: PublishFn;
    fence?: FencingToken;
  }): Promise<ReconstructedStep<TOutput> | undefined> {
    const session = this.sessions.get(input.execution.id);
    if (!session || session.diverged) return undefined;

    assertSafeReplayReconstruction(input.execution.id, session.lifecycle);

    if (input.fence) {
      CentralizedReplayEnforcer.validateFence(input.execution, input.fence, "replay.step");
    }

    if (input.context) {
      session.eventContext = input.context;
    }

    const parentSteps = extractCompletedSteps(session.parentEvents);
    if (session.replayStepCount >= parentSteps.length) {
      const parentExternalityEvent = session.parentEvents.find(
        (e) =>
          e.type === "EXTERNALITY_RECORDED" &&
          Number((e.payload as any)?.externality?.stepSequence ?? 0) === session.replayStepCount + 1
      );
      if (!parentExternalityEvent) {
        if (session.lifecycle === "REPLAY_EQUIVALENT" || parentSteps.length > 0) {
          return undefined;
        }
      }
    }

    const currentParentEvents = await this.events.listByExecution(session.parentExecutionId);
    if (
      parentLogStale(currentParentEvents, session.parentEventSequenceWatermark) ||
      parentLogStale(session.parentEvents, session.parentEventSequenceWatermark)
    ) {
      const narrative = "Parent event log grew after replay watermark; stale replay attempt";
      await this.handleUnsafeDivergence(session, input.execution, narrative, input.context, input.fence);
      throw new NonReconstructableReplayError(input.execution.id, narrative);
    }

    const { step: expectedStep } = findParentStepAtIndex(session.parentEvents, session.replayStepCount);

    const parentExternalityEvent = session.parentEvents.find(
      (e) =>
        e.type === "EXTERNALITY_RECORDED" &&
        Number((e.payload as any)?.externality?.stepSequence ?? 0) === session.replayStepCount + 1
    );

    const check = await this.runValidationCheckpoint(session, input, expectedStep, parentExternalityEvent);

    if (check.classification === "UNSAFE_DIVERGENCE" || check.classification === "NON_RECONSTRUCTABLE") {
      session.diverged = true;
      session.divergenceReason = check.reason;
      session.divergenceClassification = check.classification;
      session.divergenceStepIndex = session.replayStepCount;
      
      await this.handleUnsafeDivergence(session, input.execution, check.narrative, input.context, input.fence);
      if (check.classification === "NON_RECONSTRUCTABLE") {
        throw new NonReconstructableReplayError(input.execution.id, check.narrative);
      } else {
        throw new UnsafeReplayDivergenceError(input.execution.id, check.narrative);
      }
    }

    if (check.classification === "DIVERGED") {
      await this.recordDivergence(session, input.execution, input.context, input.fence, {
        reason: check.reason,
        narrative: check.narrative
      });
      return undefined;
    }

    session.replayStepCount++;
    if (session.lifecycle === "REPLAYING") {
      await this.transitionLifecycle(session, "REPLAY_EQUIVALENT", input.execution, input.fence);
    }

    const output = expectedStep!.output as TOutput;
    const completed: ExecutionStep = {
      id: expectedStep!.id,
      executionId: input.execution.id,
      agentId: input.agentId,
      type: input.type,
      status: "COMPLETED",
      input: input.stepInput,
      output,
      startedAt: expectedStep!.startedAt,
      completedAt: expectedStep!.completedAt,
      durationMs: expectedStep!.durationMs
    };

    const parentExternality = parentExternalityEvent?.payload?.externality as
      | ReplayExternalityRecord
      | undefined;
    if (parentExternality) {
      assertUnsafeRandomnessUsage(input.execution.id, parentExternality.randomnessSeed);
    }
    const nestedEmitters = this.buildNestedEmitters(session, input, completed, parentExternality);

    return { output, completed, nestedEmitters };
  }

  /**
   * Emit replayed step events (isolated to child aggregate).
   */
  async emitReconstructedStep(input: {
    execution: Execution;
    completed: ExecutionStep;
    nestedEmitters: ReconstructedStep<Record<string, unknown>>["nestedEmitters"];
    context: EventContext;
    publish: PublishFn;
    fence?: FencingToken;
  }): Promise<void> {
    const session = this.sessions.get(input.execution.id);
    if (!session) return;

    assertReplayIsolation({
      replayExecutionId: input.execution.id,
      parentExecutionId: session.parentExecutionId,
      aggregateId: input.execution.id
    });

    const startedPartial: ExecutionStep = {
      ...input.completed,
      status: "STARTED",
      output: undefined,
      completedAt: undefined,
      durationMs: undefined
    };

    await input.publish(
      this.eventFactory.create({
        type: "EXECUTION_STEP_STARTED",
        aggregateId: input.execution.id,
        aggregateType: "EXECUTION",
        payload: { step: startedPartial },
        context: input.context
      }),
      input.fence
    );

    for (const emit of input.nestedEmitters) {
      await emit((event) => input.publish(event, input.fence));
    }

    await input.publish(
      this.eventFactory.create({
        type: "EXECUTION_STEP_COMPLETED",
        aggregateId: input.execution.id,
        aggregateType: "EXECUTION",
        payload: { step: input.completed },
        context: input.context
      }),
      input.fence
    );
  }

  /**
   * Gate live tool invocation during replay.
   */
  validateLiveTool(execution: Execution, toolName: string): void {
    const session = this.sessions.get(execution.id);
    if (!session) return;

    IdempotencyPolicyEnforcer.validateReplaySafety(toolName, {
      diverged: session.diverged,
      operatorApproved: execution.input?.operatorApproved === true
    });

    const safety = mapLifecycleToSafetyClassification(session.lifecycle);
    assertSideEffectSuppressed({
      executionId: execution.id,
      diverged: session.diverged,
      safety,
      toolName
    });

    if (session.diverged) {
      void this.transitionLifecycle(session, "REPLAY_DIVERGED", execution);
    }
  }

  async markUnsafe(
    executionId: string,
    execution?: Execution,
    fence?: FencingToken,
    eventContext?: EventContext
  ): Promise<void> {
    const session = this.sessions.get(executionId);
    if (!session) return;
    if (eventContext) session.eventContext = eventContext;
    if (execution) {
      await this.transitionLifecycle(session, "REPLAY_UNSAFE", execution, fence);
    } else {
      session.lifecycle = "REPLAY_UNSAFE";
    }
  }

  async abort(
    executionId: string,
    execution?: Execution,
    fence?: FencingToken,
    eventContext?: EventContext
  ): Promise<void> {
    const session = this.sessions.get(executionId);
    if (!session) return;
    if (eventContext) session.eventContext = eventContext;
    if (execution) {
      await this.transitionLifecycle(session, "REPLAY_ABORTED", execution, fence);
    } else {
      session.lifecycle = "REPLAY_ABORTED";
    }
  }

  /**
   * Verify prefix equivalence and mark REPLAY_VERIFIED on full success.
   */
  async finalize(
    execution: Execution,
    completedSuccessfully: boolean,
    fence?: FencingToken,
    eventContext?: EventContext
  ): Promise<ReplaySessionState | undefined> {
    const session = this.sessions.get(execution.id);
    if (!session) return undefined;

    if (eventContext) session.eventContext = eventContext;

    if (!completedSuccessfully) {
      if (session.lifecycle !== "REPLAY_UNSAFE") {
        await this.transitionLifecycle(session, "REPLAY_ABORTED", execution, fence);
      }
      return session;
    }

    if (!session.diverged) {
      const parentSteps = extractCompletedSteps(session.parentEvents);
      if (session.replayStepCount === parentSteps.length) {
        if (session.lifecycle !== "REPLAY_VERIFIED") {
          await this.transitionLifecycle(session, "REPLAY_VERIFIED", execution, fence);
        }
        session.verified = true;
      }
    } else if (session.lifecycle === "REPLAY_DIVERGED") {
      // Diverged but completed under sandbox — verified for audit trail only
      session.verified = false;
    }

    return session;
  }

  buildLifecycleTransitionEvent(
    session: ReplaySessionState,
    from: ReplayLifecycleStatus,
    to: ReplayLifecycleStatus,
    context: EventContext
  ): ReturnType<EventFactory["create"]> {
    return this.eventFactory.create({
      type: "REPLAY_LIFECYCLE_TRANSITIONED",
      aggregateId: session.executionId,
      aggregateType: "EXECUTION",
      payload: {
        executionId: session.executionId,
        parentExecutionId: session.parentExecutionId,
        from,
        to,
        diverged: session.diverged,
        replayStepCount: session.replayStepCount,
        verified: session.verified,
        divergenceReason: session.divergenceReason,
        safety: mapLifecycleToSafetyClassification(to),
        parentEventSequenceWatermark: session.parentEventSequenceWatermark
      },
      context
    });
  }

  private async transitionLifecycle(
    session: ReplaySessionState,
    to: ReplayLifecycleStatus,
    execution: Execution,
    fence?: FencingToken
  ): Promise<void> {
    const from = session.lifecycle;
    if (from === to) return;
    assertReplayLifecycleAdvance(session.executionId, from, to);
    session.lifecycle = to;

    const context = session.eventContext ?? { traceId: session.executionId };
    const lifecycleEvent = this.buildLifecycleTransitionEvent(session, from, to, context);

    try {
      await this.executions.commitTransition({
        execution,
        events: [lifecycleEvent],
        fence
      });

      const isOutbox = this.executions.isOutboxEnabled?.();
      if (!isOutbox) {
        await this.publisher.publish(lifecycleEvent);
      }
    } catch (err) {
      // Lifecycle telemetry must not abort replay reconstruction; observability
      // consumers read REPLAY_DIVERGENCE_DETECTED / step events as source of truth.
      if (err instanceof Error && err.name === "FencingViolationError") {
        return;
      }
      throw err;
    }
  }

  private async recordDivergence(
    session: ReplaySessionState,
    execution: Execution,
    context: EventContext,
    fence: FencingToken | undefined,
    input: { reason: ReplayDivergenceReason; narrative: string }
  ): Promise<void> {
    session.diverged = true;
    session.divergenceReason = input.reason;
    session.divergenceStepIndex = session.replayStepCount;
    await this.transitionLifecycle(session, "REPLAY_DIVERGED", execution, fence);

    const payload: ReplayDivergencePayload = {
      sourceExecutionId: session.parentExecutionId,
      replayExecutionId: session.executionId,
      divergenceStepIndex: session.replayStepCount,
      reason: input.reason,
      narrative: input.narrative,
      lifecycle: session.lifecycle
    };

    const divergenceEvent = this.eventFactory.create({
      type: "REPLAY_DIVERGENCE_DETECTED",
      aggregateId: execution.id,
      aggregateType: "EXECUTION",
      payload: payload as any,
      context
    });

    await this.executions.commitTransition({
      execution,
      events: [divergenceEvent],
      fence
    });

    const isOutbox = this.executions.isOutboxEnabled?.();
    if (!isOutbox) {
      await this.publisher.publish(divergenceEvent);
    }
  }

  private divergenceNarrative(
    session: ReplaySessionState,
    type: ExecutionStepType,
    reason: ReplayDivergenceReason,
    expected?: ExecutionStep
  ): string {
    switch (reason) {
      case "MISSING_STEP":
        return `Replay diverged: missing step at sequence ${session.replayStepCount} in original events`;
      case "ORDER_MISMATCH":
        return `Replay diverged: step order mismatch: expected ${expected?.type ?? "unknown"}, got ${type}`;
      case "STALE_PARENT_LOG":
        return "Replay diverged: parent log advanced beyond replay watermark";
      default:
        return `Replay diverged due to input mismatch on step ${session.replayStepCount} (${type})`;
    }
  }

  private buildNestedEmitters(
    session: ReplaySessionState,
    input: {
      execution: Execution;
      type: ExecutionStepType;
      stepInput: Record<string, unknown>;
      context: EventContext;
    },
    completed: ExecutionStep,
    parentExternality: any
  ): ReconstructedStep<Record<string, unknown>>["nestedEmitters"] {
    const emitters: ReconstructedStep<Record<string, unknown>>["nestedEmitters"] = [];

    // Always emit the child-scoped EXTERNALITY_RECORDED event to ensure child execution logs are self-contained
    if (parentExternality) {
      emitters.push(async (publish) => {
        await publish(
          this.eventFactory.create({
            type: "EXTERNALITY_RECORDED",
            aggregateId: input.execution.id,
            aggregateType: "EXECUTION",
            payload: {
              externality: {
                ...parentExternality,
                id: createId(),
                executionId: input.execution.id,
                replayMetadata: {
                  replayedFromExecutionId: session.parentExecutionId,
                  originalExternalityId: parentExternality.id
                }
              }
            },
            context: input.context
          })
        );
      });
    }

    if (input.type === "MEMORY_RETRIEVAL") {
      const retrievedEvent = session.parentEvents.find((e) => e.type === "MEMORY_RETRIEVED");
      const records = parentExternality?.llmOutput?.records ?? retrievedEvent?.payload?.records ?? [];
      emitters.push(async (publish) => {
        await publish(
          this.eventFactory.create({
            type: "MEMORY_RETRIEVED",
            aggregateId: input.execution.id,
            aggregateType: "EXECUTION",
            payload: { records, query: input.stepInput.query },
            context: input.context
          })
        );
      });
    } else if (input.type === "MODEL_GENERATION") {
      const completedEvent = session.parentEvents.find((e) => e.type === "MODEL_COMPLETED");
      const payload = parentExternality?.providerResponse ?? completedEvent?.payload ?? {
        output: parentExternality?.llmOutput,
        tokenUsage: { prompt: 0, completion: 0, total: 0 }
      };
      emitters.push(async (publish) => {
        await publish(
          this.eventFactory.create({
            type: "MODEL_COMPLETED",
            aggregateId: input.execution.id,
            aggregateType: "EXECUTION",
            payload,
            context: input.context
          })
        );
      });
    } else if (input.type === "TOOL_CALL") {
      const toolName = String(input.stepInput.toolName ?? "");
      const toolCalledEvent = session.parentEvents.find(
        (e) =>
          e.type === "TOOL_CALLED" && (e.payload?.toolCall as { toolName?: string })?.toolName === toolName
      );
      const originalToolCall = toolCalledEvent?.payload?.toolCall as Record<string, unknown>;
      const output = parentExternality?.toolOutput ?? originalToolCall?.output;
      
      emitters.push(async (publish) => {
        await publish(
          this.eventFactory.create({
            type: "TOOL_CALLED",
            aggregateId: input.execution.id,
            aggregateType: "EXECUTION",
            payload: {
              toolCall: {
                ...(originalToolCall ?? {}),
                id: createId(),
                executionId: input.execution.id,
                stepId: completed.id,
                toolName,
                input: input.stepInput.args ?? originalToolCall?.input ?? {},
                output,
                status: parentExternality?.sideEffectMetadata?.status ?? originalToolCall?.status ?? "COMPLETED",
                createdAt: parentExternality?.timestamp ?? originalToolCall?.createdAt
              }
            },
            context: input.context
          })
        );
      });
    }

    return emitters;
  }

  async runValidationCheckpoint(
    session: ReplaySessionState,
    input: {
      execution: Execution;
      type: ExecutionStepType;
      stepInput: Record<string, unknown>;
      context: EventContext;
      fence?: FencingToken;
    },
    expectedStep: ExecutionStep | undefined,
    parentExternalityEvent: DomainEvent | undefined
  ): Promise<{ classification: "EQUIVALENT" | "ACCEPTABLE_VARIANCE" | "DIVERGED" | "UNSAFE_DIVERGENCE" | "NON_RECONSTRUCTABLE"; reason: ReplayDivergenceReason; narrative: string }> {
    return CentralizedReplayEnforcer.runValidationCheckpoint({
      executionId: input.execution.id,
      replayStepCount: session.replayStepCount,
      lifecycle: session.lifecycle,
      expectedStep,
      parentExternalityEvent,
      actualType: input.type,
      actualInput: input.stepInput
    }) as any;
  }

  async handleUnsafeDivergence(
    session: ReplaySessionState,
    execution: Execution,
    reason: string,
    context: EventContext,
    fence?: FencingToken
  ): Promise<void> {
    await this.markUnsafe(execution.id, execution, fence, context);

    const reconciledExec: Execution = {
      ...execution,
      status: "RECONCILIATION_REQUIRED",
      failure: {
        message: reason,
        code: "AMBIGUOUS_EXTERNAL_COMMIT",
        recoverable: false
      },
      updatedAt: toIso(new Date())
    };

    const reconciliationRequiredEvent = this.eventFactory.create({
      type: "EXECUTION_RECONCILIATION_REQUIRED",
      aggregateId: execution.id,
      aggregateType: "EXECUTION",
      payload: {
        executionId: execution.id,
        toolName: "replay_divergence_detector",
        idempotencyKey: `reconciliation-${execution.id}`,
        stepSequence: session.replayStepCount + 1,
        args: { reason },
        message: reason
      },
      context
    });

    await this.executions.commitTransition({
      execution: reconciledExec,
      events: [reconciliationRequiredEvent],
      fence
    });

    const isOutbox = this.executions.isOutboxEnabled?.();
    if (!isOutbox) {
      await this.publisher.publish(reconciliationRequiredEvent);
    }
  }
}

