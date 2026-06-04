import type { EventFactory, EventContext } from "../infrastructure/events/eventFactory.js";
import { IdempotencyPolicyEnforcer } from "./policyEnforcer.js";
import { PersistedEventPublisher } from "../infrastructure/events/persistedEventPublisher.js";
import { withSpan } from "../infrastructure/telemetry/tracing.js";
import type { Clock } from "../shared/clock.js";
import { toIso, FrozenClock } from "../shared/clock.js";
import { createId } from "../shared/id.js";
import { canonicalize, deterministicId, syncFingerprint, seededRandom } from "../shared/determinism.js";
import type { DomainEvent, DomainEventType } from "../domain/events.js";
import type { ExecutionCheckpoint } from "../domain/cluster.js";
import type { CheckpointStore, FencingToken } from "../domain/clusterPorts.js";
import type { Agent, Execution, ExecutionStep, MemoryRecord, ToolCallRecord } from "../domain/model.js";
import type { EventStore, ExecutionRepository, MemoryRepository, ModelProvider, ToolExecutor, CommitTransitionInput } from "../domain/ports.js";
import { throwIfAborted } from "../providers/retry.js";
import { trueDateNow } from "../shared/trueClock.js";
import {
  assertRuntimeInvariant,
  assertTransition,
  classifyRuntimeFailure,
  isReplaySafeTool,
  InvariantViolation,
  resolveExecutionStartStatus,
  validateFencingMonotonicity,
  validateFencingToken
} from "./canonicalSemantics.js";
import { ReplayExecutionCoordinator } from "./replay/replayExecutionCoordinator.js";
import { assertDeterministicReconstructionBoundary } from "./replay/replayAssertions.js";
import { CentralizedReplayEnforcer } from "./replay/replayEnforcer.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  SandboxedEventStore,
  SandboxedExecutionRepository,
  SandboxedMemoryRepository,
  SandboxedEventPublisher,
  SandboxedToolExecutor
} from "./replay/replaySandbox.js";

export interface DeterministicExecutionContext {
  executionId: string;
  stepType: ExecutionStep["type"];
  clock: Clock;
  random: () => number;
  allowUntracked?: boolean;
}

export const deterministicStorage = new AsyncLocalStorage<DeterministicExecutionContext>();

export function runWithUntrackedAllowed<T>(fn: () => T): T {
  const store = deterministicStorage.getStore();
  if (store) {
    const originalValue = store.allowUntracked;
    store.allowUntracked = true;
    try {
      return fn();
    } finally {
      store.allowUntracked = originalValue;
    }
  }
  return fn();
}

/**
 * Run an awaited, trusted I/O effect (model provider fetch, memory search,
 * tool execution) entirely OUTSIDE the determinism guard's AsyncLocalStorage
 * context.
 *
 * Why exit() and not an `allowUntracked = true` boolean flip on the live store:
 *   The recorded effect is genuine, inherently non-deterministic I/O — an HTTP
 *   fetch through undici, a Postgres round-trip. undici schedules INTERNAL
 *   continuations (e.g. node:internal/deps/undici processResponseEndOfBody)
 *   that call Date.now() while finalizing the response body. Those
 *   continuations capture whatever ALS context was active when the fetch was
 *   initiated, and they can fire AFTER our `await` has already resolved.
 *
 *   A boolean flip restored in a `finally` is therefore racy: the trailing
 *   undici continuation runs with the step's context still on the async stack
 *   but `allowUntracked` already reset to false → PatchedDate.now() throws
 *   InvariantViolation(S_UNSAFE_REPLAY) on trusted infrastructure I/O, even
 *   though no step-body code did anything wrong.
 *
 *   exit() removes the store for the entire async subtree the effect spawns,
 *   so every continuation it schedules inherits "no store" and the guard never
 *   arms for them — regardless of when they fire. The guard stays fully armed
 *   for step-body code before and after the effect: that code runs in the
 *   caller's context, which exit() does not touch (the caller's `await` on the
 *   returned promise resumes inside the original step context).
 */
export async function runWithUntrackedAllowedAsync<T>(fn: () => Promise<T>): Promise<T> {
  return await deterministicStorage.exit(fn);
}

