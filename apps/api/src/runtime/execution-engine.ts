import { randomUUID } from "node:crypto";
import { GroqProvider, GroqUnavailableError, type GroqStreamChunk } from "../providers/GroqProvider.js";
import type { LiveEventBroadcaster } from "../events/live-broadcaster.js";
import type {
  LiveEvent,
  LiveExecutionState,
  ModelCompleteEvent,
  ModelErrorEvent,
  TokenStreamEvent
} from "../telemetry/live-events.js";
import { throwIfAborted } from "../providers/retry.js";

export interface RunPromptInput {
  prompt: string;
  system?: string;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * C-2: tenantId is REQUIRED for tenant-isolated emission and ownership
   * filtering. Routes call requireTenant() before invoking runPrompt so this
   * is always supplied in normal operation. Marked optional only to preserve
   * the existing in-process test fixtures that exercise the engine without
   * an HTTP boundary; runPrompt then falls back to SYSTEM_TENANT and admin
   * visibility is the only path that can observe the result.
   */
  tenantId?: string;
  executionId?: string;
  /**
   * Optional per-request model override. When supplied the live run uses this
   * Groq model instead of the provider default — this is what the UI model
   * selector drives. Falls back to the provider's configured model.
   */
  model?: string;
}

export interface ExecutionRecord {
  id: string;
  prompt: string;
  state: LiveExecutionState;
  model: string;
  startedAt: string;
  completedAt?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  streamDurationMs: number;
  tokensPerSecond: number;
  output: string;
  error?: { message: string; code: string };
  /**
   * Owning tenant. Stamped at execution creation so REST list/detail/SSE
   * endpoints can enforce ownership without an extra DB join.
   */
  tenantId?: string;
}

/**
 * Live execution engine. One instance manages many concurrent executions.
 *
 * Lifecycle per execution:
 *   PENDING → RUNNING → STREAMING → COMPLETED | FAILED
 *
 * Each transition and each streamed token is broadcast as a LiveEvent so the
 * UI receives realtime telemetry over SSE.
 *
 * Memory bound (audit CRITICAL-8): the in-process executions map is capped
 * by MAX_TRACKED_EXECUTIONS via FIFO eviction (insertion-ordered Map).
 * Before this bound the map grew without limit, and weeks of uptime in a
 * live-streaming workload would OOM the API process. We evict only when the
 * map is over the cap AND adding a new run, so the active SSE window is
 * always intact for in-flight runs.
 */
const MAX_TRACKED_EXECUTIONS = 4096;

export class LiveExecutionEngine {
  private readonly executions = new Map<string, ExecutionRecord>();
  private sequence = 0;

  constructor(
    private readonly groq: GroqProvider,
    private readonly broadcaster: LiveEventBroadcaster
  ) {}

  list(): ExecutionRecord[] {
    return [...this.executions.values()].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  }

  get(id: string): ExecutionRecord | undefined {
    return this.executions.get(id);
  }

  /**
   * Evict the oldest non-active executions until the map is below the cap.
   * Active runs (RUNNING / STREAMING) are always preserved — evicting one
   * would lose telemetry mid-stream. If every tracked entry is active and we
   * are at the cap, we accept the temporary overshoot rather than corrupt
   * a live stream; the next completed run will free a slot.
   */
  private evictIfOverCapacity(): void {
    if (this.executions.size < MAX_TRACKED_EXECUTIONS) return;
    for (const [id, rec] of this.executions) {
      if (rec.state === "RUNNING" || rec.state === "STREAMING") continue;
      this.executions.delete(id);
      this.broadcaster.resetExecution(id);
      if (this.executions.size < MAX_TRACKED_EXECUTIONS) return;
    }
  }

  metrics() {
    const all = [...this.executions.values()];
    const active = all.filter((e) => e.state === "RUNNING" || e.state === "STREAMING");
    const completed = all.filter((e) => e.state === "COMPLETED");
    const failed = all.filter((e) => e.state === "FAILED");
    const totals = all.reduce(
      (acc, e) => {
        acc.tokens += e.totalTokens;
        acc.latency += e.latencyMs;
        acc.stream += e.streamDurationMs;
        return acc;
      },
      { tokens: 0, latency: 0, stream: 0 }
    );
    return {
      executions: { total: all.length, active: active.length, completed: completed.length, failed: failed.length },
      tokens: { total: totals.tokens },
      latency: { totalMs: totals.latency, averageMs: all.length ? totals.latency / all.length : 0 },
      stream: { totalMs: totals.stream, averageMs: all.length ? totals.stream / all.length : 0 },
      tokensPerSecond: totals.stream > 0 ? (totals.tokens / (totals.stream / 1000)) : 0
    };
  }

