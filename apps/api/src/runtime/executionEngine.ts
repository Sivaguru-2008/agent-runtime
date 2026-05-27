import type { EventFactory, EventContext } from "../infrastructure/events/eventFactory.js";
import type { PersistedEventPublisher } from "../infrastructure/events/persistedEventPublisher.js";
import { withSpan } from "../infrastructure/telemetry/tracing.js";
import type { Clock } from "../shared/clock.js";
import { toIso } from "../shared/clock.js";
import { createId } from "../shared/id.js";
import { canonicalize, deterministicId, syncFingerprint } from "../shared/determinism.js";
import type { DomainEvent, DomainEventType } from "../domain/events.js";
import type { ExecutionCheckpoint } from "../domain/cluster.js";
import type { CheckpointStore, FencingToken } from "../domain/clusterPorts.js";
import type { Agent, Execution, ExecutionStep, MemoryRecord, ToolCallRecord } from "../domain/model.js";
import type { ExecutionRepository, MemoryRepository, ModelProvider, ToolExecutor } from "../domain/ports.js";
import { throwIfAborted } from "../providers/retry.js";

/**
 * Sentinel thrown by the fenced-publish helper when a stale worker's
 * execution-scoped event is rejected at the persistence boundary. Caught
 * inside execute() at well-defined surrender points; collapses the remainder
 * of the execution flow without running further steps, further model calls,
 * or further state mutations.
 *
 * NOT exported — callers outside the engine should never see this; it's
 * a control-flow sentinel, not a real failure mode. The engine converts
 * it into the same silent-surrender semantics the existing FENCED branches
 * already produce.
 */
class StaleWorkerSurrender extends Error {
  readonly name = "StaleWorkerSurrender";
  constructor(public readonly eventType: DomainEventType, executionId: string) {
    super(`stale-worker surrender on ${eventType} for ${executionId}`);
  }
}

/**
 * Optional lease ownership validator injected by the scheduler.
 *
 * The engine calls this before writing the final execution result. If the
 * validator returns false (lease was reclaimed by another worker or expired),
 * the engine aborts with FencingViolationError rather than writing corrupted
 * state over a result that a legitimate new worker may have already produced.
 *
 * Operational impact:
 *   Fencing violations surface as EXECUTION_FENCE_VIOLATED events and are
 *   non-recoverable from the current execution — the execution has already
 *   been re-enqueued by the recovery loop. The stale worker simply stops.
 *
 * Replay safety:
 *   The fencing token (= lease.attempt at acquisition time) is monotonically
 *   increasing. If a replay reprocesses the same execution, it will acquire
 *   a new lease with a higher attempt count. The stale worker's token will
 *   not match and it will be correctly rejected.
 */
export type LeaseValidator = (executionId: string) => Promise<boolean>;

export class FencingViolationError extends Error {
  readonly name = "FencingViolationError";
  constructor(public readonly executionId: string, public readonly workerId: string) {
    super(
      `Fencing violation: worker '${workerId}' lost ownership of execution '${executionId}' — aborting write to prevent state corruption`
    );
  }
}

export interface ExecuteTaskInput {
  agent: Agent;
  execution: Execution;
  task: Record<string, unknown>;
  context?: EventContext;
  workerId?: string;
  /**
   * Callback provided by the scheduler to atomically verify that this worker
   * still owns the lease before committing the execution result. If absent,
   * no fencing check is performed (safe for single-worker / test deployments).
   *
   * NOTE: With `fence` set (below), validateLease is an *optional* cheap
   * pre-check that lets the engine surrender before performing expensive
   * post-model setup. The authoritative correctness check is the conditional
   * SQL write inside saveFenced/addFenced — validateLease alone is advisory.
   */
  validateLease?: LeaseValidator;
  /**
   * Fencing token captured at lease acquisition. When provided, the engine
   * routes every status-mutating durable write (executions.save for RUNNING/
   * COMPLETED/FAILED, memory.add for the terminal TASK_HISTORY) through the
   * adapter's fenced variant. The adapter performs a conditional write that
   * commits ONLY if the lease still matches this token — no stale-worker
   * write can stomp a legitimate terminal state.
   *
   * Omit for legacy / single-worker / unit-test contexts where the lease
   * substrate isn't present; the engine falls back to unconditional writes.
   */
  fence?: FencingToken;
  /**
   * Cancellation signal forwarded to the model provider. The worker loop
   * owns this controller and aborts it when the lease is lost mid-execution
   * (so the model call interrupts immediately instead of running to
   * completion and being fenced out at the end). The engine also pre-checks
   * the signal at the top of execute() so a pre-aborted signal never even
   * runs the RUNNING save. Optional — callers that omit it get the
   * pre-existing behavior unchanged.
   */
  signal?: AbortSignal;
  /**
   * Why the caller might abort. Stamped onto EXECUTION_ABORTED so consumers
   * can distinguish operator-issued cancellation, lease-recovery aborts,
   * and graceful-drain aborts without re-deriving from log context.
   * Defaults to "manual" when omitted — the existing behavior.
   */
  abortReason?: ExecutionAbortReason;
}

