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
 *      include the RuntimeContainer.close() call registered in app.ts. When
 *      the app was built with `forceCloseConnections: true` (development),
 *      long-lived connections such as SSE streams are destroyed immediately
 *      so a watcher restart does not strand the port for the whole drain
 *      window. In production the default keeps in-flight requests alive.
 *   4. RuntimeContainer.close() stops the recovery loop, heartbeat worker,
 *      and event bus — all in-progress executions finish naturally or
 *      hit the drain timeout.
 *   5. Process exits 0.
 *
 * Crash-resilience change (root-cause fix for "starts then ERR_CONNECTION_REFUSED"):
 *   Process-level crash handling now lives in `processLifecycle`. The decisive
 *   policy change is that an `unhandledRejection` is NON-FATAL: it is logged
 *   with a full diagnostic snapshot but no longer triggers app.close() +
 *   process.exit(). Previously a single stray rejection anywhere (a transient
 *   downstream blip, a provider timeout, the OTel exporter failing to reach a
 *   missing collector) tore down the HTTP listener. Only `uncaughtException`
 *   remains fatal, and it is routed through this same drain with a hard-exit
 *   fallback so termination can never hang.
 */

import type { FastifyInstance } from "fastify";
import { installProcessLifecycle } from "./processLifecycle.js";

export interface GracefulShutdownOptions {
  drainTimeoutMs: number;
  /**
   * Optional callback fired after Fastify has finished its onClose chain
   * but before the process exits. Used to flush OpenTelemetry's
   * BatchSpanProcessor so the final spans of a draining pod actually
   * reach the collector. Errors are swallowed to keep shutdown deterministic.
   */
  afterClose?: () => Promise<void> | void;
  /** Stable id for this process instance — stamped on every lifecycle log. */
  runtimeId?: string;
  /** "api" by default — disambiguates logs from a co-located worker. */
  role?: string;
  /** Accessor for the active execution id, surfaced in crash diagnostics. */
  getExecutionId?: () => string | undefined;
  /**
   * Opt back into crash-on-unhandled-rejection. Defaults to false; the whole
   * point of the refactor is that a stray rejection must not drop the listener.
   */
  fatalOnUnhandledRejection?: boolean;
  /**
   * Whether an uncaughtException should drain + exit. Defaults to true
   * (production policy: let the orchestrator restart a clean process). The API
   * entry point sets this false in development so a stray throw cannot leave the
   * backend permanently offline under `tsx watch` (which never restarts a
   * crashed child). See processLifecycle for the full rationale.
   */
  fatalOnUncaughtException?: boolean;
}

export function registerGracefulShutdown(
  app: FastifyInstance,
  opts: GracefulShutdownOptions
): void {
  let shuttingDown = false;
  const role = opts.role ?? "api";
  const runtimeId = opts.runtimeId ?? "unknown";

  const shutdown = async (signal: string, exitCode: number = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info(
      { signal, exitCode, drainTimeoutMs: opts.drainTimeoutMs, runtimeId, role },
      "Shutdown signal received — draining"
    );

    // Force exit if drain takes too long. unref() prevents this timer from
    // keeping the event loop alive if everything closes quickly.
    const forceExit = setTimeout(() => {
      app.log.error(
        { drainTimeoutMs: opts.drainTimeoutMs, signal },
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

  // Crash diagnostics + termination policy. uncaughtException drains through
  // the SAME path; unhandledRejection is logged but non-fatal.
  installProcessLifecycle({
    logger: app.log,
    runtimeId,
    role,
    getExecutionId: opts.getExecutionId,
    fatalOnUnhandledRejection: opts.fatalOnUnhandledRejection,
    fatalOnUncaughtException: opts.fatalOnUncaughtException,
    onFatal: (reason) => shutdown(reason, 1)
  });
}
