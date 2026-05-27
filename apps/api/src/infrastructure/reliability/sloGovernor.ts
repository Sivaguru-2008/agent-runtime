/**
 * V3 — SLO governance.
 *
 * What this gives the operator:
 *   - A typed registry of every SLO the runtime promises (availability,
 *     latency, queueing, replay determinism).
 *   - Live error-budget tracking over an operator-configured window
 *     (typically 30d) for each SLO.
 *   - Multi-window burn-rate calculation (1h / 6h / 24h) following the
 *     Google SRE workbook page 33 fast/slow burn pattern, so a burst of
 *     errors trips a fast-burn alert before the long-window budget is
 *     fully consumed.
 *   - Deploy-freeze enforcement contract — `shouldFreezeDeploys()` returns
 *     true when ANY SLO has exhausted its budget OR is on a sustained
 *     critical burn. Wired into the deployFreeze module which an external
 *     CD system can poll before promoting a release.
 *
 * What this is NOT:
 *   - Not a metrics store. Counts are kept in-memory in a ring buffer.
 *     Long-term storage lives in Prometheus; this module is the in-process
 *     enforcement contract. Recoverable across restart is not required —
 *     budget restarts after a deploy is acceptable because deploy freeze
 *     enforcement is *current-state* driven from Prometheus alerts in
 *     production. The in-memory ring buffer is the fail-safe in case the
 *     Prometheus side has a gap.
 *
 * Cardinality:
 *   - Each SLO has a fixed name. No tenant/agent labels are baked in here
 *     — those are tracked at the metrics layer. This keeps the SLO surface
 *     small enough to reason about during an incident.
 */

export type SloKind = "availability" | "latency" | "queueing" | "determinism";

export interface SloDefinition {
  /** Stable identifier, snake_case. e.g. "http_availability". */
  name: string;
  kind: SloKind;
  /** Target as a fraction in (0, 1]. e.g. 0.999 = "99.9% success". */
  target: number;
  /** Sliding window in seconds (default 30d). */
  windowSec: number;
  /** Human-readable description for dashboards / alerts. */
  description: string;
}

interface BucketCounts {
  total: number;
  bad: number;
}

interface RingBuffer {
  buckets: BucketCounts[];
  bucketSec: number;
  cursor: number;
  cursorEpochSec: number;
}

/** Multi-window burn pattern from Google SRE workbook page 33. */
export interface BurnRateWindow {
  /** Short window in seconds (the fast alert). */
  shortWindowSec: number;
  /** Long window in seconds (the slow alert). */
  longWindowSec: number;
  /** Burn-rate threshold above which the window contributes to firing. */
  burnRateThreshold: number;
  /** Human label, used in alert payloads. e.g. "fast" / "slow". */
  label: "fast" | "slow" | "page";
}

/**
 * Multi-window burn-rate ladders. Lifted directly from SRE Workbook
 * (Implementing SLOs) — three ladders catch budget exhaustion at three
 * different time horizons.
 *
 *   page  — 2% of 30d budget consumed in 1h  → P1, page on-call immediately
 *   fast  — 5% of 30d budget consumed in 6h  → P2, page on-call
 *   slow  — 10% of 30d budget consumed in 3d → P3, ticket for tomorrow
 */
const DEFAULT_BURN_WINDOWS: BurnRateWindow[] = [
  { label: "page", shortWindowSec: 5 * 60, longWindowSec: 60 * 60, burnRateThreshold: 14.4 },
  { label: "fast", shortWindowSec: 30 * 60, longWindowSec: 6 * 60 * 60, burnRateThreshold: 6 },
  { label: "slow", shortWindowSec: 2 * 60 * 60, longWindowSec: 24 * 60 * 60, burnRateThreshold: 1 }
];

const BUCKET_GRANULARITY_SEC = 60;

export interface SloSnapshot {
  name: string;
  kind: SloKind;
  target: number;
  windowSec: number;
  total: number;
  bad: number;
  successFraction: number;
  /** Fraction of the error budget consumed in [0, 1]. >1 means exhausted. */
  budgetConsumed: number;
  /** Active burn-rate alerts, indexed by label. */
  burns: { label: BurnRateWindow["label"]; burnRate: number; firing: boolean }[];
}

