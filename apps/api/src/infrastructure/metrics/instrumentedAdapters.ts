/**
 * PHASE 4 — Instrumented Adapter Wrappers
 *
 * These thin wrappers intercept the three most operationally critical adapters
 * and record Prometheus observations without modifying any business logic.
 *
 * Operational visibility gained:
 *   MetricsModelProvider  → latency, token burn, retry rates, circuit-open events
 *   MetricsToolExecutor   → per-tool latency distribution, error rate by tool
 *   MetricsDeadLetterQueue → DLQ volume truth (set from actual list size, not counter estimate)
 *
 * Debugging improvements:
 *   - A P99 spike in agent_model_provider_duration_seconds{provider="claude"}
 *     immediately names the slow dependency without log-grep.
 *   - agent_tool_total{tool_name="web.search", status="error"} climbing
 *     means Brave/DuckDuckGo is down — before users file tickets.
 *   - agent_dlq_volume > 0 is a direct alert: executions are unreachable.
 *
 * Distributed tracing implications:
 *   All wrappers are transparent pass-throughs. They do not start new OTel
 *   spans — the inner adapters own tracing. This separates the metrics signal
 *   from the trace signal without double-instrumentation.
 *
 * Scaling implications:
 *   All operations are O(1) per call (histogram.observe, counter.inc).
 *   The DLQ push calls list() once to get the true volume — this is acceptable
 *   because DLQ pushes are rare (poison-pill threshold events).
 */

import type { ModelProvider, ToolExecutor } from "../../domain/ports.js";
import type { DeadLetterEntry } from "../../domain/cluster.js";
import type { DeadLetterQueue } from "../../domain/clusterPorts.js";
import type { AgentMetrics } from "./prometheusMetrics.js";

// ── Model Provider ─────────────────────────────────────────────────────────

export class MetricsModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly metrics: AgentMetrics,
    /** Provider name for label — must match AppConfig.MODEL_PROVIDER. */
    private readonly provider: string
  ) {}

  async complete(input: Parameters<ModelProvider["complete"]>[0]): ReturnType<ModelProvider["complete"]> {
    // Sanitise model name from ModelConfig — e.g. "claude-sonnet-4-6" or "gpt-4o".
    const model = input.agent.model?.model?.trim() || "default";
    const start = performance.now();

    try {
      const result = await this.inner.complete(input);
      const durationSec = (performance.now() - start) / 1000;

      this.metrics.modelProviderDuration.observe({ provider: this.provider, model }, durationSec);
      this.metrics.modelProviderTotal.inc({ provider: this.provider, status: "ok" });

      // Token accounting: both sides of the exchange are tracked so cost
      // dashboards can compute $ per execution.
      this.metrics.modelTokensTotal.inc(
        { provider: this.provider, token_type: "prompt" },
        result.tokenUsage.prompt
      );
      this.metrics.modelTokensTotal.inc(
        { provider: this.provider, token_type: "completion" },
        result.tokenUsage.completion
      );

      return result;
    } catch (err) {
      // We do NOT observe duration on error: partial/aborted calls produce
      // misleading latency data. Only record the outcome counter.
      const isCircuitOpen =
        err instanceof Error && err.message.toLowerCase().includes("circuit");
      const status = isCircuitOpen ? "circuit_open" : "error";
      this.metrics.modelProviderTotal.inc({ provider: this.provider, status });
      throw err;
    }
  }
}

// ── Tool Executor ──────────────────────────────────────────────────────────

export class MetricsToolExecutor implements ToolExecutor {
  constructor(
    private readonly inner: ToolExecutor,
    private readonly metrics: AgentMetrics
  ) {}

  async execute(
    input: Parameters<ToolExecutor["execute"]>[0]
  ): ReturnType<ToolExecutor["execute"]> {
    const start = performance.now();
    const toolName = input.toolName;

    try {
      const result = await this.inner.execute(input);
      const durationSec = (performance.now() - start) / 1000;

      this.metrics.toolDuration.observe({ tool_name: toolName, status: "ok" }, durationSec);
      this.metrics.toolTotal.inc({ tool_name: toolName, status: "ok" });

      return result;
    } catch (err) {
      const durationSec = (performance.now() - start) / 1000;
      // Record duration even on error: slow-then-fail is a different pattern
      // from fast-fail (e.g., timeout vs validation error).
      this.metrics.toolDuration.observe({ tool_name: toolName, status: "error" }, durationSec);
      this.metrics.toolTotal.inc({ tool_name: toolName, status: "error" });
      throw err;
    }
  }
}

// ── Dead-Letter Queue ──────────────────────────────────────────────────────

export class MetricsDeadLetterQueue implements DeadLetterQueue {
  constructor(
    private readonly inner: DeadLetterQueue,
    private readonly metrics: AgentMetrics
  ) {}

  async push(entry: DeadLetterEntry): Promise<void> {
    await this.inner.push(entry);

    // Increment the lifetime counter. Note: the inner store is upsert-on-
    // executionId, so a duplicate push doesn't add a new entry — but the
    // counter still fires because the caller believes it's a new failure.
    // This is intentional: repeated pushes of the same execution indicate
    // the recovery loop is still seeing it, which is itself a signal.
    this.metrics.dlqEnqueued.inc({ agent_id: entry.agentId });

    // Set the volume gauge to the true current count. list() is O(n) but
    // push() is only called when the poison-pill threshold is crossed —
    // a rare event. Accuracy is worth the cost.
    const all = await this.inner.list();
    this.metrics.dlqVolume.set(all.length);
  }

  async list(): Promise<DeadLetterEntry[]> {
    return this.inner.list();
  }

  async getByExecution(executionId: string): Promise<DeadLetterEntry | undefined> {
    return this.inner.getByExecution(executionId);
  }
}
