import {
  assertRuntimeInvariant,
  InvariantViolation,
  type CanonicalOwnershipContext
} from "./canonicalSemantics.js";

/**
 * Canonical Coordination Authority Boundary.
 *
 * This module is the single authoritative statement of *who owns what* across
 * the Redis<->Postgres split, and the runtime guards that keep that boundary
 * from eroding. It exists because the boundary was previously implicit —
 * scattered across container wiring, production invariants, and SQL — which
 * made "could a correctness decision ever depend on Redis durability?" an
 * answer you had to reconstruct by reading the whole system.
 *
 * The boundary, stated once:
 *
 *   • Postgres is the SOLE authority for correctness state. Leases, fences,
 *     checkpoints, the event log, the outbox, tool-call dedup, dead-letters,
 *     and execution state are durable truth. They survive total Redis loss
 *     unchanged.
 *
 *   • Redis is EPHEMERAL coordination only — the job queue, the event/stream
 *     bus, rate limiting, quota, liveness, SSE de-dupe. Every Redis-resident
 *     datum is either reconstructable from durable truth or safe to lose
 *     (degrades to a permissive/empty default). Losing all of Redis can delay
 *     or duplicate *delivery*, but can never change a *committed* outcome.
 *
 *   • In-process coordination (the single-flight retry coordinator) is
 *     ephemeral and process-local. Cross-process serialization is delegated to
 *     the durable lease — never to Redis.
 *
 * The CA1..CA6 invariants (see canonicalSemantics.INVARIANT_REGISTRY) encode
 * this, and the functions below enforce it: at container startup
 * (`assertCoordinationAuthorityWiring`), at ownership-establishment
 * (`reconcileOwnershipView` / `assertOwnershipResolvesToDurable`), and at
 * reconstruction time (`assertReconstructionDurable`).
 */

/** Where a coordination concern's authoritative state physically lives. */
export type CoordinationAuthority = "POSTGRES" | "REDIS" | "PROCESS";

/**
 * The durability class of a concern.
 *   DURABLE_TRUTH   — the canonical record; loss is a data-loss incident.
 *   RECONSTRUCTABLE — not itself canonical, but fully derivable from durable
 *                     truth (e.g., replay projections rebuilt from the event log).
 *   EPHEMERAL       — coordination scratch; loss is tolerated by design.
 */
export type DurabilityClass = "DURABLE_TRUTH" | "RECONSTRUCTABLE" | "EPHEMERAL";

export interface ConcernAuthority {
  readonly concern: CoordinationConcern;
  readonly authority: CoordinationAuthority;
  readonly durability: DurabilityClass;
  /** True iff the concern's state can be rebuilt from durable truth after total loss. */
  readonly reconstructable: boolean;
  /** Human-readable source used to reconstruct the concern after loss. */
  readonly reconstructionSource: string;
  /**
   * True iff a correctness decision for this concern must NEVER depend on Redis
   * durability. Every DURABLE_TRUTH concern sets this; it is the property the
   * startup wiring guard enforces (CA1).
   */
  readonly mustNeverDependOnRedis: boolean;
  readonly notes: string;
}

export type CoordinationConcern =
  // ── Durable truth (Postgres) ──────────────────────────────────────────────
  | "EXECUTION_STATE"
  | "EXECUTION_LEASE"
  | "FENCE_STATE"
  | "EXECUTION_CHECKPOINT"
  | "EVENT_LOG"
  | "EVENT_OUTBOX"
  | "TOOL_CALL_DEDUP"
  | "DEAD_LETTER"
  | "WORKER_REGISTRY"
  | "REPLAY_METADATA"
  // ── Reconstructable / process-local ───────────────────────────────────────
  | "RETRY_COORDINATION"
  // ── Ephemeral coordination (Redis) ────────────────────────────────────────
  | "JOB_QUEUE"
  | "EVENT_BUS"
  | "RATE_LIMIT"
  | "QUOTA"
  | "LIVENESS"
  | "SSE_DEDUPE";

/**
 * The durability authority matrix. This table is the machine-readable contract
 * the docs (docs/specs/coordination-boundary.md) render and the runtime guards
 * consult. Adding a coordination concern WITHOUT adding it here makes
 * `classifyConcern` throw CA6 — that is intentional: an unclassified concern
 * may not participate in coordination.
 */
