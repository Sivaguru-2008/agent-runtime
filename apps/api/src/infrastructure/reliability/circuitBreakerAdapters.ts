/**
 * Circuit-breaker decorators for external dependencies.
 *
 * Each adapter wraps a real implementation behind a CircuitBreaker so that
 * repeated failures open the circuit and subsequent calls fast-fail rather
 * than blocking until timeout.
 *
 * Corruption risk prevented:
 *   Without these adapters, a hung model provider or saturated Postgres pool
 *   causes every in-flight execution to block until PROVIDER_TIMEOUT_MS,
 *   exhausting the Node.js event loop and causing total scheduler stall.
 *
 * Distributed implications:
 *   Each adapter instance carries its own circuit state. Circuits are
 *   intentionally per-process — a CB open on one worker does not propagate
 *   to others. Use the `onStateChange` callback to emit CIRCUIT_BREAKER_*
 *   events so the cluster-wide view is observable via the event log.
 */

import type { MemoryRecord, Agent, Execution } from "../../domain/model.js";
import type { ModelProvider, ToolExecutor } from "../../domain/ports.js";
import type { PgClient } from "../persistence/postgres/pgClient.js";
import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker.js";
export { CircuitOpenError };

export class CircuitBreakerModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly cb: CircuitBreaker
  ) {}

  async complete(input: {
    agent: Agent;
    execution: Execution;
    prompt: string;
    context: MemoryRecord[];
    onToken?: (token: string, confidence: number) => void;
    signal?: AbortSignal;
  }) {
    return this.cb.call(() => this.inner.complete(input));
  }
}

export class CircuitBreakerToolExecutor implements ToolExecutor {
  constructor(
    private readonly inner: ToolExecutor,
    private readonly cb: CircuitBreaker
  ) {}

  async execute(input: {
    toolName: string;
    args: Record<string, unknown>;
    executionId: string;
    agentId: string;
  }) {
    return this.cb.call(() => this.inner.execute(input));
  }
}

/**
 * PgClient decorator that wraps every query and transaction inside a
 * shared circuit breaker. When Postgres is unavailable, the circuit opens
 * and all subsequent queries fast-fail with CircuitOpenError instead of
 * blocking until TCP timeout.
 *
 * The transaction wrapping is critical: `withTransaction` calls multiple
 * queries sequentially; if Postgres fails mid-transaction, the CB records
 * the failure and subsequent independent callers short-circuit.
 */
export class CircuitBreakerPgClient implements PgClient {
  constructor(
    private readonly inner: PgClient,
    private readonly cb: CircuitBreaker
  ) {}

  async query<T = unknown>(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    return this.cb.call(() => this.inner.query<T>(text, params));
  }

  async withTransaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T> {
    return this.cb.call(() =>
      this.inner.withTransaction((tx) => fn(new CircuitBreakerPgClient(tx, this.cb)))
    );
  }

  // Sprint Stabilization — PgClient interface now exposes acquire() + stats()
  // so the EventStore can share the persistence pool and operators get a
  // Prometheus-visible view of pool utilisation. The CB decorator forwards
  // both unchanged; the circuit only guards the actual SQL operations.
  async acquire(label?: string) {
    return this.inner.acquire(label);
  }

  stats() {
    return this.inner.stats();
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