export type ExecutionAbortReason = "lease-lost" | "shutdown" | "manual";

export interface ExecutionEngineDeps {
  checkpoints?: CheckpointStore;
  workerId?: string;
}

export class ExecutionEngine {
  private readonly checkpoints?: CheckpointStore;
  private readonly defaultWorkerId?: string;

  constructor(
    private readonly eventFactory: EventFactory,
    private readonly publisher: PersistedEventPublisher,
    private readonly executions: ExecutionRepository,
    private readonly memory: MemoryRepository,
    private readonly modelProvider: ModelProvider,
    private readonly tools: ToolExecutor,
    private readonly clock: Clock,
    deps: ExecutionEngineDeps = {}
  ) {
    this.checkpoints = deps.checkpoints;
    this.defaultWorkerId = deps.workerId;
  }

  private async writeCheckpoint(
    executionId: string,
    phase: ExecutionCheckpoint["phase"],
    sequence: number,
    state: Record<string, unknown>,
    context: EventContext,
    workerId?: string,
    fence?: FencingToken
  ): Promise<void> {
    if (!this.checkpoints) return;
    const owner = workerId ?? this.defaultWorkerId ?? "local";
    const checkpoint: ExecutionCheckpoint = {
      id: createId(),
      executionId,
      workerId: owner,
      sequence,
      phase,
      state,
      createdAt: toIso(this.clock.now())
    };

    // Checkpoints are the authoritative recovery anchor — if the fence is
    // already invalid we MUST NOT write one (a stale worker's checkpoint
    // would shift subsequent crash recovery to a snapshot the legitimate
    // owner never produced). Route through writeFenced and surrender on
    // FENCED, identical to the publish path.
    if (fence) {
      const outcome = await this.checkpoints.writeFenced(checkpoint, fence);
      if (outcome === "FENCED") {
        await this.emitFenceRejected(
          executionId,
          owner,
          phase,
          `checkpoint.${phase}`,
          context
        );
        throw new StaleWorkerSurrender("EXECUTION_CHECKPOINT_WRITTEN", executionId);
      }
    } else {
      await this.checkpoints.write(checkpoint);
    }

    await this.publishExecutionScoped(
      this.eventFactory.create({
        type: "EXECUTION_CHECKPOINT_WRITTEN",
        aggregateId: executionId,
        aggregateType: "EXECUTION",
        payload: { checkpoint },
        context
      }),
      fence
    );
  }

  /**
   * Validate lease ownership before committing any state that would survive
   * process restart. Called immediately before writing the final execution
   * result to prevent a stale-worker double-write.
   *
   * NOTE: With saveFenced/addFenced this is now an advisory optimization
   * (cheap early-exit before the more expensive memory.add round-trip).
   * The authoritative check is the conditional SQL write inside the fenced
   * variants — those collapse the TOCTOU window that this advisory call
   * alone could not.
   */
  private async assertFencing(input: ExecuteTaskInput, execution: Execution): Promise<void> {
    if (!input.validateLease) return;
    const valid = await input.validateLease(execution.id);
    if (!valid) {
      throw new FencingViolationError(execution.id, input.workerId ?? this.defaultWorkerId ?? "unknown");
    }
  }

