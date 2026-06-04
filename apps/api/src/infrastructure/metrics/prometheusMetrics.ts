/**
 * PHASE 4 — Prometheus Metrics Registry
 *
 * Operational visibility gained:
 *   - Every dimension of runtime health is a queryable time series.
 *   - Execution latency P50/P95/P99 expose SLA regressions before users notice.
 *   - Queue depth reveals scheduler saturation before workers are overwhelmed.
 *   - Lease contention exposes multi-worker coordination failures.
 *   - Replay divergence tracks determinism violations in production.
 *   - SSE reconnect/drop rates diagnose streaming reliability.
 *   - Tool and model latency pinpoint which external dependency is the bottleneck.
 *   - DLQ volume acts as a poison-pill alarm.
 *   - Worker utilisation enables horizontal scaling decisions.
 *
 * Debugging improvements:
 *   - Correlate Prometheus alerts back to individual executions via traceId labels.
 *   - Histogram quantiles (P95, P99) expose latency outliers hidden by averages.
 *   - Circuit-breaker transitions create a time-series of reliability events.
 *
 * Distributed tracing implications:
 *   - All metrics use the same cardinality-bounded labels (agent_id, worker_id,
 *     provider) as OTel span attributes, so Grafana exemplars can link a spike
 *     in a histogram directly to a Jaeger/Tempo trace.
 *   - Default process metrics (event-loop lag, GC, heap) expose Node.js runtime
 *     health alongside application-level signals.
 *
 * Scaling implications:
 *   - Scoped Registry (not global) means multiple test instances don't clash.
 *   - Label cardinality is deliberately bounded: agent_id and worker_id are
 *     safe because agent/worker counts are operator-controlled and small.
 *     Tool names and provider names are from fixed enumerations.
 *   - Histogram buckets are tuned per domain: ms-scale for HTTP, second-scale
 *     for tools and models, minute-scale for full executions.
 */

import {
  Registry,
  Histogram,
  Counter,
  Gauge,
  collectDefaultMetrics
} from "prom-client";

export class AgentMetrics {
  readonly registry: Registry;

  // ── Execution ────────────────────────────────────────────────────────────
  /** End-to-end wall-clock time from task submission to final status write. */
  readonly executionDuration: Histogram<string>;
  /** Cumulative completed executions by agent and final status. */
  readonly executionTotal: Counter<string>;
  /**
   * Per-tenant operation accounting for multi-tenant observability, billing,
   * and quota dashboards. Deliberately a SEPARATE counter rather than a
   * `tenant_id` label bolted onto the high-frequency histograms above: those
   * are intentionally cardinality-bounded (agent_id/worker_id/provider from
   * small operator-controlled sets), and a per-tenant label on a latency
   * histogram would multiply series by the tenant count and blow up the TSDB.
   *
   * Cardinality here is bounded by (tenant count × small fixed `operation`
   * enum: execution_started | execution_completed | execution_failed). Tenant
   * count is the natural billing dimension, so this is the one place an
   * unbounded-ish tenant label is acceptable — and it is additive, so no
   * existing call site changes its label set.
   */
  readonly tenantOperationsTotal: Counter<string>;

  // ── Queue + Scheduling ───────────────────────────────────────────────────
  /** Executions waiting for a free worker lease. Spike → scheduler saturation. */
  readonly queueDepth: Gauge<string>;
  /** Executions actively running under a lease. Steady-state ≤ worker capacity. */
  readonly inFlightCount: Gauge<string>;
  /**
   * Sprint Stabilization — HTTP requests rejected because the job queue is
   * above QUEUE_BACKPRESSURE_THRESHOLD. Each increment is a client-visible
   * 503 with Retry-After; sustained non-zero rate means workers cannot keep
   * up with offered load and the cluster needs to scale out (or the caller
   * needs to back off).
   *
   * Operator wiring: alert when rate over 5m exceeds your acceptable shed-load
   * rate. Pair with `agent_queue_depth` to distinguish "transient spike under
   * autoscaling" (depth spikes then drops) from "stuck workers" (depth flat
   * high with sustained rejections).
   */
  readonly queueSaturationRejections: Counter<string>;

  // ── Lease Coordination ───────────────────────────────────────────────────
  /**
   * Failed lease acquisitions. Type labels:
   *   CONTENTION  - another worker acquired first (normal under load)
   *   EXPIRED     - lease TTL elapsed before renewal (worker stall or GC pause)
   *   RECLAIMED   - recovery loop took it back (crashed worker)
   */
  readonly leaseContention: Counter<string>;

