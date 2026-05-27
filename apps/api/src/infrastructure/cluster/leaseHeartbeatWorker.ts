/**
 * LeaseHeartbeatWorker — prevents lease expiry from causing spurious
 * double-execution of long-running jobs.
 *
 * Corruption risk prevented:
 *   Without heartbeat renewal, any execution that outlives EXECUTION_LEASE_TTL_MS
 *   will have its lease reclaimed by the BackgroundRecoveryLoop, which re-enqueues
 *   it and allows another worker to start executing it. If the original worker
 *   then completes, two workers may simultaneously write EXECUTION_COMPLETED —
 *   a silent data corruption (second write overwrites first, or worse, both
 *   emit events with different outputs).
 *
 * Operational impact:
 *   The worker renews leases proactively when remaining TTL drops below
 *   `renewThresholdFactor * leaseTtlMs`. Renewal failure means the lease was
 *   lost (reclaimed by another worker or expired); the tracked entry is
 *   removed, and the execution engine's fencing token check will catch the
 *   stale-worker condition before it can write corrupted state.
 *
 * Distributed implications:
 *   Renewal uses a conditional UPDATE (workerId must match, status must be
 *   ACTIVE) so only the legitimate owner can extend its own lease. A stale
 *   worker cannot accidentally extend a lease already taken by a new worker.
 *
 * Replay safety:
 *   Every renewal emits EXECUTION_LEASE_RENEWED with the updated expiresAt,
 *   providing an audit trail for lease lifetime reconstruction during replay
 *   diagnostics.
 */

import type { Clock } from "../../shared/clock.js";
import type { ExecutionLease } from "../../domain/cluster.js";
import type { LeaseStore } from "../../domain/clusterPorts.js";
import type { EventFactory } from "../events/eventFactory.js";
import type { PersistedEventPublisher } from "../events/persistedEventPublisher.js";
import type pino from "pino";

export interface LeaseHeartbeatConfig {
  workerId: string;
  leaseTtlMs: number;
  /**
   * Renew when remaining lease time drops below this fraction of leaseTtlMs.
   * Default 0.4 means renew when < 40% of TTL remains (i.e., at 60% elapsed).
   */
  renewThresholdFactor: number;
  /** How often to check tracked leases for upcoming expiry. */
  pollIntervalMs: number;
}

export type LeaseLostListener = (executionId: string) => void;

export class LeaseHeartbeatWorker {
  private readonly tracked = new Map<string, ExecutionLease>();
  private handle?: NodeJS.Timeout;

  /**
   * Listeners notified when a tracked lease is confirmed lost. "Confirmed
   * lost" means the lease store either rejected the renewal (lease.renew
   * returned undefined) or the lease's expiresAt has already passed at
   * tick time. Transient renewal errors (thrown exceptions) do NOT fire
   * listeners — those are retried next tick.
   *
   * Listener errors are isolated: a throwing listener cannot prevent
   * other listeners from firing or block heartbeat processing.
   */
  private readonly leaseLostListeners = new Set<LeaseLostListener>();

  constructor(
    private readonly leases: LeaseStore,
    private readonly publisher: PersistedEventPublisher,
    private readonly eventFactory: EventFactory,
    private readonly clock: Clock,
    private readonly logger: pino.Logger,
    private readonly config: LeaseHeartbeatConfig
  ) {}

  /**
   * Subscribe to confirmed lease-loss notifications. Returns a dispose
   * function that removes the listener. Used by WorkerExecutionLoop to
   * abort the in-flight executeJob's AbortController when its lease is
   * revoked mid-execution.
   */
  addLeaseLostListener(handler: LeaseLostListener): () => void {
    this.leaseLostListeners.add(handler);
    return () => {
      this.leaseLostListeners.delete(handler);
    };
  }