export const COORDINATION_AUTHORITY_MATRIX: Readonly<Record<CoordinationConcern, ConcernAuthority>> = {
  EXECUTION_STATE: {
    concern: "EXECUTION_STATE",
    authority: "POSTGRES",
    durability: "DURABLE_TRUTH",
    reconstructable: false,
    reconstructionSource: "executions table (authoritative); event log can re-derive history",
    mustNeverDependOnRedis: true,
    notes: "The execution row is canonical. Redis job envelopes carry a denormalized snapshot for transport only."
  },
  EXECUTION_LEASE: {
    concern: "EXECUTION_LEASE",
    authority: "POSTGRES",
    durability: "DURABLE_TRUTH",
    reconstructable: false,
    reconstructionSource: "execution_leases table; expiry + serialized takeoverRecovery re-establish ownership",
    mustNeverDependOnRedis: true,
    notes: "Sole source of ownership truth. Fencing token = attempt is minted here and only here."
  },
  FENCE_STATE: {
    concern: "FENCE_STATE",
    authority: "POSTGRES",
    durability: "DURABLE_TRUTH",
    reconstructable: false,
    reconstructionSource: "execution_fences table (PENDING/EXECUTING/COMMITTED ledger)",
    mustNeverDependOnRedis: true,
    notes: "Every external side effect is gated by a committed durable fence. Never Redis-resident."
  },
  EXECUTION_CHECKPOINT: {
    concern: "EXECUTION_CHECKPOINT",
    authority: "POSTGRES",
    durability: "DURABLE_TRUTH",
    reconstructable: false,
    reconstructionSource: "execution_checkpoints table; recovery anchor",
    mustNeverDependOnRedis: true,
    notes: "Crash-recovery resumes from the latest fenced checkpoint."
  },
  EVENT_LOG: {
    concern: "EVENT_LOG",
    authority: "POSTGRES",
    durability: "DURABLE_TRUTH",
    reconstructable: false,
    reconstructionSource: "events table; append-only, fenced writes",
    mustNeverDependOnRedis: true,
    notes: "The replay/recovery substrate. The Redis bus is a best-effort fan-out of what is already committed here."
  },
  EVENT_OUTBOX: {
    concern: "EVENT_OUTBOX",
    authority: "POSTGRES",
    durability: "DURABLE_TRUTH",
    reconstructable: false,
    reconstructionSource: "event_outbox table; drained by OutboxDispatcher",
    mustNeverDependOnRedis: true,
    notes: "Bridges the committed event log to the ephemeral bus. Guarantees at-least-once delivery despite bus loss."
  },
  TOOL_CALL_DEDUP: {
    concern: "TOOL_CALL_DEDUP",
    authority: "POSTGRES",
    durability: "DURABLE_TRUTH",
    reconstructable: false,
    reconstructionSource: "tool_call_dedup table; keyed on idempotency key",
    mustNeverDependOnRedis: true,
    notes: "Side-effect uniqueness (S1) is enforced durably, not via a Redis cache."
  },
  DEAD_LETTER: {
    concern: "DEAD_LETTER",
    authority: "POSTGRES",
    durability: "DURABLE_TRUTH",
    reconstructable: false,
    reconstructionSource: "dead_letter table; operator triage queue",
    mustNeverDependOnRedis: true,
    notes: "Poisoned executions must survive restarts for post-incident triage."
  },
  WORKER_REGISTRY: {
    concern: "WORKER_REGISTRY",
    authority: "POSTGRES",
    durability: "DURABLE_TRUTH",
    reconstructable: true,
    reconstructionSource: "runtime_workers table; re-populated by worker (re)registration + heartbeat",
    mustNeverDependOnRedis: true,
    notes: "Durable directory of capacity. Stale rows are swept by TTL; workers re-register on restart."
  },
  REPLAY_METADATA: {
    concern: "REPLAY_METADATA",
    authority: "POSTGRES",
    durability: "DURABLE_TRUTH",
    reconstructable: true,
    reconstructionSource: "snapshots / replay_sessions / replay_certifications / replay_externalities tables; derivable from the event log",
    mustNeverDependOnRedis: true,
    notes: "Replay projections are durable and additionally reconstructable from the canonical event log."
  },
  RETRY_COORDINATION: {
    concern: "RETRY_COORDINATION",
    authority: "PROCESS",
    durability: "RECONSTRUCTABLE",
    reconstructable: true,
    reconstructionSource: "rebuilt from durable lease epoch + execution state on the next claim",
    mustNeverDependOnRedis: true,
    notes: "In-process single-flight gate (RT1..RT8). Cross-process serialization is the durable lease, never Redis."
  },
  JOB_QUEUE: {
    concern: "JOB_QUEUE",
    authority: "REDIS",
    durability: "EPHEMERAL",
    reconstructable: true,
    reconstructionSource: "recovery loop re-enqueues from durable execution + lease state (expired-lease reclaim)",
    mustNeverDependOnRedis: false,
    notes: "Delivery medium. A lost job is re-created by recovery from durable truth; visibility >= lease TTL prevents double-drive."
  },
  EVENT_BUS: {
    concern: "EVENT_BUS",
    authority: "REDIS",
    durability: "EPHEMERAL",
    reconstructable: true,
    reconstructionSource: "durable event log + outbox dispatcher re-publish",
    mustNeverDependOnRedis: false,
    notes: "Best-effort fan-out for live consumers. Subscribers reconcile against the durable event log / outbox."
  },
  RATE_LIMIT: {
    concern: "RATE_LIMIT",
    authority: "REDIS",
    durability: "EPHEMERAL",
    reconstructable: false,
    reconstructionSource: "n/a — resets to a permissive empty window on loss",
    mustNeverDependOnRedis: false,
    notes: "Loss-safe: a flushed counter fails open to a fresh window. Not a correctness concern."
  },
  QUOTA: {
    concern: "QUOTA",
    authority: "REDIS",
    durability: "EPHEMERAL",
    reconstructable: false,
    reconstructionSource: "n/a — soft enforcement; loss resets the counter window",
    mustNeverDependOnRedis: false,
    notes: "Soft enforcement. Hard billing truth, if any, lives in Postgres, not here."
  },
  LIVENESS: {
    concern: "LIVENESS",
    authority: "REDIS",
    durability: "EPHEMERAL",
    reconstructable: true,
    reconstructionSource: "rebuilt from heartbeats; absence is treated as not-live (fail-safe)",
    mustNeverDependOnRedis: false,
    notes: "Liveness/region hints. Missing data degrades to 'assume not-live', which is the safe default."
  },
  SSE_DEDUPE: {
    concern: "SSE_DEDUPE",
    authority: "REDIS",
    durability: "EPHEMERAL",
    reconstructable: false,
    reconstructionSource: "n/a — a flushed window may re-deliver an SSE frame (idempotent on the client)",
    mustNeverDependOnRedis: false,
    notes: "At-most-once SSE hint. Loss can cause a duplicate frame, never a wrong outcome."
  }
};