// Monkey-patch global Math.random and Date to capture and block untracked nondeterminism inside steps.
// trueClock captures the genuine Date.now BEFORE this patch installs (imports
// evaluate before this module body), so infrastructure (logging, metrics) can
// read wall-clock time without tripping the guard. Importing it here also
// pins that evaluation order.
const originalRandom = Math.random;
const originalDate = Date;
const originalDateNow = trueDateNow;

Math.random = function patchedRandom() {
  const store = deterministicStorage.getStore();
  if (store && !store.allowUntracked) {
    throw new InvariantViolation(
      `Untracked Nondeterminism Detected: Unsafe usage of Math.random() inside execution step '${store.stepType}' for execution '${store.executionId}'. Steps must use the injected 'step.random()' or seeded PRNG.`,
      "S_UNSAFE_REPLAY"
    );
  }
  return originalRandom();
};

const PatchedDate: any = function (...args: any[]) {
  const store = deterministicStorage.getStore();
  if (store && !store.allowUntracked) {
    throw new InvariantViolation(
      `Untracked Nondeterminism Detected: Unsafe usage of global Date inside execution step '${store.stepType}' for execution '${store.executionId}'. Steps must use the injected 'step.clock' or clock port.`,
      "S_UNSAFE_REPLAY"
    );
  }
  if (new.target) {
    return new (originalDate as any)(...args);
  }
  return (originalDate as any)(...args);
};

PatchedDate.prototype = originalDate.prototype;
Object.getOwnPropertyNames(originalDate).forEach((prop) => {
  if (prop !== "prototype" && prop !== "name") {
    Object.defineProperty(PatchedDate, prop, {
      value: (originalDate as any)[prop],
      writable: true,
      configurable: true,
      enumerable: true
    });
  }
});

PatchedDate.now = function patchedNow() {
  const store = deterministicStorage.getStore();
  if (store && !store.allowUntracked) {
    throw new InvariantViolation(
      `Untracked Nondeterminism Detected: Unsafe usage of Date.now() inside execution step '${store.stepType}' for execution '${store.executionId}'. Steps must use the injected 'step.clock.now()' or clock port.`,
      "S_UNSAFE_REPLAY"
    );
  }
  return originalDateNow();
};

Date = PatchedDate as any;


export interface SandboxContext {
  publisher: PersistedEventPublisher;
  executions: ExecutionRepository;
  memory: MemoryRepository;
  tools: ToolExecutor;
}

export const sandboxStorage = new AsyncLocalStorage<SandboxContext>();


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
 * Thrown when partial-commit detection identifies a database state and event log inconsistency.
 */
export class PartialCommitError extends Error {
  readonly name = "PartialCommitError";
  constructor(public readonly executionId: string, message: string) {
    super(message);
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
  events?: EventStore;
  /** Injectable for tests; created from events + repos when omitted. */
  replayCoordinator?: ReplayExecutionCoordinator;
}

export class ExecutionEngine {
  private readonly checkpoints?: CheckpointStore;
  private readonly defaultWorkerId?: string;
  private readonly events?: EventStore;
  private readonly replayCoordinator?: ReplayExecutionCoordinator;

  private readonly _publisher: PersistedEventPublisher;
  private readonly _executions: ExecutionRepository;
  private readonly _memory: MemoryRepository;
  private readonly _tools: ToolExecutor;

  private get publisher(): PersistedEventPublisher {
    return sandboxStorage.getStore()?.publisher ?? this._publisher;
  }

  private get executions(): ExecutionRepository {
    return sandboxStorage.getStore()?.executions ?? this._executions;
  }

  private get memory(): MemoryRepository {
    return sandboxStorage.getStore()?.memory ?? this._memory;
  }

  private get tools(): ToolExecutor {
    return sandboxStorage.getStore()?.tools ?? this._tools;
  }

