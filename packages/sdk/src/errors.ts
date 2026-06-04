/**
 * Typed error hierarchy.
 *
 * Every failure surfaced by the SDK is an instance of {@link AgentRuntimeError},
 * so a single `catch (err) { if (err instanceof AgentRuntimeError) ... }` covers
 * the whole surface. Subclasses map 1:1 to the HTTP envelopes the API returns
 * (see `apps/api/src/interfaces/http/routes.ts`) so callers can branch on the
 * concrete type rather than parsing strings.
 */

export interface AgentRuntimeErrorOptions {
  /** HTTP status code, when the failure originated from a response. */
  status?: number;
  /** Machine-readable error code from the response body (e.g. "NOT_FOUND"). */
  code?: string;
  /** Whether retrying the same request might succeed. */
  retryable?: boolean;
  /** Server-suggested backoff, in milliseconds (derived from `Retry-After`). */
  retryAfterMs?: number;
  /** Raw parsed response body, for forensic logging. */
  body?: unknown;
  /** Correlation id stamped by the server on 500s. */
  errorId?: string;
  /** Underlying cause (network error, abort, etc.). */
  cause?: unknown;
}

/** Base class for every error thrown by the SDK. */
export class AgentRuntimeError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly body?: unknown;
  readonly errorId?: string;

  constructor(message: string, options: AgentRuntimeErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    if (options.status !== undefined) this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.body !== undefined) this.body = options.body;
    if (options.errorId !== undefined) this.errorId = options.errorId;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Misuse of the SDK before any request is sent (bad config, missing args). */
export class ConfigurationError extends AgentRuntimeError {}

/** The request never produced a response (DNS, connection reset, offline). */
export class NetworkError extends AgentRuntimeError {
  constructor(message: string, options: AgentRuntimeErrorOptions = {}) {
    super(message, { retryable: true, ...options });
  }
}

/** The request exceeded the configured timeout. */
export class TimeoutError extends AgentRuntimeError {
  constructor(message: string, options: AgentRuntimeErrorOptions = {}) {
    super(message, { retryable: true, ...options });
  }
}

/** The caller aborted the request via an AbortSignal. */
export class AbortError extends AgentRuntimeError {}

/** 400 — request body failed validation. `body.issues` holds Zod issues. */
export class ValidationError extends AgentRuntimeError {}

/** 401 — missing/invalid API key. */
export class AuthenticationError extends AgentRuntimeError {}

/** 403 — authenticated but not allowed (role or cross-tenant). */
export class AuthorizationError extends AgentRuntimeError {}

/** 404 — resource does not exist (or is hidden cross-tenant). */
export class NotFoundError extends AgentRuntimeError {}

/** 409 — state conflict. */
export class ConflictError extends AgentRuntimeError {}

/** 429 — rate limit or quota exceeded. Retryable, honors Retry-After. */
export class RateLimitError extends AgentRuntimeError {
  constructor(message: string, options: AgentRuntimeErrorOptions = {}) {
    super(message, { retryable: true, ...options });
  }
}

/**
 * 503 — the runtime is healthy but cannot serve right now (queue saturated,
 * model provider unavailable, auth backend down). Always retryable.
 */
export class ServiceUnavailableError extends AgentRuntimeError {
  constructor(message: string, options: AgentRuntimeErrorOptions = {}) {
    super(message, { retryable: true, ...options });
  }
}

/** 5xx other than 503 — an unexpected server fault. */
export class ServerError extends AgentRuntimeError {
  constructor(message: string, options: AgentRuntimeErrorOptions = {}) {
    // 500/502/504 are commonly transient; treat as retryable for safe methods.
    super(message, { retryable: true, ...options });
  }
}

/** Any other unexpected HTTP status the SDK does not specifically model. */
export class ApiError extends AgentRuntimeError {}

interface ParsedErrorBody {
  message: string;
  code?: string;
  errorId?: string;
}

/**
 * Normalise the two response-body shapes the API uses into a flat message/code.
 *
 *   1. `{ error: "NOT_FOUND", message: "..." }`           (most routes)
 *   2. `{ success:false, error:{ type, message, ... } }`  (runtime errors)
 */
function parseErrorBody(body: unknown, fallback: string): ParsedErrorBody {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (b.error && typeof b.error === "object") {
      const inner = b.error as Record<string, unknown>;
      return {
        message: typeof inner.message === "string" ? inner.message : fallback,
        ...(typeof inner.type === "string" ? { code: inner.type } : {})
      };
    }
    return {
      message: typeof b.message === "string" ? b.message : fallback,
      ...(typeof b.error === "string" ? { code: b.error } : {}),
      ...(typeof b.errorId === "string" ? { errorId: b.errorId } : {})
    };
  }
  return { message: fallback };
}

/**
 * Build the correct error subclass for an HTTP response.
 *
 * `retryAfterMs` is resolved from the `Retry-After` header (preferred) and
 * falls back to the `retryAfterSec` field the API includes on 503 bodies.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  retryAfterMs?: number
): AgentRuntimeError {
  const { message, code, errorId } = parseErrorBody(body, `Request failed with status ${status}`);
  const base: AgentRuntimeErrorOptions = {
    status,
    body,
    ...(code !== undefined ? { code } : {}),
    ...(errorId !== undefined ? { errorId } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  };

  switch (status) {
    case 400:
      return new ValidationError(message, base);
    case 401:
      return new AuthenticationError(message, base);
    case 403:
      return new AuthorizationError(message, base);
    case 404:
      return new NotFoundError(message, base);
    case 409:
      return new ConflictError(message, base);
    case 429:
      return new RateLimitError(message, base);
    case 503:
      return new ServiceUnavailableError(message, base);
    default:
      if (status >= 500) return new ServerError(message, base);
      return new ApiError(message, base);
  }
}
