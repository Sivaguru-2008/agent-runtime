/**
 * DistributedScheduler — Phase 6 concurrency model + Phase 2 reliability hardening.
 *
 * Phase 6 concurrency:
 *   Up to `capacity` jobs execute in parallel. Each job runs in an isolated
 *   async context — failures or lease loss in one job do not stall others.
 *   Queue is FIFO; the loop drains as many items as free slots per tick.
 *
 * Phase 2 additions:
 *   Poison-pill protection:
 *     Uses `lease.attempt` (a monotonically-increasing counter persisted in
 *     Postgres) as a durable failure counter. An execution whose attempt count
 *     exceeds `maxPoisonPillAttempts` is moved to the Dead-Letter Queue and
 *     never re-enqueued. This survives process restarts — the attempt count
 *     lives in Postgres, not in memory.
 *
 *   Fencing token validation:
 *     The lease.attempt at acquisition time is passed to the ExecutionEngine as
 *     a `validateLease` callback. The engine checks fencing before committing
 *     the final result, preventing a stale worker from corrupting state after
 *     its lease was reclaimed.
 *
 *   Lease heartbeat:
 *     The LeaseHeartbeatWorker renews active leases before they expire,
 *     preventing the recovery loop from spuriously reclaiming leases of
 *     healthy, long-running executions.
 *
 *   Visible failures:
 *     Scheduler tick errors are no longer swallowed — they emit SYSTEM_ERROR_RAISED
 *     events and are logged at error severity. There are no silent recoveries.
 */

import type { Clock } from "../../shared/clock.js";
import { toIso } from "../../shared/clock.js";
import type { Agent, Execution } from "../../domain/model.js";
import type { AgentRepository, ExecutionRepository } from "../../domain/ports.js";
import type { DeadLetterQueue, LeaseStore, WorkerRegistry } from "../../domain/clusterPorts.js";
import type { DeadLetterEntry, ExecutionLease } from "../../domain/cluster.js";
import type { EventFactory, EventContext } from "../../infrastructure/events/eventFactory.js";
import type { PersistedEventPublisher } from "../../infrastructure/events/persistedEventPublisher.js";
import type { ExecutionEngine } from "../../runtime/executionEngine.js";
import type { LeaseHeartbeatWorker } from "../../infrastructure/cluster/leaseHeartbeatWorker.js";
import { createId } from "../../shared/id.js";
import type { ExecutionJobQueue } from "../../domain/jobQueue.js";
import type pino from "pino";
import { injectTraceContext } from "../../infrastructure/telemetry/tracing.js";
import { acquireFencingToken, assertCanWrite } from "../../infrastructure/reliability/splitBrainGuard.js";

export interface DispatchInput {
  agent: Agent;
  execution: Execution;
  task: Record<string, unknown>;
  context?: EventContext;
}

export interface QueuedJob extends DispatchInput {
  enqueuedAt: string;
}

export interface SchedulerConfig {
  leaseTtlMs: number;
  workerId: string;
  pollIntervalMs: number;
  /**
   * Maximum number of execution attempts (= lease.attempt) before an execution
   * is declared a poison pill and moved to the Dead-Letter Queue.
   *
   * Because `lease.attempt` is persisted in Postgres and increments on each
   * reclaim + re-acquire, this limit survives process restarts. An execution
   * that fails on one worker, is reclaimed, and then fails on a different
   * worker still accumulates toward this limit.
   */
  maxPoisonPillAttempts: number;
  /**
   * Bounded concurrency limit for recovery loops to avoid sequential stalling.
   */
  recoveryConcurrencyLimit?: number;
}

export class DistributedScheduler {
  private readonly queue: QueuedJob[] = [];
  private inFlight = 0;
  private loopHandle?: NodeJS.Timeout;
  private externalQueue?: ExecutionJobQueue;

  constructor(
    private readonly engine: ExecutionEngine,
    private readonly executions: ExecutionRepository,
    private readonly agents: AgentRepository,
    private readonly leases: LeaseStore,
    private readonly workers: WorkerRegistry,
    private readonly publisher: PersistedEventPublisher,
    private readonly eventFactory: EventFactory,
    private readonly clock: Clock,
    private readonly config: SchedulerConfig,
    private readonly deadLetterQueue: DeadLetterQueue,
    private readonly heartbeatWorker: LeaseHeartbeatWorker,
    private readonly logger: pino.Logger
  ) {}

