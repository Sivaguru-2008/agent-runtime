import {
  Fence,
  FenceConfig,
  Dispatch,
  WrappedDispatch,
  CallOptions,
  withRun,
} from "./fence";

export { Fence, withRun, resolveStorage } from "./fence";
export type {
  FenceConfig,
  StorageOption,
  Clock,
  Dispatch,
  WrappedDispatch,
  CallOptions,
  ToolExecutor,
} from "./fence";

export { EffectRegistry } from "./registry";
export type { EffectType, EffectMap } from "./registry";

export type {
  StorageAdapter,
  CommittedEffect,
  IntentRecord,
  IntentStatus,
  PutResult,
} from "./storage/base";
export { SqliteStorage } from "./storage/sqlite";
export { PostgresStorage } from "./storage/postgres";

export { createLogger } from "./utils/logger";
export type { FenceLogger, LoggerOptions, FenceEvent } from "./utils/logger";

export {
  hashInput,
  sha256,
  canonicalize,
  makeOperationId,
} from "./utils/hash";

export type WrappedAgent = WrappedDispatch & {
  /** The underlying Fence instance (for sharing storage, closing, etc.). */
  fence: Fence;
  /** Release storage handles. */
  close: () => Promise<void>;
};

/**
 * Wrap a tool-dispatch function so every call is fenced. This is the one-line
 * entry point:
 *
 * ```ts
 * const agent = wrap(myAgent, { effects: { stripeCharge: "IRREVERSIBLE" }, storage: "sqlite" });
 * ```
 *
 * `myAgent` is your `(toolName, input) => result` dispatcher. On retry, an
 * IRREVERSIBLE effect that already succeeded returns its recorded response
 * instead of re-executing.
 */
export function wrap(dispatch: Dispatch, config: FenceConfig): WrappedAgent {
  const f = new Fence(config);
  const wrapped = ((toolName: string, input: any, callOpts?: CallOptions) =>
    f.dispatch(
      toolName,
      input,
      () => dispatch(toolName, input),
      callOpts
    )) as WrappedAgent;
  wrapped.fence = f;
  wrapped.close = () => f.close();
  return wrapped;
}

/** Create a reusable Fence without wrapping a specific dispatcher. */
export function createFence(config: FenceConfig): Fence {
  return new Fence(config);
}

/** Namespaced API: `fence.wrap(...)`. */
export const fence = { wrap, createFence, withRun, Fence };

export default fence;