class SloRing {
  private readonly buf: RingBuffer;
  constructor(windowSec: number) {
    const buckets = Math.max(1, Math.ceil(windowSec / BUCKET_GRANULARITY_SEC));
    this.buf = {
      buckets: Array.from({ length: buckets }, () => ({ total: 0, bad: 0 })),
      bucketSec: BUCKET_GRANULARITY_SEC,
      cursor: 0,
      cursorEpochSec: Math.floor(Date.now() / 1000 / BUCKET_GRANULARITY_SEC)
    };
  }

  record(bad: boolean, nowSec: number): void {
    this.advance(nowSec);
    const bucket = this.buf.buckets[this.buf.cursor]!;
    bucket.total += 1;
    if (bad) bucket.bad += 1;
  }

  sum(nowSec: number, lookbackSec?: number): BucketCounts {
    this.advance(nowSec);
    const lookback = lookbackSec
      ? Math.min(this.buf.buckets.length, Math.ceil(lookbackSec / this.buf.bucketSec))
      : this.buf.buckets.length;
    let total = 0;
    let bad = 0;
    for (let i = 0; i < lookback; i++) {
      const idx = (this.buf.cursor - i + this.buf.buckets.length) % this.buf.buckets.length;
      const b = this.buf.buckets[idx]!;
      total += b.total;
      bad += b.bad;
    }
    return { total, bad };
  }

  private advance(nowSec: number): void {
    const nowBucketEpoch = Math.floor(nowSec / this.buf.bucketSec);
    let drift = nowBucketEpoch - this.buf.cursorEpochSec;
    if (drift <= 0) return;
    if (drift > this.buf.buckets.length) drift = this.buf.buckets.length;
    for (let i = 0; i < drift; i++) {
      this.buf.cursor = (this.buf.cursor + 1) % this.buf.buckets.length;
      this.buf.buckets[this.buf.cursor] = { total: 0, bad: 0 };
    }
    this.buf.cursorEpochSec = nowBucketEpoch;
  }
}

/**
 * Process-wide SLO governor. Single instance per process — registered on
 * the RuntimeContainer so HTTP, scheduler, replay, and DLQ paths share
 * the same view.
 */
export class SloGovernor {
  private readonly defs = new Map<string, SloDefinition>();
  private readonly rings = new Map<string, SloRing>();
  private readonly burnWindows: BurnRateWindow[];
  /** When freezeOverride is true, deploy freeze is forced active regardless of budgets. */
  private freezeOverride = false;
  private freezeReason?: string;

  constructor(opts?: { burnWindows?: BurnRateWindow[] }) {
    this.burnWindows = opts?.burnWindows ?? DEFAULT_BURN_WINDOWS;
  }

  register(def: SloDefinition): void {
    if (def.target <= 0 || def.target > 1) {
      throw new Error(`SLO ${def.name} target must be in (0, 1], got ${def.target}`);
    }
    this.defs.set(def.name, def);
    if (!this.rings.has(def.name)) {
      this.rings.set(def.name, new SloRing(def.windowSec));
    }
  }

  /** Record one observation. `good` = met SLI, `bad` otherwise. */
  observe(name: string, good: boolean, nowMs: number = Date.now()): void {
    const ring = this.rings.get(name);
    if (!ring) return; // unregistered SLO is a no-op, never throws
    ring.record(!good, Math.floor(nowMs / 1000));
  }

  snapshot(name: string, nowMs: number = Date.now()): SloSnapshot | undefined {
    const def = this.defs.get(name);
    const ring = this.rings.get(name);
    if (!def || !ring) return undefined;
    const nowSec = Math.floor(nowMs / 1000);
    const { total, bad } = ring.sum(nowSec);
    const successFraction = total === 0 ? 1 : 1 - bad / total;
    // Error budget consumed = (observed_error_rate) / (allowed_error_rate).
    // 1.0 means the budget is exactly exhausted. Higher means overspent.
    const allowedErrorRate = 1 - def.target;
    const observedErrorRate = total === 0 ? 0 : bad / total;
    const budgetConsumed = allowedErrorRate === 0
      ? observedErrorRate > 0 ? Infinity : 0
      : observedErrorRate / allowedErrorRate;

    const burns = this.burnWindows.map((w) => {
      const burnRate = this.burnRateOver(ring, w.shortWindowSec, def, nowSec);
      const longBurnRate = this.burnRateOver(ring, w.longWindowSec, def, nowSec);
      // Multi-window: BOTH the short and long window must exceed the threshold
      // before the burn fires. Prevents single-minute blips from paging.
      const firing = burnRate >= w.burnRateThreshold && longBurnRate >= w.burnRateThreshold;
      return { label: w.label, burnRate, firing };
    });

    return {
      name: def.name,
      kind: def.kind,
      target: def.target,
      windowSec: def.windowSec,
      total,
      bad,
      successFraction,
      budgetConsumed,
      burns
    };
  }

