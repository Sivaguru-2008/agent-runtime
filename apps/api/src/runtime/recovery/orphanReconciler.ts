/**
 * orphanReconciler — startup reconciliation of leaseless orphaned executions.
 *
 * Two distinct subsystems write Execution rows:
 *
 *   • the DURABLE runloop — a worker acquires a LEASE, then sets the execution
 *     RUNNING. Such an execution ALWAYS has a lease row; if the worker crashes,
 *     the lease expires and BackgroundRecoveryLoop → reclaimExpired →
 *     takeoverRecovery re-drives it. Lease-based recovery owns these.
 *
 *   • the COGNITION runloop — runs in-process (no worker, no lease). It
 *     materialises a backing Execution row as RUNNING in
 *     orchestrator.persistExecutionStart(), then reflects the terminal phase in
 *     persistExecutionTerminal(). If the process dies BETWEEN those two steps,
 *     the row is stranded at RUNNING forever — it holds NO lease, so the
 *     lease-based recovery loop can never see it.
 *
 * This reconciler closes that gap. On startup (before the HTTP server accepts
 * new work, so there is no race with a live cognition run) it finalises every
 * RUNNING execution that holds NO lease as FAILED. The "no lease" predicate is
 * the exact, safe discriminator: a recoverable durable execution always carries
 * a lease row (even an EXPIRED one, which lease-recovery re-drives), and
 * pre-lease durable work is QUEUED/SCHEDULING, never RUNNING. So this can only
 * ever finalise a genuinely orphaned cognition run, never a recoverable one.
 */

import type { ExecutionRepository } from "../../domain/ports.js";
import type { LeaseStore } from "../../domain/clusterPorts.js";
import type { Clock } from "../../shared/clock.js";
import { toIso } from "../../shared/clock.js";
import type pino from "pino";

/** Stamped on the failure of an execution finalised by startup reconciliation. */
export const ORPHANED_ON_RESTART_CODE = "ORPHANED_ON_RESTART";

export interface OrphanReconciliationSummary {
  scanned: number;
  finalized: number;
  finalizedIds: string[];
}

export interface OrphanReconcilerDeps {
  executions: ExecutionRepository;
  leases: LeaseStore;
  clock: Clock;
  logger: pino.Logger;
}

/**
 * Finalise leaseless RUNNING executions as FAILED. Returns a summary. Never
 * throws — a failure to finalise one execution is logged and the sweep
 * continues, so a single bad row cannot abort startup.
 */
export async function reconcileOrphanedExecutions(
  deps: OrphanReconcilerDeps
): Promise<OrphanReconciliationSummary> {
  const { executions, leases, clock, logger } = deps;

  const running = await executions.listByStatus("RUNNING");
  const finalizedIds: string[] = [];

  for (const exec of running) {
    // A lease row (in ANY state, including EXPIRED) means this is a durable
    // execution owned by lease-based recovery — leave it untouched.
    const lease = await leases.getByExecution(exec.id);
    if (lease) continue;

    const now = toIso(clock.now());
    const finalized = {
      ...exec,
      status: "FAILED" as const,
      failure: {
        message:
          "Execution orphaned: the process restarted before this run reached a terminal state, and it holds no recoverable lease.",
        code: ORPHANED_ON_RESTART_CODE,
        recoverable: false
      },
      completedAt: now,
      updatedAt: now
    };

    try {
      await executions.save(finalized);
      finalizedIds.push(exec.id);
    } catch (err) {
      logger.error(
        { err, executionId: exec.id },
        "[reconcile] failed to finalize orphaned execution"
      );
    }
  }

  if (finalizedIds.length > 0) {
    logger.warn(
      { count: finalizedIds.length, executionIds: finalizedIds },
      "[reconcile] finalized leaseless orphaned RUNNING executions as FAILED"
    );
  }

  return { scanned: running.length, finalized: finalizedIds.length, finalizedIds };
}