  constructor(
    private readonly eventFactory: EventFactory,
    publisher: PersistedEventPublisher,
    executions: ExecutionRepository,
    memory: MemoryRepository,
    private readonly modelProvider: ModelProvider,
    tools: ToolExecutor,
    private readonly clock: Clock,
    deps: ExecutionEngineDeps = {}
  ) {
    this._publisher = publisher;
    this._executions = executions;
    this._memory = memory;
    this._tools = tools;
    this.checkpoints = deps.checkpoints;
    this.defaultWorkerId = deps.workerId;
    this.events = deps.events;
    this.replayCoordinator =
      deps.replayCoordinator ??
      (this.events
        ? new ReplayExecutionCoordinator(
            this.events,
            this.executions,
            this.publisher,
            this.eventFactory
          )
        : undefined);
  }

  private async writeCheckpoint(
    execution: Execution,
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
      executionId: execution.id,
      workerId: owner,
      sequence,
      phase,
      state,
      createdAt: toIso(this.clock.now())
    };

    const checkpointWrittenEvent = this.eventFactory.create({
      type: "EXECUTION_CHECKPOINT_WRITTEN",
      aggregateId: execution.id,
      aggregateType: "EXECUTION",
      payload: { checkpoint },
      context
    });

    const outcome = await this.executions.commitTransition({
      execution,
      checkpoint: {
        phase,
        sequence,
        state
      },
      events: [checkpointWrittenEvent],
      fence
    });

    if (outcome === "FENCED") {
      await this.emitFenceRejected(
        execution.id,
        owner,
        phase,
        `checkpoint.${phase}`,
        context
      );
      throw new StaleWorkerSurrender("EXECUTION_CHECKPOINT_WRITTEN", execution.id);
    }

    const isOutbox = this.executions.isOutboxEnabled && this.executions.isOutboxEnabled();
    if (!isOutbox) {
      await this.publisher.publish(checkpointWrittenEvent);
    }
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
    if (input.execution.parentExecutionId) {
      const getSession = () => this.replayCoordinator?.getSession(input.execution.id);
      const isDiverged = () => getSession()?.diverged ?? false;
      const isOperatorApproved = () => input.execution.input?.operatorApproved === true;

      const baseEventStore = this.events ?? {
        append: async (e: any) => e,
        appendFenced: async (e: any) => ({ outcome: "COMMITTED" as const, event: e }),
        listByAggregate: async () => [],
        listByExecution: async () => [],
        listRecent: async () => [],
        lastForExecution: async () => undefined,
        listAfterSequence: async () => []
      };

      const sandboxCtx = CentralizedReplayEnforcer.enterSandbox({
        executionId: input.execution.id,
        parentExecutionId: input.execution.parentExecutionId,
        events: baseEventStore,
        executions: this._executions,
        memory: this._memory,
        tools: this._tools,
        isDiverged,
        isOperatorApproved
      });

      return sandboxStorage.run(sandboxCtx, () => this.executeInternal(input));
    } else {
      return this.executeInternal(input);
    }
  }

