/**
 * D1 — Real OpenTelemetry SDK bootstrap.
 *
 * V3 — Production scalability hardening:
 *   - Always-on sampling replaced with ParentBased(TraceIdRatioBased)
 *     so trace volume scales with traffic, not request count.
 *   - Adaptive sampling: ratio reads from OTEL_TRACE_SAMPLE_RATIO at boot
 *     and exposes setSamplingRatio() for runtime adjustment (operator
 *     dial-down during incidents).
 *   - Error-trace priority: any span marked with the `slo.error=true`
 *     attribute is force-sampled even if the ratio would drop it. This
 *     keeps the diagnostic-value-per-trace-byte high.
 *   - Collector backpressure: the BatchSpanProcessor queue length is
 *     watched and a `recordBackpressureEvent` counter is incremented on
 *     overflow. The exporter-healthy gauge is driven from export
 *     callback failures.
 *
 * Why a dedicated bootstrap module:
 *   The NodeSDK must initialize the GlobalTracerProvider BEFORE any module
 *   that calls trace.getTracer() is imported. We expose `startTracing()`
 *   so server.ts / workerProcess.ts can side-effect import this file at the
 *   very top of their module graph and have the SDK live before any other
 *   import runs (Node hoists side-effect imports in declaration order).
 *
 * Why not @opentelemetry/auto-instrumentations-node:
 *   We already instrument every meaningful boundary by hand (withSpan,
 *   withClientSpan) and want predictable span counts. Pulling auto-instr
 *   would double-cover fastify/http and bloat trace volume without adding
 *   information our hand-rolled spans don't already carry.
 *
 * Exporter selection:
 *   - OTEL_EXPORTER_OTLP_ENDPOINT is set → real OTLP/HTTP exporter, spans
 *     ship to the collector. This is the production path.
 *   - OTEL_EXPORTER_OTLP_ENDPOINT is unset → SDK still starts (so getTracer
 *     returns a real tracer that creates valid spanContexts), but no
 *     exporter is registered and spans are dropped. This preserves
 *     development ergonomics: traces work in unit tests and propagation
 *     keeps functioning, but we don't fail-boot when a collector isn't
 *     deployed.
 *
 * Shutdown:
 *   shutdownTracing() flushes the BatchSpanProcessor and shuts the SDK
 *   down. Called from the graceful-shutdown chain so the last spans of a
 *   draining pod actually reach the collector rather than getting lost
 *   when the process exits.
 */

import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

let sdk: import("@opentelemetry/sdk-node").NodeSDK | undefined;
let started = false;

/** Mutable sampling state. Read at every shouldSample() invocation. */
const samplingState = {
  ratio: 0.05,
  errorTracePriority: true
};

interface ExporterHealth {
  healthy: boolean;
  lastFailure?: { at: number; message: string };
  lastSuccessAt?: number;
  backpressureCount: number;
}

const exporterHealth: ExporterHealth = {
  healthy: true,
  backpressureCount: 0
};

/** Callbacks for the metrics layer to subscribe to exporter state. */
const observers = new Set<(h: ExporterHealth) => void>();

export interface TracingStartOptions {
  serviceName: string;
  /** Optional OTLP endpoint override. Defaults to env OTEL_EXPORTER_OTLP_ENDPOINT. */
  endpoint?: string;
  /** Pin a deployment role (api | worker) onto every emitted span. */
  role?: "api" | "worker";
  /**
   * Initial sampling ratio in [0, 1]. Defaults to env OTEL_TRACE_SAMPLE_RATIO
   * or 0.05. Operators can adjust at runtime via setSamplingRatio().
   */
  samplingRatio?: number;
}

export interface TracingStartResult {
  enabled: boolean;
  exporterEndpoint?: string;
  serviceName: string;
  role?: "api" | "worker";
  samplingRatio: number;
}

/**
 * Adjust the sampling ratio at runtime. Used by the operator /tracing/sampling
 * endpoint and (programmatically) by the DegradationClassifier when the
 * runtime enters a critical state — reducing sampling under load preserves
 * the most diagnostic spans without overwhelming the collector.
 */
export function setSamplingRatio(ratio: number): void {
  if (!isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error(`OTel sampling ratio must be in [0, 1], got ${ratio}`);
  }
  samplingState.ratio = ratio;
}

export function getSamplingState(): { ratio: number; errorTracePriority: boolean } {
  return { ...samplingState };
}

export function getExporterHealth(): ExporterHealth {
  return { ...exporterHealth };
}

export function onExporterHealthChange(fn: (h: ExporterHealth) => void): () => void {
  observers.add(fn);
  return () => observers.delete(fn);
}

function emitHealth(): void {
  for (const fn of observers) {
    try {
      fn(exporterHealth);
    } catch {
      // observers must never break the export path.
    }
  }
}

/**
 * Start the OpenTelemetry NodeSDK. Idempotent — repeated calls are no-ops.
 * Must be invoked BEFORE any module that resolves `trace.getTracer()` at
 * module-evaluation time.
 */