/**
 * CA6 — resolve a concern's authority classification, throwing if the concern
 * is not in the matrix. An unclassified concern may not participate in
 * coordination.
 */
export function classifyConcern(concern: CoordinationConcern): ConcernAuthority {
  const entry = COORDINATION_AUTHORITY_MATRIX[concern];
  assertRuntimeInvariant(
    "CA6",
    entry !== undefined,
    `coordination concern '${concern}' has no authority classification`,
    { concern }
  );
  return entry;
}

/** All classifications, ordered durable-first, for docs/operator surfaces. */
export function describeAuthorityMatrix(): ConcernAuthority[] {
  const order: DurabilityClass[] = ["DURABLE_TRUTH", "RECONSTRUCTABLE", "EPHEMERAL"];
  return Object.values(COORDINATION_AUTHORITY_MATRIX).sort(
    (a, b) => order.indexOf(a.durability) - order.indexOf(b.durability)
  );
}

// ─── Adapter classification (startup wiring guard, CA1) ──────────────────────

export type AdapterAuthority = CoordinationAuthority | "UNKNOWN";

/**
 * Classify a wired adapter by its constructor name. The convention across the
 * codebase is rigid enough to be load-bearing here:
 *   Redis*    → REDIS  (RedisExecutionJobQueue, RedisEventBus, RedisStreamsEventBus)
 *   Postgres* → POSTGRES
 *   InMemory* / Noop* → PROCESS (acceptable for dev/test of any concern)
 * Anything else is UNKNOWN and treated as a wiring error by the guard.
 */
export function classifyAdapter(adapterCtorName: string): AdapterAuthority {
  if (adapterCtorName.startsWith("Redis")) return "REDIS";
  if (adapterCtorName.startsWith("Postgres")) return "POSTGRES";
  if (adapterCtorName.startsWith("InMemory") || adapterCtorName.startsWith("Noop")) return "PROCESS";
  return "UNKNOWN";
}

export interface AdapterBinding {
  readonly concern: CoordinationConcern;
  /** The constructor name of the *raw* adapter (before metrics/CB wrappers). */
  readonly adapterCtorName: string;
}

export interface WiringAuthorityReport {
  readonly concern: CoordinationConcern;
  readonly adapter: string;
  readonly adapterAuthority: AdapterAuthority;
  readonly expected: CoordinationAuthority;
  readonly ok: boolean;
}

