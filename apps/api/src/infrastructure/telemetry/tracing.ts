/**
 * PHASE 4 — OpenTelemetry Distributed Tracing
 *
 * Operational visibility gained:
 *   - Every agent execution is a top-level trace with child spans for each
 *     phase: memory retrieval, model call, tool call, checkpoint write.
 *   - withSpan() creates spans that appear in Jaeger/Tempo/Grafana as a
 *     waterfall, immediately showing which step took the most time.
 *   - HTTP header propagation (W3C TraceContext) links frontend requests
 *     to backend execution spans across the network boundary.
 *
 * Debugging improvements:
 *   - getActiveSpanContext() lets any code log its traceId/spanId so a log
 *     line and its span are trivially correlated.
 *   - extractTraceContext() enables an operator to paste a W3C traceparent
 *     header from a browser request and find the exact backend span tree.
 *   - Replay runs link to their parent execution trace via the parent execution's
 *     traceId, giving a side-by-side diff view in the trace UI.
 *
 * Distributed tracing implications:
 *   - Uses the OpenTelemetry W3C TraceContext propagator — compatible with
 *     all major APM vendors (Datadog, New Relic, Honeycomb, Grafana Tempo).
 *   - Span context flows through async boundaries automatically via Node.js
 *     AsyncLocalStorage (built into the OTel SDK).
 *   - Baggage propagation (correlationId, executionId) crosses service
 *     boundaries so downstream services can join the trace.
 *
 * Scaling implications:
 *   - Head-based sampling: all spans are recorded. In high-throughput
 *     production add a TraceIdRatioBased sampler to the SDK init.
 *   - Spans are exported asynchronously; the hot path is not blocked.
 */

import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  SpanKind,
  type Span,
  type Context
} from "@opentelemetry/api";

const TRACER_NAME = "agent-runtime";

// ── Core Span Wrapper ──────────────────────────────────────────────────────

/**
 * Wraps an async function in an OTel span. The span is automatically:
 *   - ended on completion or error
 *   - marked OK / ERROR based on whether the function throws
 *   - annotated with all provided attributes
 *
 * Child spans created inside `fn` are automatically parented via the
 * active context propagated through AsyncLocalStorage.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, async (span) => {
    setAttributes(span, attributes);
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : "Unknown error"
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Wraps a function in a CLIENT-kind span — use this for outbound model
 * provider calls and tool HTTP calls so the trace UI shows them as
 * remote dependencies, not internal processing steps.
 */
export async function withClientSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, { kind: SpanKind.CLIENT }, async (span) => {
    setAttributes(span, attributes);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : "Unknown error"
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

// ── Context Propagation ────────────────────────────────────────────────────

/**
 * Extract a remote trace context from HTTP headers (W3C TraceContext format).
 * Use on inbound HTTP requests so that a browser-initiated trace continues
 * into the backend without a trace break.
 *
 * Usage (Fastify hook):
 *   const ctx = extractTraceContext(request.headers);
 *   context.with(ctx, () => { ... rest of handler ... });
 */
export function extractTraceContext(
  headers: Record<string, string | string[] | undefined>
): Context {
  const carrier: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") carrier[key] = value;
    else if (Array.isArray(value)) carrier[key] = value[0] ?? "";
  }
  return propagation.extract(context.active(), carrier);
}

/**
 * Inject the current trace context into outgoing HTTP headers (W3C TraceContext).
 * Use when making outbound HTTP calls to other services so the trace continues.
 *
 * Usage:
 *   const headers: Record<string, string> = {};
 *   injectTraceContext(headers);
 *   fetch(url, { headers });
 */
export function injectTraceContext(headers: Record<string, string>): void {
  propagation.inject(context.active(), headers);
}

/**
 * Returns the traceId and spanId from the currently active OTel span.
 * Returns undefined if no span is active (no-op tracer or outside a trace).
 *
 * Useful for including the traceId in structured log lines so that every
 * log entry is linkable to its trace in the APM tool:
 *   logger.info({ ...getActiveSpanContext() }, "model call completed");
 */
export function getActiveSpanContext(): {
  traceId: string;
  spanId: string;
  traceFlags: number;
} | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  // isValid returns false for the no-op span (sampling disabled or no SDK).
  if (!trace.isSpanContextValid(ctx)) return undefined;
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    traceFlags: ctx.traceFlags
  };
}

/**
 * Adds a structured event to the active span — appears as a log line inside
 * the span in Jaeger/Tempo. More structured than recordException().
 *
 * Usage:
 *   addSpanEvent("checkpoint.written", { phase: "MODEL_GENERATION", seq: 42 });
 */
export function addSpanEvent(
  name: string,
  attributes?: Record<string, string | number | boolean>
): void {
  trace.getActiveSpan()?.addEvent(name, attributes);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function setAttributes(
  span: Span,
  attributes: Record<string, string | number | boolean | undefined>
): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) span.setAttribute(key, value);
  }
}
