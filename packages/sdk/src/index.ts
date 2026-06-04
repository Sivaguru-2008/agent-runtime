/**
 * @agent-platform/sdk — official TypeScript SDK for the Agent Runtime API.
 *
 * @example
 * ```ts
 * import { AgentRuntimeClient } from "@agent-platform/sdk";
 *
 * const client = new AgentRuntimeClient({
 *   baseUrl: "https://api.example.com",
 *   apiKey: process.env.AGENT_API_KEY
 * });
 *
 * const execution = await client.createExecution({
 *   agentId: "agent_123",
 *   prompt: "Draft a release note for v1.2"
 * });
 * const final = await client.waitForExecution(execution.id);
 * ```
 */

export { AgentRuntimeClient } from "./client.js";
export type { WaitForExecutionOptions } from "./client.js";

export type {
  ClientConfig,
  AuthScheme,
  FetchLike
} from "./config.js";

export type {
  RetryOptions,
  RetryInfo
} from "./retry.js";
export { DEFAULT_RETRY } from "./retry.js";

export {
  AgentRuntimeError,
  ConfigurationError,
  NetworkError,
  TimeoutError,
  AbortError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServiceUnavailableError,
  ServerError,
  ApiError
} from "./errors.js";

export {
  isTerminalStatus,
  TERMINAL_STATUSES
} from "./types.js";

export type {
  Agent,
  CreateAgentParams,
  Execution,
  ExecutionStatus,
  ExecutionDetails,
  ExecutionStep,
  ExecutionStepType,
  ExecutionStepStatus,
  ExecutionEvent,
  ExecutionFailure,
  TokenUsage,
  CreateExecutionParams,
  ListExecutionsParams,
  StreamExecutionParams
} from "./types.js";

export type { SseFrame } from "./streaming.js";
export { SseParser } from "./streaming.js";
