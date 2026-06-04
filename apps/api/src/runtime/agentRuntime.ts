import type { EventContext } from "../infrastructure/events/eventFactory.js";
import type { EventFactory } from "../infrastructure/events/eventFactory.js";
import type { PersistedEventPublisher } from "../infrastructure/events/persistedEventPublisher.js";
import type { Clock } from "../shared/clock.js";
import { toIso } from "../shared/clock.js";
import { BackpressureError, ConflictError, NotFoundError } from "../shared/errors.js";
import { createId } from "../shared/id.js";
import type { Agent, Execution, MemoryPolicy, ModelConfig, ToolConfig } from "../domain/model.js";
import { assertTransition } from "./canonicalSemantics.js";
import type { AgentRepository, ExecutionRepository } from "../domain/ports.js";
import type { DistributedScheduler } from "../application/cluster/distributedScheduler.js";
import type { ExecutionEngine } from "./executionEngine.js";
import type { ExecutionJob, ExecutionJobQueue } from "../domain/jobQueue.js";
import { propagation, context as otelContext } from "@opentelemetry/api";
import { withSpan } from "../infrastructure/telemetry/tracing.js";

export interface CreateAgentInput {
  name: string;
  goal: string;
  model?: Partial<ModelConfig>;
  tools?: ToolConfig[];
  memoryPolicy?: Partial<MemoryPolicy>;
}

export interface AgentRuntimeOptions {
  /**
   * Queue-driven distributed dispatch. Used by the API runtime to hand
   * execution work to dedicated worker processes via Redis.
   *
   * When set, runTask enqueues onto the queue and returns the QUEUED execution
   * immediately. The API process never executes the job — that is the worker's
   * job. This is the true-distributed code path.
   */
  jobQueue?: ExecutionJobQueue;
  /**
   * Legacy in-process scheduler. Retained for backwards compatibility with
   * combined-mode (RUNTIME_MODE=single) tests and developer runs. When both
   * jobQueue and scheduler are provided, jobQueue wins.
   */
  scheduler?: DistributedScheduler;
  /**
   * Reject enqueue when ready depth ≥ threshold. Surfaces a BackpressureError
   * to the HTTP layer (translated to 503). Set to 0 to disable.
   */
  backpressureThreshold?: number;
}

export class AgentRuntime {
  private readonly jobQueue?: ExecutionJobQueue;
  private readonly scheduler?: DistributedScheduler;
  private readonly backpressureThreshold: number;

  constructor(
    private readonly agents: AgentRepository,
    private readonly executions: ExecutionRepository,
    private readonly engine: ExecutionEngine,
    private readonly eventFactory: EventFactory,
    private readonly publisher: PersistedEventPublisher,
    private readonly clock: Clock,
    schedulerOrOptions?: DistributedScheduler | AgentRuntimeOptions
  ) {
    // Back-compat: the previous constructor took a 7th positional arg of type
    // DistributedScheduler. Detect that shape and route to the new options
    // surface without breaking existing callers (notably tests).
    if (schedulerOrOptions && "enqueue" in schedulerOrOptions && "tick" in schedulerOrOptions) {
      this.scheduler = schedulerOrOptions as DistributedScheduler;
      this.backpressureThreshold = 0;
    } else {
      const opts = (schedulerOrOptions ?? {}) as AgentRuntimeOptions;
      this.jobQueue = opts.jobQueue;
      this.scheduler = opts.scheduler;
      this.backpressureThreshold = opts.backpressureThreshold ?? 0;
    }
  }

  async createAgent(input: CreateAgentInput, context?: EventContext): Promise<Agent> {
    const now = toIso(this.clock.now());
    const agent: Agent = {
      id: createId(),
      name: input.name,
      goal: input.goal,
      state: "IDLE",
      runtimeStatus: "READY",
      model: {
        provider: input.model?.provider ?? "mock",
        model: input.model?.model ?? "deterministic-runtime-v1",
        temperature: input.model?.temperature ?? 0
      },
      tools: input.tools ?? [{ name: "runtime.inspect", enabled: true }],
      memoryPolicy: {
        episodicEnabled: input.memoryPolicy?.episodicEnabled ?? true,
        semanticEnabled: input.memoryPolicy?.semanticEnabled ?? false,
        maxRetrievedItems: input.memoryPolicy?.maxRetrievedItems ?? 5
      },
      createdAt: now,
      updatedAt: now,
      // C-1: stamp tenantId from the authenticated request context. The HTTP
      // route layer always sets context.tenantId for authenticated callers;
      // tests and back-compat callers without a context fall through to
      // SYSTEM_TENANT_ID so the postgres adapters' tenant assertion still has
      // a non-empty value to persist.
      tenantId: contextTenantId(context)
    };

    await this.agents.save(agent);
    await this.publisher.publish(
      this.eventFactory.create({
        type: "AGENT_CREATED",
        aggregateId: agent.id,
        aggregateType: "AGENT",
        payload: { agent },
        context
      })
    );

    return agent;
  }

