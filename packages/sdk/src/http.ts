import { authHeaders, type ResolvedConfig } from "./config.js";
import {
  AbortError,
  AgentRuntimeError,
  NetworkError,
  TimeoutError,
  errorFromResponse
} from "./errors.js";
import { resolveRetryOptions, withRetry } from "./retry.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Extra per-request headers (e.g. Idempotency-Key, Last-Event-ID). */
  headers?: Record<string, string>;
  /** Caller abort signal. Composed with the timeout signal. */
  signal?: AbortSignal;
  /**
   * Force-allow retries for an otherwise-unsafe method. Set by `createExecution`
   * when an idempotency key is supplied, so a network blip can be retried
   * without risking a duplicate side effect.
   */
  allowRetry?: boolean;
  /** Skip JSON parsing and return the raw Response (used by the SSE path). */
  raw?: boolean;
}

/**
 * Parse `Retry-After`, which may be either a delta in seconds or an HTTP date.
 * Returns milliseconds, or undefined if absent/unparseable.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - now);
  return undefined;
}

function buildUrl(config: ResolvedConfig, path: string, query?: RequestOptions["query"]): string {
  const url = new URL(`${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Compose the caller signal with a timeout. Returns the signal to pass to
 * fetch plus a `cleanup` to clear the timer and a `timedOut` getter.
 */
function withTimeout(
  timeoutMs: number,
  caller?: AbortSignal
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = (): void => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
    didTimeout: () => timedOut
  };
}

async function parseJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class HttpClient {
  constructor(private readonly config: ResolvedConfig) {}

  /** Perform a single HTTP attempt (no retry). Returns the raw Response. */
  private async fetchOnce(opts: RequestOptions): Promise<Response> {
    const { signal, cleanup, didTimeout } = withTimeout(this.config.timeoutMs, opts.signal);
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.config.userAgent,
      ...this.config.headers,
      ...authHeaders(this.config),
      ...opts.headers
    };

    const hasBody = opts.body !== undefined && !SAFE_METHODS.has(opts.method);
    if (hasBody) headers["content-type"] = "application/json";

    try {
      return await this.config.fetch(buildUrl(this.config, opts.path, opts.query), {
        method: opts.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
        signal
      });
    } catch (err) {
      if (didTimeout()) {
        throw new TimeoutError(`Request timed out after ${this.config.timeoutMs}ms`, { cause: err });
      }
      // The caller aborted (not our timeout).
      if (opts.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new AbortError("Request was aborted", { cause: err });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new NetworkError(`Network request failed: ${message}`, { cause: err });
    } finally {
      cleanup();
    }
  }

  /**
   * Execute a request with retry. Errors are normalised to
   * {@link AgentRuntimeError}; retries occur only for retryable failures on
   * safe methods (or when `allowRetry` is set).
   */
  async request<T>(opts: RequestOptions): Promise<T> {
    const retryOptions = resolveRetryOptions(this.config.retry);
    const mayRetry = SAFE_METHODS.has(opts.method) || opts.allowRetry === true;

    const run = async (): Promise<T> => {
      const response = await this.fetchOnce(opts);

      if (response.ok) {
        if (opts.raw) return response as unknown as T;
        if (response.status === 204) return undefined as T;
        return (await parseJsonSafely(response)) as T;
      }

      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const body = await parseJsonSafely(response);
      const error = errorFromResponse(response.status, body, retryAfterMs);

      // Even if the server says an error class is "retryable", never auto-retry
      // an unsafe method without an idempotency key — that risks duplicate
      // side effects. Demote to non-retryable in that case.
      if (!mayRetry && error.retryable) {
        throw demoteToNonRetryable(error);
      }
      throw error;
    };

    return withRetry<T>(run, retryOptions, opts.signal);
  }
}

/**
 * Return a structurally-identical error whose `retryable` flag is false. We
 * cannot mutate the readonly field, so we re-instantiate the same subclass.
 */
function demoteToNonRetryable(error: AgentRuntimeError): AgentRuntimeError {
  const Ctor = error.constructor as new (msg: string, opts: object) => AgentRuntimeError;
  return new Ctor(error.message, {
    status: error.status,
    code: error.code,
    retryable: false,
    body: error.body,
    errorId: error.errorId
  });
}
