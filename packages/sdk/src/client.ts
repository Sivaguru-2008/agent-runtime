import { resolveConfig, type ClientConfig } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { HttpClient } from "./http.js";
import { executionFilter, parseEventStream } from "./streaming.js";
import {
  isTerminalStatus,
  type Agent,
  type CreateAgentParams,
  type CreateExecutionParams,
  type Execution,
  type ExecutionDetails,
  type ExecutionEvent,
  type ListExecutionsParams,
  type StreamExecutionParams
} from "./types.js";

/** Options for {@link AgentRuntimeClient.waitForExecution}. */
export interface WaitForExecutionOptions {
  /** Stop waiting after this many milliseconds. Defaults to 120_000. */
  timeoutMs?: number;
  /** Poll interval in milliseconds. Defaults to 1_000. */
  pollIntervalMs?: number;
  /** Abort the wait early. */
  signal?: AbortSignal;
  /** Invoked on each poll with the latest execution. */
  onPoll?: (execution: Execution) => void;
}

/**
 * The Agent Runtime SDK client.
 *
 * ```ts
 * const client = new AgentRuntimeClient({
 *   baseUrl: "https://api.example.com",
 *   apiKey: process.env.AGENT_API_KEY
 * });
 *
 * const execution = await client.createExecution({
 *   agentId: "agent_123",
 *   prompt: "Summarise the latest incident report"
 * });
 * ```
 */
export class AgentRuntimeClient {
  private readonly http: HttpClient;

  constructor(config: ClientConfig) {
    this.http = new HttpClient(resolveConfig(config));
  }

  /**
   * Create an agent (`POST /agents`). Returns the new {@link Agent}; pass its
   * `id` to {@link createExecution} to run a task. This is the first call in the
   * happy path for a fresh tenant, which has no agents yet.
   */
  async createAgent(params: CreateAgentParams): Promise<Agent> {
    if (!params?.name) {
      throw new ConfigurationError("`name` is required to create an agent.");
    }
    if (!params?.goal) {
      throw new ConfigurationError("`goal` is required to create an agent.");
    }
    const body: Record<string, unknown> = { name: params.name, goal: params.goal };
    if (params.model !== undefined) body.model = params.model;
    if (params.tools !== undefined) body.tools = params.tools;
    if (params.memoryPolicy !== undefined) body.memoryPolicy = params.memoryPolicy;

    return this.http.request<Agent>({ method: "POST", path: "/agents", body });
  }

  /**
   * Start a new execution for an agent (`POST /agents/:agentId/tasks`).
   *
   * Returns immediately with the execution in its initial state — the runtime
   * processes it asynchronously. Use {@link streamExecution} or
   * {@link waitForExecution} to observe completion.
   *
   * Pass `idempotencyKey` to make the call safe to auto-retry on network
   * failure without risking a duplicate execution.
   */
  async createExecution(params: CreateExecutionParams): Promise<Execution> {
    if (!params?.agentId) {
      throw new ConfigurationError("`agentId` is required to create an execution.");
    }
    if (!params.prompt && !params.goal && !params.input) {
      throw new ConfigurationError(
        "Provide at least one of `prompt`, `goal`, or `input` when creating an execution."
      );
    }

    const body: Record<string, unknown> = {};
    if (params.prompt !== undefined) body.prompt = params.prompt;
    if (params.goal !== undefined) body.goal = params.goal;
    if (params.input !== undefined) body.input = params.input;
    if (params.scheduleAt !== undefined) body.scheduleAt = params.scheduleAt;

    return this.http.request<Execution>({
      method: "POST",
      path: `/agents/${encodeURIComponent(params.agentId)}/tasks`,
      body,
      ...(params.idempotencyKey
        ? { headers: { "idempotency-key": params.idempotencyKey }, allowRetry: true }
        : {})
    });
  }

  /**
   * Fetch a single execution with its observability envelope
   * (`GET /executions/:id`). The bare {@link Execution} is available under
   * `.execution`.
   */
  async getExecution(executionId: string): Promise<ExecutionDetails> {
    requireId(executionId, "executionId");
    return this.http.request<ExecutionDetails>({
      method: "GET",
      path: `/executions/${encodeURIComponent(executionId)}`
    });
  }

  /**
   * Replay an existing execution (`POST /executions/:id/replay`). Returns the
   * new replay execution. Replay is a write-class operation and requires a
   * developer+ key.
   */
  async replayExecution(executionId: string): Promise<Execution> {
    requireId(executionId, "executionId");
    return this.http.request<Execution>({
      method: "POST",
      path: `/executions/${encodeURIComponent(executionId)}/replay`
    });
  }

  /**
   * List executions (`GET /executions`). Without `agentId`, returns every
   * execution the API key can see (across all owned agents), newest first.
   * Filtering by `status` and `limit` is applied server-side.
   */
  async listExecutions(params: ListExecutionsParams = {}): Promise<Execution[]> {
    const query: Record<string, string | number | undefined> = {};
    if (params.agentId) query.agentId = params.agentId;
    if (params.status) {
      query.status = (Array.isArray(params.status) ? params.status : [params.status]).join(",");
    }
    if (typeof params.limit === "number" && params.limit >= 0) query.limit = params.limit;

    const response = await this.http.request<{ executions?: Execution[] }>({
      method: "GET",
      path: "/executions",
      query
    });
    return response.executions ?? [];
  }

  /**
   * Stream runtime events as they happen (`GET /events/stream`, SSE).
   *
   * Returns an async iterator of {@link ExecutionEvent}. When `executionId` is
   * provided, only events for that execution are yielded. Pass a `signal` to
   * stop the stream.
   *
   * ```ts
   * const ac = new AbortController();
   * for await (const event of client.streamExecution({ executionId, signal: ac.signal })) {
   *   if (event.type === "COGNITION_COMPLETED") ac.abort();
   * }
   * ```
   */
  async *streamExecution(params: StreamExecutionParams = {}): AsyncGenerator<ExecutionEvent> {
    const response = await this.http.request<Response>({
      method: "GET",
      path: "/events/stream",
      ...(params.afterSequence !== undefined ? { query: { afterSequence: params.afterSequence } } : {}),
      headers: { accept: "text/event-stream" },
      ...(params.signal ? { signal: params.signal } : {}),
      raw: true
    });

    const filter = params.executionId ? executionFilter(params.executionId) : undefined;
    yield* parseEventStream(response, filter, params.signal);
  }

  /**
   * Poll until an execution reaches a terminal state (or `timeoutMs` elapses).
   * A convenience wrapper over {@link getExecution} for request/response style
   * callers who don't want to consume the event stream.
   */
  async waitForExecution(
    executionId: string,
    options: WaitForExecutionOptions = {}
  ): Promise<Execution> {
    requireId(executionId, "executionId");
    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const { execution } = await this.getExecution(executionId);
      options.onPoll?.(execution);
      if (isTerminalStatus(execution.status)) return execution;
      if (Date.now() >= deadline) {
        throw new ConfigurationError(
          `Execution ${executionId} did not reach a terminal state within ${timeoutMs}ms (last status: ${execution.status}).`
        );
      }
      await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal);
    }
  }
}

function requireId(value: string | undefined, name: string): asserts value is string {
  if (!value || typeof value !== "string") {
    throw new ConfigurationError(`\`${name}\` is required and must be a non-empty string.`);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
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
}