  /**
   * Wire the external cross-process ExecutionJobQueue. When set, `recover()`
   * routes reclaimed executions back onto the shared queue instead of this
   * scheduler's local in-process array — the distributed topology requires
   * recovered work to be visible to every worker, not just the local one.
   */
  setJobQueue(queue: ExecutionJobQueue): void {
    this.externalQueue = queue;
  }

  enqueue(job: DispatchInput): void {
    this.queue.push({ ...job, enqueuedAt: toIso(this.clock.now()) });
  }

  queueDepth(): number {
    return this.queue.length;
  }

  inFlightCount(): number {
    return this.inFlight;
  }

  start(): void {
    if (this.loopHandle) return;
    this.heartbeatWorker.start();
    this.loopHandle = setInterval(() => {
      void this.tick().catch((err) => {
        // Tick errors are no longer silently discarded. They are logged at
        // error severity AND emitted as SYSTEM_ERROR_RAISED events so they
        // appear in the event log and operational dashboards.
        this.logger.error({ err }, "scheduler tick failed");
        void this.publisher
          .publish(
            this.eventFactory.create({
              type: "SYSTEM_ERROR_RAISED",
              aggregateId: this.config.workerId,
              aggregateType: "SYSTEM",
              payload: {
                subsystem: "scheduler-tick",
                message: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined
              }
            })
          )
          .catch(() => undefined); // best-effort — do not mask the original error
      });
    }, this.config.pollIntervalMs);
    this.loopHandle.unref?.();
  }

  stop(): void {
    if (this.loopHandle) {
      clearInterval(this.loopHandle);
      this.loopHandle = undefined;
    }
    this.heartbeatWorker.stop();
  }