  // ── Replay ───────────────────────────────────────────────────────────────
  /**
   * Replay sessions where re-execution output differed from the original.
   * Non-zero = determinism violation. Requires operator investigation.
   * Divergence type labels: OUTPUT_MISMATCH | TOOL_CHAIN_MISMATCH | TOKEN_DELTA
   */
  readonly replayDivergence: Counter<string>;

  // ── SSE Streaming ────────────────────────────────────────────────────────
  /** Client reconnected with a non-zero Last-Event-ID (dropped + resumed). */
  readonly sseReconnects: Counter<string>;
  /** Frames not delivered. Reason: BACKPRESSURE | DEDUPE | DISCONNECT. */
  readonly sseDrops: Counter<string>;
  /** Open SSE connections right now. Used to detect fan-out growth. */
  readonly sseActiveConnections: Gauge<string>;

  // ── Tool Execution ───────────────────────────────────────────────────────
  /** Per-tool call latency. Separate buckets catch slow web.search vs fast file.read. */
  readonly toolDuration: Histogram<string>;
  /** Tool call outcomes by name. High error rate → tool misconfiguration. */
  readonly toolTotal: Counter<string>;

  // ── Model Provider ───────────────────────────────────────────────────────
  /**
   * Provider round-trip latency excluding circuit-open rejections.
   * Bimodal distribution (fast cache hits vs slow full generation) visible in P50 vs P99.
   */
  readonly modelProviderDuration: Histogram<string>;
  /** Retries by provider. Sustained retries → rate-limit or provider degradation. */
  readonly modelProviderRetries: Counter<string>;
  /** Provider call outcomes. High error rate → trigger circuit-breaker alert. */
  readonly modelProviderTotal: Counter<string>;
  /** Tokens consumed by type. Cost accounting and quota monitoring. */
  readonly modelTokensTotal: Counter<string>;
  /**
   * Estimated USD spend by provider and model, derived from token usage and
   * the price table in providers/cost.ts. Monotonic — divide by a time window
   * (rate()) for $/min, or sum for cumulative spend. Pairs with
   * modelTokensTotal: tokens are the durable truth, cost is the recomputable
   * dollar projection.
   */
  readonly modelCostUsdTotal: Counter<string>;
  /**
   * Response-cache outcomes by event (hit | miss | skip). hit/(hit+miss) is the
   * cache hit ratio — every hit is a saved upstream call and zero billed
   * tokens. `skip` counts non-deterministic requests that bypassed the cache.
   */
  readonly modelCacheTotal: Counter<string>;
  /**
   * D2 — failover transitions inside the FailoverModelProvider chain.
   * Labelled by `from` (provider that failed) and `to` (provider chosen
   * next). High rates mean the primary provider's circuit breaker is
   * tripping; sustained → page on-call.
   */
  readonly providerFailoverTotal: Counter<string>;
  /**
   * D2 — full-chain degradation: every configured provider failed or had
   * an open circuit. Each increment is a user-visible request failure
   * that survived the failover chain. Page on any non-zero rate.
   */
  readonly providerDegradationTotal: Counter<string>;

  // ── Reliability ──────────────────────────────────────────────────────────
  /**
   * Circuit-breaker state transitions (CLOSED→OPEN, OPEN→HALF_OPEN, HALF_OPEN→CLOSED).
   * OPEN transitions require immediate operator attention.
   */
  readonly circuitBreakerTransitions: Counter<string>;

  // ── Failure Intelligence ─────────────────────────────────────────────────
  /**
   * Failure signals emitted by the FailureIntelligenceEngine.
   * kind = HALLUCINATION | CONTRADICTION | RECURSION | TOOL_MISUSE | etc.
   * severity = INFO | LOW | MEDIUM | HIGH | CRITICAL
   */
  readonly failureSignals: Counter<string>;

  // ── Dead-Letter Queue ────────────────────────────────────────────────────
  /** Current DLQ depth. Non-zero means poison pills accumulating. */
  readonly dlqVolume: Gauge<string>;
  /** Total lifetime DLQ entries. Monotonically increasing; spikes signal bugs. */
  readonly dlqEnqueued: Counter<string>;

