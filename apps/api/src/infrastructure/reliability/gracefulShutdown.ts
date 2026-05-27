/**
 * Graceful Shutdown — POSIX signal handling with connection draining.
 *
 * Production risk solved:
 *   Without graceful shutdown, a SIGTERM from Kubernetes (rolling deploy,
 *   node drain) kills the process mid-execution. This leaves:
 *     • Active lease records in Postgres that expire only after TTL (30s)
 *     • SSE connections that close abruptly (client reconnects, extra load)
 *     • In-flight DB transactions that roll back without completing
 *     • Incomplete event writes that break event stream consumers
 *
 * Shutdown sequence:
 *   1. Mark process as shutting down — new requests get 503 (handled by
 *      Kubernetes readiness probe pulling traffic before SIGTERM arrives).
 *   2. Stop accepting new connections (Fastify close()).
 *   3. Fastify drains existing connections via its onClose hooks, which
 *      include the RuntimeContainer.close() call registered in app.ts.
 *   4. RuntimeContainer.close() stops the recovery loop, heartbeat worker,
 *      and event bus — all in-progress executions finish naturally or
 *      hit the drain timeout.
 *   5. Process exits 0.
 *
 * Drain timeout:
 *   If draining takes longer than SHUTDOWN_DRAIN_TIMEOUT_MS, the process
 *   force-exits with code 1. Kubernetes will re-schedule the pod; active
 *   leases expire and the recovery loop on a healthy pod reclaims them.
 *
 * Kubernetes alignment:
 *   terminationGracePeriodSeconds (default 30s) should be set to at least
 *   SHUTDOWN_DRAIN_TIMEOUT_MS + 5s buffer. Set SHUTDOWN_DRAIN_TIMEOUT_MS
 *   to less than terminationGracePeriodSeconds so graceful exit wins the race.
 *
 * Uncaught exception handling:
 *   unhandledRejection and uncaughtException trigger the same shutdown path
 *   so the process exits cleanly rather than entering an undefined state.
 *   In both cases the process exits non-zero so the orchestrator restarts it.
 */

import type { FastifyInstance } from "fastify";

export interface GracefulShutdownOptions {
  drainTimeoutMs: number;
  /**
   * Optional callback fired after Fastify has finished its onClose chain
   * but before the process exits. Used to flush OpenTelemetry's
   * BatchSpanProcessor so the final spans of a draining pod actually
   * reach the collector. Errors are swallowed to keep shutdown deterministic.
   */
  afterClose?: () => Promise<void> | void;
}

export function registerGracefulShutdown(
  app: FastifyInstance,
  opts: GracefulShutdownOptions
): void {
  let shuttingDown = false;

  const shutdown = async (signal: string, exitCode: number = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info({ signal, drainTimeoutMs: opts.drainTimeoutMs }, "Shutdown signal received — draining");

    // Force exit if drain takes too long. unref() prevents this timer from
    // keeping the event loop alive if everything closes quickly.
    const forceExit = setTimeout(() => {
      app.log.error(
        { drainTimeoutMs: opts.drainTimeoutMs },
        "Drain timeout exceeded — forcing exit(1)"
      );
      process.exit(1);
    }, opts.drainTimeoutMs);
    forceExit.unref();

    try {
      // app.close() triggers onClose hooks → RuntimeContainer.close()
      // → stops recovery loop, heartbeat, event bus, DB pools.
      await app.close();
      if (opts.afterClose) {
        try {
          await opts.afterClose();
        } catch (err) {
          app.log.warn({ err }, "afterClose hook threw — continuing shutdown");
        }
      }
      clearTimeout(forceExit);
      app.log.info({ signal }, "Graceful shutdown complete");
      process.exit(exitCode);
    } catch (err) {
      app.log.error({ err, signal }, "Error during shutdown — forcing exit(1)");
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));

  process.on("uncaughtException", (err) => {
    app.log.fatal({ err }, "Uncaught exception — shutting down");
    void shutdown("uncaughtException", 1);
  });

  process.on("unhandledRejection", (reason) => {
    app.log.fatal({ reason: String(reason) }, "Unhandled promise rejection — shutting down");
    void shutdown("unhandledRejection", 1);
  });
}
