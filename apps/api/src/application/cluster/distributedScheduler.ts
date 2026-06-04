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
 *   Recovery-resume cap:
 *     A second, independent bound on how many times the recovery loop may RESUME
 *     one execution. The poison cap above only fires when the lease epoch climbs
 *     to its ceiling inside the recovery loop; a stuck execution that never makes
 *     forward progress can otherwise be re-driven forever if that epoch fails to
 *     advance. The cap counts durable EXECUTION_RESUMED events (append-only,
 *     restart-surviving, +1 per re-drive); past `maxRecoveryAttempts` the
 *     execution is dead-lettered exactly like a poison pill, terminating the loop.
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
import { assertTransition, isAmbiguityError, assertRuntimeInvariant, FAILURE_CODES, type RuntimeFailureCategory } from "../../runtime/canonicalSemantics.js";
import { RetryCoordinator } from "../../runtime/retry/retryCoordinator.js";
import { InMemoryRetryCoordinationStore } from "../../runtime/retry/inMemoryRetryStore.js";
import { DistributedRecoveryOrchestrator } from "../../runtime/recovery/recoveryOrchestrator.js";
import { InMemoryRecoveryCoordinationStore } from "../../runtime/recovery/inMemoryRecoveryStore.js";

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
  /**
   * Maximum number of times the recovery loop may RESUME a single execution
   * before it is declared a stuck/non-progressing recovery and finalized to the
   * Dead-Letter Queue.
   *
   * This is a SECOND, independent bound layered on top of the lease-epoch poison
   * cap (`maxPoisonPillAttempts`). The poison cap only fires when the durable
   * lease epoch (`lease.attempt`) climbs past its ceiling INSIDE the recovery
   * loop; a never-progressing execution can otherwise be re-driven forever if the
   * epoch fails to advance to that ceiling (e.g. a mixed-persistence restart
   * resetting it, or the worker-side poison-pill never running because the
   * consumer can never acquire the RECOVERY_OWNED lease). This cap counts durable
   * EXECUTION_RESUMED events — an append-only signal that grows by exactly one
   * per re-drive and survives restarts — so the re-drive cycle is bounded no
   * matter how the lease epoch behaves.
   *
   * Optional; defaults to `maxPoisonPillAttempts` so existing call sites need no
   * change and inherit the same proven threshold. A first/single clean recovery
   * (resume count 0 → 1) is always allowed.
   */
  maxRecoveryAttempts?: number;
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
    private readonly logger: pino.Logger,
    /**
     * Single-flight retry coordinator. Optional so existing call sites/tests
     * need no change; defaults to a process-local in-memory instance. The
     * scheduler uses it to serialize and throttle recovery sweeps (RT3) and to
     * block recovery from overlapping an active replay (RT4). Cross-process
     * recovery serialization is also enforced durably by the lease store's
     * takeoverRecovery CAS; this is the in-process policy + canonical state layer.
     */
    private readonly coordinator: RetryCoordinator = new RetryCoordinator(new InMemoryRetryCoordinationStore()),
    /**
     * Canonical distributed-recovery orchestrator. Optional so existing call
     * sites/tests need no change; defaults to a process-local in-memory
     * instance. It sits ABOVE the retry coordinator: the retry coordinator
     * gates recovery as a retry-coordination concern (RT3/RT4), while the
     * orchestrator classifies the recovery strategy (crash / replay /
     * reconcile / dead-letter), drives the canonical recovery lifecycle
     * (RECOVERY_PENDING → RECOVERING/REPLAY_RECOVERING/RECONCILING →
     * RECOVERY_COMPLETED/ABORTED), arbitrates a single owner per execution by
     * monotonic recovery epoch, applies recovery backpressure, and enforces the
     * REC1..REC9 recovery invariants. Cross-process ownership transfer is still
     * the durable lease's takeoverRecovery CAS; this is the in-process policy +
     * canonical state layer that composes it.
     */
    private readonly orchestrator: DistributedRecoveryOrchestrator = new DistributedRecoveryOrchestrator(
      new InMemoryRecoveryCoordinationStore()
    )
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
      if (job.execution.parentExecutionId) {
        assertRuntimeInvariant(
          "RP3",
          false,
          `Replay ownership collision: another worker already holds the active lease for replay execution '${job.execution.id}'`
        );
      }
      // Another worker holds this lease — that worker will execute the job.
      return;
    }

    assertCanWrite(held);

    const currentExec = await this.executions.getById(job.execution.id);
    if (currentExec) {
      if (currentExec.status === "COMPLETED" || currentExec.status === "FAILED" || currentExec.status === "DEAD_LETTERED" || currentExec.status === "CANCELLED") {
        // Deduplicate: already finished!
        await this.safeReleaseLease(job, "dedup");
        return;
      }
      assertTransition(currentExec.id, currentExec.status, "LEASE_ACQUISITION");
      currentExec.status = "LEASE_ACQUISITION";
      currentExec.updatedAt = toIso(this.clock.now());
      await this.executions.saveFenced(currentExec, {
        executionId: job.execution.id,
        leaseId: lease.leaseId,
        leaseEpoch: lease.attempt,
        workerId: this.config.workerId,
        expiration: lease.expiresAt,
        attempt: lease.attempt
      });
    }

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

      if (execution) {
        assertTransition(execution.id, execution.status, "DEAD_LETTERED");
        execution.status = "DEAD_LETTERED";
        execution.updatedAt = toIso(now);
        await this.executions.saveFenced(execution, {
          executionId: job.execution.id,
          workerId: this.config.workerId,
          attempt: lease.attempt
        }).catch(() => this.executions.save(execution));
      }

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

      // Free the agent — this execution is terminal (dead-lettered) and will
      // not be re-enqueued, so the agent must not stay pinned in RUNNING/BUSY.
      await this.releaseAgentAfterFailure(job.agent.id);

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
          this.leases.validateFencing(
            executionId,
            this.config.workerId,
            fencingToken,
            lease.leaseId,
            lease.expiresAt
          ),
        // Authoritative fencing — threaded into every status-mutating
        // durable write. The adapter rejects writes whose token does not
        // match the live lease, closing the TOCTOU window that the advisory
        // validateLease() above cannot.
        fence: {
          executionId: job.execution.id,
          leaseId: lease.leaseId,
          leaseEpoch: lease.attempt,
          workerId: this.config.workerId,
          expiration: lease.expiresAt,
          attempt: lease.attempt
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
      const isFencing = err instanceof Error && err.name === "FencingViolationError";
      const isAmbiguity = isAmbiguityError(err);
      
      if (isAmbiguity) {
        this.logger.warn(
          { executionId: job.execution.id, err: err instanceof Error ? err.message : String(err) },
          "runJob: ambiguous side effect detected; execution quarantined"
        );
      } else {
        this.logger.error(
          { err, executionId: job.execution.id, workerId: this.config.workerId },
          "runJob: execution engine threw — job failed visibly"
        );
      }
      
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
      } else if (!isAmbiguity) {
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
   * Free an agent after one of its executions reached a TERMINAL dead-letter.
   *
   * runJob resets agent state only on its success path, so an execution that is
   * dead-lettered (poison-pill at dispatch, or recovery attempts exhausted) left
   * the agent pinned in RUNNING/BUSY forever — which is exactly what keeps the
   * console's "Active" agent count stuck at a non-zero value long after nothing
   * is running. Mirror runJob's failure convention (DEGRADED/ERROR); a later
   * successful run resets it back to IDLE/READY. Best-effort — never throws.
   */
  private async releaseAgentAfterFailure(agentId: string): Promise<void> {
    try {
      const agent = await this.agents.getById(agentId);
      if (!agent) return;
      await this.agents.save({
        ...agent,
        state: "DEGRADED",
        runtimeStatus: "ERROR",
        updatedAt: toIso(this.clock.now())
      });
    } catch (err) {
      this.logger.warn(
        { err, agentId },
        "failed to reset agent state after dead-letter — non-fatal (agent display state may lag)"
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
    const reclaimed = await this.leases.reclaimExpired(this.clock.now(), 10);
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

    // ─── Recovery serialization + throttle gate (RT3 + RT4) ────────────────
    // Bound concurrent recovery sweeps and refuse to recover an execution whose
    // replay coordination is active. takeoverRecovery below is the durable CAS
    // that picks the single winner across processes; this in-process gate adds
    // throttling, replay/recovery overlap rejection, and the canonical retry
    // state. The prospective epoch matches the attempt takeoverRecovery mints.
    const prospectiveEpoch = lease.attempt + 1;
    const gate = await this.coordinator.requestRecovery({
      executionId: lease.executionId,
      recoveryWorkerId: this.config.workerId,
      ownerEpoch: prospectiveEpoch
    });
    if (gate.decision !== "ADMITTED") {
      this.logger.warn(
        { executionId: lease.executionId, decision: gate.decision, reason: gate.reason },
        "recover: skipping recovery — not admitted by coordinator (serialized/throttled/replay-overlap)"
      );
      return;
    }

    try {
      // ─── Canonical distributed-recovery orchestration ────────────────────
      // Classify the recovery strategy, arbitrate a single owner by monotonic
      // recovery epoch, apply recovery backpressure, and drive the canonical
      // recovery lifecycle. Only an explicit re-drive decision proceeds to the
      // durable takeover + re-enqueue; ambiguous (RECONCILE), exhausted
      // (ABORTED), already-concluded (COMPLETED), and contended (BLOCKED /
      // ALREADY_OWNED) classifications are deliberately NOT blindly re-driven —
      // that is the REC3 reconciliation-bypass and REC4 stale-ownership guard.
      const snapshot = await this.executions.getById(lease.executionId);
      const failureCategory = this.classifyFailureCategory(snapshot?.failure?.code);
      const decision = await this.orchestrator.orchestrateRecovery({
        executionId: lease.executionId,
        recoveryWorkerId: this.config.workerId,
        ownerEpoch: prospectiveEpoch,
        executionStatus: snapshot?.status ?? "RECOVERING",
        ...(failureCategory ? { failureCategory } : {}),
        ...(snapshot?.parentExecutionId ? { parentExecutionId: snapshot.parentExecutionId } : {}),
        attemptCount: lease.attempt,
        maxAttempts: this.config.maxPoisonPillAttempts
      });

      try {
        if (decision.decision === "RECOVER" || decision.decision === "REPLAY_RECOVER") {
          // ─── Recovery-resume cap (independent of the lease-epoch poison cap) ──
          // The orchestrator's ABORTED/poison path keys on the durable lease
          // epoch (lease.attempt) climbing past maxPoisonPillAttempts. That cap
          // only fires if the epoch actually reaches the ceiling INSIDE this loop
          // — and a never-progressing execution can be re-driven forever if the
          // epoch fails to climb (a mixed-persistence restart resetting it, a
          // misconfigured ceiling, or the worker-side poison-pill never running
          // because the consumer can never acquire the RECOVERY_OWNED lease this
          // takeover holds). Guard with a second, independent bound: the count of
          // durable EXECUTION_RESUMED events. It is append-only (lease churn or an
          // epoch reset cannot lower it), survives restarts (the event log is
          // durable), and grows by exactly one per re-drive — so it bounds the
          // re-drive cycle no matter how the epoch behaves. A first clean recovery
          // (0 → 1) is unaffected; only an execution already resumed
          // `recoveryAttemptCap` times WITHOUT reaching a terminal state is
          // finalized, exactly as the dispatch-time poison path does.
          const recoveryAttemptCap = this.config.maxRecoveryAttempts ?? this.config.maxPoisonPillAttempts;
          const priorResumes = await this.countRecoveryResumes(lease.executionId);
          if (priorResumes >= recoveryAttemptCap) {
            await this.deadLetterExhaustedRecovery(
              lease,
              prospectiveEpoch,
              `recovery resume cap reached — execution resumed ${priorResumes} time(s) without reaching a terminal state (cap ${recoveryAttemptCap})`
            );
          } else {
            const handedOff = await this.recoverOneAdmitted(lease, heldFencing);
            if (handedOff) {
              await this.orchestrator.completeRecovery({
                executionId: lease.executionId,
                workerId: this.config.workerId,
                ownerEpoch: prospectiveEpoch
              });
            }
          }
        } else if (decision.decision === "ABORTED") {
          // The orchestrator classified this recovery as non-recoverable
          // (attempts exhausted / poison). The re-drive path never re-enqueues
          // it, so runJob's poison-pill guard would never fire — the execution
          // would otherwise churn through reclaimExpired → ABORTED forever,
          // pinned in a non-terminal state. Finalize it here exactly as the
          // dispatch-time poison path does: DEAD_LETTER the execution, record it
          // in the DLQ, and terminalize the lease so it is never re-surfaced.
          await this.deadLetterExhaustedRecovery(lease, prospectiveEpoch, decision.reason);
        } else {
          this.logger.warn(
            { executionId: lease.executionId, decision: decision.decision, state: decision.state, reason: decision.reason },
            "recover: orchestrator routed recovery off the re-drive path (reconcile/blocked/owned/completed)"
          );
        }
      } finally {
        decision.release();
      }
    } finally {
      gate.release();
    }
  }

  /**
   * Map a persisted `Execution.failure.code` onto the canonical runtime failure
   * taxonomy. The code is stamped from `FAILURE_CODES` at failure time, so a
   * round-trip is exact; anything unrecognized is treated as "no classification"
   * (the orchestrator then falls back to plain crash recovery).
   */
  private classifyFailureCategory(code: string | undefined): RuntimeFailureCategory | undefined {
    if (code && Object.prototype.hasOwnProperty.call(FAILURE_CODES, code)) {
      return code as RuntimeFailureCategory;
    }
    return undefined;
  }

  /**
   * Count the durable EXECUTION_RESUMED events recorded for an execution — the
   * number of times the recovery loop has already re-driven it. Unlike the lease
   * epoch (`lease.attempt`), this count is append-only: lease churn, an epoch
   * reset, or a process restart cannot lower it, and it survives restarts because
   * the event log is durable. It is the canonical "how many times has recovery
   * resumed this execution" signal and the basis of the recovery-resume cap that
   * stops a never-progressing execution from being recovered indefinitely.
   */
  private async countRecoveryResumes(executionId: string): Promise<number> {
    const events = await this.publisher.eventStore.listByExecution(executionId);
    let count = 0;
    for (const event of events) {
      if (event.type === "EXECUTION_RESUMED") count += 1;
    }
    return count;
  }

  /**
   * Finalize an execution whose recovery the orchestrator classified as
   * non-recoverable (attempts exhausted / poison). The re-drive path never
   * re-enqueues such an execution, so the dispatch-time poison-pill guard in
   * runJob can never fire for it — without this it would remain pinned in a
   * non-terminal state and (with reclaimExpired re-surfacing stranded EXPIRED
   * leases) be re-classified ABORTED on every recovery tick forever.
   *
   * Mirrors the dispatch-time poison path: move the execution to DEAD_LETTERED,
   * record a Dead-Letter entry for operator replay, and terminalize the lease so
   * it is never re-surfaced. Ordering matters — the unfenced execution write
   * must land while the lease is still inactive (EXPIRED) to pass the
   * active-lease guard, so the lease is terminalized last.
   */
  private async deadLetterExhaustedRecovery(
    lease: ExecutionLease,
    prospectiveEpoch: number,
    reason: string
  ): Promise<void> {
    const now = this.clock.now();
    const execution = await this.executions.getById(lease.executionId);
    const alreadyTerminal =
      execution !== undefined &&
      (execution.status === "COMPLETED" ||
        execution.status === "FAILED" ||
        execution.status === "DEAD_LETTERED" ||
        execution.status === "CANCELLED");

    // 1. Finalize the execution to DEAD_LETTERED (lease still EXPIRED → the
    //    unfenced save passes the active-lease guard).
    if (execution && !alreadyTerminal) {
      const dead: Execution = {
        ...execution,
        status: "DEAD_LETTERED",
        failure: {
          message: execution.failure?.message ?? reason,
          code: execution.failure?.code ?? "RECOVERY_ATTEMPTS_EXHAUSTED",
          recoverable: false
        },
        completedAt: toIso(now),
        updatedAt: toIso(now)
      };
      try {
        await this.executions.save(dead);
      } catch (err) {
        this.logger.error(
          { err, executionId: lease.executionId },
          "recover: failed to finalize exhausted execution as DEAD_LETTERED"
        );
      }
    }

    // 1b. Free the agent — the recovery path never runs runJob's success reset,
    //     so without this the agent stays pinned in RUNNING/BUSY indefinitely
    //     after its execution is dead-lettered (stale "Active" count in the UI).
    if (execution && !alreadyTerminal) {
      await this.releaseAgentAfterFailure(execution.agentId);
    }

    // 2. Record in the DLQ for operator visibility (idempotent).
    if (execution) {
      const existing = await this.deadLetterQueue.getByExecution(lease.executionId);
      if (!existing) {
        const dlqEntry: DeadLetterEntry = {
          id: createId(),
          executionId: lease.executionId,
          agentId: execution.agentId,
          workerId: this.config.workerId,
          failureCount: lease.attempt,
          lastError: execution.failure?.message ?? reason,
          firstFailedAt: execution.startedAt,
          movedAt: toIso(now),
          taskSnapshot: execution.input
        };
        try {
          await this.deadLetterQueue.push(dlqEntry);
          await this.publisher.publish(
            this.eventFactory.create({
              type: "EXECUTION_DEAD_LETTERED",
              aggregateId: lease.executionId,
              aggregateType: "EXECUTION",
              payload: {
                executionId: lease.executionId,
                workerId: this.config.workerId,
                failureCount: lease.attempt,
                lastError: dlqEntry.lastError,
                movedAt: dlqEntry.movedAt
              }
            })
          );
        } catch (err) {
          this.logger.error(
            { err, executionId: lease.executionId },
            "recover: failed to push exhausted execution to DLQ"
          );
        }
      }
    }

    // 3. Conclude the recovery coordination record (best-effort).
    try {
      await this.orchestrator.abortRecovery({
        executionId: lease.executionId,
        workerId: this.config.workerId,
        ownerEpoch: prospectiveEpoch,
        reason
      });
    } catch {
      // best-effort — the lease terminalization below is what actually stops
      // the execution from being re-surfaced.
    }

    // 4. Terminalize the lease so reclaimExpired never re-surfaces it. release()
    //    only acts on an active lease and the stranded lease is EXPIRED, so take
    //    a fresh recovery ownership first, then release it to TRANSFERRED.
    try {
      const held = acquireFencingToken();
      const owned = await this.leases.takeoverRecovery(
        lease.executionId,
        this.config.workerId,
        now,
        this.config.leaseTtlMs
      );
      if (owned) {
        assertCanWrite(held);
        await this.leases.release(lease.executionId, this.config.workerId, now);
      }
    } catch (err) {
      this.logger.error(
        { err, executionId: lease.executionId },
        "recover: failed to terminalize lease for exhausted execution"
      );
    }

    this.logger.warn(
      {
        executionId: lease.executionId,
        attemptCount: lease.attempt,
        maxAttempts: this.config.maxPoisonPillAttempts,
        reason
      },
      "recover: dead-lettered execution with exhausted recovery attempts"
    );
  }

  private async recoverOneAdmitted(lease: ExecutionLease, heldFencing: { token: number; regionId: string }): Promise<boolean> {
    // Atomically transition the lease status to RECOVERY_OWNED to serialize recovery takeover.
    const recoveryLease = await this.leases.takeoverRecovery(
      lease.executionId,
      this.config.workerId,
      this.clock.now(),
      this.config.leaseTtlMs
    );
    if (!recoveryLease) {
      this.logger.warn(
        { executionId: lease.executionId },
        "recover: skipping recovery takeover — already claimed by another recovery coordinator"
      );
      return false;
    }

    const execution = await this.executions.getById(lease.executionId);
    if (!execution || execution.status === "COMPLETED" || execution.status === "FAILED" || execution.status === "DEAD_LETTERED") return false;

    // Skip executions already in the DLQ — they exceeded the poison-pill
    // threshold and must not be re-enqueued without operator intervention.
    const dlqEntry = await this.deadLetterQueue.getByExecution(lease.executionId);
    if (dlqEntry) {
      this.logger.warn(
        { executionId: lease.executionId },
        "recover: skipping DLQ execution — requires operator intervention to replay"
      );
      return false;
    }

    const agent = await this.agents.getById(execution.agentId);
    if (!agent) return false;

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

    assertTransition(execution.id, execution.status, "RECOVERING");
    execution.status = "RECOVERING";
    execution.updatedAt = toIso(this.clock.now());

    // Use saveFenced with the recovery fencing token to enforce serialized recovery state transition!
    const fence = {
      executionId: execution.id,
      leaseId: recoveryLease.leaseId,
      leaseEpoch: recoveryLease.attempt,
      workerId: this.config.workerId,
      expiration: recoveryLease.expiresAt,
      attempt: recoveryLease.attempt
    };
    const outcome = await this.executions.saveFenced(execution, fence);
    if (outcome === "FENCED") {
      this.logger.error(
        { executionId: execution.id },
        "recover: failed to save RECOVERING transition because recovery lease was fenced"
      );
      return false;
    }

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
    return true;
  }
}
