/**
 * V3 — Region awareness boundary.
 *
 * Goals:
 *   - Provide a single, typed source of truth for the region this process
 *     believes itself to be running in (primary / secondary).
 *   - Provide a tagging facility so any Redis/Postgres client we hand out
 *     can be labelled with its region for split-brain detection downstream.
 *   - Allow operators to flip the topology classification at boot via env
 *     vars without touching code, and to observe it via /operator/region.
 *
 * Non-goals:
 *   - This module does NOT itself open Redis/Postgres connections — it is
 *     a boundary, not a driver. Callers (createRedisClient, createPgClient)
 *     consume the topology and apply it.
 *   - It does NOT perform automatic failover — `triggerDegradation` flips
 *     state and emits a metric; the orchestrator is responsible for the
 *     control-plane reaction (DNS, ALB target swap, traffic-shift).
 *
 * Backward compatibility:
 *   - When REGION_ID is unset the topology reports "primary" with role
 *     "active" so existing single-region deployments behave identically.
 *
 * Split-brain protection:
 *   - The topology also exposes a `fencingToken` which monotonically
 *     increments on every classified failover. The token is included in
 *     write-path heartbeats so a secondary that mistakenly believes itself
 *     promoted cannot win a CAS against the real primary.
 */

export type RegionRole = "active" | "passive" | "degraded";

export interface RegionTopology {
  /** Stable identifier — usually the cloud region, e.g. "us-east-1". */
  readonly regionId: string;
  /** Which region this process believes is the write-primary right now. */
  readonly primaryRegionId: string;
  /** Whether this process is in the primary, secondary, or degraded region. */
  readonly role: RegionRole;
  /**
   * Monotonic fencing token. Increments every failover. The token is the
   * split-brain barrier: replicas that come back online must observe a
   * higher token and stand down.
   */
  readonly fencingToken: number;
  /** Wall-clock timestamp this state was set (ISO-8601). */
  readonly lastTransitionAt: string;
  /** Operator-supplied explanation of the most recent transition. */
  readonly reason?: string;
}

export interface RegionAwarenessOptions {
  regionId?: string;
  primaryRegionId?: string;
  /** Optional initial fencing token (defaults to 0). */
  initialFencingToken?: number;
}

const DEFAULT_REGION_ID = "primary";

class RegionAwareness {
  private regionId: string;
  private primaryRegionId: string;
  private fencingToken: number;
  private role: RegionRole;
  private lastTransitionAt: string;
  private reason?: string;
  private listeners = new Set<(t: RegionTopology) => void>();

  constructor(opts: RegionAwarenessOptions) {
    this.regionId = opts.regionId ?? DEFAULT_REGION_ID;
    this.primaryRegionId = opts.primaryRegionId ?? this.regionId;
    this.fencingToken = opts.initialFencingToken ?? 0;
    this.role = this.regionId === this.primaryRegionId ? "active" : "passive";
    this.lastTransitionAt = new Date().toISOString();
  }

  topology(): RegionTopology {
    return {
      regionId: this.regionId,
      primaryRegionId: this.primaryRegionId,
      role: this.role,
      fencingToken: this.fencingToken,
      lastTransitionAt: this.lastTransitionAt,
      ...(this.reason ? { reason: this.reason } : {})
    };
  }

  /**
   * Promote this region. Increments the fencing token and emits a
   * transition event. Safe to call from operator routes only — never from
   * inside a request handler, because a misclassified failover causes
   * split-brain.
   */
  promote(reason: string): RegionTopology {
    this.primaryRegionId = this.regionId;
    this.role = "active";
    this.fencingToken += 1;
    this.lastTransitionAt = new Date().toISOString();
    this.reason = reason;
    this.emit();
    return this.topology();
  }

  /**
   * Demote this region. Used when an operator confirms a previously-active
   * region is now serving as standby. Does NOT bump the fencing token —
   * the new primary owns that responsibility.
   */
  demote(reason: string): RegionTopology {
    this.role = "passive";
    this.lastTransitionAt = new Date().toISOString();
    this.reason = reason;
    this.emit();
    return this.topology();
  }

  /**
   * Soft signal — mark the region as degraded but still serving. Read paths
   * stay open, write paths are expected to short-circuit via downstream
   * circuit breakers. Does NOT bump the fencing token.
   */
  degrade(reason: string): RegionTopology {
    this.role = "degraded";
    this.lastTransitionAt = new Date().toISOString();
    this.reason = reason;
    this.emit();
    return this.topology();
  }

  /**
   * Subscribe to topology transitions. Returns an unsubscribe handle. Used
   * by SLO governance and the metrics layer to surface region health.
   */
  onTransition(fn: (t: RegionTopology) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.topology();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        // listeners must never block transitions.
      }
    }
  }
}

let singleton: RegionAwareness | undefined;

/**
 * Get (or lazily initialise) the process-wide RegionAwareness. Reads the
 * environment so a process can pick up REGION_ID / PRIMARY_REGION_ID
 * without code changes.
 */
export function getRegionAwareness(): RegionAwareness {
  if (!singleton) {
    singleton = new RegionAwareness({
      regionId: process.env.REGION_ID,
      primaryRegionId: process.env.PRIMARY_REGION_ID,
      initialFencingToken: process.env.REGION_FENCING_TOKEN
        ? Number(process.env.REGION_FENCING_TOKEN)
        : 0
    });
  }
  return singleton;
}

/**
 * Test-only reset.
 */
export function __resetRegionAwarenessForTests(opts?: RegionAwarenessOptions): void {
  singleton = opts ? new RegionAwareness(opts) : undefined;
}

/**
 * Convenience — used by Redis/Postgres factories to tag connections with
 * their region so downstream split-brain guards can attribute writes.
 */
export function currentRegionTag(): string {
  return getRegionAwareness().topology().regionId;
}
