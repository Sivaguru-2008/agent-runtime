/**
 * WorkerExecutionLoop — the worker-side queue consumer.
 *
 * This is the ONLY place execution actually happens in the distributed
 * topology. It runs inside the worker process; the API process never
 * instantiates it. Its responsibilities are bounded:
 *
 *   1. Pull jobs from ExecutionJobQueue
 *   2. Acquire the per-execution lease atomically (fencing token = lease.attempt)
 *   3. Invoke ExecutionEngine.execute (the cognition pipeline — untouched)
 *   4. Handle outcomes:
 *      - Success     → ack queue, release lease, mark agent IDLE
 *      - Transient   → nack with exponential backoff, lease released, attempt++
 *      - Poison pill → DLQ, ack queue, release lease, no re-enqueue
 *      - Fence loss  → emit EXECUTION_FENCE_VIOLATED, ack queue (winner will own state)
 *   5. Keep concurrent in-flight count below worker.capacity
 *   6. Drain gracefully on stop() — let in-flight jobs finish, refuse new ones
 *
 * What it deliberately does NOT do:
 *   - Hold its own queue (the queue is the durable cross-process medium)
 *   - Decide retry policy beyond backoff math (DLQ threshold lives here, but
 *     the engine-internal retry/replay logic remains in the engine)
 *   - Touch HTTP, auth, or rate limits — that is the API process's job
 *
 * Concurrency model:
 *   The consume() iterator is single-reader, but executeJob() runs each job
 *   on its own promise. The loop only awaits the iterator's next() when it
 *   has spare capacity. Backpressure on the queue side: stop pulling jobs
 *   when at capacity.
 */

import type pino from "pino";
import type { Clock } from "../../shared/clock.js";
import { toIso } from "../../shared/clock.js";
import type { AgentRepository, ExecutionRepository } from "../../domain/ports.js";
import type { DeadLetterQueue, LeaseStore, WorkerRegistry } from "../../domain/clusterPorts.js";
import type { DeadLetterEntry } from "../../domain/cluster.js";
import type { ExecutionJobQueue, ExecutionJob, QueuedJobMessage } from "../../domain/jobQueue.js";
import type { EventFactory } from "../../infrastructure/events/eventFactory.js";
import type { PersistedEventPublisher } from "../../infrastructure/events/persistedEventPublisher.js";
import type { ExecutionEngine } from "../../runtime/executionEngine.js";
import type { LeaseHeartbeatWorker } from "../../infrastructure/cluster/leaseHeartbeatWorker.js";
import { createId } from "../../shared/id.js";
import { propagation, context as otelContext } from "@opentelemetry/api";
import { withSpan } from "../../infrastructure/telemetry/tracing.js";

export interface WorkerExecutionLoopConfig {
  workerId: string;
  leaseTtlMs: number;
  /** Max attempts before the job is poison-pilled (matches DistributedScheduler). */
  maxAttempts: number;
  /** Exponential backoff: delay = baseMs * 2^(attempt-1), capped at maxMs. */
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
  /** Group name for the queue consumer. */
  consumerGroup: string;
  /** Block time on queue read. */
  queueBlockMs: number;
}

export class WorkerExecutionLoop {
  private running = false;
  private draining = false;
  private inFlight = 0;
  private capacity = 1;
  private loopPromise?: Promise<void>;
  private stopRequested = false;
  private readonly inflightTasks = new Set<Promise<void>>();
  /** The currently-active queue consume iterator. Held so stop() can cancel it. */
  private activeIterator?: AsyncIterator<QueuedJobMessage>;

  constructor(
    private readonly engine: ExecutionEngine,
    private readonly jobQueue: ExecutionJobQueue,
    private readonly executions: ExecutionRepository,
    private readonly agents: AgentRepository,
    private readonly leases: LeaseStore,
    private readonly workers: WorkerRegistry,
    private readonly publisher: PersistedEventPublisher,
    private readonly eventFactory: EventFactory,
    private readonly clock: Clock,
    private readonly deadLetterQueue: DeadLetterQueue,
    private readonly heartbeatWorker: LeaseHeartbeatWorker,
    private readonly logger: pino.Logger,
    private readonly config: WorkerExecutionLoopConfig
  ) {}