  // ── Worker Health ────────────────────────────────────────────────────────
  /** CPU utilisation estimate per worker (0-100). */
  readonly workerCpu: Gauge<string>;
  /** Heap utilisation per worker (0-100). Sustained >85% → memory pressure. */
  readonly workerMemory: Gauge<string>;
  /** In-flight executions per worker. Saturated at capacity → add workers. */
  readonly workerInFlight: Gauge<string>;
  /**
   * Milliseconds since last heartbeat per worker.
   * Exceeds WORKER_HEARTBEAT_TTL_MS → worker should be marked LOST.
   */
  readonly workerHeartbeatAgeMs: Gauge<string>;

  // ── HTTP ─────────────────────────────────────────────────────────────────
  /** HTTP request duration by method, route (normalized), and status code. */
  readonly httpRequestDuration: Histogram<string>;

  // ── V3: SLO governance ───────────────────────────────────────────────────
  /** Per-SLO budget consumed in [0, 1]. >=1 → budget exhausted. */
  readonly sloBudgetConsumed: Gauge<string>;
  /** Per-SLO multi-window burn-rate by ladder label (page/fast/slow). */
  readonly sloBurnRate: Gauge<string>;
  /** Active deploy-freeze flag — 0 open, 1 frozen. Source label = slo|operator. */
  readonly deployFreezeActive: Gauge<string>;

  // ── V3: Region awareness ─────────────────────────────────────────────────
  /** Region role: 1 if active in this region, 0 if passive/degraded. */
  readonly regionActive: Gauge<string>;
  /** Fencing token — monotonic across failovers. */
  readonly regionFencingToken: Gauge<string>;
  /** Region failover transitions by direction (promote/demote/degrade). */
  readonly regionTransitions: Counter<string>;
  /** Writes rejected due to stale fencing token. */
  readonly splitBrainRejections: Counter<string>;
  /**
   * Execution-scoped event appends rejected because the worker's lease was
   * no longer ACTIVE at the moment of the persistence INSERT. Each increment
   * is exactly one stale-worker emission that was prevented from polluting
   * replay. Labels:
   *   - event_type: the would-have-been event type (e.g. MODEL_COMPLETED)
   * Operators should treat sustained nonzero rate as a stale-worker bug
   * (clock skew, GC pause, partition) rather than expected churn.
   */
  readonly eventFenceRejected: Counter<string>;

  // ── V3: DLQ remediation ──────────────────────────────────────────────────
  /** DLQ replay attempts by outcome (succeeded/failed/quarantined). */
  readonly dlqReplayTotal: Counter<string>;
  /** DLQ entries currently quarantined (over replay-attempt limit). */
  readonly dlqQuarantined: Gauge<string>;
  /** DLQ replay latency, end-to-end. */
  readonly dlqReplayDuration: Histogram<string>;

  // ── V3: OTel sampling ────────────────────────────────────────────────────
  /** Sampling decisions by outcome (recorded/dropped/error-forced). */
  readonly otelSamplingDecisions: Counter<string>;
  /** Backpressure events from the OTLP exporter queue. */
  readonly otelExporterBackpressure: Counter<string>;
  /** Whether the OTel exporter is currently healthy — 1 ok, 0 down. */
  readonly otelExporterHealthy: Gauge<string>;

  // ── V3: Runtime degradation ──────────────────────────────────────────────
  /** Active degradation level: 0 nominal, 1 partial, 2 critical, 3 failed. */
  readonly runtimeDegradationLevel: Gauge<string>;

  // ── Sprint Stabilization: Postgres pool ────────────────────────────────
  /** Total clients in the pool (idle + checked-out). Labelled by pool name. */
  readonly pgPoolTotal: Gauge<string>;
  /** Idle clients available for immediate acquisition. */
  readonly pgPoolIdle: Gauge<string>;
  /** Queries waiting on a client. Sustained > 0 indicates pool exhaustion. */
  readonly pgPoolWaiting: Gauge<string>;
  /** Outstanding `acquire()` tokens that have not been released. */
  readonly pgPoolOutstanding: Gauge<string>;
  /** Suspected connection leaks (acquire held > threshold). */
  readonly pgPoolLeaks: Counter<string>;
  /** Time elapsed from execution cancel request to actual graceful abort. */
  readonly cancellationPropagationDuration: Histogram<string>;

