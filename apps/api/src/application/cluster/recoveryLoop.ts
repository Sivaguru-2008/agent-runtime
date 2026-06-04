import type { Clock } from "../../shared/clock.js";
import type pino from "pino";
import type { WorkerLifecycleService } from "./workerLifecycle.js";
import type { DistributedScheduler } from "./distributedScheduler.js";
import { withSpan } from "../../infrastructure/telemetry/tracing.js";

export interface RecoveryLoopConfig {
  intervalMs: number;
}

export interface RecoveryTickSummary {
  expiredWorkers: number;
  reclaimedLeases: number;
  reapedWorkers: number;
  recoveredExecutions: number;
  durationMs: number;
}

/**
 * BackgroundRecoveryLoop — autonomous cluster recovery (Phase 5).
 *
 * Each tick:
 *   1. WorkerLifecycle.sweep() — detect heartbeat-timeout workers and reclaim
 *      their active leases (emits WORKER_LOST + EXECUTION_LEASE_RECLAIMED).
 *      Postgres lease store uses FOR UPDATE SKIP LOCKED so concurrent
 *      recovery loops on different API replicas don't double-reclaim.
 *   2. Scheduler.recover() — re-enqueue reclaimed executions onto the local
 *      worker (the LeaseStore guarantees only one worker actually acquires
 *      the lease again).
 *
 * The loop is *idempotent*. Two replicas running it on the same Postgres
 * cluster will converge on the same recovery outcome — leases reclaimed by
 * one are not reclaimed twice by the other.
 *
 * Decoupled from `WorkerLifecycleService` so the lifecycle layer remains a
 * pure worker-state machine: cluster recovery sits in the application layer
 * where re-enqueue policy decisions belong.
 */
export class BackgroundRecoveryLoop {
  private handle?: NodeJS.Timeout;
  private inFlight = false;

  constructor(
    private readonly lifecycle: WorkerLifecycleService,
    private readonly scheduler: DistributedScheduler,
    private readonly clock: Clock,
    private readonly logger: pino.Logger,
    private readonly config: RecoveryLoopConfig
  ) {}

  start(): void {
    if (this.handle) return;
    this.handle = setInterval(() => {
      // Skip if a previous tick is still running — protects against slow
      // recovery (large reclaim batch) overlapping itself.
      if (this.inFlight) return;
      void this.tick().catch((err) => this.logger.error({ err }, "recovery loop tick failed"));
    }, this.config.intervalMs);
    this.handle.unref?.();
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = undefined;
    }
  }

  async tick(): Promise<RecoveryTickSummary> {
    if (this.inFlight) {
      return { expiredWorkers: 0, reclaimedLeases: 0, reapedWorkers: 0, recoveredExecutions: 0, durationMs: 0 };
    }
    this.inFlight = true;
    const startedAt = this.clock.now().getTime();
    try {
      return await withSpan("cluster.recovery.tick", {}, async () => {
        const sweep = await this.lifecycle.sweep();
        const recovered = await this.scheduler.recover();
        const summary: RecoveryTickSummary = {
          expiredWorkers: sweep.expired.length,
          reclaimedLeases: sweep.reclaimedLeases,
          reapedWorkers: sweep.reaped.length,
          recoveredExecutions: recovered,
          durationMs: this.clock.now().getTime() - startedAt
        };
        if (
          summary.expiredWorkers > 0 ||
          summary.reclaimedLeases > 0 ||
          summary.reapedWorkers > 0 ||
          summary.recoveredExecutions > 0
        ) {
          this.logger.info(summary, "cluster recovery tick");
        }
        return summary;
      });
    } finally {
      this.inFlight = false;
    }
  }
}