  /**
   * Emit EXECUTION_FENCE_REJECTED for a fenced-write surrender. Used by every
   * call site where saveFenced/addFenced returns "FENCED" — uniform payload
   * shape so consumers can correlate the lost-write across phases.
   *
   * Payload extension: `phase` records which durable write was rejected
   * ("executions.RUNNING" | "executions.COMPLETED" | "executions.FAILED" |
   * "memory.add"). The pre-existing `attemptedStatus` field is retained so
   * existing consumers continue to work; `phase` is additive context.
   */
  private async emitFenceRejected(
    executionId: string,
    workerId: string,
    attemptedStatus: Execution["status"] | ExecutionCheckpoint["phase"],
    phase:
      | "executions.RUNNING"
      | "executions.COMPLETED"
      | "executions.FAILED"
      | "memory.add"
      | `checkpoint.${ExecutionCheckpoint["phase"]}`,
    context: EventContext,
    originalError?: string
  ): Promise<void> {
    // EXECUTION_FENCE_REJECTED is itself a diagnostic surrender event. It is
    // intentionally NOT fenced — emitting it requires no lease ownership, and
    // its purpose is precisely to record that the worker lost authority.
    // Routing it through publishFenced would create a chicken-and-egg loop
    // (the publisher would reject the rejection event).
    await this.publisher.publish(
      this.eventFactory.create({
        type: "EXECUTION_FENCE_REJECTED",
        aggregateId: executionId,
        aggregateType: "EXECUTION",
        payload: {
          executionId,
          workerId,
          attemptedStatus,
          phase,
          ...(originalError !== undefined ? { originalError } : {})
        },
        context
      })
    );
  }

  /**
   * Authoritative emission helper for execution-scoped events from the
   * worker-owned hot path.
   *
   * When `fence` is supplied:
   *   - The event is routed through publisher.publishFenced(), which performs
   *     atomic lease validation INSIDE the events INSERT transaction.
   *   - On a FENCED outcome we throw StaleWorkerSurrender — caught at the
   *     execute() boundary, where it short-circuits any remaining steps,
   *     skips terminal save, and (if no FENCE_REJECTED has been emitted
   *     yet for this surrender) emits one as the single diagnostic
   *     breadcrumb. The thrown sentinel keeps the engine's control flow
   *     uniform: no scattered `if (result.outcome === "FENCED") return` at
   *     every emission site, no silent-continue bugs where a later step
   *     accidentally writes after authority was lost.
   *
   * When `fence` is absent (legacy single-worker / unit-test contexts):
   *   - Falls back to publisher.publish() — pre-existing behavior unchanged.
   *
   * Why a single helper rather than per-site fan-out:
   *   The audit's invariant is "ZERO replay-visible artifacts after losing
   *   authority." That requires every execution-scoped emission to use the
   *   same gate; a single helper makes the gate impossible to forget. A
   *   future event added to runStep/runToolStep automatically inherits the
   *   fencing contract.
   */
  private async publishExecutionScoped(
    event: DomainEvent,
    fence: FencingToken | undefined
  ): Promise<void> {
    if (!fence) {
      await this.publisher.publish(event);
      return;
    }
    const result = await this.publisher.publishFenced(event, fence);
    if (result.outcome === "FENCED") {
      throw new StaleWorkerSurrender(event.type, fence.executionId);
    }
  }

