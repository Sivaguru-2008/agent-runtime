/**
 * ChaosController — process-singleton registry of active fault-injection
 * scenarios and a recorder of every chaos event that fires.
 *
 * Design:
 *   - One controller per process. Tests reset it between scenarios.
 *   - Scenarios are addressed by name (e.g. "redis.latency", "pg.statementTimeout").
 *   - A scenario has: probability ∈ [0,1], a payload describing what to do
 *     (e.g. {ms: 500} for latency), and a remaining-call counter that
 *     decrements toward an optional `times` budget. Once exhausted the
 *     scenario auto-clears, mirroring how a real incident self-heals after
 *     the underlying cause is removed.
 *   - Every fault that actually fires is appended to an in-memory ring of
 *     ChaosEvent entries. The certification report drains this ring at the
 *     end of a phase and computes acceptance metrics from it.
 *
 * Determinism:
 *   The controller accepts an injected RNG so tests can be made fully
 *   deterministic by passing a seeded Math.random replacement. Default is
 *   Math.random — fine for the harness itself but not for assertions over
 *   single-trial behaviour.
 */

export type ChaosEventKind =
  | "redis.latency"
  | "redis.disconnect"
  | "redis.pubsubDrop"
  | "redis.ackDelay"
  | "pg.disconnect"
  | "pg.statementTimeout"
  | "pg.poolStarvation"
  | "worker.kill"
  | "sse.disconnect"
  | "sse.tokenDrop"
  | "queue.saturation";

export interface ChaosScenario {
  /** Stable identifier; matches a ChaosEventKind. */
  kind: ChaosEventKind;
  /** Probability per eligible call site, in [0,1]. */
  probability: number;
  /**
   * Maximum number of times this scenario may fire before auto-clearing.
   * Defaults to Infinity. Useful for "burst" scenarios (e.g. 50 disconnects
   * then steady-state).
   */
  times?: number;
  /** Free-form payload — interpreted by the proxy that owns this kind. */
  payload?: Record<string, unknown>;
  /** When the scenario was registered (epoch ms). Used in event records. */
  registeredAt: number;
  /** Decremented when `times` is set. */
  remaining: number;
}

export interface ChaosEvent {
  kind: ChaosEventKind;
  /** Epoch ms when this fault was injected at the call site. */
  at: number;
  /** Optional small fact about the fault (latency value, signal, etc.). */
  detail?: Record<string, unknown>;
}

export interface ChaosMetricsSnapshot {
  scenariosActive: number;
  totalFired: number;
  byKind: Record<ChaosEventKind, number>;
}

export interface ChaosControllerOptions {
  /** Replacement for Math.random — pass a seeded RNG for deterministic tests. */
  rng?: () => number;
  /** Maximum events retained in the ring. Older events are dropped. */
  eventCapacity?: number;
}

export class ChaosController {
  private readonly scenarios = new Map<ChaosEventKind, ChaosScenario>();
  private readonly events: ChaosEvent[] = [];
  private readonly rng: () => number;
  private readonly eventCapacity: number;
  private fired = 0;
  private readonly fireCounts: Record<ChaosEventKind, number>;

  constructor(opts: ChaosControllerOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.eventCapacity = opts.eventCapacity ?? 10_000;
    this.fireCounts = {
      "redis.latency": 0,
      "redis.disconnect": 0,
      "redis.pubsubDrop": 0,
      "redis.ackDelay": 0,
      "pg.disconnect": 0,
      "pg.statementTimeout": 0,
      "pg.poolStarvation": 0,
      "worker.kill": 0,
      "sse.disconnect": 0,
      "sse.tokenDrop": 0,
      "queue.saturation": 0
    };
  }

  register(scenario: Omit<ChaosScenario, "registeredAt" | "remaining">): void {
    if (scenario.probability < 0 || scenario.probability > 1) {
      throw new Error(`[chaos] scenario probability out of range: ${scenario.probability}`);
    }
    this.scenarios.set(scenario.kind, {
      ...scenario,
      registeredAt: Date.now(),
      remaining: scenario.times ?? Number.POSITIVE_INFINITY
    });
  }

  clear(kind?: ChaosEventKind): void {
    if (kind) this.scenarios.delete(kind);
    else this.scenarios.clear();
  }

  reset(): void {
    this.scenarios.clear();
    this.events.length = 0;
    this.fired = 0;
    for (const k of Object.keys(this.fireCounts) as ChaosEventKind[]) {
      this.fireCounts[k] = 0;
    }
  }

  /**
   * Roll the dice for `kind`. If the scenario fires, returns its payload (or
   * an empty object); otherwise returns null. Updates the call budget and
   * records an event for the certification report.
   */
  maybeFire(kind: ChaosEventKind, detail?: Record<string, unknown>): Record<string, unknown> | null {
    const scenario = this.scenarios.get(kind);
    if (!scenario) return null;
    if (scenario.remaining <= 0) {
      this.scenarios.delete(kind);
      return null;
    }
    if (this.rng() >= scenario.probability) return null;

    scenario.remaining -= 1;
    if (scenario.remaining <= 0) {
      this.scenarios.delete(kind);
    }

    this.fired += 1;
    this.fireCounts[kind] += 1;
    this.events.push({
      kind,
      at: Date.now(),
      ...(detail ? { detail } : {})
    });
    if (this.events.length > this.eventCapacity) {
      this.events.shift();
    }
    return scenario.payload ?? {};
  }

  events_snapshot(): ChaosEvent[] {
    return this.events.slice();
  }

  metrics(): ChaosMetricsSnapshot {
    return {
      scenariosActive: this.scenarios.size,
      totalFired: this.fired,
      byKind: { ...this.fireCounts }
    };
  }
}

let singleton: ChaosController | null = null;

/** Lazily-constructed process-wide controller. */
export function chaosController(): ChaosController {
  if (!singleton) singleton = new ChaosController();
  return singleton;
}

/** Test-only: replace the singleton (e.g. with a seeded RNG). */
export function __setChaosControllerForTests(c: ChaosController | null): void {
  singleton = c;
}
