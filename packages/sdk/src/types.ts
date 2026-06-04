/**
 * Public domain types for the Agent Runtime API.
 *
 * These mirror the server-side domain model (`apps/api/src/domain/model.ts`)
 * but are intentionally decoupled: the SDK ships its own copy so consumers do
 * not depend on the server package. Fields the server marks optional for
 * back-compat are optional here too.
 */

/** Lifecycle state of an execution as it moves through the runtime. */
export type ExecutionStatus =
  | "CREATION"
  | "SCHEDULING"
  | "LEASE_ACQUISITION"
  | "RUNNING"
  | "SIDE_EFFECT_PENDING"
  | "REPLAYING"
  | "RECOVERING"
  | "COMMITTED"
  | "COMPLETED"
  | "FAILED"
  | "AMBIGUOUS"
  | "RECONCILIATION_REQUIRED"
  | "DEAD_LETTERED"
  | "EXPIRED"
  | "QUEUED"
  | "CANCELLED";

/** Terminal states — an execution in one of these will not change again. */
export const TERMINAL_STATUSES: readonly ExecutionStatus[] = [
  "COMPLETED",
  "FAILED",
  "DEAD_LETTERED",
  "EXPIRED",
  "CANCELLED"
];

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface ExecutionFailure {
  message: string;
  code?: string;
  recoverable: boolean;
}

/** A single agent execution. */
export interface Execution {
  id: string;
  agentId: string;
  parentExecutionId?: string;
  status: ExecutionStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  failure?: ExecutionFailure;
  tokenUsage: TokenUsage;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
  tenantId?: string;
  traceId?: string;
}

export type ExecutionStepType =
  | "PLANNING"
  | "MEMORY_RETRIEVAL"
  | "TOOL_CALL"
  | "MODEL_GENERATION"
  | "RETRY"
  | "COMPLETION";

export type ExecutionStepStatus = "STARTED" | "COMPLETED" | "FAILED";

export interface ExecutionStep {
  id: string;
  executionId: string;
  agentId: string;
  type: ExecutionStepType;
  status: ExecutionStepStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

/**
 * Response envelope returned by `GET /executions/:id`. The server wraps the
 * execution with observability metadata (trace id, runtime id) plus any
 * detail fields produced by the observability query layer.
 */
export interface ExecutionDetails {
  execution: Execution;
  traceId?: string;
  runtimeId?: string;
  steps?: ExecutionStep[];
  /** Forward-compatible: server may attach additional analysis fields. */
  [key: string]: unknown;
}

/**
 * A runtime event delivered over the SSE stream. The server emits a broad set
 * of event types (cognition, node, lifecycle); the shape below captures the
 * envelope fields the SDK relies on for filtering and resuming. `payload` is
 * left open so consumers can narrow on `type` themselves.
 */
export interface ExecutionEvent<TPayload = Record<string, unknown>> {
  type: string;
  /** Monotonic sequence used for resume/dedupe. May be absent on some frames. */
  sequence?: number;
  aggregateId?: string;
  aggregateType?: "EXECUTION" | "AGENT" | "MEMORY" | "SYSTEM" | string;
  payload?: TPayload;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

/**
 * An agent record as returned by `POST /agents` and `GET /agents/:id`.
 * Additional server fields are passed through untyped.
 */
export interface Agent {
  /** Stable agent identifier — pass this to {@link CreateExecutionParams.agentId}. */
  id: string;
  name: string;
  goal: string;
  status?: string;
  createdAt?: string;
  [key: string]: unknown;
}

/** Parameters accepted by {@link AgentRuntimeClient.createAgent}. */
export interface CreateAgentParams {
  /** Human-readable agent name. Required. */
  name: string;
  /** The agent's standing goal/charter. Required. */
  goal: string;
  /** Optional model selection; the server applies sensible defaults when omitted. */
  model?: { provider?: string; model?: string; temperature?: number };
  /** Optional tool grants. */
  tools?: Array<{ name: string; description?: string; enabled?: boolean }>;
  /** Optional memory policy. */
  memoryPolicy?: { episodicEnabled?: boolean; semanticEnabled?: boolean; maxRetrievedItems?: number };
}

/** Parameters accepted by {@link AgentRuntimeClient.createExecution}. */
export interface CreateExecutionParams {
  /** Agent that will run the task. */
  agentId: string;
  /** Free-text prompt for the task. Either `prompt` or `goal` is typical. */
  prompt?: string;
  /** Structured goal for the task. */
  goal?: string;
  /** Arbitrary structured input forwarded to the agent. */
  input?: Record<string, unknown>;
  /** ISO-8601 timestamp to defer execution. */
  scheduleAt?: string;
  /**
   * Optional idempotency key. When set, a retried create (e.g. after a network
   * blip) is forwarded with the same `Idempotency-Key` header so the server can
   * de-duplicate. Required to make `createExecution` safe to auto-retry.
   */
  idempotencyKey?: string;
}

/** Parameters accepted by {@link AgentRuntimeClient.listExecutions}. */
export interface ListExecutionsParams {
  /**
   * Restrict to a single agent. When omitted, every execution the API key can
   * see (across all owned agents) is returned, newest first.
   */
  agentId?: string;
  /** Filter by status. Applied server-side. */
  status?: ExecutionStatus | ExecutionStatus[];
  /** Cap on the number of executions returned (newest first). Applied server-side. */
  limit?: number;
}

/** Parameters accepted by {@link AgentRuntimeClient.streamExecution}. */
export interface StreamExecutionParams {
  /**
   * Restrict the stream to a single execution. When set, only events whose
   * `aggregateId` (or `payload.executionId`) match are yielded.
   */
  executionId?: string;
  /** Resume from a sequence cursor (exclusive). */
  afterSequence?: number;
  /** Abort the stream early. */
  signal?: AbortSignal;
}
