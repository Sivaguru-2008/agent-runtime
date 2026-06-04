/**
 * Live runtime telemetry event types. These are the realtime events emitted by
 * the Groq-backed execution engine. They are separate from the rich domain
 * events used by the existing agent runtime — the live events are intentionally
 * compact, transport-friendly, and built around a single executionId.
 */

export type LiveEventType =
  | "PROMPT_RECEIVED"
  | "MODEL_START"
  | "TOKEN_STREAM"
  | "MODEL_COMPLETE"
  | "MODEL_ERROR"
  | "EXECUTION_STATE";

export type LiveExecutionState =
  | "PENDING"
  | "RUNNING"
  | "STREAMING"
  | "COMPLETED"
  | "FAILED";

export interface LiveEventBase {
  executionId: string;
  timestamp: string;
  sequence: number;
  /**
   * Tenant that owns this execution. Stamped at event emission time so the
   * SSE/broadcaster fan-out layer can filter without an extra database lookup.
   * Optional for back-compat with pre-tenancy events still in the in-memory
   * ring buffer — those default to the system tenant and are only visible to
   * admin subscribers.
   */
  tenantId?: string;
}

export interface PromptReceivedEvent extends LiveEventBase {
  type: "PROMPT_RECEIVED";
  prompt: string;
  model: string;
}

export interface ModelStartEvent extends LiveEventBase {
  type: "MODEL_START";
  model: string;
  prompt: string;
}

export interface TokenStreamEvent extends LiveEventBase {
  type: "TOKEN_STREAM";
  token: string;
  tokensSoFar: number;
  latencyMs: number;
}

export interface ModelCompleteEvent extends LiveEventBase {
  type: "MODEL_COMPLETE";
  model: string;
  prompt: string;
  output: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  streamDurationMs: number;
  tokensPerSecond: number;
}

export interface ModelErrorEvent extends LiveEventBase {
  type: "MODEL_ERROR";
  message: string;
  code: string;
  latencyMs: number;
}

export interface ExecutionStateEvent extends LiveEventBase {
  type: "EXECUTION_STATE";
  state: LiveExecutionState;
}

export type LiveEvent =
  | PromptReceivedEvent
  | ModelStartEvent
  | TokenStreamEvent
  | ModelCompleteEvent
  | ModelErrorEvent
  | ExecutionStateEvent;