/**
 * CA1 — assert that no durable-truth concern is served by a Redis-backed
 * adapter, and that no concern is bound to an adapter the convention can't
 * classify. Fail-closed: a single bad binding throws.
 *
 * This runs once at container construction. It is the structural guard that
 * makes "a future refactor accidentally backs leases with Redis" a boot-time
 * crash instead of a silent split-brain corruption window.
 */
export function assertCoordinationAuthorityWiring(bindings: readonly AdapterBinding[]): WiringAuthorityReport[] {
  const report: WiringAuthorityReport[] = [];
  for (const binding of bindings) {
    const classification = classifyConcern(binding.concern);
    const adapterAuthority = classifyAdapter(binding.adapterCtorName);

    // CA1: a concern that must never depend on Redis durability cannot be
    // served by a Redis adapter. This is the load-bearing guard — a Redis*
    // constructor name is unambiguous, so an UNKNOWN adapter (e.g. a unit-test
    // double) is by definition NOT Redis and passes. We deliberately do NOT
    // throw on UNKNOWN: tests legitimately inject fakes, and the threat model
    // here is "a durable concern silently backed by Redis", which is caught.
    assertRuntimeInvariant(
      "CA1",
      !(classification.mustNeverDependOnRedis && adapterAuthority === "REDIS"),
      `durable concern '${binding.concern}' is bound to a Redis adapter '${binding.adapterCtorName}' — correctness state must live in Postgres`,
      { concern: binding.concern, adapter: binding.adapterCtorName }
    );

    // A durable-truth concern may be served by Postgres (prod) or PROCESS
    // (in-memory dev/test), never Redis.
    const ok =
      classification.durability !== "DURABLE_TRUTH"
        ? true
        : adapterAuthority === "POSTGRES" || adapterAuthority === "PROCESS";

    report.push({
      concern: binding.concern,
      adapter: binding.adapterCtorName,
      adapterAuthority,
      expected: classification.authority,
      ok
    });
  }
  return report;
}

// ─── Ephemeral-loss safety (CA2) ─────────────────────────────────────────────

/**
 * CA2 — a concern is "loss-safe" iff losing all of its state cannot change a
 * committed outcome: it is durable truth, OR it is ephemeral but fully
 * reconstructable from durable truth, OR it is ephemeral and explicitly
 * tolerated (resets to a safe default). The matrix is the source of these
 * facts; this function asserts the table itself never describes an
 * ephemeral concern that is simultaneously non-reconstructable AND required
 * for correctness (mustNeverDependOnRedis).
 */
export function assertEphemeralLossSafe(concern: CoordinationConcern): void {
  const c = classifyConcern(concern);
  const lossSafe =
    c.durability === "DURABLE_TRUTH" ||
    c.reconstructable ||
    c.mustNeverDependOnRedis === false;
  assertRuntimeInvariant(
    "CA2",
    lossSafe,
    `concern '${concern}' is ephemeral, non-reconstructable, and flagged as correctness-critical — losing Redis would change a committed outcome`,
    { concern, durability: c.durability, reconstructable: c.reconstructable }
  );
}

// ─── Reconstruction source validation (CA4) ──────────────────────────────────

/**
 * CA4 — assert that a recovery/replay reconstruction draws only on durable
 * sources. Each source concern must be durable truth or reconstructable from
 * durable truth; an EPHEMERAL source that is not reconstructable would make
 * reconstruction depend on Redis surviving, which is forbidden.
 */
export function assertReconstructionDurable(
  sources: readonly CoordinationConcern[],
  context?: Record<string, unknown>
): void {
  for (const concern of sources) {
    const c = classifyConcern(concern);
    const durableSource = c.durability !== "EPHEMERAL" || c.reconstructable;
    assertRuntimeInvariant(
      "CA4",
      durableSource,
      `reconstruction depends on ephemeral, non-reconstructable concern '${concern}' — recovery must not require Redis-resident state`,
      { ...context, concern, durability: c.durability }
    );
  }
}

// ─── Ownership reconciliation (CA3 / CA5) ────────────────────────────────────

/**
 * The durable ownership record (a lease projection). This is the authority.
 */
export interface DurableOwnership {
  readonly workerId: string;
  readonly attempt: number;
  /** Whether the durable lease is currently in an active/owning state. */
  readonly active: boolean;
}

/**
 * An ephemeral ownership hint observed off a Redis-resident or in-process
 * source (a job envelope, an in-memory tracked lease, a cached view). It is
 * never authoritative — it can at most agree with the durable record.
 */
export interface EphemeralOwnershipHint {
  readonly workerId?: string;
  readonly attempt?: number;
  readonly source: string;
}

export type OwnershipDesyncSeverity = "NONE" | "STALE" | "CONFLICT" | "IMPOSSIBLE";