  async execute(input: ExecuteTaskInput): Promise<Execution> {
    const context = input.context ?? { traceId: createId() };
    const workerId = input.workerId ?? this.defaultWorkerId;

    // Pre-execute abort short-circuit. If the caller already cancelled the
    // signal before calling execute() (lease lost during job pickup, drain
    // already in progress), surrender immediately without writing RUNNING.
    // Same surrender contract as the fence-rejection path: return the input
    // execution by reference, no save, single EXECUTION_ABORTED event.
    //
    // The ABORTED event is execution-scoped: a stale worker that wakes up
    // post-reclaim and finds its signal aborted must NOT pollute replay
    // with an ABORTED event the legitimate new owner didn't produce. Route
    // through publishExecutionScoped; if fenced, the diagnostic counter is
    // emitted by the publisher and nothing reaches replay. We deliberately
    // swallow the StaleWorkerSurrender here — the engine's pre-abort path
    // has no further work to do and the legitimate owner will produce the
    // terminal outcome.
    if (input.signal?.aborted) {
      try {
        await this.publishExecutionScoped(
          this.eventFactory.create({
            type: "EXECUTION_ABORTED",
            aggregateId: input.execution.id,
            aggregateType: "EXECUTION",
            payload: {
              executionId: input.execution.id,
              workerId: workerId ?? "unknown",
              reason: input.abortReason ?? "manual"
            },
            context
          }),
          input.fence
        );
      } catch (e) {
        if (!(e instanceof StaleWorkerSurrender)) throw e;
      }
      return input.execution;
    }

    const execution: Execution = {
      ...input.execution,
      status: "RUNNING",
      updatedAt: toIso(this.clock.now())
    };

    // Fenced RUNNING save — closes the window where a GC-paused worker wakes
    // up AFTER the legitimate new owner has already written COMPLETED, and
    // would otherwise regress the row to RUNNING with its stale snapshot.
    // The fenced UPSERT commits only if this worker's token still matches
    // the live lease; otherwise the engine surrenders without any further
    // mutation or event emission for this execution.
    if (input.fence) {
      const outcome = await this.executions.saveFenced(execution, input.fence);
      if (outcome === "FENCED") {
        await this.emitFenceRejected(
          execution.id,
          workerId ?? "unknown",
          "RUNNING",
          "executions.RUNNING",
          context
        );
        return input.execution;
      }
    } else {
      await this.executions.save(execution);
    }
    await this.publishExecutionScoped(
      this.eventFactory.create({
        type: "EXECUTION_STARTED",
        aggregateId: execution.id,
        aggregateType: "EXECUTION",
        payload: { execution },
        context
      }),
      input.fence
    );
    await this.writeCheckpoint(execution.id, "INITIALIZED", 0, { task: input.task }, context, workerId, input.fence);

    let stepSequence = 0;

    try {
      throwIfAborted(input.signal);
      const plan = await this.runStep(input.agent, execution, "PLANNING", { task: input.task }, async () => ({
        objective: input.agent.goal,
        task: input.task,
        next: ["MEMORY_RETRIEVAL", "TOOL_CALL", "MODEL_GENERATION"]
      }), context, input.signal, input.fence);
      await this.writeCheckpoint(execution.id, "PLANNING", ++stepSequence, { plan }, context, workerId, input.fence);

      throwIfAborted(input.signal);
      const query = String(input.task.prompt ?? input.task.goal ?? input.agent.goal);
      const memories = await this.runStep(input.agent, execution, "MEMORY_RETRIEVAL", { query }, async () => {
        const records = (await this.memory.search(input.agent.id, query, input.agent.memoryPolicy.maxRetrievedItems))
          .map((record, index) => ({
            ...record,
            metadata: {
              ...record.metadata,
              retrievalScore: Number((1 - index * 0.13).toFixed(2)),
              influenceReason: index === 0 ? "highest lexical overlap with task prompt" : "recent task context"
            }
          }));
        await this.publishExecutionScoped(
          this.eventFactory.create({
            type: "MEMORY_RETRIEVED",
            aggregateId: execution.id,
            aggregateType: "EXECUTION",
            payload: { records, query },
            context
          }),
          input.fence
        );
        return { records };
      }, context, input.signal, input.fence);
      await this.writeCheckpoint(execution.id, "MEMORY_RETRIEVAL", ++stepSequence, { query, recordCount: (memories.records ?? []).length }, context, workerId, input.fence);

      throwIfAborted(input.signal);
      const enabledTools = input.agent.tools.filter((tool) => tool.enabled);
      for (const enabledTool of enabledTools) {
        throwIfAborted(input.signal);
        // Audit CRITICAL-1: pass the deterministic stepSequence so the tool
        // dedup key is stable across redelivery / replay. Without this, a
        // redelivered job would compute a different key (because step.id is
        // a fresh createId() per process invocation) and the dedup table
        // would miss — defeating the entire wrapper.
        await this.runToolStep(input.agent, execution, enabledTool.name, { plan }, context, input.signal, input.fence, stepSequence + 1);
        await this.writeCheckpoint(execution.id, "TOOL_CALL", ++stepSequence, { tool: enabledTool.name }, context, workerId, input.fence);
      }

      throwIfAborted(input.signal);
      const prompt = JSON.stringify({
        goal: input.agent.goal,
        task: input.task,
        plan,
        memories
      });

      const modelResult = await this.runStep(input.agent, execution, "MODEL_GENERATION", { prompt }, async () => {
        const contextRecords = (memories.records ?? []) as MemoryRecord[];
        const result = await this.modelProvider.complete({
          agent: input.agent,
          execution,
          prompt,
          context: contextRecords,
          // Forward the caller's cancellation signal so a worker that loses
          // its lease mid-call can interrupt the (potentially long) model
          // request instead of spending tokens for an outcome that will be
          // discarded by the post-execute fencing check.
          signal: input.signal
        });
        await this.publishExecutionScoped(
          this.eventFactory.create({
            type: "MODEL_COMPLETED",
            aggregateId: execution.id,
            aggregateType: "EXECUTION",
            payload: result,
            context
          }),
          input.fence
        );
        return result;
      }, context, input.signal, input.fence);

      await this.writeCheckpoint(execution.id, "MODEL_GENERATION", ++stepSequence, { tokenUsage: modelResult.tokenUsage }, context, workerId, input.fence);

      // Fencing check — validate lease ownership before any state-mutating
      // writes. This is the last barrier preventing a stale worker from
      // overwriting state already committed by the legitimate new owner.
      throwIfAborted(input.signal);
      await this.assertFencing(input, execution);

      const completed: Execution = {
        ...execution,
        status: "COMPLETED",
        output: modelResult.output as Record<string, unknown>,
        tokenUsage: modelResult.tokenUsage,
        completedAt: toIso(this.clock.now()),
        updatedAt: toIso(this.clock.now())
      };

      // Second advisory fencing pre-check, immediately before the first
      // durable write of the success path.
      throwIfAborted(input.signal);
      await this.assertFencing(input, execution);

      const memoryRecord: MemoryRecord = {
        id: createId(),
        agentId: input.agent.id,
        executionId: execution.id,
        type: "TASK_HISTORY",
        content: `Task completed: ${JSON.stringify(input.task).slice(0, 500)}`,
        metadata: { executionId: execution.id, tokenUsage: completed.tokenUsage },
        createdAt: toIso(this.clock.now()),
        // C-1: stamp the originating tenant on every persisted memory record
        // so the postgres adapter writes the correct tenant_id rather than
        // silently falling back to the schema's 'system' default.
        tenantId: execution.tenantId ?? input.agent.tenantId
      };

      const terminalEvent = this.eventFactory.create({
        type: "EXECUTION_COMPLETED",
        aggregateId: execution.id,
        aggregateType: "EXECUTION",
        payload: { execution: completed },
        context
      });

      const outcome = await this.executions.commitTerminal({
        execution: completed,
        event: terminalEvent,
        memoryRecord,
        checkpoint: { status: "COMPLETED" },
        checkpointSequence: ++stepSequence,
        fence: input.fence
      });

      if (outcome === "FENCED") {
        await this.emitFenceRejected(
          execution.id,
          workerId ?? "unknown",
          "COMPLETED",
          "executions.COMPLETED",
          context
        );
        return input.execution;
      }

      // If outbox dispatcher is disabled (e.g. in-memory or fallback), broadcast directly
      const isOutbox = this.executions.isOutboxEnabled && this.executions.isOutboxEnabled();
      if (!isOutbox) {
        await this.publisher.publishDurable(terminalEvent);
      }

      return completed;
    } catch (error) {
      const originalMessage =
        error instanceof Error ? error.message : "Unknown execution error";

      // Cancellation: AbortSignal-triggered failures are NOT real failures —
      // the caller asked us to stop. Surrender the same way the fence-
      // rejection branch does: no save, no EXECUTION_FAILED, single
      // EXECUTION_ABORTED event. Must run BEFORE the fencing check so an
      // aborted execution doesn't accidentally consume a lease validation
      // round-trip. AbortError detection covers both DOMException-based
      // aborts (the standard) and Node's name="AbortError" convention.
      const isAbort =
        error instanceof Error &&
        (error.name === "AbortError" || input.signal?.aborted === true);
      if (isAbort) {
        try {
          await this.publishExecutionScoped(
            this.eventFactory.create({
              type: "EXECUTION_ABORTED",
              aggregateId: execution.id,
              aggregateType: "EXECUTION",
              payload: {
                executionId: execution.id,
                workerId: workerId ?? "unknown",
                reason: input.abortReason ?? "manual"
              },
              context
            }),
            input.fence
          );
        } catch (e) {
          // Same posture as the pre-execute abort branch: if our fence is
          // already gone we still need to surrender silently. The diagnostic
          // counter has been recorded by the publisher.
          if (!(e instanceof StaleWorkerSurrender)) throw e;
        }
        return input.execution;
      }

      // If a fenced step/memory/model emission surrendered, treat it as a
      // silent stop: every prior fenced emit was rejected at the persistence
      // boundary (nothing in replay), and no further state mutation is safe
      // because our lease is dead. The publisher already recorded the
      // diagnostic counter on the rejected event; we return the input
      // execution by reference, matching the existing fence-rejection surrender.
      if (error instanceof StaleWorkerSurrender) {
        return input.execution;
      }

      // Symmetric fencing: the success path validates lease ownership before
      // committing COMPLETED. The failure path must do the same before
      // committing FAILED — otherwise a stale worker whose lease was already
      // reclaimed will overwrite a terminal state already produced by the
      // legitimate new owner. The check is opt-in (no validator → no check),
      // matching the success path's behavior and keeping single-worker tests
      // unaffected.
      if (input.validateLease) {
        let leaseValid = false;
        try {
          leaseValid = await input.validateLease(execution.id);
        } catch {
          // Loss of contact with the lease store is treated as "cannot prove
          // ownership" — fail closed and surrender. Same posture as an
          // explicit revocation.
          leaseValid = false;
        }
        if (!leaseValid) {
          // Use the unified emitFenceRejected helper so all surrender paths
          // produce a consistent payload shape (executionId, workerId,
          // attemptedStatus, phase, originalError?). The `phase` field lets
          // consumers correlate whether the advisory check or the SQL fence
          // caught the lost lease.
          await this.emitFenceRejected(
            execution.id,
            input.workerId ?? this.defaultWorkerId ?? "unknown",
            "FAILED",
            "executions.FAILED",
            context,
            originalMessage
          );
          // Return the input.execution unchanged — no save, no FAILED event.
          // The legitimate new owner's outcome (already committed elsewhere)
          // is preserved.
          return input.execution;
        }
      }

      const failed: Execution = {
        ...execution,
        status: "FAILED",
        failure: {
          message: originalMessage,
          recoverable: true
        },
        completedAt: toIso(this.clock.now()),
        updatedAt: toIso(this.clock.now())
      };

      const terminalEvent = this.eventFactory.create({
        type: "EXECUTION_FAILED",
        aggregateId: execution.id,
        aggregateType: "EXECUTION",
        payload: { execution: failed },
        context
      });

      const outcome = await this.executions.commitTerminal({
        execution: failed,
        event: terminalEvent,
        fence: input.fence
      });

      if (outcome === "FENCED") {
        await this.emitFenceRejected(
          execution.id,
          workerId ?? "unknown",
          "FAILED",
          "executions.FAILED",
          context,
          originalMessage
        );
        return input.execution;
      }

      // If outbox dispatcher is disabled, publish directly to bus
      const isOutbox = this.executions.isOutboxEnabled && this.executions.isOutboxEnabled();
      if (!isOutbox) {
        await this.publisher.publishDurable(terminalEvent);
      }

      return failed;
    }
  }