  private async executeInternal(input: ExecuteTaskInput): Promise<Execution> {
    assertRuntimeInvariant(
      "P2",
      typeof input.execution.tenantId === "string" && input.execution.tenantId.length > 0,
      "Execution must carry a valid non-empty tenantId for isolation",
      { executionId: input.execution.id }
    );

    // Invariant S3: Ambiguous Effects Require Reconciliation
    // Prevents silent ambiguity bypass by asserting that we cannot execute a quarantined execution.
    assertRuntimeInvariant(
      "S3",
      input.execution.status !== "AMBIGUOUS" && input.execution.status !== "RECONCILIATION_REQUIRED",
      `Ambiguity Bypass Blocked: execution '${input.execution.id}' is in quarantined state '${input.execution.status}' and cannot be executed without manual operator reconciliation`,
      { executionId: input.execution.id, status: input.execution.status }
    );

    // Invariant S3: Partial-commit detection & validation
    const partialCommitCheck = await this.executions.detectPartialCommit(input.execution.id);
    if (!partialCommitCheck.isConsistent) {
      throw new PartialCommitError(
        input.execution.id,
        partialCommitCheck.error ?? "Partial commit detected on execution"
      );
    }

    const context = input.context ?? { traceId: createId() };
    const workerId = input.workerId ?? this.defaultWorkerId;

    // Invariant R1: Recovery Fence Monotonicity
    // Ensure that recovery/execution fencing attempt counts are strictly monotonic.
    if (input.fence) {
      validateFencingToken({
        executionId: input.fence.executionId,
        workerId: input.fence.workerId,
        attempt: input.fence.attempt,
        currentStatus: input.execution.status,
        phase: "execution.start"
      });
      validateFencingMonotonicity(input.fence.attempt, input.execution.status, workerId);
    }

    if (input.execution.parentExecutionId) {
      assertRuntimeInvariant(
        "RP1",
        this.replayCoordinator !== undefined,
        `Replay illegal: execution '${input.execution.id}' has parentExecutionId but execution engine has no replay coordinator configured.`,
        { executionId: input.execution.id }
      );
      await this.replayCoordinator!.beginReplay(input.execution, input.fence, context);
    }

    try {

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
        // Same posture as the pre-execute abort branch: if our fence is
        // already gone we still need to surrender silently. The diagnostic
        // counter has been recorded by the publisher.
        if (!(e instanceof StaleWorkerSurrender)) throw e;
      }
      return input.execution;
    }
    const { status: targetStatus } = resolveExecutionStartStatus({
      executionId: input.execution.id,
      currentStatus: input.execution.status,
      parentExecutionId: input.execution.parentExecutionId,
      fenceAttempt: input.fence?.attempt
    });

    const execution: Execution = {
      ...input.execution,
      status: targetStatus,
      updatedAt: toIso(this.clock.now())
    };

    const executionStartedEvent = this.eventFactory.create({
      type: "EXECUTION_STARTED",
      aggregateId: execution.id,
      aggregateType: "EXECUTION",
      payload: { execution },
      context
    });

    const outcome = await this.executions.commitTransition({
      execution,
      checkpoint: {
        phase: "INITIALIZED",
        sequence: 0,
        state: { task: input.task }
      },
      events: [executionStartedEvent],
      fence: input.fence
    });

    if (outcome === "FENCED") {
      await this.emitFenceRejected(
        execution.id,
        workerId ?? "unknown",
        targetStatus,
        "executions.RUNNING",
        context
      );
      return input.execution;
    }

    const isOutbox = this.executions.isOutboxEnabled && this.executions.isOutboxEnabled();
    if (!isOutbox) {
      await this.publisher.publish(executionStartedEvent);
    }

    let stepSequence = 0;

