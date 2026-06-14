import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { EffectMap, EffectRegistry, EffectType } from "./registry";
import { hashInput, makeOperationId } from "./utils/hash";
import { createLogger, FenceLogger, LoggerOptions } from "./utils/logger";
import { IntentRecord, IntentStatus, StorageAdapter } from "./storage/base";
import { SqliteStorage } from "./storage/sqlite";
import { PostgresStorage } from "./storage/postgres";

export type StorageOption = "sqlite" | "postgres" | StorageAdapter;

export interface FenceConfig {
  /** Map of tool name -> IRREVERSIBLE | IDEMPOTENT. */
  effects: EffectMap;
  /** "sqlite" (default), "postgres", or a custom StorageAdapter instance. */
  storage?: StorageOption;
  /** SQLite file path or Postgres connection string. */
  connectionString?: string;
  /**
   * Stable identifier for one logical agent run. MUST be the same across a
   * crash and restart for fencing to match. Falls back to an ambient id set
   * via {@link withRun}, then to `"default"`.
   */
  runId?: string;
  /** Effect type for tools not present in `effects`. Default: IDEMPOTENT. */
  defaultEffect?: EffectType;
  /** On storage failure, execute the tool anyway. Default: true (fail open). */
  failOpen?: boolean;
  logger?: LoggerOptions | FenceLogger;
}

export type ToolExecutor = () => unknown | Promise<unknown>;
export interface CallOptions {
  runId?: string;
}
export type Dispatch = (toolName: string, input: any) => unknown | Promise<unknown>;
export type WrappedDispatch = (
  toolName: string,
  input: any,
  callOpts?: CallOptions
) => Promise<any>;

const runStore = new AsyncLocalStorage<{ runId: string }>();

/** Run `fn` with an ambient run id that fenced calls inherit automatically. */
export function withRun<T>(runId: string, fn: () => T): T {
  return runStore.run({ runId }, fn);
}

export class Fence {
  private readonly registry: EffectRegistry;
  private readonly storage: StorageAdapter;
  private readonly logger: FenceLogger;
  private readonly failOpen: boolean;
  private readonly configRunId?: string;
  private ready: Promise<void> | null = null;