  private async runStep<TOutput extends Record<string, unknown>>(
    agent: Agent,
    execution: Execution,
    type: ExecutionStep["type"],
    stepInput: Record<string, unknown>,
    fn: (step: ExecutionStep) => Promise<TOutput>,
    context: EventContext,
    signal?: AbortSignal,
    fence?: FencingToken
  ): Promise<TOutput> {
    throwIfAborted(signal);
    return withSpan(`execution.step.${type.toLowerCase()}`, {
      "agent.id": agent.id,
      "execution.id": execution.id,
      "execution.step.type": type
    }, async () => {
      const startedAt = this.clock.now();
      const started: ExecutionStep = {
        id: createId(),
        executionId: execution.id,
        agentId: agent.id,
        type,
        status: "STARTED",
        input: stepInput,
        startedAt: toIso(startedAt)
      };

      await this.publishExecutionScoped(
        this.eventFactory.create({
          type: "EXECUTION_STEP_STARTED",
          aggregateId: execution.id,
          aggregateType: "EXECUTION",
          payload: { step: started },
          context
        }),
        fence
      );

      throwIfAborted(signal);
      const output = await fn(started);
      throwIfAborted(signal);

      const completedAt = this.clock.now();
      const completed: ExecutionStep = {
        ...started,
        status: "COMPLETED",
        output,
        completedAt: toIso(completedAt),
        durationMs: completedAt.getTime() - startedAt.getTime()
      };

      await this.publishExecutionScoped(
        this.eventFactory.create({
          type: "EXECUTION_STEP_COMPLETED",
          aggregateId: execution.id,
          aggregateType: "EXECUTION",
          payload: { step: completed },
          context
        }),
        fence
      );

      return output;
    });
  }

