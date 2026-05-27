/**
 * Typed error hierarchy for LLM provider adapters.
 *
 * Operational impact  : callers catch by type to decide retry vs abort.
 * Replay implications : all errors are serialised into the event store as
 *                       EXECUTION_FAILED payloads, so replay can reconstruct
 *                       exactly which error class terminated the execution.
 * Failure modes       : ProviderRateLimitError carries retryAfterMs so the
 *                       retry policy can honour the provider's back-off hint.
 * Observability       : every error includes `provider` so structured logs
 *                       can group by provider without parsing the message.
 */

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public override readonly cause?: unknown
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(provider: string) {
    super(`${provider}: authentication failed — check your API key.`, provider);
    this.name = "ProviderAuthError";
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(
    provider: string,
    /** Milliseconds to wait before retrying, if the provider sent Retry-After. */
    public readonly retryAfterMs?: number
  ) {
    super(`${provider}: rate limit exceeded`, provider);
    this.name = "ProviderRateLimitError";
  }
}

export class ProviderServerError extends ProviderError {
  constructor(provider: string, public readonly statusCode: number) {
    super(`${provider}: server error HTTP ${statusCode}`, provider);
    this.name = "ProviderServerError";
  }
}

export class ProviderNetworkError extends ProviderError {
  constructor(provider: string, cause: unknown) {
    super(`${provider}: network error — is the service reachable?`, provider, cause);
    this.name = "ProviderNetworkError";
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(provider: string, public readonly timeoutMs: number) {
    super(`${provider}: request timed out after ${timeoutMs}ms`, provider);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderContextLengthError extends ProviderError {
  constructor(provider: string) {
    super(`${provider}: prompt exceeds the model's context window`, provider);
    this.name = "ProviderContextLengthError";
  }
}

/** Thrown when the model's response cannot be parsed as structured JSON. */
export class ProviderStructuredOutputError extends ProviderError {
  constructor(provider: string, public readonly raw: string) {
    super(`${provider}: could not extract structured JSON from response`, provider);
    this.name = "ProviderStructuredOutputError";
  }
}