  constructor() {
    this.registry = new Registry();

    // Collect default Node.js process metrics: event-loop lag, GC durations,
    // heap stats, active handles. These are the first things to check during
    // a memory leak or CPU saturation incident.
    collectDefaultMetrics({ register: this.registry });

    // ── Execution ──────────────────────────────────────────────────────────
    this.executionDuration = new Histogram({
      name: "agent_execution_duration_seconds",
      help: "End-to-end agent execution wall-clock time",
      labelNames: ["agent_id", "status"],
      // Buckets span 100ms (sub-second model calls) to 10m (long tool chains).
      buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600],
      registers: [this.registry]
    });

    this.executionTotal = new Counter({
      name: "agent_execution_total",
      help: "Total agent executions by final status",
      labelNames: ["agent_id", "status"],
      registers: [this.registry]
    });

    this.tenantOperationsTotal = new Counter({
      name: "agent_tenant_operations_total",
      help: "Per-tenant operation accounting (multi-tenant billing/quota visibility)",
      labelNames: ["tenant_id", "operation"],
      registers: [this.registry]
    });

    // ── Queue + Scheduling ─────────────────────────────────────────────────
    this.queueDepth = new Gauge({
      name: "agent_queue_depth",
      help: "Number of executions queued awaiting a worker lease",
      labelNames: ["worker_id"],
      registers: [this.registry]
    });

    this.inFlightCount = new Gauge({
      name: "agent_in_flight_count",
      help: "Executions actively running under a lease",
      labelNames: ["worker_id"],
      registers: [this.registry]
    });

    this.queueSaturationRejections = new Counter({
      name: "agent_queue_saturation_rejections_total",
      help:
        "HTTP requests rejected with 503 because the execution job queue " +
        "depth crossed QUEUE_BACKPRESSURE_THRESHOLD",
      labelNames: ["route"],
      registers: [this.registry]
    });

    // ── Lease ──────────────────────────────────────────────────────────────
    this.leaseContention = new Counter({
      name: "agent_lease_contention_total",
      help: "Lease acquisition failures — CONTENTION | EXPIRED | RECLAIMED",
      labelNames: ["type"],
      registers: [this.registry]
    });

    // ── Replay ────────────────────────────────────────────────────────────
    this.replayDivergence = new Counter({
      name: "agent_replay_divergence_total",
      help: "Replay sessions where output diverged from original execution",
      labelNames: ["divergence_type"],
      registers: [this.registry]
    });

    // ── SSE ───────────────────────────────────────────────────────────────
    this.sseReconnects = new Counter({
      name: "agent_sse_reconnect_total",
      help: "SSE client reconnect events (non-zero cursor on connect = drop+resume)",
      labelNames: ["has_cursor"],
      registers: [this.registry]
    });

    this.sseDrops = new Counter({
      name: "agent_sse_drop_total",
      help: "SSE frames not delivered: BACKPRESSURE | DEDUPE | DISCONNECT",
      labelNames: ["reason"],
      registers: [this.registry]
    });

    this.sseActiveConnections = new Gauge({
      name: "agent_sse_active_connections",
      help: "Currently open SSE connections",
      registers: [this.registry]
    });

