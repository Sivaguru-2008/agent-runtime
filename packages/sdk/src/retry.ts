import { AgentRuntimeError } from "./errors.js";

/** Tunable retry behaviour. All fields optional; sane defaults applied. */
export interface RetryOptions {
  /** Maximum number of retries (in addition to the initial attempt). */
  maxRetries?: number;
  /** Base delay for exponential backoff, in milliseconds. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff delay, in milliseconds. */
  maxDelayMs?: number;
  /**
   * Jitter factor in [0, 1]. The computed backoff is multiplied by a random
   * value in `[1 - jitter, 1 + jitter]` to avoid thundering-herd retries.
   */
  jitter?: number;
  /**
   * Hook invoked before each retry sleep. Useful for logging/metrics in
   * consumer apps. Never throws into the retry loop.
   */
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: AgentRuntimeError;
}

export interface ResolvedRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  onRetry?: (info: RetryInfo) => void;
}

export const DEFAULT_RETRY: ResolvedRetryOptions = {
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 10_000,
  jitter: 0.25
};

export function resolveRetryOptions(opts?: RetryOptions): ResolvedRetryOptions {
  return {
    maxRetries: opts?.maxRetries ?? DEFAULT_RETRY.maxRetries,
    baseDelayMs: opts?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
    maxDelayMs: opts?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    jitter: opts?.jitter ?? DEFAULT_RETRY.jitter,
    ...(opts?.onRetry ? { onRetry: opts.onRetry } : {})
  };
}

/**
 * Compute the delay before the next attempt.
 *
 * A server-supplied `Retry-After` (carried on the error as `retryAfterMs`)
 * always wins — the server knows better than our backoff curve. Otherwise we
 * use exponential backoff with full jitter, capped at `maxDelayMs`.
 *
 * `attempt` is zero-based (0 = first retry).
 */
export function computeDelayMs(
  attempt: number,
  error: AgentRuntimeError,
  opts: ResolvedRetryOptions,
  random: () => number = Math.random
): number {
  if (typeof error.retryAfterMs === "number" && error.retryAfterMs >= 0) {
    return Math.min(error.retryAfterMs, opts.maxDelayMs);
  }
  const exponential = opts.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, opts.maxDelayMs);
  const factor = 1 + (random() * 2 - 1) * opts.jitter;
  return Math.max(0, Math.round(capped * factor));
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Run `fn` with retries. `fn` is invoked once per attempt and is expected to
 * throw an {@link AgentRuntimeError} on failure. Only errors whose `retryable`
 * flag is true are retried; everything else is re-thrown immediately.
 *
 * `retryable` is gated by the caller (the transport only marks a request
 * retryable when the HTTP method is safe or an idempotency key is present), so
 * this loop never silently re-sends a non-idempotent mutation.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: ResolvedRetryOptions,
  signal?: AbortSignal,
  random: () => number = Math.random
): Promise<T> {
  let lastError: AgentRuntimeError | undefined;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      const error = err instanceof AgentRuntimeError ? err : undefined;
      // Non-SDK errors (programming bugs) and non-retryable errors propagate.
      if (!error || !error.retryable || attempt === opts.maxRetries) {
        throw err;
      }
      lastError = error;
      const delayMs = computeDelayMs(attempt, error, opts, random);
      opts.onRetry?.({ attempt: attempt + 1, maxRetries: opts.maxRetries, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
  // Unreachable: the loop either returns or throws. Satisfy the type checker.
  throw lastError ?? new Error("Retry loop exited unexpectedly");
}
