/**
 * WorkerContainer — composition root for a worker-only process.
 *
 * A worker process has *no HTTP server*, *no auth*, *no rate limiter*, *no
 * audit log*, *no quotas*. It only does the following:
 *
 *   1. Connect to the durable cluster state (Postgres-backed lease store,
 *      worker registry, checkpoint store, DLQ).
 *   2. Subscribe to the cross-process job queue (Redis-backed in production).
 *   3. Register itself in the worker registry and start its heartbeat.
 *   4. Run the WorkerExecutionLoop: lease → execute → ack | retry | DLQ.
 *   5. Run the BackgroundRecoveryLoop: reclaim expired leases from crashed
 *      siblings and re-enqueue their executions.
 *
 * It is deliberately built on top of `createRuntimeContainer` with
 * RUNTIME_ROLE=worker. Reusing the same wiring guarantees that:
 *   - The cognition pipeline (executor agent, planner, etc.) is identical
 *     to the one the original combined container ran — no behavioral drift.
 *   - The event model is identical — events emitted from inside a worker
 *     have the same shape and source as before.
 *   - The persistence layer is identical — leases, checkpoints, and dead
 *     letters all share schema with the API process.
 *
 * What this factory adds beyond the base container:
 *   - Sets RUNTIME_ROLE="worker" before container construction (so the API
 *     enqueue path is also wired but the worker registers + consumes).
 *   - Provides a `runUntilSignal()` helper so the worker entry point can
 *     `await` a clean shutdown.
 */

import type pino from "pino";
import type { AppConfig } from "../shared/config.js";
import {
  createRuntimeContainer,
  type RuntimeContainer,
  type RuntimeContainerOverrides
} from "./runtimeContainer.js";

export interface WorkerContainer extends RuntimeContainer {
  /**
   * Block until the process receives a termination signal, then drain
   * gracefully and close the container. Resolves when shutdown is complete.
   */
  runUntilSignal(signals?: NodeJS.Signals[]): Promise<void>;
}

export async function createWorkerContainer(
  config: AppConfig,
  logger: pino.Logger,
  overrides: RuntimeContainerOverrides = {}
): Promise<WorkerContainer> {
  if (config.RUNTIME_ROLE !== "worker") {
    throw new Error(
      `createWorkerContainer requires RUNTIME_ROLE=worker, got "${config.RUNTIME_ROLE}". ` +
        "Set the env var before launching the worker process."
    );
  }

  const base = await createRuntimeContainer(config, logger, overrides);

  if (!base.workerLoop) {
    // Defensive: createRuntimeContainer is supposed to build the loop when
    // role !== "api", so this should never happen. Treat it as a startup
    // failure.
    await base.close();
    throw new Error("WorkerContainer construction did not produce a WorkerExecutionLoop");
  }

  return {
    ...base,
    async runUntilSignal(signals = ["SIGTERM", "SIGINT"]): Promise<void> {
      logger.info(
        { workerId: base.workerId, capacity: base.config.WORKER_CAPACITY },
        "worker process ready — awaiting termination signal"
      );

      await new Promise<void>((resolve) => {
        const onSignal = (sig: NodeJS.Signals) => {
          logger.info({ sig, workerId: base.workerId }, "worker received shutdown signal");
          for (const s of signals) process.off(s, onSignal);
          resolve();
        };
        for (const s of signals) process.on(s, onSignal);
      });

      // Drain in-flight executions, then close all resources.
      await base.close();
    }
  };
}