  constructor(config: FenceConfig) {
    this.registry = new EffectRegistry(
      config.effects ?? {},
      config.defaultEffect ?? "IDEMPOTENT"
    );
    this.storage = resolveStorage(config);
    this.logger = createLogger(config.logger ?? {});
    this.failOpen = config.failOpen ?? true;
    this.configRunId = config.runId;
  }

  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.storage.init().catch((err) => {
        this.ready = null; // allow a later retry if init failed transiently
        throw err;
      });
    }
    return this.ready;
  }

  private resolveRunId(callOpts?: CallOptions): string {
    return (
      callOpts?.runId ??
      runStore.getStore()?.runId ??
      this.configRunId ??
      "default"
    );
  }

  /**
   * Run a single tool through the fence. `exec` performs the real side effect.
   *
   * IDEMPOTENT tools pass straight through. IRREVERSIBLE tools are checked
   * against the committed-effects log first: a hit is SUPPRESSED (the recorded
   * response is returned and `exec` is never called); a miss executes `exec`
   * and, on success, commits the result.
   */
  async dispatch(
    toolName: string,
    input: unknown,
    exec: ToolExecutor,
    callOpts?: CallOptions
  ): Promise<any> {
    if (this.registry.classify(toolName) === "IDEMPOTENT") {
      this.logger.debug("idempotent passthrough", { tool: toolName });
      return exec();
    }

    const runId = this.resolveRunId(callOpts);
    const inputHash = hashInput(input);
    const operationId = makeOperationId(runId, toolName, inputHash);

    // 1) Check the committed-effects log.
    let existing;
    try {
      await this.ensureReady();
      existing = await this.storage.getCommitted(operationId);
    } catch (err) {
      this.logger.warn("storage unavailable on read; failing open", {
        tool: toolName,
        error: errMsg(err),
      });
      if (!this.failOpen) throw err;
      return exec();
    }

    if (existing) {
      this.logger.suppressed({ tool: toolName, operationId, runId });
      await this.recordIntentSafe({
        id: randomUUID(),
        operationId,
        toolName,
        input: safeStringify(input),
        intendedAt: nowIso(),
        status: "SUPPRESSED",
      });
      return safeParse(existing.response);
    }

    // 2) Record intent, then execute the real side effect.
    const intentId = randomUUID();
    await this.recordIntentSafe({
      id: intentId,
      operationId,
      toolName,
      input: safeStringify(input),
      intendedAt: nowIso(),
      status: "PENDING",
    });

    let result: unknown;
    try {
      result = await exec();
    } catch (err) {
      // The tool failed: the effect did not commit. Leave the intent PENDING
      // so the audit trail shows it was attempted but never fired.
      this.logger.debug("tool execution failed; not committing", {
        tool: toolName,
        error: errMsg(err),
      });
      throw err;
    }

    // 3) Commit the result so future retries are suppressed.
    try {
      const { inserted } = await this.storage.putCommitted({
        id: randomUUID(),
        operationId,
        toolName,
        inputHash,
        response: safeStringify(result),
        committedAt: nowIso(),
      });
      await this.updateIntentSafe(intentId, "COMMITTED");
      if (inserted) {
        this.logger.committed({ tool: toolName, operationId, runId });
      } else {
        this.logger.warn(
          "concurrent commit detected; effect may have fired more than once",
          { tool: toolName, operationId }
        );
      }
    } catch (err) {
      // The effect already executed; we just couldn't record it. Fail open so
      // the caller still gets the result, but warn loudly — a future retry may
      // re-fire this effect.
      this.logger.warn("commit write failed after effect executed", {
        tool: toolName,
        error: errMsg(err),
      });
      if (!this.failOpen) throw err;
    }

    return result;
  }

  /** Wrap a `(toolName, input)` dispatcher so every call is fenced. */
  wrapDispatcher(dispatch: Dispatch): WrappedDispatch {
    return (toolName, input, callOpts) =>
      this.dispatch(toolName, input, () => dispatch(toolName, input), callOpts);
  }

  /** Wrap a single tool function `(input) => result` so it is fenced. */
  wrapTool<I, O>(
    toolName: string,
    fn: (input: I) => O | Promise<O>
  ): (input: I, callOpts?: CallOptions) => Promise<O> {
    return (input, callOpts) =>
      this.dispatch(toolName, input, () => fn(input), callOpts) as Promise<O>;
  }

  close(): Promise<void> {
    return this.storage.close();
  }

  // Intent writes are best-effort audit only; they must never break a real
  // tool call.
  private async recordIntentSafe(record: IntentRecord): Promise<void> {
    try {
      await this.storage.recordIntent(record);
    } catch (err) {
      this.logger.debug("intent audit write failed", { error: errMsg(err) });
    }
  }

  private async updateIntentSafe(
    id: string,
    status: IntentStatus
  ): Promise<void> {
    try {
      await this.storage.updateIntentStatus(id, status);
    } catch (err) {
      this.logger.debug("intent audit update failed", { error: errMsg(err) });
    }
  }
}

export function resolveStorage(config: FenceConfig): StorageAdapter {
  const storage = config.storage ?? "sqlite";
  if (typeof storage !== "string") return storage;
  if (storage === "sqlite") {
    return new SqliteStorage(config.connectionString ?? "agent-fence.db");
  }
  if (storage === "postgres") {
    if (!config.connectionString) {
      throw new Error(
        "agent-fence: postgres storage requires a `connectionString`."
      );
    }
    return new PostgresStorage(config.connectionString);
  }
  throw new Error(
    `agent-fence: unknown storage "${String(
      storage
    )}". Use "sqlite", "postgres", or a StorageAdapter.`
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value === undefined ? null : value) ?? "null";
  } catch {
    return "null";
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
