/**
 * Circuit Breaker — prevents cascading failures by fast-failing calls to a
 * degraded dependency (Postgres, model providers, tools).
 *
 * Corruption risk prevented:
 *   Without a CB, a slow/failed dependency causes every execution to block
 *   until its timeout, exhausting the worker's capacity and starving healthy
 *   executions. With a CB, failures are detected quickly and subsequent calls
 *   short-circuit immediately (microseconds, not seconds).
 *
 * State machine:
 *   CLOSED     → normal operation; failures accumulate against threshold.
 *   OPEN       → fast-fail; no calls reach the dependency.
 *   HALF_OPEN  → one probe call per recovery window; success → CLOSED,
 *                failure → OPEN again.
 *
 * Replay safety:
 *   The CB is purely operational infrastructure — it never mutates event store
 *   state. A CB-open failure surfaces as EXECUTION_FAILED with the circuit
 *   error message, which is fully auditable.
 *
 * Distributed implications:
 *   Each worker process holds its own CB state. A CB that opens on one worker
 *   does not affect others. This is intentional: per-worker CBs prevent a
 *   single slow worker from tripping a shared global state.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Logical name — used in events and logs, e.g. "postgres", "claude". */
  name: string;
  /** Consecutive failures required to open the circuit. */
  failureThreshold: number;
  /** Consecutive successes in HALF_OPEN required to close the circuit. */
  successThreshold: number;
  /** Time OPEN before attempting a probe (ms). */
  recoveryTimeoutMs: number;
  /** Called on every state transition for event emission and logging. */
  onStateChange?: (from: CircuitState, to: CircuitState, name: string, meta: CircuitTransitionMeta) => void;
}

export interface CircuitTransitionMeta {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** How long the circuit was open before this transition (ms), if transitioning from OPEN. */
  openDurationMs?: number;
}

export class CircuitOpenError extends Error {
  readonly name = "CircuitOpenError";
  constructor(public readonly circuit: string) {
    super(`Circuit breaker '${circuit}' is OPEN — request fast-failed to protect downstream`);
  }
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt?: number;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  getState(): CircuitState {
    return this.state;
  }

  getMetrics(): {
    state: CircuitState;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    openDurationMs?: number;
  } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      openDurationMs: this.openedAt ? Date.now() - this.openedAt : undefined
    };
  }

  /**
   * Execute `fn` through the circuit breaker.
   *
   * CLOSED  → runs fn; failure increments counter; success resets counter.
   * OPEN    → if recovery timeout has not elapsed, throws CircuitOpenError
   *           immediately without calling fn. Otherwise transitions HALF_OPEN
   *           and runs fn as a probe.
   * HALF_OPEN → runs fn as a probe; success increments success counter (may
   *             close); failure re-opens the circuit.
   *
   * CircuitOpenError is intentionally non-retryable: retrying a fast-fail
   * request defeats the purpose of the circuit breaker.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      const openDurationMs = Date.now() - (this.openedAt ?? 0);
      if (openDurationMs < this.opts.recoveryTimeoutMs) {
        throw new CircuitOpenError(this.opts.name);
      }
      this.transition("HALF_OPEN", { consecutiveFailures: this.consecutiveFailures, consecutiveSuccesses: 0 });
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      // Do not count CircuitOpenError as a failure — it would create a
      // feedback loop where the CB counts its own fast-fails as failures.
      if (!(err instanceof CircuitOpenError)) {
        this.recordFailure();
      }
      throw err;
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "HALF_OPEN") {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.opts.successThreshold) {
        const successes = this.consecutiveSuccesses;
        this.consecutiveSuccesses = 0;
        this.transition("CLOSED", { consecutiveFailures: 0, consecutiveSuccesses: successes });
      }
    }
  }

  private recordFailure(): void {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures += 1;

    if (this.state === "CLOSED" && this.consecutiveFailures >= this.opts.failureThreshold) {
      this.transition("OPEN", { consecutiveFailures: this.consecutiveFailures, consecutiveSuccesses: 0 });
    } else if (this.state === "HALF_OPEN") {
      this.transition("OPEN", { consecutiveFailures: this.consecutiveFailures, consecutiveSuccesses: 0 });
    }
  }

  private transition(to: CircuitState, meta: Omit<CircuitTransitionMeta, "openDurationMs">): void {
    const from = this.state;
    if (from === to) return;

    let openDurationMs: number | undefined;
    if (to === "OPEN") {
      this.openedAt = Date.now();
    } else {
      openDurationMs = this.openedAt ? Date.now() - this.openedAt : undefined;
      if (to === "CLOSED") this.openedAt = undefined;
    }

    this.state = to;
    this.opts.onStateChange?.(from, to, this.opts.name, { ...meta, openDurationMs });
  }
}
