export type FenceEventType = "COMMITTED" | "SUPPRESSED" | "WARN" | "DEBUG";

export interface FenceEvent {
  type: FenceEventType;
  tool?: string;
  operationId?: string;
  runId?: string;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

export interface FenceLogger {
  committed(e: { tool: string; operationId: string; runId: string }): void;
  suppressed(e: { tool: string; operationId: string; runId: string }): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  /** Turn all logging on/off. Default: true. */
  enabled?: boolean;
  /** Minimum level emitted. Default: "info". */
  level?: "debug" | "info" | "warn" | "silent";
  /** Receives a formatted line plus the structured event. Default: console. */
  sink?: (line: string, event: FenceEvent) => void;
}

const LEVEL_RANK = { debug: 10, info: 20, warn: 30, silent: 99 } as const;

function shortOp(op?: string): string {
  return op ? op.slice(0, 12) : "";
}

function isLogger(x: unknown): x is FenceLogger {
  return (
    !!x &&
    typeof (x as FenceLogger).committed === "function" &&
    typeof (x as FenceLogger).suppressed === "function"
  );
}

function defaultSink(line: string, event: FenceEvent): void {
  // Fence logs are diagnostics — keep them on stderr so they never pollute an
  // agent's stdout payloads.
  if (event.type === "WARN") console.warn(line);
  else console.error(line);
}

/**
 * Build the structured logger used by the fence. Pass a {@link LoggerOptions}
 * object to tune output, or a fully custom {@link FenceLogger} to take over
 * completely (handy in tests).
 */
export function createLogger(
  options: LoggerOptions | FenceLogger = {}
): FenceLogger {
  if (isLogger(options)) return options;

  const opts = options as LoggerOptions;
  const enabled = opts.enabled ?? true;
  const level = opts.level ?? "info";
  const minRank = LEVEL_RANK[level];
  const sink = opts.sink ?? defaultSink;

  function emit(rank: number, line: string, event: FenceEvent): void {
    if (!enabled || level === "silent" || rank < minRank) return;
    sink(line, event);
  }

  return {
    committed(e) {
      emit(
        LEVEL_RANK.info,
        `[COMMITTED] ${e.tool} run=${e.runId} op=${shortOp(e.operationId)} — effect executed and recorded`,
        { type: "COMMITTED", ...e }
      );
    },
    suppressed(e) {
      emit(
        LEVEL_RANK.info,
        `[SUPPRESSED] ${e.tool} run=${e.runId} op=${shortOp(e.operationId)} — already committed; returning recorded response`,
        { type: "SUPPRESSED", ...e }
      );
    },
    warn(message, fields = {}) {
      emit(LEVEL_RANK.warn, `[WARN] ${message}`, {
        type: "WARN",
        message,
        ...fields,
      });
    },
    debug(message, fields = {}) {
      emit(LEVEL_RANK.debug, `[DEBUG] ${message}`, {
        type: "DEBUG",
        message,
        ...fields,
      });
    },
  };
}
