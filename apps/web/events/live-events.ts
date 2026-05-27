/**
 * Mirror of the backend LiveEvent union. Kept in lockstep with
 * apps/api/src/telemetry/live-events.ts.
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

export const LIVE_EVENT_TYPES: LiveEventType[] = [
  "PROMPT_RECEIVED",
  "MODEL_START",
  "TOKEN_STREAM",
  "MODEL_COMPLETE",
  "MODEL_ERROR",
  "EXECUTION_STATE"
];