  /**
   * Fire all listeners with the given executionId. Errors thrown by any
   * one listener are isolated so they cannot starve later listeners or
   * subsequent renewals in the same tick.
   */
  private notifyLeaseLost(executionId: string): void {
    for (const listener of this.leaseLostListeners) {
      try {
        listener(executionId);
      } catch (err) {
        this.logger.error(
          { err, executionId, workerId: this.config.workerId },
          "leaseLost listener threw — continuing with remaining listeners"
        );
      }
    }
  }

  /** Register a lease for automatic renewal while its execution is running. */
  track(executionId: string, lease: ExecutionLease): void {
    this.tracked.set(executionId, lease);
  }

  /** Remove a lease from tracking (call when execution completes or fails). */
  untrack(executionId: string): void {
    this.tracked.delete(executionId);
  }

  trackedCount(): number {
    return this.tracked.size;
  }

  start(): void {
    if (this.handle) return;
    this.handle = setInterval(() => {
      void this.tick().catch((err) =>
        this.logger.error({ err }, "lease heartbeat tick failed — will retry on next interval")
      );
    }, this.config.pollIntervalMs);
    this.handle.unref?.();
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = undefined;
    }
    this.tracked.clear();
  }

  /**
   * Check all tracked leases. Renew any that are within the renewal window.
   *
   * If renewal fails (lease lost/expired), the entry is removed from tracking.
   * The execution engine's fencing token validation will detect this and abort
   * the stale execution before it can write corrupted output.
   */
  async tick(): Promise<void> {
    if (!this.tracked.size) return;

    const now = this.clock.now();
    const nowMs = now.getTime();
    const renewWindowMs = this.config.leaseTtlMs * this.config.renewThresholdFactor;

    const renewals: Promise<void>[] = [];
    for (const [executionId, lease] of this.tracked) {
      const expiresAtMs = new Date(lease.expiresAt).getTime();
      const remainingMs = expiresAtMs - nowMs;

      // Alarm: lease is already expired but still tracked — the execution
      // engine should have been aborted by fencing. Log at error severity
      // AND fire onLeaseLost so the worker loop can proactively cancel its
      // in-flight model call (post-execute fencing is the backstop).
      if (remainingMs <= 0) {
        this.logger.error(
          { executionId, workerId: this.config.workerId, expiresAt: lease.expiresAt },
          "lease heartbeat: lease expired while still tracked — fencing token should abort execution"
        );
        this.tracked.delete(executionId);
        this.notifyLeaseLost(executionId);
        continue;
      }

      if (remainingMs > renewWindowMs) continue; // plenty of time remaining

      renewals.push(this.renewOne(executionId, now));
    }

    await Promise.allSettled(renewals);
  }

  private async renewOne(executionId: string, now: Date): Promise<void> {
    try {
      const renewed = await this.leases.renew(
        executionId,
        this.config.workerId,
        now,
        this.config.leaseTtlMs
      );

      if (!renewed) {
        // Renewal rejected — lease was reclaimed or expired. Remove tracking
        // so the execution engine's fencing check picks up the loss, AND
        // fire onLeaseLost so the worker loop can proactively abort the
        // in-flight model call instead of waiting for the post-execute
        // fencing rejection (which would spend tokens for a discarded
        // outcome).
        this.tracked.delete(executionId);
        this.logger.warn(
          { executionId, workerId: this.config.workerId },
          "lease heartbeat: renewal rejected — lease was lost; execution will be aborted"
        );
        this.notifyLeaseLost(executionId);
        return;
      }

      // Update our view of the lease so the next tick uses the new expiresAt.
      this.tracked.set(executionId, renewed);

      await this.publisher.publish(
        this.eventFactory.create({
          type: "EXECUTION_LEASE_RENEWED",
          aggregateId: executionId,
          aggregateType: "EXECUTION",
          payload: { lease: renewed }
        })
      );
    } catch (err) {
      this.logger.error(
        { err, executionId, workerId: this.config.workerId },
        "lease heartbeat: renewal error — will retry on next tick"
      );
    }
  }
}
