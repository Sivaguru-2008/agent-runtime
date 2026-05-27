export class NotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class RuntimeError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "RuntimeError";
  }
}

/**
 * Surfaced when the runtime composition cannot complete its bootstrap.
 * Sprint Hardening 3 — startup is now synchronous; partial init must reject
 * rather than leave the process in a half-wired state.
 */
export class RuntimeStartupError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    readonly cause?: unknown
  ) {
    super(`[${stage}] ${message}`);
    this.name = "RuntimeStartupError";
  }
}

/**
 * Raised when the API attempts to enqueue work but the queue depth has
 * crossed the configured backpressure threshold. Producers MUST surface this
 * to clients as a 503-class signal — silently buffering would violate the
 * distributed runtime's backpressure contract.
 */
export class BackpressureError extends Error {
  constructor(
    readonly depth: number,
    readonly threshold: number
  ) {
    super(
      `Execution queue is over capacity (${depth} ≥ ${threshold}). ` +
        `New tasks rejected until workers catch up.`
    );
    this.name = "BackpressureError";
  }
}

export class PlannerValidationError extends Error {
  readonly name = "PlannerValidationError";
  constructor(
    message: string,
    public readonly cognitionId?: string,
    public readonly recoverable = true,
    public readonly retryable = true,
    public readonly validationErrors?: string[]
  ) {
    super(message);
  }
}

export class LowConfidenceExecutionBlocked extends Error {
  readonly name = "LowConfidenceExecutionBlocked";
  constructor(
    message: string,
    public readonly confidenceScore: number,
    public readonly recoverable = true,
    public readonly retryable = true,
    public readonly cognitionId?: string
  ) {
    super(message);
  }
}

export class RuntimeExecutionError extends Error {
  readonly name = "RuntimeExecutionError";
  constructor(
    message: string,
    public readonly cognitionId?: string,
    public readonly recoverable = true,
    public readonly retryable = true,
    public readonly originalError?: unknown
  ) {
    super(message);
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack;
    }
  }
}

export class ToolContractViolation extends Error {
  readonly name = "ToolContractViolation";
  constructor(
    message: string,
    public readonly cognitionId?: string,
    public readonly recoverable = true,
    public readonly retryable = false,
    public readonly toolName?: string,
    public readonly schemaErrors?: unknown
  ) {
    super(message);
  }
}

export class NodeResolutionFailure extends Error {
  readonly name = "NodeResolutionFailure";
  constructor(
    message: string,
    public readonly cognitionId?: string,
    public readonly recoverable = false,
    public readonly retryable = false,
    public readonly nodeId?: string
  ) {
    super(message);
  }
}

