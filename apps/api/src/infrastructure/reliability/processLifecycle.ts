/**
 * processLifecycle — comprehensive process-termination diagnostics.
 *
 * Root-cause history:
 *   The API would "start successfully" (port 4000 bound, Postgres connected,
 *   migrations applied) and then become unreachable — ERR_CONNECTION_REFUSED.
 *   Two structural defects fed that symptom:
 *
 *     1. The previous graceful-shutdown wiring escalated EVERY
 *        `unhandledRejection` to a full `app.close()` + `process.exit(1)`.
 *        A single stray async rejection from any background loop (a transient
 *        Postgres/Redis blip, a provider timeout, the OTel exporter failing to
 *        reach a non-existent collector at localhost:4318) therefore tore down
 *        the HTTP listener. The process "started" then died.
 *
 *     2. When the process did exit, nothing recorded WHY — the operator was
 *        left with a dead port and no stack trace, execution id, or memory
 *        reading to explain it.
 *
 * This module fixes both:
 *   • `unhandledRejection` is NON-FATAL by default. It is logged loudly with a
 *     full diagnostic snapshot but the process keeps serving. An unhandled
 *     rejection is a bug to fix, not a reason to take the whole API offline.
 *   • `uncaughtException` IS fatal (the process is in an undefined state) but is
 *     logged with a complete snapshot and routed through the SAME graceful
 *     drain as a signal, with a hard-exit fallback so termination can never
 *     hang.
 *   • Every termination-relevant event (signals, beforeExit, exit, warning) is
 *     logged with: reason, stack, runtime id, trace/span id, execution id
 *     (when the async context is preserved), ISO timestamp, uptime, and a full
 *     memory-usage breakdown.
 *
 * The snapshot timestamp uses `trueIsoNow()` (the un-patched clock) so the
 * fatal handler can log even when it fires inside an execution step's async
 * context, where the determinism guard would otherwise make a global `Date`
 * read throw and mask the original error.
 */

import { trueIsoNow } from "../../shared/trueClock.js";
import { getActiveSpanContext } from "../telemetry/tracing.js";

/** Minimal structural logger — satisfied by the pino instance from createLogger. */
export interface LifecycleLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  fatal(obj: unknown, msg?: string): void;
}

export interface ProcessLifecycleOptions {
  logger: LifecycleLogger;
  /** Stable id for THIS process instance — correlates a crash to a boot. */
  runtimeId: string;
  /** "api" | "worker" — disambiguates logs when both run on one host. */
  role: string;
  /**
   * Invoked for a fatal condition (uncaughtException). Should perform a
   * best-effort graceful drain and then NOT return (it owns process.exit).
   * If it throws or hangs, the hard-exit fallback fires after `fatalExitDelayMs`.
   */
  onFatal: (reason: string, error: unknown) => Promise<void> | void;
  /**
   * Optional accessor for the current execution id. Wired by the caller to
   * `() => deterministicStorage.getStore()?.executionId` so the diagnostics
   * module does not have to import the execution engine (and trip its global
   * Date monkey-patch at an unexpected point in the import graph).
   */
  getExecutionId?: () => string | undefined;
  /**
   * Treat unhandledRejection as fatal too. Defaults to FALSE — the whole point
   * of this module is that a stray rejection must not take the API down. Set
   * true only in environments that genuinely want crash-on-rejection.
   */
  fatalOnUnhandledRejection?: boolean;
  /**
   * Treat uncaughtException as fatal (drain + exit). Defaults to TRUE — an
   * uncaught exception leaves the process in a formally undefined state, so the
   * production policy is to exit and let the orchestrator restart a clean
   * process.
   *
   * Set FALSE in development: there, `tsx watch` does NOT restart a crashed
   * child (it only reloads on a file change), so a single stray synchronous
   * throw from a timer/background callback would `process.exit(1)` and leave the
   * backend PERMANENTLY unreachable until the next save — the exact "starts then
   * ERR_CONNECTION_REFUSED / Backend offline" symptom. Non-fatal mode logs the
   * full fatal snapshot loudly but keeps the HTTP listener alive; the throw has
   * almost always escaped a callback, not Fastify's request pipeline (those are
   * caught by the framework error handler), so the server keeps serving.
   */
  fatalOnUncaughtException?: boolean;
  /** Hard-exit fallback delay if onFatal does not terminate. Default 10s. */
  fatalExitDelayMs?: number;
}