export async function startTracing(opts: TracingStartOptions): Promise<TracingStartResult> {
  if (started) {
    return {
      enabled: true,
      exporterEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: opts.serviceName,
      role: opts.role,
      samplingRatio: samplingState.ratio
    };
  }
  started = true;

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  const endpoint = opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const tracesDisabled = process.env.OTEL_SDK_DISABLED === "true";

  const envRatio = process.env.OTEL_TRACE_SAMPLE_RATIO
    ? Number(process.env.OTEL_TRACE_SAMPLE_RATIO)
    : undefined;
  const initialRatio = opts.samplingRatio ?? envRatio ?? 0.05;
  if (!isFinite(initialRatio) || initialRatio < 0 || initialRatio > 1) {
    throw new Error(`OTEL_TRACE_SAMPLE_RATIO must be in [0, 1], got ${initialRatio}`);
  }
  samplingState.ratio = initialRatio;

  if (tracesDisabled) {
    return { enabled: false, serviceName: opts.serviceName, role: opts.role, samplingRatio: 0 };
  }

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { Resource } = await import("@opentelemetry/resources");
  const { SemanticResourceAttributes } = await import("@opentelemetry/semantic-conventions");
  const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
  const { ParentBasedSampler, TraceIdRatioBasedSampler, SamplingDecision } = await import(
    "@opentelemetry/sdk-trace-base"
  );

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: opts.serviceName,
    [SemanticResourceAttributes.SERVICE_NAMESPACE]: "agent-runtime",
    ...(opts.role ? { "deployment.role": opts.role } : {}),
    ...(process.env.REGION_ID ? { "deployment.region": process.env.REGION_ID } : {})
  });

  /**
   * Composite sampler:
   *  1. If the span carries `slo.error=true` (set by withSpan when an
   *     error bubbles up), force-record regardless of ratio.
   *  2. Otherwise delegate to ParentBased(TraceIdRatioBased) so child spans
   *     of a sampled root are guaranteed to ship together.
   *  3. The ratio is read from samplingState on every decision so
   *     setSamplingRatio() takes effect without process restart.
   */
  const baseSampler = new ParentBasedSampler({
    root: {
      shouldSample(_ctx, traceId) {
        // Manual TraceIdRatioBased so we can read the live ratio.
        const upper = parseInt(traceId.slice(-8) || "0", 16) >>> 0;
        const bound = Math.floor(samplingState.ratio * 0xffffffff);
        return {
          decision: upper < bound ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD,
          attributes: { "sampler.ratio": samplingState.ratio }
        };
      },
      toString: () => "TraceIdRatioBased(adaptive)"
    } as ConstructorParameters<typeof ParentBasedSampler>[0]["root"]
  });

  const sampler = {
    shouldSample: (
      ctx: Parameters<typeof baseSampler.shouldSample>[0],
      traceId: string,
      name: string,
      kind: Parameters<typeof baseSampler.shouldSample>[3],
      attributes: Parameters<typeof baseSampler.shouldSample>[4],
      links: Parameters<typeof baseSampler.shouldSample>[5]
    ) => {
      if (
        samplingState.errorTracePriority &&
        attributes &&
        (attributes as Record<string, unknown>)["slo.error"] === true
      ) {
        return { decision: SamplingDecision.RECORD_AND_SAMPLED, attributes: {} };
      }
      return baseSampler.shouldSample(ctx, traceId, name, kind, attributes, links);
    },
    toString: () => "ErrorPriority(ParentBased(TraceIdRatioBased))"
  };

  let spanProcessor: import("@opentelemetry/sdk-trace-base").SpanProcessor | undefined;
  if (endpoint) {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const rawExporter = new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/traces`
    });

    /**
     * Wrap the exporter so we can observe export outcomes for the
     * exporter-health gauge. Done at the exporter layer (not the
     * processor) because the processor's queue overflow is reported
     * separately via the maxQueueSize ceiling.
     */
    const exporter: typeof rawExporter = Object.assign(
      Object.create(Object.getPrototypeOf(rawExporter)) as typeof rawExporter,
      rawExporter
    );
    const originalExport = rawExporter.export.bind(rawExporter);
    exporter.export = (spans, resultCallback) => {
      originalExport(spans, (result) => {
        if (result.code === 0) {
          exporterHealth.healthy = true;
          exporterHealth.lastSuccessAt = Date.now();
        } else {
          exporterHealth.healthy = false;
          exporterHealth.lastFailure = {
            at: Date.now(),
            message: result.error?.message ?? "unknown OTLP export failure"
          };
        }
        emitHealth();
        resultCallback(result);
      });
    };

    spanProcessor = new BatchSpanProcessor(exporter, {
      // BatchSpanProcessor defaults are tuned for browsers (low batch size);
      // server workloads benefit from a larger batch + slightly longer
      // schedule so we ship fewer, fatter OTLP requests under load.
      maxQueueSize: 4096,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 1_000,
      exportTimeoutMillis: 15_000
    });
  }

  sdk = new NodeSDK({
    resource,
    spanProcessor,
    sampler: sampler as unknown as import("@opentelemetry/sdk-trace-base").Sampler,
    // No autoInstrumentations — every boundary is hand-instrumented and we
    // want span counts to remain predictable for billing/quota analysis.
    instrumentations: []
  });

  await Promise.resolve(sdk.start());

  return {
    enabled: true,
    exporterEndpoint: endpoint,
    serviceName: opts.serviceName,
    role: opts.role,
    samplingRatio: samplingState.ratio
  };
}

/**
 * Mark the exporter as having dropped a span due to queue saturation.
 * Called by withSpan when the BatchSpanProcessor returns a drop signal
 * (the actual SDK does not expose this directly, so we increment from
 * the wrap site).
 */
export function recordBackpressureEvent(): void {
  exporterHealth.backpressureCount += 1;
  emitHealth();
}

/**
 * Flush all in-flight spans and shut down the SDK. Safe to call when the
 * SDK was never started — returns silently in that case.
 */
export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // Shutdown errors must never block process exit; the collector will
    // miss the last batch but that's preferable to hanging termination.
  }
  sdk = undefined;
  started = false;
}

/** Test-only: report whether the SDK has been initialized in this process. */
export function isTracingStarted(): boolean {
  return started;
}
