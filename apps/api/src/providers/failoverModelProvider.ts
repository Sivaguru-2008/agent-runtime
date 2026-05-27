/**
 * D2 — FailoverModelProvider.
 *
 * Wraps an ordered list of concrete ModelProviders. Tries them in order;
 * on transient failure or an open circuit, advances to the next provider.
 *
 * Contract preservation:
 *   - Implements the same ModelProvider interface as ClaudeProvider /
 *     OpenAIProvider / OllamaModelProvider. Callers (executionEngine,
 *     stream pipeline) do not need to change.
 *   - `onToken` callbacks are forwarded unmodified to the underlying
 *     provider that ultimately produced the response. Streaming
 *     semantics are preserved — there is no buffering layer here.
 *   - The provider snapshot recorded on the Execution still reflects the
 *     specific upstream that succeeded (each underlying provider stamps
 *     its own provider field via existing instrumentation). The failover
 *     coordinator does not rewrite that.
 *
 * Reliability budget:
 *   - Each underlying provider's existing retry policy is honored —
 *     this class does NOT inject another retry loop. Failover only kicks
 *     in once an underlying provider has exhausted its retries OR its
 *     circuit breaker is OPEN.
 *   - Per-call wall-clock budget enforced via an AbortController so a
 *     hanging primary cannot starve the failover.
 *   - Circuit breakers are inspected synchronously before the call. An
 *     OPEN breaker advances to the next link without burning an attempt.
 *
 * Observability:
 *   - Increments `provider_failover_total{from,to,reason}` on every
 *     transition.
 *   - Increments `provider_degradation_total{chain}` exactly once when
 *     the chain is exhausted.
 */

import type { ModelProvider } from "../domain/ports.js";
import type { CircuitBreaker } from "../infrastructure/reliability/circuitBreaker.js";
import { CircuitOpenError } from "../infrastructure/reliability/circuitBreaker.js";
import type { AgentMetrics } from "../infrastructure/metrics/prometheusMetrics.js";
import { throwIfAborted, isAbortError, composeAbortSignals } from "./retry.js";

export interface FailoverLink {
  name: string;
  provider: ModelProvider;
  /** Optional circuit breaker — when OPEN, this link is skipped without a call. */
  breaker?: CircuitBreaker;
}

export interface FailoverModelProviderOptions {
  links: FailoverLink[];
  /**
   * Hard wall-clock budget per upstream call. If exceeded, the in-flight
   * request is aborted and the next link is tried. Defaults to 30s.
   * (Each provider's own retry/connect timeouts still apply within this.)
   */
  perCallTimeoutMs?: number;
  /** Optional metrics — required in production wiring. */
  metrics?: AgentMetrics;
}

export class AllProvidersFailedError extends Error {
  readonly name = "AllProvidersFailedError";
  constructor(
    public readonly chain: string[],
    public readonly causes: Array<{ provider: string; error: string }>
  ) {
    super(
      `All providers in failover chain [${chain.join(",")}] failed: ` +
        causes.map((c) => `${c.provider}=${c.error}`).join("; ")
    );
  }
}

export class FailoverModelProvider implements ModelProvider {
  constructor(private readonly opts: FailoverModelProviderOptions) {
    if (!opts.links.length) {
      throw new Error(
        "FailoverModelProvider requires at least one configured link — " +
          "check MODEL_FAILOVER_CHAIN and that API keys are present for the chosen providers."
      );
    }
  }

  async complete(
    input: Parameters<ModelProvider["complete"]>[0]
  ): ReturnType<ModelProvider["complete"]> {
    throwIfAborted(input.signal);

    const chain = this.opts.links.map((l) => l.name);
    const causes: Array<{ provider: string; error: string }> = [];

    for (let i = 0; i < this.opts.links.length; i += 1) {
      throwIfAborted(input.signal);
      const link = this.opts.links[i];
      const isLast = i === this.opts.links.length - 1;

      // Fast-skip: open circuit means we don't even attempt this link.
      if (link.breaker && link.breaker.getState() === "OPEN") {
        const next = this.opts.links[i + 1];
        if (next) {
          this.opts.metrics?.providerFailoverTotal.inc({
            from: link.name,
            to: next.name,
            reason: "circuit-open"
          });
        }
        causes.push({ provider: link.name, error: "circuit-open" });
        continue;
      }

      // Per-link timeout budget: chain the caller's signal with our own.
      const linkAbort = new AbortController();
      const timeoutMs = this.opts.perCallTimeoutMs ?? 30_000;
      const timer = setTimeout(() => linkAbort.abort(new Error("failover.link-timeout")), timeoutMs);
      
      const upstreamSignal = input.signal;
      const { signal: composedSignal, cleanup: cleanupComposition } = composeAbortSignals(
        upstreamSignal,
        linkAbort.signal
      );

      try {
        const result = await link.provider.complete({
          ...input,
          signal: composedSignal
        });
        clearTimeout(timer);
        cleanupComposition();
        return result;
      } catch (err) {
        clearTimeout(timer);
        cleanupComposition();

        const message = err instanceof Error ? err.message : String(err);
        const reason = err instanceof CircuitOpenError ? "circuit-open" : "error";
        causes.push({ provider: link.name, error: message });

        // Caller-side cancellation: don't waste budget retrying.
        if (upstreamSignal?.aborted || isAbortError(err)) {
          throw err;
        }

        if (isLast) {
          // Exhausted the chain — record degradation and surface a typed error.
          this.opts.metrics?.providerDegradationTotal.inc({ chain: chain.join("→") });
          throw new AllProvidersFailedError(chain, causes);
        }

        const next = this.opts.links[i + 1];
        this.opts.metrics?.providerFailoverTotal.inc({
          from: link.name,
          to: next.name,
          reason
        });
        // Continue to next link.
      }
    }

    // Unreachable — the loop either returns, throws AllProvidersFailedError,
    // or re-throws an upstream cancellation. Keep the guard for type safety.
    this.opts.metrics?.providerDegradationTotal.inc({ chain: chain.join("→") });
    throw new AllProvidersFailedError(chain, causes);
  }
}