  async tick(): Promise<void> {
    if (!this.queue.length) return;

    const worker = await this.workers.getById(this.config.workerId);
    if (!worker || worker.status === "LOST" || worker.status === "STOPPED" || worker.status === "DRAINING") return;

    const pending: Promise<void>[] = [];
    while (this.inFlight < worker.capacity && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      this.inFlight += 1;
      const p = this.runJob(job).finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
      });
      pending.push(p);
    }
    if (pending.length) {
      await Promise.allSettled(pending);
    }
  }

  private async runJob(job: QueuedJob): Promise<void> {
    const held = acquireFencingToken();
    const lease = await this.leases.acquire({
      executionId: job.execution.id,
      workerId: this.config.workerId,
      ttlMs: this.config.leaseTtlMs,
      now: this.clock.now()
    });

    if (!lease) {
      // Another worker holds this lease — that worker will execute the job.
      return;
    }

    assertCanWrite(held);

    // ─── Poison-pill check ───────────────────────────────────────────────────
    // `lease.attempt` increments in Postgres on every acquire (including
    // re-acquires after reclaim). If this execution has been retried more
    // times than allowed, it is a poison pill. Move to DLQ immediately without
    // executing. The lease is released in the finally block.
    //
    // Corruption risk prevented: without this check, a broken execution can
    // consume worker capacity indefinitely, starving healthy executions and
    // generating unbounded alert noise.
    if (lease.attempt > this.config.maxPoisonPillAttempts) {
      const execution = await this.executions.getById(job.execution.id);
      const lastError = execution?.failure?.message ?? "unknown (exceeded max attempts without recorded failure)";
      const now = this.clock.now();

      await this.publisher.publish(
        this.eventFactory.create({
          type: "EXECUTION_POISON_PILL_DETECTED",
          aggregateId: job.execution.id,
          aggregateType: "EXECUTION",
          payload: {
            executionId: job.execution.id,
            workerId: this.config.workerId,
            attemptCount: lease.attempt,
            maxAttempts: this.config.maxPoisonPillAttempts
          },
          context: job.context
        })
      );

      const dlqEntry: DeadLetterEntry = {
        id: createId(),
        executionId: job.execution.id,
        agentId: job.agent.id,
        workerId: this.config.workerId,
        failureCount: lease.attempt,
        lastError,
        firstFailedAt: job.enqueuedAt,
        movedAt: toIso(now),
        taskSnapshot: job.task
      };
      await this.deadLetterQueue.push(dlqEntry);

      await this.publisher.publish(
        this.eventFactory.create({
          type: "EXECUTION_DEAD_LETTERED",
          aggregateId: job.execution.id,
          aggregateType: "EXECUTION",
          payload: {
            executionId: job.execution.id,
            workerId: this.config.workerId,
            failureCount: lease.attempt,
            lastError,
            movedAt: toIso(now)
          },
          context: job.context
        })
      );

      // Release lease — job will not be re-enqueued.
      await this.safeReleaseLease(job, "poison-pill");
      return;
    }

    // ─── Normal execution ────────────────────────────────────────────────────
    await this.publisher.publish(
      this.eventFactory.create({
        type: "EXECUTION_LEASED",
        aggregateId: job.execution.id,
        aggregateType: "EXECUTION",
        payload: { lease },
        context: job.context
      })
    );

    // Register lease for automatic heartbeat renewal. The heartbeat worker
    // will renew the lease before it expires, preventing spurious reclaim of
    // healthy long-running executions.
    this.heartbeatWorker.track(job.execution.id, lease);

    // Capture the fencing token at acquisition time. This is the `attempt`
    // count that the ExecutionEngine will validate against before writing the
    // final result. If the lease was reclaimed (attempt incremented), the
    // validation fails and the stale write is aborted.
    const fencingToken = lease.attempt;

    try {
      const completed = await this.engine.execute({
        agent: job.agent,
        execution: job.execution,
        task: job.task,
        context: job.context,
        workerId: this.config.workerId,
        validateLease: (executionId: string) =>
          this.leases.validateFencing(executionId, this.config.workerId, fencingToken),
        // Authoritative fencing — threaded into every status-mutating
        // durable write. The adapter rejects writes whose token does not
        // match the live lease, closing the TOCTOU window that the advisory
        // validateLease() above cannot.
        fence: {
          executionId: job.execution.id,
          workerId: this.config.workerId,
          attempt: fencingToken
        }
      });

      const latest = await this.agents.getById(job.agent.id);
      if (latest) {
        await this.agents.save({
          ...latest,
          state: completed.status === "FAILED" ? "DEGRADED" : "IDLE",
          runtimeStatus: completed.status === "FAILED" ? "ERROR" : "READY",
          updatedAt: toIso(this.clock.now())
        });
      }
    } catch (err) {
      // The engine can throw FencingViolationError (lease lost while executing)
      // or any other unexpected error. Both are logged and emitted as events.
      // We do NOT re-throw — the job slot must be freed in the finally block
      // and the process must not crash.
      this.logger.error(
        { err, executionId: job.execution.id, workerId: this.config.workerId },
        "runJob: execution engine threw — job failed visibly"
      );
      const isFencing = err instanceof Error && err.name === "FencingViolationError";
      if (isFencing) {
        await this.publisher
          .publish(
            this.eventFactory.create({
              type: "EXECUTION_FENCE_VIOLATED",
              aggregateId: job.execution.id,
              aggregateType: "EXECUTION",
              payload: {
                executionId: job.execution.id,
                workerId: this.config.workerId,
                heldToken: fencingToken,
                currentToken: -1 // unknown at this point; validateFencing returned false
              },
              context: job.context
            })
          )
          .catch(() => undefined);
      } else {
        await this.publisher
          .publish(
            this.eventFactory.create({
              type: "SYSTEM_ERROR_RAISED",
              aggregateId: job.execution.id,
              aggregateType: "EXECUTION",
              payload: {
                subsystem: "execution-engine",
                message: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined
              },
              context: job.context
            })
          )
          .catch(() => undefined);
      }
    } finally {
      // Always stop heartbeat tracking before releasing the lease. Reversing
      // this order could cause the heartbeat worker to renew a just-released
      // lease, transitioning it back to ACTIVE unexpectedly.
      this.heartbeatWorker.untrack(job.execution.id);
      await this.safeReleaseLease(job, "normal");
    }
  }

  /**
   * Release the lease and emit EXECUTION_LEASE_RELEASED.
   *
   * Errors here are logged but never re-thrown — a failed release means the
   * lease will expire naturally and be reclaimed by the recovery loop. That
   * is safe. Throwing here would mask the original execution error.
   */
  private async safeReleaseLease(job: QueuedJob, reason: string): Promise<void> {
    try {
      const held = acquireFencingToken();
      const released = await this.leases.release(job.execution.id, this.config.workerId, this.clock.now());
      if (released) {
        assertCanWrite(held);
        await this.publisher.publish(
          this.eventFactory.create({
            type: "EXECUTION_LEASE_RELEASED",
            aggregateId: job.execution.id,
            aggregateType: "EXECUTION",
            payload: { lease: released },
            context: job.context
          })
        );
      }
    } catch (err) {
      this.logger.error(
        { err, executionId: job.execution.id, reason },
        "lease release failed — lease will expire naturally and be reclaimed by recovery loop"
      );
    }
  }

  /**
   * Re-enqueue executions whose leases were reclaimed (worker death, lease
   * expiry). Safe to call concurrently with the main scheduler loop.
   *
   * DLQ guard: executions already in the Dead-Letter Queue are not re-enqueued.
   * Their attempt count is still > maxPoisonPillAttempts, so even without the
   * DLQ check the poison-pill guard in runJob would catch them — but the DLQ
   * check provides an earlier, cheaper exit without acquiring a lease.
   */
  async recover(): Promise<number> {
    // TASK D1: Split-brain sweep fencing: only the active region performs recovery sweeps.
    const held = acquireFencingToken();
    const reclaimed = await this.leases.reclaimExpired(this.clock.now());
    if (reclaimed.length === 0) return 0;

    assertCanWrite(held);

    // TASK E1: Bounded Concurrency Recovery
    // Recovering executions sequentially can block or stall the recovery loop if there is a slow
    // database call or event bus lag. Instead, we execute independent recovery tasks in parallel
    // up to a configurable concurrency limit (defaulting to 4), while preserving serialization.
    const limit = this.config.recoveryConcurrencyLimit ?? 4;
    let recoveredCount = 0;

    const pool = [...reclaimed];
    const worker = async () => {
      while (pool.length > 0) {
        const lease = pool.shift();
        if (!lease) break;

        try {
          // Isolate each execution's recovery so failure doesn't block other executions
          await this.recoverOne(lease, held);
          recoveredCount += 1;
        } catch (err) {
          this.logger.error(
            { err, executionId: lease.executionId },
            "recover: failed to recover execution"
          );
        }
      }
    };

    // Spawn up to `limit` parallel recovery worker tasks
    const workerSpawns = Array.from(
      { length: Math.min(limit, pool.length) },
      () => worker()
    );
    await Promise.all(workerSpawns);

    return recoveredCount;
  }

  private async recoverOne(lease: ExecutionLease, heldFencing: { token: number; regionId: string }): Promise<void> {
    assertCanWrite(heldFencing);

    const execution = await this.executions.getById(lease.executionId);
    if (!execution || execution.status === "COMPLETED" || execution.status === "FAILED") return;

    // Skip executions already in the DLQ — they exceeded the poison-pill
    // threshold and must not be re-enqueued without operator intervention.
    const dlqEntry = await this.deadLetterQueue.getByExecution(lease.executionId);
    if (dlqEntry) {
      this.logger.warn(
        { executionId: lease.executionId },
        "recover: skipping DLQ execution — requires operator intervention to replay"
      );
      return;
    }

    const agent = await this.agents.getById(execution.agentId);
    if (!agent) return;

    // TASK B1+B2: Recovery context hydration & correlation / causation chaining
    // Query the EventStore to fetch the last event associated with this execution, and chain
    // causation back to it so the trace context survives regional failover and recovery.
    const lastEvent = await this.publisher.eventStore.lastForExecution(execution.id);
    const context: EventContext = lastEvent
      ? {
          traceId: lastEvent.metadata.traceId,
          correlationId: lastEvent.metadata.correlationId,
          causationId: lastEvent.id, // Causation chaining
          tenantId: (lastEvent.metadata as any)?.tenantId
        }
      : {
          traceId: execution.id,
          correlationId: execution.id,
          tenantId: execution.tenantId
        };

    assertCanWrite(heldFencing);

    await this.publisher.publish(
      this.eventFactory.create({
        type: "EXECUTION_RESUMED",
        aggregateId: execution.id,
        aggregateType: "EXECUTION",
        payload: { executionId: execution.id, fromSequence: 0, workerId: this.config.workerId },
        context
      })
    );

    if (this.externalQueue) {
      // Distributed path: push the recovered execution back onto the cross-
      // process queue so any healthy worker — including sibling pods — can
      // pick it up. Local re-enqueue would silently strand work on the
      // recovering process.
      const traceContext: Record<string, string> = {};
      injectTraceContext(traceContext);

      await this.externalQueue
        .enqueue({
          jobId: createId(),
          agentId: agent.id,
          executionId: execution.id,
          agentSnapshot: agent,
          executionSnapshot: execution,
          task: execution.input,
          enqueuedAt: toIso(this.clock.now()),
          attempt: 1,
          priorFailures: 0,
          traceContext
        })
        .catch((err) => {
          this.logger.error(
            { err, executionId: execution.id },
            "recover: queue re-enqueue failed — relying on next recovery tick"
          );
        });
    } else {
      // Legacy single-process path — only safe when this scheduler is the
      // sole consumer (back-compat with cluster.test.ts).
      this.enqueue({ agent, execution, task: execution.input, context });
    }
  }
}
