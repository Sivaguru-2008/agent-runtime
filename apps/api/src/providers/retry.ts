/**
 * Retry-with-exponential-backoff and timeout utilities for provider calls.
 *
 * Operational impact  : transient provider failures (network blips, 429s,
 *                       5xx) are retried automatically so callers never see
 *                       a single-packet failure.
 * Replay implications : retry attempts are transparent to the event log — the
 *                       final success or failure is what gets persisted.
 * Failure modes       : non-retryable errors (401, 400, context-length) are
 *                       rethrown immediately without waiting.
 * Observability       : the `onRetry` hook lets callers emit structured log
 *                       entries or metrics per attempt.
 */

import {
  ProviderRateLimitError,
  ProviderServerError,
  ProviderNetworkError,
  ProviderTimeoutError
} from "./errors.js";

export interface RetryOptions {
  maxAttempts: number;
  /** Base delay for attempt 1 (doubles each subsequent attempt). */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fraction of computed delay added as ±random jitter. Range [0,1]. */
  jitterFactor: number;
}

export const defaultRetryOptions: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterFactor: 0.25
};

function isRetryable(error: unknown): boolean {
  return (
    error instanceof ProviderRateLimitError ||
    error instanceof ProviderServerError ||
    error instanceof ProviderNetworkError ||
    error instanceof ProviderTimeoutError
  );
}

/**
 * Core cancellation primitives and error normalisation.
 */
export function createAbortError(message = "The operation was aborted."): Error {
  try {
    return new DOMException(message, "AbortError");
  } catch {
    const err = new Error(message);
    err.name = "AbortError";
    return err;
  }
}

/**
 * Normalises whatever an AbortSignal carries in `reason` into a proper Error.
 *
 * `signal.reason` is `any` by spec — callers can pass strings, plain objects,
 * DOMExceptions, real Errors, or leave it undefined. Throwing the raw value
 * downstream breaks `instanceof Error` checks and produces useless stack
 * traces. This funnels every shape into an Error while preserving AbortError
 * semantics so the global `isAbortError()` check still classifies it.
 */
export function normalizeAbortReason(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") {
    const err = new Error(reason);
    err.name = "AbortError";
    return err;
  }
  if (reason === undefined || reason === null) {
    return createAbortError();
  }
  // Arbitrary object / primitive — preserve a readable message without
  // assuming the value has a useful `.toString()`.
  let message: string;
  try {
    message = typeof reason === "object" ? JSON.stringify(reason) : String(reason);
  } catch {
    message = "The operation was aborted.";
  }
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw normalizeAbortReason(signal.reason);
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message.includes("aborted") || error.message.includes("AbortError");
  }
  return false;
}

/**
 * Centralised guarded onToken dispatcher. Re-checks the abort signal
 * immediately before invoking the consumer callback so the
 * "throwIfAborted → produce-token → onToken" window cannot leak a token to
 * downstream consumers (SSE bridge, cognition graph) after cancellation.
 *
 * The check-and-throw is intentional: throwing here aborts the stream-drain
 * loop one microtask earlier than the next reader.read() iteration would,
 * which keeps cancellation latency tight under streaming load.
 */
export function emitTokenIfLive(
  signal: AbortSignal | undefined,
  emit: ((token: string, confidence: number) => void) | undefined,
  token: string,
  confidence: number
): void {
  if (signal?.aborted) throw normalizeAbortReason(signal.reason);
  emit?.(token, confidence);
}

/**
 * Creates an interruptible sleep promise that rejects immediately if the AbortSignal aborts.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(normalizeAbortReason(signal.reason));
    }
    // Listener cleanup invariant: BOTH paths (timer-fires and abort-fires)
    // must remove the listener. The `once: true` registration handles the
    // abort-fires path automatically; the timer-fires path removes
    // explicitly. Calling removeEventListener on an already-removed listener
    // is a no-op per DOM spec, so double-removal in pathological races is
    // safe.
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(normalizeAbortReason(signal?.reason));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Composes multiple abort signals into one. The returned signal aborts when
 * the first input signal aborts. MUST call `cleanup()` when finished to remove
 * all attached event listeners.
 */
export function composeAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const active = signals.filter((s): s is AbortSignal => !!s);
  if (active.length === 0) {
    return { signal: new AbortController().signal, cleanup: () => {} };
  }
  if (active.length === 1) {
    return { signal: active[0]!, cleanup: () => {} };
  }
  const controller = new AbortController();
  // Double-abort guard: AbortController.abort() is idempotent per spec, but
  // some polyfills/test harnesses re-fire the event on the second call. The
  // guard keeps observable behavior deterministic: the first abort wins and
  // its reason is preserved.
  const abortOnce = (reason: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(normalizeAbortReason(reason));
    }
  };
  const onAbort = (ev: Event) => {
    const target = ev.target as AbortSignal | null;
    abortOnce(target?.reason);
  };
  for (const s of active) {
    if (s.aborted) {
      abortOnce(s.reason);
      // Listeners have not been attached yet for any signal after this one,
      // and any earlier attachments are auto-removed by `once: true` only
      // when their signals fire. Explicitly remove for the signals we
      // already attached to so a later, lazy abort on a sibling doesn't
      // re-trigger a no-op handler.
      const cleanup = () => {
        for (const s2 of active) s2.removeEventListener("abort", onAbort);
      };
      return { signal: controller.signal, cleanup };
    }
    s.addEventListener("abort", onAbort, { once: true });
  }
  // Cleanup is safe to call multiple times: removeEventListener is a no-op
  // when the listener is already detached (either by explicit cleanup or by
  // `once: true` after firing).
  const cleanup = () => {
    for (const s of active) {
      s.removeEventListener("abort", onAbort);
    }
  };
  return { signal: controller.signal, cleanup };
}

/**
 * Executes `fn` up to `options.maxAttempts` times, applying exponential
 * backoff with jitter between failures. The `onRetry` callback fires before
 * each sleep so the caller can log or emit metrics. Supports early abortion.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = defaultRetryOptions,
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === options.maxAttempts || !isRetryable(error)) throw error;
      throwIfAborted(signal);

      // Honour provider-supplied Retry-After for rate-limit responses.
      let base = Math.min(
        options.baseDelayMs * 2 ** (attempt - 1),
        options.maxDelayMs
      );
      if (error instanceof ProviderRateLimitError && error.retryAfterMs) {
        base = Math.min(error.retryAfterMs, options.maxDelayMs);
      }

      const jitter = base * options.jitterFactor * (Math.random() - 0.5);
      const delay = Math.max(0, Math.round(base + jitter));

      onRetry?.(attempt, error, delay);
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

/**
 * Races `promise` against a timer. Throws ProviderTimeoutError on expiry
 * so the retry logic can decide whether to retry.
 */
export async function withProviderTimeout<T>(
  promise: Promise<T>,
  ms: number,
  provider: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProviderTimeoutError(provider, ms)),
          ms
        );
        // Prevent the timer from blocking process exit during tests.
        if (typeof timer.unref === "function") timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