  async startAgent(agentId: string, context?: EventContext): Promise<Agent> {
    const agent = await this.requireAgent(agentId);
    const updated = {
      ...agent,
      state: "IDLE" as const,
      runtimeStatus: "READY" as const,
      updatedAt: toIso(this.clock.now())
    };
    await this.agents.save(updated);
    await this.publisher.publish(
      this.eventFactory.create({
        type: "AGENT_STARTED",
        aggregateId: agentId,
        aggregateType: "AGENT",
        payload: { agent: updated },
        context
      })
    );
    return updated;
  }

  async stopAgent(agentId: string, context?: EventContext): Promise<Agent> {
    const agent = await this.requireAgent(agentId);
    const updated = {
      ...agent,
      state: "STOPPED" as const,
      runtimeStatus: "OFFLINE" as const,
      updatedAt: toIso(this.clock.now())
    };
    await this.agents.save(updated);
    await this.publisher.publish(
      this.eventFactory.create({
        type: "AGENT_STOPPED",
        aggregateId: agentId,
        aggregateType: "AGENT",
        payload: { agent: updated },
        context
      })
    );
    return updated;
  }

  async runTask(agentId: string, task: Record<string, unknown>, context?: EventContext): Promise<Execution> {
    const agent = await this.requireAgent(agentId);
    if (agent.state === "STOPPED" || agent.runtimeStatus === "OFFLINE") {
      throw new ConflictError(`Agent ${agentId} is stopped`);
    }

    // ─── Backpressure check (queue-driven path) ────────────────────────────
    // Done BEFORE any DB write so a rejected request leaves no orphan row.
    if (this.jobQueue && this.backpressureThreshold > 0) {
      const depth = await this.jobQueue.depth();
      const liveDepth = depth.ready + depth.inFlight + depth.delayed;
      if (liveDepth >= this.backpressureThreshold) {
        throw new BackpressureError(liveDepth, this.backpressureThreshold);
      }
    }

    const now = toIso(this.clock.now());
    // C-1: stamp tenantId at execution creation so every downstream save
    // (RUNNING / COMPLETED / FAILED) carries the originating tenant. Falls
    // through to the owning agent's tenantId when context is absent so the
    // worker-side scheduler path (which lacks the original HTTP context but
    // already loaded the agent snapshot) still persists correctly.
    const execTenantId =
      contextTenantId(context) ?? agent.tenantId ?? "system";
    const execution: Execution = {
      id: createId(),
      agentId,
      status: "CREATION",
      input: task,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: now,
      updatedAt: now,
      tenantId: execTenantId,
      traceId: contextTraceId(context)
    };

    assertTransition(execution.id, "CREATION", "SCHEDULING");
    execution.status = "SCHEDULING";
    execution.updatedAt = toIso(this.clock.now());
    assertTransition(execution.id, "SCHEDULING", "QUEUED");
    execution.status = "QUEUED";
    execution.updatedAt = toIso(this.clock.now());

    await this.executions.save(execution);
    await this.publisher.publish(
      this.eventFactory.create({
        type: "TASK_SCHEDULED",
        aggregateId: agentId,
        aggregateType: "AGENT",
        payload: { execution, task },
        context
      })
    );

    const busy = {
      ...agent,
      state: "RUNNING" as const,
      runtimeStatus: "BUSY" as const,
      updatedAt: now
    };
    await this.agents.save(busy);

    // ─── Dispatch path selection ──────────────────────────────────────────
    // 1. jobQueue is the true distributed path — the API never executes; a
    //    worker process pops the job and runs it.
    // 2. scheduler is the legacy combined-mode path — only used when no
    //    queue is wired (e.g. older tests).
    // 3. engine.execute is the test-only synchronous fallback when neither
    //    queue nor scheduler is wired.
    if (this.jobQueue) {
      // D4: capture the current OTel context at enqueue time and inject it
      // into a flat carrier on the job envelope. The worker extracts this
      // and parents its execution span under the API enqueue span, giving
      // a single continuous trace across the API → Redis → worker hop.
      // withSpan creates a parent that survives long enough for inject()
      // to capture a non-empty traceparent even when the API process is
      // the trace root.
      const enqueued = await withSpan(
        "queue.enqueue",
        {
          "messaging.system": "redis",
          "messaging.destination": "agent-runtime:exec-jobs",
          "messaging.operation": "publish",
          "agent.id": busy.id,
          "execution.id": execution.id,
          "execution.attempt": 1
        },
        async () => {
          const traceCarrier: Record<string, string> = {};
          propagation.inject(otelContext.active(), traceCarrier);
          const job: ExecutionJob = {
            jobId: createId(),
            agentId: busy.id,
            executionId: execution.id,
            agentSnapshot: busy,
            executionSnapshot: execution,
            task,
            context,
            enqueuedAt: now,
            attempt: 1,
            priorFailures: 0,
            traceContext: Object.keys(traceCarrier).length > 0 ? traceCarrier : undefined
          };
          await this.jobQueue!.enqueue(job);
          return { ...execution };
        }
      );
      return enqueued;
    }

    if (this.scheduler) {
      this.scheduler.enqueue({ agent: busy, execution, task, context });
      return { ...execution };
    }

    const completed = await this.engine.execute({ agent: busy, execution, task, context });
    const latest = await this.requireAgent(agentId);
    await this.agents.save({
      ...latest,
      state: completed.status === "FAILED" ? "DEGRADED" : "IDLE",
      runtimeStatus: completed.status === "FAILED" ? "ERROR" : "READY",
      updatedAt: toIso(this.clock.now())
    });

    return completed;
  }