  inFlightCount(): number {
    return this.inFlight;
  }

  /**
   * Start consuming. The loop runs until stop() is called. Returns a promise
   * that resolves when the loop has fully drained.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.draining = false;
    this.heartbeatWorker.start();
    this.loopPromise = this.runLoop().catch((err) => {
      this.logger.error({ err, workerId: this.config.workerId }, "worker execution loop crashed");
    });
  }

  /**
   * Stop accepting new jobs and wait for in-flight executions to drain.
   * Honors gracefulShutdown — never aborts a running execution mid-step.
   *
   * The active consume iterator is cancelled via .return() so the loop exits
   * promptly rather than waiting out the blockMs poll. Without this the
   * shutdown would always wait the full queue block period.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.draining = true;
    this.stopRequested = true;
    this.heartbeatWorker.stop();
    // Cancel the consume iterator first so the loop wakes immediately.
    if (this.activeIterator) {
      await this.activeIterator.return?.().catch(() => undefined);
    }
    // Wait for the consume loop to exit
    if (this.loopPromise) await this.loopPromise;
    // Wait for every in-flight job to finalize (success, retry, or DLQ)
    if (this.inflightTasks.size) {
      await Promise.allSettled([...this.inflightTasks]);
    }
    this.running = false;
  }

  /**
   * Manually drive one consume-and-execute cycle. Useful for tests that need
   * deterministic dispatching without running the background loop.
   */
  async tick(): Promise<boolean> {
    if (this.stopRequested) return false;
    await this.refreshCapacity();
    if (this.inFlight >= this.capacity) return false;
    const iter = this.jobQueue.consume({
      workerId: this.config.workerId,
      group: this.config.consumerGroup,
      blockMs: 50
    });
    const reader = iter[Symbol.asyncIterator]();
    const next = await reader.next();
    // Eagerly close the iterator — tick is one-shot.
    await reader.return?.();
    if (next.done || !next.value) return false;
    await this.dispatch(next.value);
    return true;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        await this.refreshCapacity();
        if (this.inFlight >= this.capacity) {
          // At capacity — pause briefly before re-checking.
          await new Promise((r) => {
            const t = setTimeout(r, 50);
            t.unref?.();
          });
          continue;
        }
        const iterable = this.jobQueue.consume({
          workerId: this.config.workerId,
          group: this.config.consumerGroup,
          blockMs: this.config.queueBlockMs
        });
        const iterator = iterable[Symbol.asyncIterator]();
        this.activeIterator = iterator;
        try {
          while (!this.stopRequested) {
            const next = await iterator.next();
            if (next.done || !next.value) break;
            const message = next.value;
            if (this.stopRequested) {
              await this.jobQueue
                .nack(message.receiptId, "worker-draining", 0)
                .catch(() => undefined);
              break;
            }
            // Fire-and-track — do NOT await per-job inside the iterator so we
            // can pull the next job concurrently up to capacity.
            await this.dispatch(message);
            if (this.inFlight >= this.capacity) break;
          }
        } finally {
          await iterator.return?.().catch(() => undefined);
          this.activeIterator = undefined;
        }
      } catch (err) {
        // The consume() iterator threw. Log and back off briefly before
        // re-establishing — preserves "visible failure" rule.
        this.logger.error({ err, workerId: this.config.workerId }, "queue consume loop error");
        await this.publisher
          .publish(
            this.eventFactory.create({
              type: "SYSTEM_ERROR_RAISED",
              aggregateId: this.config.workerId,
              aggregateType: "SYSTEM",
              payload: {
                subsystem: "worker-execution-loop",
                message: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined
              }
            })
          )
          .catch(() => undefined);
        await new Promise((r) => {
          const t = setTimeout(r, 500);
          t.unref?.();
        });
      }
    }
  }

  private async refreshCapacity(): Promise<void> {
    const w = await this.workers.getById(this.config.workerId);
    if (w) this.capacity = w.capacity;
  }

  private async dispatch(message: QueuedJobMessage): Promise<void> {
    this.inFlight += 1;
    const task = this.executeJob(message).finally(() => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.inflightTasks.delete(task);
    });
    this.inflightTasks.add(task);
  }

  private async executeJob(message: QueuedJobMessage): Promise<void> {
    // D4: re-hydrate the OTel context the API injected at enqueue. We run
    // the entire job under context.with(extracted, ...) so every span the
    // engine, provider call, tool call, and event publisher create gets
    // parented under the API's enqueue span. Result: one continuous trace
    // across API → Redis → worker → provider. When no traceContext is
    // present (legacy jobs, in-process tests) we fall through to the
    // active context and start a fresh root span — semantics unchanged.
    const job = message.job;
    const carrier = job.traceContext ?? {};
    const parentCtx = propagation.extract(otelContext.active(), carrier);
    return otelContext.with(parentCtx, () =>
      withSpan(
        "worker.execute.job",
        {
          "messaging.system": "redis",
          "messaging.destination": "agent-runtime:exec-jobs",
          "messaging.operation": "process",
          "agent.id": job.agentId,
          "execution.id": job.executionId,
          "execution.attempt": job.attempt,
          "worker.id": this.config.workerId,
          // Preserve correlation IDs — surfaced as attributes for log/trace correlation.
          "correlation.id": job.context?.correlationId,
          "trace.id": job.context?.traceId
        },
        () => this.executeJobInner(message)
      )
    );
  }

  private async executeJobInner(message: QueuedJobMessage): Promise<void> {
    const { receiptId, job } = message;
    const lease = await this.leases.acquire({
      executionId: job.executionId,
      workerId: this.config.workerId,
      ttlMs: this.config.leaseTtlMs,
      now: this.clock.now()
    });

    if (!lease) {
      // Another worker holds the lease — give the queue back to itself.
      // We ack so the message doesn't re-deliver; the winner is responsible.
      await this.jobQueue.ack(receiptId).catch(() => undefined);
      return;
    }

    // ─── Poison-pill: too many lease attempts → DLQ ───────────────────────
    if (lease.attempt > this.config.maxAttempts) {
      await this.poisonPill(job, lease.attempt, receiptId);
      await this.safeReleaseLease(job.executionId, "poison-pill");
      return;
    }

    await this.publisher.publish(
      this.eventFactory.create({
        type: "EXECUTION_LEASED",
        aggregateId: job.executionId,
        aggregateType: "EXECUTION",
        payload: { lease },
        context: job.context
      })
    );

    this.heartbeatWorker.track(job.executionId, lease);

    const controller = new AbortController();
    let unsubscribeLeaseLost: (() => void) | undefined = this.heartbeatWorker.addLeaseLostListener(
      (lostExecutionId) => {
        if (lostExecutionId === job.executionId) {
          controller.abort();
          if (unsubscribeLeaseLost) {
            unsubscribeLeaseLost();
            unsubscribeLeaseLost = undefined;
          }
        }
      }
    );

    const fencingToken = lease.attempt;
    let outcome: "success" | "fence-lost" | "error" = "success";
    let errorMessage = "";

    try {
      // Re-read latest agent/execution from durable store — snapshots on the
      // envelope are denormalised for transport, not for state mutation.
      const agent = (await this.agents.getById(job.agentId)) ?? job.agentSnapshot;
      const exec = (await this.executions.getById(job.executionId)) ?? job.executionSnapshot;

      const completed = await this.engine.execute({
        agent,
        execution: exec,
        task: job.task,
        context: job.context,
        workerId: this.config.workerId,
        validateLease: (executionId) =>
          this.leases.validateFencing(executionId, this.config.workerId, fencingToken),
        // Authoritative fencing — see DistributedScheduler.runJob for
        // rationale. saveFenced/addFenced inside the engine consult this
        // token to reject stale-worker writes deterministically.
        fence: {
          executionId: job.executionId,
          workerId: this.config.workerId,
          attempt: fencingToken
        },
        signal: controller.signal,
        abortReason: "lease-lost"
      });

      // ─── Fence-rejection detection ───────────────────────────────────────
      // The engine returns its input.execution reference unchanged ONLY on
      // the catch-branch fence-rejection path (engine never aliases the
      // input in any other return). Reference equality is therefore an
      // unambiguous signal that this worker lost the lease mid-execution
      // and must surrender silently — without stomping agent state.
      //
      // The engine has already published EXECUTION_FENCE_REJECTED, so we
      // do NOT publish EXECUTION_FENCE_VIOLATED here (that event is
      // reserved for the synchronous-throw fence path inside the catch
      // block below). We also skip the agent settle so a legitimate new
      // owner's BUSY state is preserved.
      if (completed === exec) {
        outcome = "fence-lost";
        errorMessage = "fence-rejected: lease lost during execution";
      } else {
        // Settle agent state — same semantics the old DistributedScheduler had.
        const latest = await this.agents.getById(job.agentId);
        if (latest) {
          await this.agents.save({
            ...latest,
            state: completed.status === "FAILED" ? "DEGRADED" : "IDLE",
            runtimeStatus: completed.status === "FAILED" ? "ERROR" : "READY",
            updatedAt: toIso(this.clock.now())
          });
        }

        if (completed.status === "FAILED" && completed.failure?.recoverable !== false) {
          // The engine handled the failure by writing an EXECUTION_FAILED record.
          // We still want one more retry pass at the queue level when recoverable.
          errorMessage = completed.failure?.message ?? "execution failed";
          outcome = "error";
        }
      }
    } catch (err) {
      const isFencing = err instanceof Error && err.name === "FencingViolationError";
      errorMessage = err instanceof Error ? err.message : String(err);
      outcome = isFencing ? "fence-lost" : "error";

      if (isFencing) {
        await this.publisher
          .publish(
            this.eventFactory.create({
              type: "EXECUTION_FENCE_VIOLATED",
              aggregateId: job.executionId,
              aggregateType: "EXECUTION",
              payload: {
                executionId: job.executionId,
                workerId: this.config.workerId,
                heldToken: fencingToken,
                currentToken: -1
              },
              context: job.context
            })
          )
          .catch(() => undefined);
      } else {
        this.logger.error(
          { err, executionId: job.executionId, workerId: this.config.workerId },
          "executeJob: engine threw"
        );
        await this.publisher
          .publish(
            this.eventFactory.create({
              type: "SYSTEM_ERROR_RAISED",
              aggregateId: job.executionId,
              aggregateType: "EXECUTION",
              payload: {
                subsystem: "execution-engine",
                message: errorMessage,
                stack: err instanceof Error ? err.stack : undefined
              },
              context: job.context
            })
          )
          .catch(() => undefined);
      }
    } finally {
      if (unsubscribeLeaseLost) {
        unsubscribeLeaseLost();
      }
      this.heartbeatWorker.untrack(job.executionId);
      await this.safeReleaseLease(job.executionId, "post-exec");
    }

    if (outcome === "success") {
      await this.jobQueue.ack(receiptId).catch(() => undefined);
      return;
    }

    if (outcome === "fence-lost") {
      // Winner holds the new lease — they own the result. We drop the queue
      // message: re-delivering would generate spurious second attempts on a
      // job that another worker is already processing.
      await this.jobQueue.ack(receiptId).catch(() => undefined);
      return;
    }

    // Transient error — retry with exponential backoff if attempts remain.
    const nextAttempt = job.attempt + 1;
    const remainingAttempts = this.config.maxAttempts - lease.attempt;
    if (remainingAttempts <= 0) {
      await this.poisonPill(
        { ...job, attempt: nextAttempt, priorFailures: job.priorFailures + 1 },
        lease.attempt,
        receiptId,
        errorMessage
      );
      return;
    }

    const delayMs = this.computeBackoff(nextAttempt);
    const updatedJob: ExecutionJob = {
      ...job,
      attempt: nextAttempt,
      priorFailures: job.priorFailures + 1,
      notBefore: toIso(new Date(this.clock.now().getTime() + delayMs))
    };
    await this.publisher
      .publish(
        this.eventFactory.create({
          type: "RETRY_TRIGGERED",
          aggregateId: job.executionId,
          aggregateType: "EXECUTION",
          payload: {
            executionId: job.executionId,
            attempt: nextAttempt,
            delayMs,
            reason: errorMessage
          },
          context: job.context
        })
      )
      .catch(() => undefined);
    // Re-enqueue with the new envelope, then ack the original to remove it.
    await this.jobQueue.enqueue(updatedJob).catch((e) => {
      this.logger.error({ err: e }, "retry re-enqueue failed");
    });
    await this.jobQueue.ack(receiptId).catch(() => undefined);
  }

  private computeBackoff(attempt: number): number {
    const exp = Math.min(attempt - 1, 12);
    return Math.min(
      this.config.retryBackoffMaxMs,
      this.config.retryBackoffBaseMs * 2 ** exp
    );
  }

  private async poisonPill(
    job: ExecutionJob,
    leaseAttempt: number,
    receiptId: string,
    lastError?: string
  ): Promise<void> {
    const execution = await this.executions.getById(job.executionId);
    const resolvedError =
      lastError ??
      execution?.failure?.message ??
      "unknown (exceeded max attempts without recorded failure)";
    const now = this.clock.now();

    await this.publisher.publish(
      this.eventFactory.create({
        type: "EXECUTION_POISON_PILL_DETECTED",
        aggregateId: job.executionId,
        aggregateType: "EXECUTION",
        payload: {
          executionId: job.executionId,
          workerId: this.config.workerId,
          attemptCount: leaseAttempt,
          maxAttempts: this.config.maxAttempts
        },
        context: job.context
      })
    );

    const dlqEntry: DeadLetterEntry = {
      id: createId(),
      executionId: job.executionId,
      agentId: job.agentId,
      workerId: this.config.workerId,
      failureCount: leaseAttempt,
      lastError: resolvedError,
      firstFailedAt: job.enqueuedAt,
      movedAt: toIso(now),
      taskSnapshot: job.task
    };
    await this.deadLetterQueue.push(dlqEntry).catch((err) => {
      this.logger.error({ err, executionId: job.executionId }, "DLQ push failed");
    });

    await this.publisher.publish(
      this.eventFactory.create({
        type: "EXECUTION_DEAD_LETTERED",
        aggregateId: job.executionId,
        aggregateType: "EXECUTION",
        payload: {
          executionId: job.executionId,
          workerId: this.config.workerId,
          failureCount: leaseAttempt,
          lastError: resolvedError,
          movedAt: toIso(now)
        },
        context: job.context
      })
    );
    await this.jobQueue.ack(receiptId).catch(() => undefined);
  }

  private async safeReleaseLease(executionId: string, reason: string): Promise<void> {
    try {
      const released = await this.leases.release(
        executionId,
        this.config.workerId,
        this.clock.now()
      );
      if (released) {
        await this.publisher.publish(
          this.eventFactory.create({
            type: "EXECUTION_LEASE_RELEASED",
            aggregateId: executionId,
            aggregateType: "EXECUTION",
            payload: { lease: released }
          })
        );
      }
    } catch (err) {
      this.logger.error(
        { err, executionId, workerId: this.config.workerId, reason },
        "lease release failed — will expire naturally"
      );
    }
  }
}