    // ── Tool ──────────────────────────────────────────────────────────────
    this.toolDuration = new Histogram({
      name: "agent_tool_execution_duration_seconds",
      help: "Tool call wall-clock duration by tool name",
      labelNames: ["tool_name", "status"],
      // 10ms (fast) → 30s (slow web search). Separate ok/error tracks partial failures.
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 5, 15, 30],
      registers: [this.registry]
    });

    this.toolTotal = new Counter({
      name: "agent_tool_total",
      help: "Total tool calls by tool name and outcome",
      labelNames: ["tool_name", "status"],
      registers: [this.registry]
    });

    // ── Model Provider ────────────────────────────────────────────────────
    this.modelProviderDuration = new Histogram({
      name: "agent_model_provider_duration_seconds",
      help: "Model provider round-trip latency (excludes circuit-open rejections)",
      labelNames: ["provider", "model"],
      // 100ms (fast cached) → 120s (very long generation). Bimodal expected.
      buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
      registers: [this.registry]
    });

    this.modelProviderRetries = new Counter({
      name: "agent_model_provider_retry_total",
      help: "Model provider call retries by provider",
      labelNames: ["provider"],
      registers: [this.registry]
    });

    this.modelProviderTotal = new Counter({
      name: "agent_model_provider_total",
      help: "Total model provider calls by outcome",
      labelNames: ["provider", "status"],
      registers: [this.registry]
    });

    this.modelTokensTotal = new Counter({
      name: "agent_model_tokens_total",
      help: "Total tokens processed by provider and type (prompt | completion)",
      labelNames: ["provider", "token_type"],
      registers: [this.registry]
    });

    this.modelCostUsdTotal = new Counter({
      name: "agent_model_cost_usd_total",
      help: "Estimated USD spend by provider and model (derived from token usage)",
      labelNames: ["provider", "model"],
      registers: [this.registry]
    });

    this.modelCacheTotal = new Counter({
      name: "agent_model_cache_total",
      help: "LLM response cache outcomes (hit | miss | skip)",
      labelNames: ["event"],
      registers: [this.registry]
    });

    this.providerFailoverTotal = new Counter({
      name: "provider_failover_total",
      help: "Failover transitions inside FailoverModelProvider — from one provider to the next",
      labelNames: ["from", "to", "reason"],
      registers: [this.registry]
    });

    this.providerDegradationTotal = new Counter({
      name: "provider_degradation_total",
      help: "Full FailoverModelProvider chain exhausted without a successful response",
      labelNames: ["chain"],
      registers: [this.registry]
    });

    // ── Reliability ───────────────────────────────────────────────────────
    this.circuitBreakerTransitions = new Counter({
      name: "agent_circuit_breaker_transition_total",
      help: "Circuit breaker state transitions by circuit name and target state",
      labelNames: ["circuit", "to_state"],
      registers: [this.registry]
    });

    // ── Failure Intelligence ──────────────────────────────────────────────
    this.failureSignals = new Counter({
      name: "agent_failure_signal_total",
      help: "Failure intelligence signals by kind and severity",
      labelNames: ["kind", "severity"],
      registers: [this.registry]
    });

    // ── DLQ ───────────────────────────────────────────────────────────────
    this.dlqVolume = new Gauge({
      name: "agent_dlq_volume",
      help: "Current dead-letter queue depth",
      registers: [this.registry]
    });

    this.dlqEnqueued = new Counter({
      name: "agent_dlq_enqueued_total",
      help: "Total executions moved to DLQ (lifetime, by agent)",
      labelNames: ["agent_id"],
      registers: [this.registry]
    });

    // ── Worker ────────────────────────────────────────────────────────────
    this.workerCpu = new Gauge({
      name: "agent_worker_cpu_percent",
      help: "Worker estimated CPU utilisation (0-100)",
      labelNames: ["worker_id"],
      registers: [this.registry]
    });

    this.workerMemory = new Gauge({
      name: "agent_worker_memory_percent",
      help: "Worker heap utilisation percent (0-100)",
      labelNames: ["worker_id"],
      registers: [this.registry]
    });

    this.workerInFlight = new Gauge({
      name: "agent_worker_in_flight",
      help: "In-flight executions per worker at last heartbeat",
      labelNames: ["worker_id"],
      registers: [this.registry]
    });

    this.workerHeartbeatAgeMs = new Gauge({
      name: "agent_worker_heartbeat_age_ms",
      help: "Milliseconds since worker last sent a heartbeat",
      labelNames: ["worker_id"],
      registers: [this.registry]
    });

    // ── HTTP ──────────────────────────────────────────────────────────────
    this.httpRequestDuration = new Histogram({
      name: "agent_http_request_duration_seconds",
      help: "HTTP request duration by method, route, and status code",
      labelNames: ["method", "route", "status_code"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry]
    });

    // ── V3: SLO governance ──────────────────────────────────────────────
    this.sloBudgetConsumed = new Gauge({
      name: "agent_slo_budget_consumed",
      help: "Fraction of the error budget consumed for an SLO over its rolling window",
      labelNames: ["slo", "kind"],
      registers: [this.registry]
    });
    this.sloBurnRate = new Gauge({
      name: "agent_slo_burn_rate",
      help: "Multi-window burn rate for an SLO (page/fast/slow ladders)",
      labelNames: ["slo", "window"],
      registers: [this.registry]
    });
    this.deployFreezeActive = new Gauge({
      name: "agent_deploy_freeze_active",
      help: "1 when deploy freeze is in effect, 0 otherwise (source label: slo|operator|open)",
      labelNames: ["source"],
      registers: [this.registry]
    });

    // ── V3: Region ──────────────────────────────────────────────────────
    this.regionActive = new Gauge({
      name: "agent_region_active",
      help: "1 if this process is in the active primary region, 0 otherwise",
      labelNames: ["region"],
      registers: [this.registry]
    });
    this.regionFencingToken = new Gauge({
      name: "agent_region_fencing_token",
      help: "Monotonic fencing token for the current region topology",
      labelNames: ["region"],
      registers: [this.registry]
    });
    this.regionTransitions = new Counter({
      name: "agent_region_transition_total",
      help: "Region topology transitions by direction",
      labelNames: ["region", "direction"],
      registers: [this.registry]
    });
    this.splitBrainRejections = new Counter({
      name: "agent_split_brain_rejections_total",
      help: "Writes rejected by the split-brain guard due to stale fencing token",
      labelNames: ["region"],
      registers: [this.registry]
    });
    this.eventFenceRejected = new Counter({
      name: "agent_event_fence_rejected_total",
      help: "Execution-scoped event appends rejected because the worker lost lease authority (stale-worker replay-pollution prevented)",
      labelNames: ["event_type"],
      registers: [this.registry]
    });

    // ── V3: DLQ remediation ─────────────────────────────────────────────
    this.dlqReplayTotal = new Counter({
      name: "agent_dlq_replay_total",
      help: "DLQ replay attempts by outcome",
      labelNames: ["outcome"],
      registers: [this.registry]
    });
    this.dlqQuarantined = new Gauge({
      name: "agent_dlq_quarantined_count",
      help: "DLQ entries currently quarantined past the replay-attempt limit",
      registers: [this.registry]
    });
    this.dlqReplayDuration = new Histogram({
      name: "agent_dlq_replay_duration_seconds",
      help: "DLQ replay end-to-end wall-clock duration",
      labelNames: ["outcome"],
      buckets: [0.5, 1, 5, 15, 30, 60, 120, 300, 600],
      registers: [this.registry]
    });

    // ── V3: OTel sampling ───────────────────────────────────────────────
    this.otelSamplingDecisions = new Counter({
      name: "agent_otel_sampling_decisions_total",
      help: "OTel sampling decisions by outcome",
      labelNames: ["decision"],
      registers: [this.registry]
    });
    this.otelExporterBackpressure = new Counter({
      name: "agent_otel_exporter_backpressure_total",
      help: "OTLP exporter queue backpressure events",
      registers: [this.registry]
    });
    this.otelExporterHealthy = new Gauge({
      name: "agent_otel_exporter_healthy",
      help: "1 if the OTLP exporter is currently healthy, 0 if it has failed recent exports",
      registers: [this.registry]
    });

    // ── V3: Runtime degradation ─────────────────────────────────────────
    this.runtimeDegradationLevel = new Gauge({
      name: "agent_runtime_degradation_level",
      help: "0 nominal, 1 partial, 2 critical, 3 failed — driven by DegradationClassifier",
      registers: [this.registry]
    });

    // ── Sprint Stabilization: pg pool ──────────────────────────────────
    this.pgPoolTotal = new Gauge({
      name: "agent_pg_pool_total",
      help: "Total Postgres connections in the pool (idle + checked-out)",
      labelNames: ["pool"],
      registers: [this.registry]
    });
    this.pgPoolIdle = new Gauge({
      name: "agent_pg_pool_idle",
      help: "Idle Postgres connections available for immediate use",
      labelNames: ["pool"],
      registers: [this.registry]
    });
    this.pgPoolWaiting = new Gauge({
      name: "agent_pg_pool_waiting",
      help: "Queries waiting for a Postgres connection — sustained > 0 = pool exhaustion",
      labelNames: ["pool"],
      registers: [this.registry]
    });
    this.pgPoolOutstanding = new Gauge({
      name: "agent_pg_pool_outstanding",
      help: "Acquire() tokens outstanding (held by a caller, not yet released)",
      labelNames: ["pool"],
      registers: [this.registry]
    });
    this.pgPoolLeaks = new Counter({
      name: "agent_pg_pool_leak_suspect_total",
      help: "Connection-leak warnings — acquire() held beyond the leak threshold",
      labelNames: ["pool", "label"],
      registers: [this.registry]
    });

    this.cancellationPropagationDuration = new Histogram({
      name: "agent_cancellation_propagation_duration_seconds",
      help: "Time elapsed from execution cancel request to actual graceful abort",
      labelNames: ["reason"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry]
    });
  }
}