  async replayExecution(executionId: string, context?: EventContext): Promise<Execution> {
    const original = await this.executions.getById(executionId);
    if (!original) throw new NotFoundError("Execution", executionId);

    const agent = await this.requireAgent(original.agentId);
    const now = toIso(this.clock.now());
    const replay: Execution = {
      id: createId(),
      agentId: agent.id,
      parentExecutionId: original.id,
      status: "CREATION",
      input: original.input,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: now,
      updatedAt: now,
      // C-1: replay inherits the original execution's tenant so the replay
      // record stays inside the same tenant boundary as its source. Falls
      // back to the request context (admin-initiated replay) or the owning
      // agent's tenant when those are absent.
      tenantId:
        original.tenantId ?? contextTenantId(context) ?? agent.tenantId ?? "system"
    };

    assertTransition(replay.id, "CREATION", "SCHEDULING");
    replay.status = "SCHEDULING";
    replay.updatedAt = toIso(this.clock.now());
    assertTransition(replay.id, "SCHEDULING", "QUEUED");
    replay.status = "QUEUED";
    replay.updatedAt = toIso(this.clock.now());

    await this.executions.save(replay);
    await this.publisher.publish(
      this.eventFactory.create({
        type: "EXECUTION_REPLAY_REQUESTED",
        aggregateId: replay.id,
        aggregateType: "EXECUTION",
        payload: {
          parentExecutionId: original.id,
          replayExecutionId: replay.id,
          input: replay.input
        },
        context
      })
    );

    // Audit CRITICAL-5: previously, replay always called engine.execute()
    // synchronously in the API process with no fence — replay could stomp
    // a live execution's terminal state and the API request held a long-
    // running model call. Production runs MUST be enqueued so a worker
    // acquires a lease, runs under a fencing token, and the API returns
    // immediately with the QUEUED replay record (the caller polls or
    // subscribes to events for completion).
    //
    // Path selection mirrors runTask:
    //   1. jobQueue → enqueue, return QUEUED.
    //   2. scheduler → enqueue, return QUEUED.
    //   3. In-process engine — only when ALLOW_UNFENCED_REPLAY=true
    //      (developer / test override). Production deployments wire a
    //      jobQueue and the in-process fallback is unreachable.
    if (this.jobQueue) {
      const enqueued = await withSpan(
        "queue.enqueue",
        {
          "messaging.system": "redis",
          "messaging.destination": "agent-runtime:exec-jobs",
          "messaging.operation": "publish",
          "agent.id": agent.id,
          "execution.id": replay.id,
          "execution.attempt": 1,
          "messaging.replay": true
        },
        async () => {
          const traceCarrier: Record<string, string> = {};
          propagation.inject(otelContext.active(), traceCarrier);
          const job: ExecutionJob = {
            jobId: createId(),
            agentId: agent.id,
            executionId: replay.id,
            agentSnapshot: agent,
            executionSnapshot: replay,
            task: replay.input,
            context,
            enqueuedAt: now,
            attempt: 1,
            priorFailures: 0,
            traceContext: Object.keys(traceCarrier).length > 0 ? traceCarrier : undefined
          };
          await this.jobQueue!.enqueue(job);
          return { ...replay };
        }
      );
      return enqueued;
    }

    if (this.scheduler) {
      this.scheduler.enqueue({ agent, execution: replay, task: replay.input, context });
      return { ...replay };
    }

    if (process.env.ALLOW_UNFENCED_REPLAY !== "true") {
      throw new ConflictError(
        "Replay requires a job queue or scheduler in production. " +
          "Set ALLOW_UNFENCED_REPLAY=true to opt in to the legacy in-process replay path " +
          "(unfenced; not safe for clustered deployments)."
      );
    }

    return this.engine.execute({ agent, execution: replay, task: replay.input, context });
  }

  private async requireAgent(agentId: string): Promise<Agent> {
    const agent = await this.agents.getById(agentId);
    if (!agent) throw new NotFoundError("Agent", agentId);
    return agent;
  }
}

/**
 * Extract tenantId from an EventContext if present. EventContext historically
 * carried tenantId as an extension field; this helper avoids unsafe casts at
 * each callsite while preserving back-compat with contexts that omit it.
 */
function contextTenantId(context?: EventContext): string | undefined {
  if (!context) return undefined;
  const value = (context as unknown as Record<string, unknown>).tenantId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Extract the trace correlation id from an EventContext, if present. */
function contextTraceId(context?: EventContext): string | undefined {
  if (!context) return undefined;
  const value = (context as unknown as Record<string, unknown>).traceId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