export interface OwnershipReconciliation {
  /** The authoritative view. ALWAYS the durable record (CA5: Postgres wins). */
  readonly authoritative: DurableOwnership | undefined;
  readonly desynchronized: boolean;
  readonly severity: OwnershipDesyncSeverity;
  readonly reason: string;
}

/**
 * CA3 + CA5 — reconcile an ephemeral ownership hint against the durable record.
 *
 * The durable record is the only authority; this function never promotes the
 * ephemeral view. It *classifies* the disagreement so callers can distinguish:
 *
 *   STALE      — the hint trails the durable epoch (a normal late/redelivered
 *                message). Expected; not an incident.
 *   CONFLICT   — the hint names a different owner at the same epoch. The
 *                ephemeral side is wrong; discard it.
 *   IMPOSSIBLE — the hint claims an epoch ABOVE the durable epoch. Under
 *                canonical authority Postgres mints every epoch, so Redis can
 *                never legitimately be ahead. This signals genuine
 *                desynchronization (a stale Redis snapshot from a prior epoch
 *                that outlived a Postgres restore, or corruption).
 *
 * Returns the durable view as authoritative in every case. Use
 * `assertOwnershipResolvesToDurable` when an IMPOSSIBLE desync must fail closed.
 */
export function reconcileOwnershipView(
  durable: DurableOwnership | undefined,
  ephemeral: EphemeralOwnershipHint
): OwnershipReconciliation {
  if (!durable || !durable.active) {
    // No active durable owner. An ephemeral hint that still claims ownership is
    // a desync, but a benign "no hint" is fine.
    const claims = ephemeral.attempt !== undefined || ephemeral.workerId !== undefined;
    return {
      authoritative: durable,
      desynchronized: claims,
      severity: claims ? "CONFLICT" : "NONE",
      reason: claims
        ? `ephemeral source '${ephemeral.source}' claims ownership but no active durable lease exists`
        : "no active durable owner and no ephemeral claim"
    };
  }

  if (ephemeral.attempt !== undefined && ephemeral.attempt > durable.attempt) {
    return {
      authoritative: durable,
      desynchronized: true,
      severity: "IMPOSSIBLE",
      reason: `ephemeral source '${ephemeral.source}' claims epoch ${ephemeral.attempt} > durable epoch ${durable.attempt}; Redis cannot lead the Postgres-minted epoch`
    };
  }

  if (
    ephemeral.workerId !== undefined &&
    ephemeral.workerId !== durable.workerId &&
    (ephemeral.attempt ?? durable.attempt) >= durable.attempt
  ) {
    return {
      authoritative: durable,
      desynchronized: true,
      severity: "CONFLICT",
      reason: `ephemeral source '${ephemeral.source}' names owner '${ephemeral.workerId}' but durable owner is '${durable.workerId}' at epoch ${durable.attempt}`
    };
  }

  if (ephemeral.attempt !== undefined && ephemeral.attempt < durable.attempt) {
    return {
      authoritative: durable,
      desynchronized: true,
      severity: "STALE",
      reason: `ephemeral source '${ephemeral.source}' trails durable epoch (${ephemeral.attempt} < ${durable.attempt}); discarding stale view`
    };
  }

  return {
    authoritative: durable,
    desynchronized: false,
    severity: "NONE",
    reason: "ephemeral hint agrees with durable ownership"
  };
}

/**
 * CA5 — resolve ownership to the durable record, throwing if the ephemeral hint
 * is IMPOSSIBLE (Redis ahead of Postgres). STALE/CONFLICT are returned without
 * throwing (the caller discards the hint and proceeds on the durable view);
 * IMPOSSIBLE means the two stores genuinely disagree about minted epochs and
 * must fail closed.
 */
export function assertOwnershipResolvesToDurable(
  durable: DurableOwnership | undefined,
  ephemeral: EphemeralOwnershipHint,
  context?: Record<string, unknown>
): OwnershipReconciliation {
  const result = reconcileOwnershipView(durable, ephemeral);
  assertRuntimeInvariant(
    "CA5",
    result.severity !== "IMPOSSIBLE",
    result.reason,
    { ...context, source: ephemeral.source, severity: result.severity }
  );
  return result;
}

/**
 * Convenience: build a `DurableOwnership` from any canonical ownership context
 * (a lease projection). The attempt is the single canonical epoch.
 */
export function ownershipFromCanonical(
  owner: CanonicalOwnershipContext,
  active: boolean
): DurableOwnership {
  return { workerId: owner.workerId, attempt: owner.attempt, active };
}

export { InvariantViolation };