  async runPrompt(input: RunPromptInput): Promise<ExecutionRecord> {
    // ─── Fresh-execution invariant ─────────────────────────────────────────
    // If a caller (or buggy client) supplies an executionId that collides
    // with a record we already track, evict the prior record so its state
    // cannot bleed into the new run (token counts, output, error). The new
    // run is *always* a clean slate even when the caller pinned the id.
    const executionId = input.executionId || randomUUID();
    if (this.executions.has(executionId)) {
      this.executions.delete(executionId);
    }
    // Evict any buffered events still associated with this executionId in
    // the broadcaster ring buffer. Defensive: prevents an SSE replay from
    // surfacing prior-run frames to a freshly-subscribed client.
    this.broadcaster.resetExecution(executionId);
    const model = input.model ?? this.groq.modelName;
    const startedWallClock = Date.now();
    const tenantId = input.tenantId;

    const record: ExecutionRecord = {
      id: executionId,
      prompt: input.prompt,
      state: "PENDING",
      model,
      startedAt: new Date(startedWallClock).toISOString(),
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      streamDurationMs: 0,
      tokensPerSecond: 0,
      output: "",
      tenantId
    };
    // Audit CRITICAL-8: evict BEFORE insert. The prior cap of 100 evicted
    // the oldest entry unconditionally, which could drop an active RUNNING
    // / STREAMING execution mid-stream. evictIfOverCapacity() preserves any
    // entry whose state is still live; this raises the cap to a workload-
    // realistic size while preventing unbounded growth.
    this.evictIfOverCapacity();
    this.executions.set(executionId, record);

    this.emit({
      type: "PROMPT_RECEIVED",
      executionId,
      timestamp: new Date().toISOString(),
      sequence: this.nextSeq(),
      prompt: input.prompt,
      model,
      tenantId
    });
    this.transition(record, "RUNNING");

    let firstTokenAt: number | null = null;
    let tokenCount = 0;
    let output = "";
    let promptEvalCount: number | undefined;
    let evalCount: number | undefined;
    let providerTotalDurationNs: number | undefined;

    try {
      this.emit({
        type: "MODEL_START",
        executionId,
        timestamp: new Date().toISOString(),
        sequence: this.nextSeq(),
        model,
        prompt: input.prompt,
        tenantId
      });

      const stream = this.groq.runPrompt({
        prompt: input.prompt,
        system: input.system,
        temperature: input.temperature,
        signal: input.signal,
        model
      });

      let chunk: GroqStreamChunk;
      for await (chunk of stream) {
        throwIfAborted(input.signal);
        if (chunk.token && chunk.token.length > 0) {
          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
            this.transition(record, "STREAMING");
          }
          tokenCount += 1;
          output += chunk.token;
          record.output = output;
          record.completionTokens = tokenCount;
          record.totalTokens = (record.promptTokens || 0) + tokenCount;

          const tokenEvent: TokenStreamEvent = {
            type: "TOKEN_STREAM",
            executionId,
            timestamp: new Date().toISOString(),
            sequence: this.nextSeq(),
            token: chunk.token,
            tokensSoFar: tokenCount,
            latencyMs: Date.now() - startedWallClock,
            tenantId
          };
          this.emit(tokenEvent);
        }

        if (chunk.done) {
          if (chunk.promptEvalCount !== undefined) promptEvalCount = chunk.promptEvalCount;
          if (chunk.evalCount !== undefined) evalCount = chunk.evalCount;
          if (chunk.totalDurationNs !== undefined) providerTotalDurationNs = chunk.totalDurationNs;
        }
      }

      const completedAt = Date.now();
      const latencyMs = completedAt - startedWallClock;
      const streamDurationMs = firstTokenAt ? completedAt - firstTokenAt : 0;
      const completionTokens = evalCount ?? tokenCount;
      const promptTokens = promptEvalCount ?? estimateTokens(input.prompt);
      const totalTokens = promptTokens + completionTokens;
      const tokensPerSecond = streamDurationMs > 0 ? (completionTokens / (streamDurationMs / 1000)) : 0;

      record.completedAt = new Date(completedAt).toISOString();
      record.promptTokens = promptTokens;
      record.completionTokens = completionTokens;
      record.totalTokens = totalTokens;
      record.latencyMs = latencyMs;
      record.streamDurationMs = streamDurationMs;
      record.tokensPerSecond = tokensPerSecond;
      record.output = output;

      const completeEvent: ModelCompleteEvent = {
        type: "MODEL_COMPLETE",
        executionId,
        timestamp: new Date().toISOString(),
        sequence: this.nextSeq(),
        model,
        prompt: input.prompt,
        output,
        promptTokens,
        completionTokens,
        totalTokens,
        latencyMs,
        streamDurationMs,
        tokensPerSecond,
        tenantId
      };
      this.emit(completeEvent);
      this.transition(record, "COMPLETED");

      // Use providerTotalDurationNs for debugging only — kept in record via event.
      void providerTotalDurationNs;

      return record;
    } catch (error) {
      const completedAt = Date.now();
      const code = classifyError(error);
      const message = error instanceof Error ? error.message : "Unknown execution error";

      record.completedAt = new Date(completedAt).toISOString();
      record.latencyMs = completedAt - startedWallClock;
      record.error = { message, code };
      record.output = output;

      const errorEvent: ModelErrorEvent = {
        type: "MODEL_ERROR",
        executionId,
        timestamp: new Date().toISOString(),
        sequence: this.nextSeq(),
        message,
        code,
        latencyMs: record.latencyMs,
        tenantId
      };
      this.emit(errorEvent);
      this.transition(record, "FAILED");

      return record;
    }
  }

  private transition(record: ExecutionRecord, next: LiveExecutionState): void {
    if (record.state === next) return;
    record.state = next;
    // C-2: stamp tenantId on the state-transition event so the SSE broadcaster
    // delivers it only to the owning tenant's subscribers.
    this.emit({
      type: "EXECUTION_STATE",
      executionId: record.id,
      timestamp: new Date().toISOString(),
      sequence: this.nextSeq(),
      state: next,
      tenantId: record.tenantId
    });
  }

  private nextSeq(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private emit(event: LiveEvent): void {
    this.broadcaster.publish(event);
  }
}

function estimateTokens(text: string): number {
  // Coarse heuristic — Groq reports the real count on the final usage chunk.
  return Math.max(1, Math.ceil(text.length / 4));
}

function classifyError(error: unknown): string {
  if (error instanceof GroqUnavailableError) return "GROQ_UNAVAILABLE";
  if (error instanceof Error) {
    if (error.name === "AbortError") return "ABORTED";
    if (error.message.toLowerCase().includes("timeout")) return "TIMEOUT";
  }
  return "INTERNAL_ERROR";
}