  snapshotAll(nowMs: number = Date.now()): SloSnapshot[] {
    return Array.from(this.defs.keys())
      .map((n) => this.snapshot(n, nowMs))
      .filter((s): s is SloSnapshot => s !== undefined);
  }

  /**
   * Deploy-freeze contract. Returns the reason if deploys should be
   * blocked, or undefined if it is safe to roll out.
   *
   * The contract trips when:
   *   - operator override is set, OR
   *   - any SLO has budgetConsumed >= 1.0, OR
   *   - any SLO has the page-level burn firing.
   *
   * fast/slow burns alone do NOT freeze — they page on-call but releases
   * are still allowed because the budget recovers naturally.
   */
  freezeReasonIfAny(nowMs: number = Date.now()): string | undefined {
    if (this.freezeOverride) return this.freezeReason ?? "operator-override";
    for (const snap of this.snapshotAll(nowMs)) {
      if (!isFinite(snap.budgetConsumed) || snap.budgetConsumed >= 1) {
        return `slo:${snap.name}:budget-exhausted`;
      }
      if (snap.burns.find((b) => b.label === "page" && b.firing)) {
        return `slo:${snap.name}:page-burn-rate-firing`;
      }
    }
    return undefined;
  }

  shouldFreezeDeploys(nowMs: number = Date.now()): boolean {
    return this.freezeReasonIfAny(nowMs) !== undefined;
  }

  /** Operator switch — force-freeze deploys regardless of telemetry. */
  forceFreeze(reason: string): void {
    this.freezeOverride = true;
    this.freezeReason = reason;
  }

  /** Operator switch — release a forced freeze. SLO-driven freezes remain. */
  releaseFreeze(): void {
    this.freezeOverride = false;
    this.freezeReason = undefined;
  }

  listDefinitions(): SloDefinition[] {
    return Array.from(this.defs.values());
  }

  private burnRateOver(
    ring: SloRing,
    lookbackSec: number,
    def: SloDefinition,
    nowSec: number
  ): number {
    const { total, bad } = ring.sum(nowSec, lookbackSec);
    if (total === 0) return 0;
    const observedErrorRate = bad / total;
    const allowedErrorRate = 1 - def.target;
    if (allowedErrorRate === 0) return observedErrorRate > 0 ? Infinity : 0;
    return observedErrorRate / allowedErrorRate;
  }
}

/**
 * Default SLO ladder for the autonomous runtime. Wired by the
 * RuntimeContainer at boot. Operators can append more via the governor.
 *
 * Targets are the contract we ship — narrowing them is a breaking change
 * and must be reviewed alongside on-call rotation.
 */
export function defaultSloLadder(): SloDefinition[] {
  const THIRTY_DAYS = 30 * 24 * 60 * 60;
  return [
    {
      name: "http_availability",
      kind: "availability",
      target: 0.999,
      windowSec: THIRTY_DAYS,
      description: "Fraction of HTTP responses with status < 500."
    },
    {
      name: "execution_success",
      kind: "availability",
      target: 0.99,
      windowSec: THIRTY_DAYS,
      description: "Fraction of agent executions that terminate in success."
    },
    {
      name: "queue_admission",
      kind: "queueing",
      target: 0.995,
      windowSec: THIRTY_DAYS,
      description: "Fraction of submitted jobs admitted without BackpressureError."
    },
    {
      name: "replay_determinism",
      kind: "determinism",
      target: 0.999,
      windowSec: THIRTY_DAYS,
      description: "Fraction of replays that did not diverge from the original execution."
    }
  ];
}