/** Normalise an arbitrary thrown value into a structured, loggable shape. */
export function serializeError(value: unknown): {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: string;
  aggregate?: string[];
} {
  if (value instanceof Error) {
    const out: ReturnType<typeof serializeError> = {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
    const code = (value as NodeJS.ErrnoException).code;
    if (code !== undefined) out.code = code;
    if (value.cause !== undefined) out.cause = String(value.cause);
    // AggregateError (e.g. the OTLP exporter's ECONNREFUSED to ::1 + 127.0.0.1)
    const errors = (value as AggregateError).errors;
    if (Array.isArray(errors)) {
      out.aggregate = errors.map((e) => (e instanceof Error ? e.message : String(e)));
    }
    return out;
  }
  return { message: typeof value === "string" ? value : JSON.stringify(value) };
}

let installed = false;

/**
 * Install the process-lifecycle diagnostics + termination policy.
 * Idempotent — a second call is a no-op (guards against double registration
 * when both the app factory and a test harness wire it).
 */
export function installProcessLifecycle(opts: ProcessLifecycleOptions): void {
  if (installed) {
    opts.logger.warn(
      { runtimeId: opts.runtimeId },
      "[lifecycle] installProcessLifecycle called twice — ignoring the second call"
    );
    return;
  }
  installed = true;

  const { logger, runtimeId, role } = opts;
  const fatalExitDelayMs = opts.fatalExitDelayMs ?? 10_000;
  const fatalOnUncaughtException = opts.fatalOnUncaughtException ?? true;
  const originalExit = process.exit.bind(process);

  /** Build the rich diagnostic snapshot attached to every lifecycle log line. */
  function snapshot(extra: Record<string, unknown>): Record<string, unknown> {
    const mem = process.memoryUsage();
    const span = getActiveSpanContext();
    let executionId: string | undefined;
    try {
      executionId = opts.getExecutionId?.();
    } catch {
      /* never let diagnostics collection throw */
    }
    return {
      runtimeId,
      role,
      pid: process.pid,
      timestamp: trueIsoNow(),
      uptimeSec: Math.round(process.uptime()),
      ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
      ...(executionId ? { executionId } : {}),
      memory: {
        rssMB: Math.round(mem.rss / 1024 / 1024),
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        externalMB: Math.round(mem.external / 1024 / 1024),
        arrayBuffersMB: Math.round((mem.arrayBuffers ?? 0) / 1024 / 1024)
      },
      ...extra
    };
  }

  let fatalInProgress = false;
  function handleFatal(reason: string, error: unknown): void {
    if (fatalInProgress) return;
    fatalInProgress = true;

    // Hard-exit fallback: if the graceful drain hangs (e.g. a Postgres pool
    // that won't close), terminate anyway so the orchestrator restarts a clean
    // process rather than leaving a half-dead one bound to the port.
    const hardExit = setTimeout(() => {
      logger.fatal(
        snapshot({ event: "fatal-drain-timeout", reason, fatalExitDelayMs }),
        `[lifecycle] fatal drain exceeded ${fatalExitDelayMs}ms — forcing exit(1)`
      );
      process.exit(1);
    }, fatalExitDelayMs);
    hardExit.unref();

    try {
      void Promise.resolve(opts.onFatal(reason, error)).catch((drainErr) => {
        logger.fatal(
          snapshot({ event: "fatal-drain-error", reason, drainErr: serializeError(drainErr) }),
          "[lifecycle] fatal drain threw — forcing exit(1)"
        );
        process.exit(1);
      });
    } catch (drainErr) {
      logger.fatal(
        snapshot({ event: "fatal-drain-error", reason, drainErr: serializeError(drainErr) }),
        "[lifecycle] fatal drain threw synchronously — forcing exit(1)"
      );
      process.exit(1);
    }
  }

  // ── unhandledRejection — NON-FATAL by default ──────────────────────────────
  process.exit = ((code?: string | number | null | undefined): never => {
    const stack = new Error("process.exit call site").stack;
    logger.warn(
      snapshot({ event: "process.exit", code: code ?? 0, stack }),
      "[lifecycle] process.exit requested"
    );
    return originalExit(code as never);
  }) as typeof process.exit;

  process.on("unhandledRejection", (reason, promise) => {
    const info = snapshot({
      event: "unhandledRejection",
      reason: serializeError(reason),
      // Surface the promise's string form for correlation without leaking data.
      promise: String(promise)
    });
    if (opts.fatalOnUnhandledRejection) {
      logger.fatal(info, "[lifecycle] unhandled promise rejection (fatal mode) — shutting down");
      handleFatal("unhandledRejection", reason);
      return;
    }
    logger.error(
      info,
      "[lifecycle] unhandled promise rejection — LOGGED, process kept alive. " +
        "This is a bug to fix, not a reason to drop the HTTP listener."
    );
  });

  // ── uncaughtException — FATAL by default, non-fatal in development ──────────
  process.on("uncaughtException", (err, origin) => {
    const info = snapshot({ event: "uncaughtException", origin, err: serializeError(err) });
    if (fatalOnUncaughtException) {
      logger.fatal(info, "[lifecycle] uncaught exception — draining and exiting(1)");
      handleFatal("uncaughtException", err);
      return;
    }
    // Non-fatal mode (development): exiting here is what turned a single stray
    // throw into a permanently-offline backend under `tsx watch` (which does not
    // restart a crashed child). Log the full fatal snapshot loudly and keep the
    // listener alive — the next file save hot-reloads a clean process.
    logger.fatal(
      info,
      "[lifecycle] uncaught exception — LOGGED, process kept alive (development). " +
        "This is a serious bug to fix and the process state may now be degraded; " +
        "save any source file to hot-reload a clean process once the cause is addressed."
    );
  });

  // ── Warnings (MaxListenersExceeded, deprecations, etc.) ────────────────────
  process.on("warning", (w) => {
    logger.warn(
      { event: "warning", name: w.name, message: w.message, stack: w.stack, runtimeId, role },
      `[lifecycle] process warning: ${w.name}`
    );
  });

  // ── beforeExit / exit — record the final state ─────────────────────────────
  process.on("beforeExit", (code) => {
    // Only log non-zero / unexpected drains; code 0 beforeExit is the normal
    // "event loop empty" path and would be noise on every clean shutdown.
    if (code !== 0) {
      logger.warn(snapshot({ event: "beforeExit", code }), `[lifecycle] beforeExit code=${code}`);
    }
  });

  process.on("exit", (code) => {
    // `exit` handlers must be synchronous. Emit one terminal line so the log
    // always ends with the definitive reason + code the process died with.
    logger.info(
      {
        event: "exit",
        code,
        runtimeId,
        role,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        timestamp: trueIsoNow()
      },
      `[lifecycle] process exit code=${code}`
    );
  });

  logger.info(
    {
      runtimeId,
      role,
      pid: process.pid,
      fatalOnUnhandledRejection: Boolean(opts.fatalOnUnhandledRejection),
      fatalOnUncaughtException
    },
    `[lifecycle] process-lifecycle diagnostics installed ` +
      `(unhandledRejection ${opts.fatalOnUnhandledRejection ? "FATAL" : "non-fatal"}, ` +
      `uncaughtException ${fatalOnUncaughtException ? "FATAL" : "non-fatal"})`
  );
}

/** Test-only: reset the install guard so a fresh install can be exercised. */
export function __resetProcessLifecycleForTests(): void {
  installed = false;
}