  private async runToolStep(
    agent: Agent,
    execution: Execution,
    toolName: string,
    args: Record<string, unknown>,
    context: EventContext,
    signal?: AbortSignal,
    fence?: FencingToken,
    stepSequence?: number
  ): Promise<void> {
    await this.runStep(agent, execution, "TOOL_CALL", { toolName, args }, async (step) => {
      const started = this.clock.now();
      // Canonical fence protocol (docs/specs/fence-protocol.md §B.2):
      //
      // The idempotency key is `sha256(executionId || ':' || stepSeq)` —
      // it does NOT include args or tool name. This is intentional:
      //
      //   • Stability across retries: the LLM may produce slightly drifted
      //     args between attempts. Keying on args would mint a new key,
      //     defeat the remote idem-key cache, and let a duplicate
      //     side effect through. Keying on (executionId, stepSeq) keeps
      //     retries on a single remote dedupe slot.
      //
      //   • Drift detection lives in `argsHash` (a sibling column). The
      //     dedup store surfaces `ARG_DRIFT` on retry when the recorded
      //     and observed hashes disagree (invariant I5). The engine
      //     refuses to silently re-execute under that condition.
      //
      // When stepSequence is not supplied (legacy in-process tests), we
      // fall back to the pre-spec args-inclusive key. That preserves the
      // prior behaviour for old callers but disables the fence protocol's
      // drift guarantee; new callers are expected to thread stepSequence.
      const argsHash = syncFingerprint(args);
      const idempotencyKey = stepSequence !== undefined
        ? deterministicId([execution.id, `seq:${stepSequence}`])
        : deterministicId([execution.id, `step:${step.id}`, toolName, canonicalize(args)]);
      const output = await this.tools.execute({
        toolName,
        args,
        agentId: agent.id,
        executionId: execution.id,
        signal,
        idempotencyKey,
        attempt: fence?.attempt,
        ...(stepSequence !== undefined ? { stepSeq: stepSequence, argsHash } : {})
      });
      const completed = this.clock.now();
      const toolCall: ToolCallRecord = {
        id: createId(),
        executionId: execution.id,
        stepId: step.id,
        toolName,
        input: args,
        output,
        status: "COMPLETED",
        durationMs: completed.getTime() - started.getTime(),
        createdAt: toIso(completed)
      };

      await this.publishExecutionScoped(
        this.eventFactory.create({
          type: "TOOL_CALLED",
          aggregateId: execution.id,
          aggregateType: "EXECUTION",
          payload: { toolCall },
          context
        }),
        fence
      );

      return { toolCall };
    }, context, signal, fence);
  }
}