    try {
      throwIfAborted(input.signal);
      const plan = await this.runStep(input.agent, execution, "PLANNING", { task: input.task }, async () => ({
        objective: input.agent.goal,
        task: input.task,
        next: ["MEMORY_RETRIEVAL", "TOOL_CALL", "MODEL_GENERATION"]
      }), context, input.signal, input.fence, stepSequence + 1);
      await this.writeCheckpoint(execution, "PLANNING", ++stepSequence, { plan }, context, workerId, input.fence);

      throwIfAborted(input.signal);
      const query = String(input.task.prompt ?? input.task.goal ?? input.agent.goal);
      const memories = await this.runStep(input.agent, execution, "MEMORY_RETRIEVAL", { query }, async () => {
        const records = (await runWithUntrackedAllowedAsync(() => this.memory.search(input.agent.id, query, input.agent.memoryPolicy.maxRetrievedItems)))
          .map((record, index) => ({
            ...record,
            metadata: {
              ...record.metadata,
              retrievalScore: Number((1 - index * 0.13).toFixed(2)),
              influenceReason: index === 0 ? "highest lexical overlap with task prompt" : "recent task context"
            }
          }));
        return { records };
      }, context, input.signal, input.fence, stepSequence + 1);
      await this.writeCheckpoint(execution, "MEMORY_RETRIEVAL", ++stepSequence, { query, recordCount: (memories.records ?? []).length }, context, workerId, input.fence);

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
        await this.writeCheckpoint(execution, "TOOL_CALL", ++stepSequence, { tool: enabledTool.name }, context, workerId, input.fence);
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
        const result = await runWithUntrackedAllowedAsync(() => this.modelProvider.complete({
          agent: input.agent,
          execution,
          prompt,
          context: contextRecords,
          // Forward the caller's cancellation signal so a worker that loses
          // its lease mid-call can interrupt the (potentially long) model
          // request instead of spending tokens for an outcome that will be
          // discarded by the post-execute fencing check.
          signal: input.signal
        }));
        return result;
      }, context, input.signal, input.fence, stepSequence + 1);

      await this.writeCheckpoint(execution, "MODEL_GENERATION", ++stepSequence, { tokenUsage: modelResult.tokenUsage }, context, workerId, input.fence);

      throwIfAborted(input.signal);
      await this.assertFencing(input, execution);

      if (execution.status === "REPLAYING") {
        assertTransition(execution.id, execution.status, "RUNNING");
        execution.status = "RUNNING";
        execution.updatedAt = toIso(this.clock.now());
        await this.executions.commitTransition({
          execution,
          fence: input.fence
        });
      }

      assertTransition(execution.id, execution.status, "COMMITTED");
      const committed: Execution = {
        ...execution,
        status: "COMMITTED",
        updatedAt: toIso(this.clock.now())
      };

      assertTransition(committed.id, "COMMITTED", "COMPLETED");
      const completed: Execution = {
        ...committed,
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

      await this.replayCoordinator?.finalize(completed, true, input.fence, context);
      return completed;
    } catch (error: any) {
      if (
        error instanceof InvariantViolation ||
        error.name === "UnsafeReplayDivergenceError" ||
        error.name === "NonReconstructableReplayError" ||
        (error instanceof Error && ((error as any).code === "INVARIANT_VIOLATION" || error.name === "InvariantViolation"))
      ) {
        await this.replayCoordinator?.markUnsafe(execution.id, execution, input.fence, context);
        throw error;
      }
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
        await this.replayCoordinator?.abort(execution.id, execution, input.fence, context);
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

    const failureRec = classifyRuntimeFailure(error);

    assertTransition(execution.id, execution.status, "FAILED");
    const failed: Execution = {
      ...execution,
      status: "FAILED",
      failure: {
        message: originalMessage,
        code: failureRec.category,
        recoverable: failureRec.recoverable
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

      await this.replayCoordinator?.finalize(execution, false, input.fence, context);
      return failed;
    }
  } finally {
    this.replayCoordinator?.endReplay(input.execution.id);
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
    fence?: FencingToken,
    stepSequence?: number
  ): Promise<TOutput> {
    throwIfAborted(signal);

    if (this.replayCoordinator) {
      const session = await this.replayCoordinator.getOrReconstructSession(execution.id, execution);
      if (session && !session.diverged) {
        const reconstructed = await this.replayCoordinator.tryReconstructStep<TOutput>({
          execution,
          agentId: agent.id,
          type,
          stepInput,
          context,
          publish: (event, f) => this.publishExecutionScoped(event, f),
          fence
        });

        if (reconstructed) {
          const boundary =
            type === "MODEL_GENERATION" ? "LLM" : type === "TOOL_CALL" ? "TOOL" : "CLOCK";
           CentralizedReplayEnforcer.assertBoundary(execution.id, session.lifecycle, boundary, false);

          await this.replayCoordinator.emitReconstructedStep({
            execution,
            completed: reconstructed.completed,
            nestedEmitters: reconstructed.nestedEmitters,
            context,
            publish: (event, f) => this.publishExecutionScoped(event, f),
            fence
          });

          return reconstructed.output;
        }

        if (session.diverged) {
          assertTransition(execution.id, execution.status, "RUNNING");
          execution.status = "RUNNING";
          execution.updatedAt = toIso(this.clock.now());
        }
      }
    }

    return withSpan(`execution.step.${type.toLowerCase()}`, {
      "agent.id": agent.id,
      "execution.id": execution.id,
      "execution.step.type": type
    }, async () => {
      const startedAt = this.clock.now();
      const stepSeed = deterministicId([execution.id, `seq:${stepSequence ?? 0}`, "seed"]);
      const stepClock = this.clock;
      const stepRandom = seededRandom(stepSeed);

      const started: ExecutionStep & { random?: () => number; clock?: Clock } = {
        id: createId(),
        executionId: execution.id,
        agentId: agent.id,
        type,
        status: "STARTED",
        input: stepInput,
        startedAt: toIso(startedAt)
      };
      started.random = () => runWithUntrackedAllowed(() => stepRandom());
      started.clock = {
        now: () => runWithUntrackedAllowed(() => stepClock.now())
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

      const stepCtx: DeterministicExecutionContext = {
        executionId: execution.id,
        stepType: type,
        clock: stepClock,
        random: stepRandom,
        allowUntracked: false
      };

      const output = await deterministicStorage.run(stepCtx, async () => {
        return await fn(started);
      });

      throwIfAborted(signal);

      const completedAt = this.clock.now();
      
      // Persist the canonical ReplayExternalityRecord before step completion
      const externality: any = {
        id: createId(),
        executionId: execution.id,
        stepSequence: stepSequence ?? 0,
        type,
        timestamp: toIso(completedAt),
        startedAt: toIso(startedAt),
        logicalTime: stepSequence ?? 0,
        randomnessSeed: stepSeed,
        retryAttempt: fence?.attempt ?? 1,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        providerResponseFingerprint: undefined
      };

      if (type === "MODEL_GENERATION") {
        externality.prompt = stepInput.prompt as string;
        externality.llmOutput = (output as any)?.output;
        externality.providerResponse = output as Record<string, unknown>;
        externality.providerResponseFingerprint = syncFingerprint(output);
      } else if (type === "TOOL_CALL") {
        const tc = (output as any)?.toolCall as ToolCallRecord;
        if (tc) {
          externality.toolName = tc.toolName;
          externality.toolInput = tc.input;
          externality.toolOutput = tc.output;
          externality.sideEffectMetadata = {
            idempotencyKey: tc.id,
            status: tc.status,
            durationMs: tc.durationMs
          };
          externality.providerResponseFingerprint = syncFingerprint(tc.output);
        }
      } else if (type === "MEMORY_RETRIEVAL") {
        externality.prompt = stepInput.query as string;
        externality.llmOutput = output as Record<string, unknown>;
        externality.providerResponseFingerprint = syncFingerprint(output);
      }

      // Only write the externality record if it wasn't atomically committed inside the runner callback
      if (type !== "TOOL_CALL" || !(output as any)?.externalityCommitted) {
        await this.publishExecutionScoped(
          this.eventFactory.create({
            type: "EXTERNALITY_RECORDED",
            aggregateId: execution.id,
            aggregateType: "EXECUTION",
            payload: { externality },
            context
          }),
          fence
        );
      }

      // Emit step-specific events (MODEL_COMPLETED or MEMORY_RETRIEVED) AFTER the externality is persisted
      if (type === "MODEL_GENERATION") {
        await this.publishExecutionScoped(
          this.eventFactory.create({
            type: "MODEL_COMPLETED",
            aggregateId: execution.id,
            aggregateType: "EXECUTION",
            payload: output,
            context
          }),
          fence
        );
      } else if (type === "MEMORY_RETRIEVAL") {
        await this.publishExecutionScoped(
          this.eventFactory.create({
            type: "MEMORY_RETRIEVED",
            aggregateId: execution.id,
            aggregateType: "EXECUTION",
            payload: { records: (output as any).records, query: stepInput.query },
            context
          }),
          fence
        );
      }

      const completed: ExecutionStep = {
        ...started,
        status: "COMPLETED",
        output: output as any,
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
    if (fence && !isReplaySafeTool(toolName)) {
      assertRuntimeInvariant(
        "S2",
        this.tools.constructor.name === "DedupingToolExecutor" || (this.tools as any).inner !== undefined,
        "Fenced execution requires the DedupingToolExecutor wrapper to enforce durable fences",
        { executionId: execution.id, toolName }
      );
    }
    await this.runStep(agent, execution, "TOOL_CALL", { toolName, args }, async (step) => {
      return await runWithUntrackedAllowedAsync(async () => {
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

        const owner = fence?.workerId ?? this.defaultWorkerId ?? "unknown";

        // ─── Double-Fire & Ambiguity Check (Invariant S3) ───
        // If we are recovering (e.g., attempt > 1 or status is RECOVERING / SIDE_EFFECT_PENDING),
        // we must verify if this tool call already executed but failed to save its outcome durably.
        const dedupStore = (this.tools as any).dedup;
        if (dedupStore) {
          const record = await dedupStore.get(idempotencyKey);

          // If we are in a recovery mode, or a record exists in progress, we have an ambiguity risk
          if (record && (record.status === "IN_FLIGHT" || record.status === "RESERVED" || execution.status === "RECOVERING" || execution.status === "SIDE_EFFECT_PENDING")) {
            // If the previous execution actually succeeded and is cached in the dedup table:
            if (record.status === "COMPLETED" || record.status === "SUCCEEDED") {
              const completedTime = this.clock.now();
              const toolCall: ToolCallRecord = {
                id: createId(),
                executionId: execution.id,
                stepId: step.id,
                toolName,
                input: args,
                output: record.output,
                status: "COMPLETED",
                durationMs: 0,
                createdAt: toIso(completedTime)
              };

              const externality: any = {
                id: createId(),
                executionId: execution.id,
                stepSequence: stepSequence ?? 0,
                type: "TOOL_CALL",
                timestamp: toIso(completedTime),
                randomnessSeed: deterministicId([execution.id, "TOOL_CALL", completedTime.getTime()]),
                retryAttempt: fence?.attempt ?? 1,
                toolName,
                toolInput: args,
                toolOutput: record.output,
                sideEffectMetadata: {
                  idempotencyKey,
                  status: "COMPLETED",
                  durationMs: 0
                }
              };

              const externalityEvent = this.eventFactory.create({
                type: "EXTERNALITY_RECORDED",
                aggregateId: execution.id,
                aggregateType: "EXECUTION",
                payload: { externality },
                context
              });

              const toolCalledEvent = this.eventFactory.create({
                type: "TOOL_CALLED",
                aggregateId: execution.id,
                aggregateType: "EXECUTION",
                payload: { toolCall },
                context
              });

              await this.publishExecutionScoped(externalityEvent, fence);
              await this.publishExecutionScoped(toolCalledEvent, fence);

              return { toolCall, externalityCommitted: true };
            }

            // If the cached output is not complete, it crashed mid-side-effect! We must run the verification flow.
            const { ReconciliationManager } = await import("./failure/reconciliationManager.js");
            const reconciler = new ReconciliationManager(this.executions, dedupStore, this.publisher, this.eventFactory);

            const reconCtx = {
              executionId: execution.id,
              toolName,
              args,
              idempotencyKey,
              stepSequence: stepSequence ?? 0
            };

            const reconResult = await reconciler.verifyAndReconcile(reconCtx, execution, this.clock.now());

            if (reconResult.status === "COMMITTED" && reconResult.output) {
              // Reconciled to COMMITTED successfully! Bypass tool execution.
              const completedTime = this.clock.now();
              const toolCall: ToolCallRecord = {
                id: createId(),
                executionId: execution.id,
                stepId: step.id,
                toolName,
                input: args,
                output: reconResult.output,
                status: "COMPLETED",
                durationMs: 0,
                createdAt: toIso(completedTime)
              };

              const externality: any = {
                id: createId(),
                executionId: execution.id,
                stepSequence: stepSequence ?? 0,
                type: "TOOL_CALL",
                timestamp: toIso(completedTime),
                randomnessSeed: deterministicId([execution.id, "TOOL_CALL", completedTime.getTime()]),
                retryAttempt: fence?.attempt ?? 1,
                toolName,
                toolInput: args,
                toolOutput: reconResult.output,
                sideEffectMetadata: {
                  idempotencyKey,
                  status: "COMPLETED",
                  durationMs: 0
                }
              };

              const externalityEvent = this.eventFactory.create({
                type: "EXTERNALITY_RECORDED",
                aggregateId: execution.id,
                aggregateType: "EXECUTION",
                payload: { externality },
                context
              });

              const toolCalledEvent = this.eventFactory.create({
                type: "TOOL_CALLED",
                aggregateId: execution.id,
                aggregateType: "EXECUTION",
                payload: { toolCall },
                context
              });

              await this.publishExecutionScoped(externalityEvent, fence);
              await this.publishExecutionScoped(toolCalledEvent, fence);

              return { toolCall, externalityCommitted: true };
            }
            // If reconResult.status is "NOT_COMMITTED", the side effect did not happen. We can proceed to run.
          }
        }

        assertTransition(execution.id, execution.status, "SIDE_EFFECT_PENDING");
        execution.status = "SIDE_EFFECT_PENDING";
        execution.updatedAt = toIso(this.clock.now());
        const outcome = await this.executions.commitTransition({
          execution,
          fence
        });
        if (outcome === "FENCED") {
          await this.emitFenceRejected(execution.id, owner, "SIDE_EFFECT_PENDING", "executions.RUNNING", context);
          throw new StaleWorkerSurrender("TOOL_CALLED", execution.id);
        }

        // Sandboxing boundary check for live replay execution (Invariant RP1 & CAP3):
        if (this.replayCoordinator) {
          const session = await this.replayCoordinator.getOrReconstructSession(execution.id, execution);
          if (session) {
            CentralizedReplayEnforcer.assertBoundary(execution.id, session.lifecycle, "TOOL", true);
            CentralizedReplayEnforcer.validateLiveTool(execution, toolName, session.lifecycle, session.diverged);
          }
        }

        // Enforce capability safety middleware before live execution
        IdempotencyPolicyEnforcer.validateExecutionSafety(toolName, {
          hasFence: fence !== undefined,
          operatorApproved: execution.input?.operatorApproved === true
        });

        const output = await runWithUntrackedAllowedAsync(() => this.tools.execute({
          toolName,
          args,
          agentId: agent.id,
          executionId: execution.id,
          signal,
          idempotencyKey,
          attempt: fence?.attempt,
          operatorApproved: execution.input?.operatorApproved === true,
          ...(fence?.workerId ? { workerId: fence.workerId } : {}),
          ...(stepSequence !== undefined ? { stepSeq: stepSequence, argsHash } : {})
        } as any));

        assertTransition(execution.id, execution.status, "RUNNING");
        execution.status = "RUNNING";
        execution.updatedAt = toIso(this.clock.now());

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

        const externality: any = {
          id: createId(),
          executionId: execution.id,
          stepSequence: stepSequence ?? 0,
          type: "TOOL_CALL",
          timestamp: toIso(completed),
          randomnessSeed: deterministicId([execution.id, "TOOL_CALL", completed.getTime()]),
          retryAttempt: fence?.attempt ?? 1,
          toolName,
          toolInput: args,
          toolOutput: output,
          sideEffectMetadata: {
            idempotencyKey,
            status: "COMPLETED",
            durationMs: completed.getTime() - started.getTime()
          }
        };

        const externalityEvent = this.eventFactory.create({
          type: "EXTERNALITY_RECORDED",
          aggregateId: execution.id,
          aggregateType: "EXECUTION",
          payload: { externality },
          context
        });

        const toolCalledEvent = this.eventFactory.create({
          type: "TOOL_CALLED",
          aggregateId: execution.id,
          aggregateType: "EXECUTION",
          payload: { toolCall },
          context
        });

        const postOutcome = await this.executions.commitTransition({
          execution,
          events: [externalityEvent, toolCalledEvent], // Persist BOTH atomically!
          fence
        });

        if (postOutcome === "FENCED") {
          await this.emitFenceRejected(execution.id, owner, "RUNNING", "executions.RUNNING", context);
          throw new StaleWorkerSurrender("TOOL_CALLED", execution.id);
        }

        const isOutbox = this.executions.isOutboxEnabled && this.executions.isOutboxEnabled();
        if (!isOutbox) {
          await this.publisher.publish(externalityEvent);
          await this.publisher.publish(toolCalledEvent);
        }

        return { toolCall, externalityCommitted: true };
      });
    }, context, signal, fence, stepSequence);
  }
}
