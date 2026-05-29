/**
 * Retry coordinator + durable store port.
 *
 * retryState.ts answers "is this coordination transition *legal*?" (a property
 * of the table). This module answers "is this caller *authorized* to drive a
 * retry, and *should* it right now?" — the property of retry ownership, policy,
 * and arbitration. It is the single chokepoint through which every re-attempt
 * of an execution must pass: transient-failure retries, crash/lease-loss
 * recovery, and replay re-drives.
 *
 * It exists to make eight classes of distributed-retry defect unrepresentable:
 *
 *   RT1  duplicate retries          — single-flight admission (one active
 *                                     coordination per execution; duplicate
 *                                     scheduler events / queue redeliveries are
 *                                     deduplicated, never double-driven).
 *   RT2  ownership collisions       — exclusive execution ownership keyed on the
 *                                     durable lease epoch; at most one owner may
 *                                     hold RETRY_EXECUTING at a time.
 *   RT3  concurrent recovery        — recovery serialization + a global recovery
 *                                     throttle (bounded concurrent recoveries).
 *   RT4  replay/recovery overlap    — a replay coordination and a recovery
 *                                     coordination for the same execution are
 *                                     mutually exclusive.
 *   RT5  duplicate/replayed attempt — strictly-monotonic attempt admission and
 *                                     legal-only state transitions.
 *   RT6  retry-storm amplification  — per-execution + global sliding-window
 *                                     ceilings; soft breach sheds (BLOCKED),
 *                                     hard breach asserts.
 *   RT7  reconciliation bypass      — an ambiguous side effect routes to
 *                                     RETRY_RECONCILING; no re-dispatch until
 *                                     verified.
 *   RT8  fence bypass               — execution ownership is granted only after
 *                                     the durable fence/lease is validated.
 *
 * Two distinct ownership counters thread through the record, and keeping them
 * separate is what makes the guarantees decidable:
 *
 *   • `attempt`     — the LOGICAL retry attempt (the queue envelope's
 *                     `job.attempt`). It is the single-flight key: two
 *                     deliveries of the same logical attempt are the *same*
 *                     retry and must dedupe (RT1/RT5).
 *   • `ownerEpoch`  — the DURABLE lease epoch (`lease.attempt`). It is the
 *                     execution-ownership key: strictly monotonic per execution
 *                     by construction of the lease store, so two workers can
 *                     never hold the same epoch. Exclusive ownership (RT2) is
 *                     checked against it; a higher epoch legitimately takes
 *                     over (recovery/failover), a lower one is a zombie that
 *                     surrenders.
 *
 * The store's `cas` is the sole atomic transition primitive: read current →
 * check expected state → check ownership → write, with no read-then-write
 * window. In Postgres that is one CTE under a row lock; in memory it is a
 * synchronous critical section (JS is single-threaded, so a function body with
 * no `await` between read and write is atomic). `open` is the create-or-reset
 * primitive that never disturbs a live coordination.
 *
 * Spec: docs/specs/retry-coordination.md
 */

import {
  RECOVERY_SEMANTICS_MAP,
  assertRuntimeInvariant,
  type RuntimeFailureCategory
} from "../canonicalSemantics.js";
import {
  type RetryState,
  assertRetryTransition,
  isRetryActive,
  isRetryTerminal
} from "./retryState.js";

// ─── Record + ownership model ────────────────────────────────────────────────

export type RetryMode = "normal" | "recovery" | "replay";

/** The durable coordination record — one per executionId. */
export interface RetryCoordinationRecord {
  readonly executionId: string;
  readonly state: RetryState;
  /** Logical retry attempt — single-flight key. Strictly monotonic. */
  readonly attempt: number;
  /** Durable lease epoch of the current execution owner (RT2 key). */
  readonly ownerEpoch?: number;
  readonly ownerWorkerId?: string;
  readonly mode: RetryMode;
  /** Present iff this is a replay child (parentExecutionId of the replay). */
  readonly parentExecutionId?: string;
  readonly reason?: string;
  /** ISO timestamp before which the retry must not be dispatched (backoff). */
  readonly scheduledFor?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The authority requesting or holding a coordination. */
export interface RetryClaimant {
  readonly workerId: string;
  /** Logical retry attempt (single-flight key). */
  readonly attempt: number;
  /** Durable lease epoch (execution-ownership key). */
  readonly ownerEpoch?: number;
  readonly mode: RetryMode;
  readonly parentExecutionId?: string;
}

export type RetryOwnership = "monotonic" | "exact" | "none";

/** Which dimension a CAS ownership check compares + restamps. */
export type OwnershipKey = "attempt" | "ownerEpoch";

/** A single compare-and-set transition over the coordination record. */
export interface RetryCasRequest {
  executionId: string;
  /** Current state must equal this. */
  expectedFrom: RetryState;
  to: RetryState;
  claimant: RetryClaimant;
  ownership: RetryOwnership;
  /** Dimension for monotonic/exact ownership + restamp. Default "attempt". */
  ownershipKey?: OwnershipKey;
  /** When true, the claimant becomes the new owner (ownershipKey field + ownerWorkerId + mode restamped). */
  restampOwner?: boolean;
  patch?: {
    reason?: string | undefined;
    scheduledFor?: string | undefined;
    ownerEpoch?: number | undefined;
    mode?: RetryMode | undefined;
  };
}

export type RetryCasOutcome =
  | { outcome: "APPLIED"; record: RetryCoordinationRecord }
  | { outcome: "STALE_STATE"; record: RetryCoordinationRecord }
  | { outcome: "STALE_OWNER"; record: RetryCoordinationRecord }
  | { outcome: "MISSING" };

/**
 * Durable storage for retry coordination records. Implementations MUST
 * guarantee `cas` and `open` are atomic over (state, ownership).
 */
export interface RetryCoordinationStore {
  get(executionId: string): Promise<RetryCoordinationRecord | undefined>;
  /**
   * Create a fresh RETRY_PENDING coordination, or reset a terminal one. A live
   * (active) coordination is NOT disturbed — `opened` is false and the existing
   * record is returned. This is the only way a terminal record re-enters the
   * active set, and it is the single-flight entry gate (RT1).
   */
  open(input: { executionId: string; claimant: RetryClaimant; reason?: string }): Promise<{ opened: boolean; record: RetryCoordinationRecord }>;
  cas(req: RetryCasRequest): Promise<RetryCasOutcome>;
  listActive(): Promise<RetryCoordinationRecord[]>;
}

// ─── Assertions (RT1..RT8) ───────────────────────────────────────────────────

/** RT1 — only one active coordination per execution; a duplicate is dedupe-only. */
export function assertSingleFlight(executionId: string, condition: boolean, detail: string, context?: Record<string, unknown>): void {
  assertRuntimeInvariant("RT1", condition, `single-flight violated for '${executionId}': ${detail}`, { executionId, ...context });
}

/** RT2 — at most one owner epoch may hold RETRY_EXECUTING. */
export function assertExclusiveOwnership(executionId: string, condition: boolean, detail: string, context?: Record<string, unknown>): void {
  assertRuntimeInvariant("RT2", condition, `exclusive retry ownership violated for '${executionId}': ${detail}`, { executionId, ...context });
}

/** RT3 — recovery is serialized + throttled. */
export function assertRecoverySerialized(executionId: string, condition: boolean, detail: string, context?: Record<string, unknown>): void {
  assertRuntimeInvariant("RT3", condition, `recovery serialization violated for '${executionId}': ${detail}`, { executionId, ...context });
}

/** RT4 — replay and recovery never overlap for the same execution. */
export function assertNoReplayRecoveryOverlap(executionId: string, condition: boolean, detail: string, context?: Record<string, unknown>): void {
  assertRuntimeInvariant("RT4", condition, `replay/recovery overlap for '${executionId}': ${detail}`, { executionId, ...context });
}

/** RT5 — retry attempts are strictly monotonic; no duplicate/replayed attempt drives. */
export function assertAttemptMonotonic(executionId: string, condition: boolean, detail: string, context?: Record<string, unknown>): void {
  assertRuntimeInvariant("RT5", condition, `retry attempt monotonicity violated for '${executionId}': ${detail}`, { executionId, ...context });
}

/** RT6 — retry storm amplification is bounded. */
export function assertStormBounded(executionId: string, condition: boolean, detail: string, context?: Record<string, unknown>): void {
  assertRuntimeInvariant("RT6", condition, `retry storm amplification for '${executionId}': ${detail}`, { executionId, ...context });
}

/** RT7 — retries cannot bypass reconciliation. */
export function assertReconciliationNotBypassed(executionId: string, condition: boolean, detail: string, context?: Record<string, unknown>): void {
  assertRuntimeInvariant("RT7", condition, `reconciliation bypass for '${executionId}': ${detail}`, { executionId, ...context });
}

/** RT8 — retries cannot bypass fence validation. */
export function assertFenceValidatedBeforeOwnership(executionId: string, condition: boolean, detail: string, context?: Record<string, unknown>): void {
  assertRuntimeInvariant("RT8", condition, `fence-validation bypass for '${executionId}': ${detail}`, { executionId, ...context });
}

// ─── Decision result types ───────────────────────────────────────────────────

export type RetryDecision =
  /** Proceed: enqueue the retry after `effectiveBackoffMs`. */
  | "ADMITTED"
  /** A duplicate — another coordination already owns this attempt. Do not enqueue. */
  | "DEDUPED"
  /** Backpressure / soft storm — re-enqueue with extended delay (shed, not drop). */
  | "BLOCKED"
  /** Non-retryable / exhausted / hard-stop — escalate to dead-letter. */
  | "ABORTED"
  /** Ambiguous side effect — route through reconciliation before any re-attempt. */
  | "RECONCILE_REQUIRED";

export interface RetryRequestInput {
  executionId: string;
  requesterWorkerId: string;
  /** Logical retry attempt being requested (queue envelope job.attempt). */
  attempt: number;
  failureType?: RuntimeFailureCategory;
  mode?: RetryMode;
  parentExecutionId?: string;
  /** Caller's computed backoff; the coordinator may extend it under backpressure. */
  backoffMs?: number;
  /** True if the ambiguity that caused this failure has already been reconciled. */
  reconciled?: boolean;
}

export interface RetryRequestResult {
  decision: RetryDecision;
  record?: RetryCoordinationRecord;
  effectiveBackoffMs: number;
  reason: string;
}

export type ClaimOutcome = "OWNED" | "STALE" | "FENCED" | "RECONCILE_REQUIRED";

export interface ClaimExecutionInput {
  executionId: string;
  workerId: string;
  /** Durable lease epoch (lease.attempt) — the exclusive-ownership key. */
  ownerEpoch: number;
  mode?: RetryMode;
  parentExecutionId?: string;
  /** Validates the durable fence/lease BEFORE ownership is granted (RT8). */
  validateFence?: () => Promise<boolean>;
}

export interface ClaimExecutionResult {
  outcome: ClaimOutcome;
  record?: RetryCoordinationRecord;
}

export type RecoveryDecision = "ADMITTED" | "ALREADY_OWNED" | "THROTTLED" | "BLOCKED";

export interface RecoveryRequestInput {
  executionId: string;
  recoveryWorkerId: string;
  /** Durable lease epoch of the recovery takeover. */
  ownerEpoch: number;
  /** True if a replay child of this execution is currently active. */
  replayActive?: boolean;
}

export interface RecoveryRequestResult {
  decision: RecoveryDecision;
  record?: RetryCoordinationRecord;
  /** Release the recovery throttle slot. No-op unless decision === ADMITTED. */
  release: () => void;
  reason: string;
}

export interface ReconcileResolution {
  verdict: "NOT_COMMITTED" | "COMMITTED" | "ABANDONED";
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface RetryCoordinatorConfig {
  /** Max simultaneous in-flight recoveries across all executions (RT3 throttle). */
  maxConcurrentRecoveries: number;
  /** Max in-flight retries (SCHEDULED+EXECUTING) before backpressure sheds. */
  maxInFlightRetries: number;
  /** Per-execution storm window. */
  stormWindowMs: number;
  /** Per-execution admissions/window above which retries are shed (BLOCKED). */
  stormSoftLimit: number;
  /** Per-execution admissions/window above which RT6 asserts (amplification bug). */
  stormHardLimit: number;
  /** Global storm window. */
  globalStormWindowMs: number;
  /** Global admissions/window above which retries are shed. */
  globalStormSoftLimit: number;
  /** Multiplier applied to backoff when a retry is shed under backpressure. */
  blockedBackoffFactor: number;
  /** Floor backoff (ms) applied to a shed retry. */
  blockedBackoffFloorMs: number;
}

export const DEFAULT_RETRY_COORDINATOR_CONFIG: RetryCoordinatorConfig = {
  maxConcurrentRecoveries: 8,
  maxInFlightRetries: 1024,
  stormWindowMs: 60_000,
  stormSoftLimit: 8,
  stormHardLimit: 64,
  globalStormWindowMs: 1_000,
  globalStormSoftLimit: 2_000,
  blockedBackoffFactor: 4,
  blockedBackoffFloorMs: 1_000
};

interface StormWindow {
  windowStart: number;
  count: number;
}

export interface RetryCoordinatorOptions {
  clock?: { now(): Date };
  config?: Partial<RetryCoordinatorConfig>;
}

// ─── Coordinator ─────────────────────────────────────────────────────────────

export class RetryCoordinator {
  private readonly now: () => Date;
  private readonly config: RetryCoordinatorConfig;
  private recoverySlots = 0;
  private readonly perExecWindows = new Map<string, StormWindow>();
  private globalWindow: StormWindow = { windowStart: 0, count: 0 };

  constructor(
    private readonly store: RetryCoordinationStore,
    opts: RetryCoordinatorOptions = {}
  ) {
    this.now = opts.clock ? () => opts.clock!.now() : () => new Date();
    this.config = { ...DEFAULT_RETRY_COORDINATOR_CONFIG, ...(opts.config ?? {}) };
  }

  getConfig(): Readonly<RetryCoordinatorConfig> {
    return this.config;
  }

  inFlightRecoveries(): number {
    return this.recoverySlots;
  }

  async get(executionId: string): Promise<RetryCoordinationRecord | undefined> {
    return this.store.get(executionId);
  }

  /**
   * Single-flight admission gate — the point at which a retry is *born*. Returns
   * ADMITTED (enqueue), DEDUPED (drop — a duplicate), BLOCKED (shed via delay),
   * ABORTED (dead-letter), or RECONCILE_REQUIRED (route to reconciliation).
   */
  async requestRetry(input: RetryRequestInput): Promise<RetryRequestResult> {
    const mode = input.mode ?? "normal";
    const backoff = input.backoffMs ?? 0;

    // ── RT5 — attempt must be a positive integer. ──
    assertAttemptMonotonic(
      input.executionId,
      Number.isInteger(input.attempt) && input.attempt > 0,
      `requested attempt ${input.attempt} is not a positive integer`,
      { attempt: input.attempt }
    );

    // ── Legality (RT7 + recovery policy). ──
    if (input.failureType) {
      const sem = RECOVERY_SEMANTICS_MAP[input.failureType];
      const isAmbiguous =
        input.failureType === "AMBIGUOUS_EXTERNAL_COMMIT" || input.failureType === "TOOL_NON_IDEMPOTENT";
      if (isAmbiguous && !input.reconciled) {
        await this.routeToReconciling(input.executionId, input.requesterWorkerId, input.attempt, mode, input.parentExecutionId);
        return { decision: "RECONCILE_REQUIRED", effectiveBackoffMs: backoff, reason: `failure '${input.failureType}' requires reconciliation before retry` };
      }
      if (sem && sem.retryable === false && sem.replayable === false) {
        await this.abortInternal(input.executionId, `non-retryable failure '${input.failureType}'`, input.requesterWorkerId, input.attempt);
        return { decision: "ABORTED", effectiveBackoffMs: backoff, reason: `failure '${input.failureType}' is non-retryable` };
      }
    }

    // ── Storm guard (RT6). ──
    const storm = this.chargeStorm(input.executionId);
    if (storm === "HARD") {
      assertStormBounded(
        input.executionId,
        false,
        `per-execution retries exceeded hard ceiling ${this.config.stormHardLimit} within ${this.config.stormWindowMs}ms`,
        { stormHardLimit: this.config.stormHardLimit }
      );
    }
    if (storm === "SOFT") {
      await this.blockInternal(input.executionId, input.requesterWorkerId, input.attempt, mode, "storm-shed", input.parentExecutionId);
      return { decision: "BLOCKED", effectiveBackoffMs: this.shedBackoff(backoff), reason: "retry storm — shed via extended backoff" };
    }

    // ── Backpressure. ──
    const inFlight = await this.countInFlight();
    if (inFlight >= this.config.maxInFlightRetries) {
      await this.blockInternal(input.executionId, input.requesterWorkerId, input.attempt, mode, "backpressure", input.parentExecutionId);
      return { decision: "BLOCKED", effectiveBackoffMs: this.shedBackoff(backoff), reason: `retry backpressure — ${inFlight} in flight >= ${this.config.maxInFlightRetries}` };
    }

    // ── Single-flight admission (RT1/RT4/RT5). Storm + backpressure were
    // charged exactly once above; resolution loops here without re-charging. ──
    return this.resolveSingleFlight(input, mode, backoff);
  }

  /**
   * The single-flight resolution loop. One CAS per turn, re-reading on every
   * contended write, bounded so a pathological race can never spin forever.
   * Deliberately does NOT re-enter requestRetry, so the storm/backpressure
   * windows are charged exactly once per external request.
   */
  private async resolveSingleFlight(input: RetryRequestInput, mode: RetryMode, backoff: number): Promise<RetryRequestResult> {
    for (let turn = 0; turn < 8; turn++) {
      const existing = await this.store.get(input.executionId);

      if (!existing || isRetryTerminal(existing.state)) {
        await this.store.open({
          executionId: input.executionId,
          claimant: { workerId: input.requesterWorkerId, attempt: input.attempt, mode, ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {}) },
          reason: "retry-requested"
        });
        continue; // re-read; the opener (us or a racer) is now active
      }

      // RT4 — replay/recovery overlap.
      if (isRetryActive(existing.state)) {
        assertNoReplayRecoveryOverlap(
          input.executionId,
          !(existing.mode === "replay" && mode === "recovery") && !(existing.mode === "recovery" && mode === "replay"),
          `requested mode '${mode}' conflicts with active coordination mode '${existing.mode}'`,
          { existingMode: existing.mode, requestedMode: mode }
        );
      }

      if (input.attempt < existing.attempt) {
        return { decision: "DEDUPED", record: existing, effectiveBackoffMs: backoff, reason: `attempt ${input.attempt} < live ${existing.attempt} — superseded` };
      }

      if (input.attempt === existing.attempt) {
        if (existing.state === "RETRY_PENDING" || existing.state === "RETRY_BLOCKED") {
          const r = await this.tryAdmit(input, mode, backoff, existing.state);
          if (r) return r;
          continue;
        }
        // SCHEDULED / EXECUTING / RECONCILING at the same logical attempt — a
        // duplicate scheduler event or queue redelivery. Single-flight dedupes.
        return { decision: "DEDUPED", record: existing, effectiveBackoffMs: backoff, reason: `attempt ${input.attempt} already coordinating in ${existing.state}` };
      }

      // input.attempt > existing.attempt — a genuinely newer attempt.
      if (existing.state === "RETRY_RECONCILING") {
        // RT7 — never supersede a reconciling coordination with a blind retry.
        return { decision: "RECONCILE_REQUIRED", record: existing, effectiveBackoffMs: backoff, reason: "coordination is reconciling — retry must wait for resolution" };
      }
      const r = await this.tryAdmit(input, mode, backoff, existing.state);
      if (r) return r;
    }
    // Gave up after bounded turns — treat as a duplicate to stay safe (never double-drive).
    const rec = await this.store.get(input.executionId);
    return { decision: "DEDUPED", ...(rec ? { record: rec } : {}), effectiveBackoffMs: backoff, reason: "admission contended out — treated as duplicate" };
  }

  /**
   * Attempt to drive the coordination to RETRY_SCHEDULED for `input.attempt`,
   * normalising through RETRY_PENDING when the current state cannot reach
   * SCHEDULED directly (EXECUTING/BLOCKED). Returns a terminal decision, or
   * `undefined` to signal the caller should re-read and loop (a lost race).
   */
  private async tryAdmit(
    input: RetryRequestInput,
    mode: RetryMode,
    backoff: number,
    fromState: RetryState
  ): Promise<RetryRequestResult | undefined> {
    const claimant: RetryClaimant = {
      workerId: input.requesterWorkerId,
      attempt: input.attempt,
      mode,
      ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {})
    };

    let from = fromState;
    if (from === "RETRY_EXECUTING" || from === "RETRY_BLOCKED") {
      const step = await this.store.cas({
        executionId: input.executionId,
        expectedFrom: from,
        to: "RETRY_PENDING",
        claimant,
        ownership: "monotonic",
        ownershipKey: "attempt",
        restampOwner: true,
        patch: { reason: "re-pending" }
      });
      if (step.outcome === "STALE_OWNER") {
        return { decision: "DEDUPED", record: step.record, effectiveBackoffMs: backoff, reason: "admission lost to a newer attempt" };
      }
      if (step.outcome !== "APPLIED") {
        return undefined; // lost the race — loop and re-read
      }
      from = "RETRY_PENDING";
    }

    const scheduledFor = backoff > 0 ? new Date(this.now().getTime() + backoff).toISOString() : undefined;
    const out = await this.store.cas({
      executionId: input.executionId,
      expectedFrom: from,
      to: "RETRY_SCHEDULED",
      claimant,
      ownership: "monotonic",
      ownershipKey: "attempt",
      restampOwner: true,
      patch: { reason: "admitted", mode, ...(scheduledFor ? { scheduledFor } : {}) }
    });
    if (out.outcome === "APPLIED") {
      return { decision: "ADMITTED", record: out.record, effectiveBackoffMs: backoff, reason: "admitted" };
    }
    if (out.outcome === "STALE_OWNER") {
      return { decision: "DEDUPED", record: out.record, effectiveBackoffMs: backoff, reason: "admission lost to a newer attempt" };
    }
    return undefined; // STALE_STATE / MISSING — loop and re-read
  }

  /**
   * Exclusive execution-ownership gate (RT2 + RT8). A worker calls this after
   * acquiring the durable lease, BEFORE re-driving the execution. Ownership is
   * keyed on the durable lease epoch (`ownerEpoch`): a higher epoch legitimately
   * takes over, a lower one is a zombie that surrenders.
   */
  async claimExecution(input: ClaimExecutionInput): Promise<ClaimExecutionResult> {
    const mode = input.mode ?? "normal";

    assertAttemptMonotonic(
      input.executionId,
      Number.isInteger(input.ownerEpoch) && input.ownerEpoch > 0,
      `owner epoch ${input.ownerEpoch} is not a positive integer`,
      { ownerEpoch: input.ownerEpoch }
    );

    // RT8 — validate the durable fence/lease BEFORE granting ownership.
    if (input.validateFence) {
      const ok = await input.validateFence();
      if (!ok) {
        const rec = await this.store.get(input.executionId);
        return { outcome: "FENCED", ...(rec ? { record: rec } : {}) };
      }
    }

    const mkClaimant = (attempt: number): RetryClaimant => ({
      workerId: input.workerId,
      attempt,
      ownerEpoch: input.ownerEpoch,
      mode,
      ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {})
    });

    // Drive the coordination toward RETRY_EXECUTING through legal steps, one CAS
    // per loop turn, re-reading on every contended write. Bounded so a pathological
    // race can never spin forever.
    for (let step = 0; step < 8; step++) {
      const cur = await this.store.get(input.executionId);

      if (!cur || isRetryTerminal(cur.state)) {
        await this.store.open({ executionId: input.executionId, claimant: mkClaimant(cur ? cur.attempt : 1), reason: "claim-bootstrap" });
        continue;
      }

      // RT7 — cannot seize execution from a reconciling coordination.
      if (cur.state === "RETRY_RECONCILING") {
        return { outcome: "RECONCILE_REQUIRED", record: cur };
      }

      // RT4 — replay cannot seize a recovery coordination (and vice versa).
      assertNoReplayRecoveryOverlap(
        input.executionId,
        !(cur.mode === "replay" && mode === "recovery") && !(cur.mode === "recovery" && mode === "replay"),
        `claim mode '${mode}' conflicts with active coordination mode '${cur.mode}'`,
        { existingMode: cur.mode, claimMode: mode }
      );

      if (cur.state === "RETRY_EXECUTING") {
        if (cur.ownerEpoch !== undefined && input.ownerEpoch < cur.ownerEpoch) {
          // RT2 — a strictly-lower epoch is a zombie; surrender.
          return { outcome: "STALE", record: cur };
        }
        if (cur.ownerEpoch === input.ownerEpoch) {
          if (cur.ownerWorkerId === input.workerId) {
            return { outcome: "OWNED", record: cur }; // already ours
          }
          // Two distinct workers at the IDENTICAL durable epoch — impossible if
          // the lease store is monotonic. Surface the corruption.
          assertExclusiveOwnership(
            input.executionId,
            false,
            `worker '${input.workerId}' and '${cur.ownerWorkerId}' both claim epoch ${input.ownerEpoch}`,
            { ownerEpoch: input.ownerEpoch }
          );
        }
        // A strictly-higher epoch legitimately takes over (failover/recovery).
        const out = await this.store.cas({
          executionId: input.executionId,
          expectedFrom: "RETRY_EXECUTING",
          to: "RETRY_EXECUTING",
          claimant: mkClaimant(cur.attempt),
          ownership: "monotonic",
          ownershipKey: "ownerEpoch",
          restampOwner: true,
          patch: { mode, ownerEpoch: input.ownerEpoch, reason: "executing-takeover" }
        });
        if (out.outcome === "APPLIED") return { outcome: "OWNED", record: out.record };
        if (out.outcome === "STALE_OWNER") return { outcome: "STALE", record: out.record };
        continue; // STALE_STATE / MISSING — re-read.
      }

      // PENDING/SCHEDULED/BLOCKED — step legally toward EXECUTING.
      const to: RetryState =
        cur.state === "RETRY_SCHEDULED" ? "RETRY_EXECUTING" : cur.state === "RETRY_PENDING" ? "RETRY_SCHEDULED" : "RETRY_PENDING"; // BLOCKED → PENDING
      const out = await this.store.cas({
        executionId: input.executionId,
        expectedFrom: cur.state,
        to,
        claimant: mkClaimant(cur.attempt),
        ownership: "monotonic",
        ownershipKey: "ownerEpoch",
        restampOwner: true,
        patch: { mode, ownerEpoch: input.ownerEpoch, reason: to === "RETRY_EXECUTING" ? "executing" : "claim-advance" }
      });
      if (out.outcome === "STALE_OWNER") return { outcome: "STALE", record: out.record };
      if (out.outcome === "APPLIED" && out.record.state === "RETRY_EXECUTING") {
        assertFenceValidatedBeforeOwnership(
          input.executionId,
          out.record.state === "RETRY_EXECUTING",
          "ownership granted without reaching RETRY_EXECUTING",
          { state: out.record.state }
        );
        return { outcome: "OWNED", record: out.record };
      }
      // APPLIED (intermediate) or STALE_STATE — loop and re-read.
    }

    const rec = await this.store.get(input.executionId);
    return { outcome: "STALE", ...(rec ? { record: rec } : {}) };
  }

  /**
   * Recovery serialization + throttle gate (RT3 + RT4). The scheduler's
   * recovery loop calls this before taking over a reclaimed lease.
   */
  async requestRecovery(input: RecoveryRequestInput): Promise<RecoveryRequestResult> {
    const noop = () => undefined;

    assertAttemptMonotonic(
      input.executionId,
      Number.isInteger(input.ownerEpoch) && input.ownerEpoch > 0,
      `recovery owner epoch ${input.ownerEpoch} is not a positive integer`,
      { ownerEpoch: input.ownerEpoch }
    );

    // RT4 — never recover an execution whose replay child is active.
    if (input.replayActive) {
      return { decision: "BLOCKED", release: noop, reason: "replay active — recovery would overlap replay (RT4)" };
    }

    const existing = await this.store.get(input.executionId);

    // RT4 — an active replay coordination blocks recovery.
    if (existing && isRetryActive(existing.state) && existing.mode === "replay") {
      assertNoReplayRecoveryOverlap(input.executionId, false, "recovery requested while a replay coordination is active", { existingMode: existing.mode });
    }

    // RT3 — serialize: a recovery already owns this execution at >= epoch.
    if (
      existing &&
      isRetryActive(existing.state) &&
      existing.mode === "recovery" &&
      existing.ownerEpoch !== undefined &&
      existing.ownerEpoch >= input.ownerEpoch
    ) {
      return { decision: "ALREADY_OWNED", record: existing, release: noop, reason: "recovery already owned by an equal-or-newer epoch" };
    }

    // RT3 — global throttle. The ceiling check and the slot reserve MUST be a
    // single synchronous critical section: there is no `await` between them, so
    // under the single-threaded event loop no concurrent recovery can slip
    // through the gate after the check but before the increment. (An earlier
    // design incremented only after the claim CAS, which leaked the gate under
    // a burst.)
    if (this.recoverySlots >= this.config.maxConcurrentRecoveries) {
      return { decision: "THROTTLED", release: noop, reason: `recovery throttle — ${this.recoverySlots} >= ${this.config.maxConcurrentRecoveries}` };
    }
    this.recoverySlots += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.recoverySlots = Math.max(0, this.recoverySlots - 1);
    };

    // RT3 — defensive: the reserve can never exceed the ceiling.
    assertRecoverySerialized(
      input.executionId,
      this.recoverySlots <= this.config.maxConcurrentRecoveries,
      `concurrent recovery count ${this.recoverySlots} exceeded ceiling ${this.config.maxConcurrentRecoveries}`,
      { recoverySlots: this.recoverySlots }
    );

    try {
      const claimant: RetryClaimant = { workerId: input.recoveryWorkerId, attempt: existing ? existing.attempt : 1, ownerEpoch: input.ownerEpoch, mode: "recovery" };

      if (!existing || isRetryTerminal(existing.state)) {
        await this.store.open({ executionId: input.executionId, claimant, reason: "recovery-open" });
      }
      const fresh = await this.store.get(input.executionId);
      const fromState: RetryState = fresh && isRetryActive(fresh.state) ? fresh.state : "RETRY_PENDING";

      // EXECUTING/BLOCKED cannot go straight to SCHEDULED; step via PENDING.
      let from = fromState;
      if (from === "RETRY_EXECUTING" || from === "RETRY_BLOCKED") {
        const step = await this.store.cas({
          executionId: input.executionId,
          expectedFrom: from,
          to: "RETRY_PENDING",
          claimant,
          ownership: "monotonic",
          ownershipKey: "ownerEpoch",
          restampOwner: true,
          patch: { mode: "recovery", ownerEpoch: input.ownerEpoch, reason: "recovery-pending" }
        });
        if (step.outcome === "STALE_OWNER") {
          release();
          return { decision: "ALREADY_OWNED", record: step.record, release: noop, reason: "recovery claim lost to a newer epoch" };
        }
        if (step.outcome !== "APPLIED") {
          release();
          return { decision: "BLOCKED", release: noop, reason: "recovery claim CAS failed — retry next sweep" };
        }
        from = "RETRY_PENDING";
      } else if (from === "RETRY_RECONCILING") {
        // RT7 — recovery cannot bypass an active reconciliation.
        release();
        return { decision: "BLOCKED", ...(fresh ? { record: fresh } : {}), release: noop, reason: "coordination is reconciling — recovery must wait" };
      }

      const out = await this.store.cas({
        executionId: input.executionId,
        expectedFrom: from,
        to: "RETRY_SCHEDULED",
        claimant,
        ownership: "monotonic",
        ownershipKey: "ownerEpoch",
        restampOwner: true,
        patch: { mode: "recovery", ownerEpoch: input.ownerEpoch, reason: "recovery-claim" }
      });

      if (out.outcome === "STALE_OWNER") {
        release();
        return { decision: "ALREADY_OWNED", record: out.record, release: noop, reason: "recovery claim lost to a newer epoch" };
      }
      if (out.outcome !== "APPLIED") {
        release();
        return { decision: "BLOCKED", release: noop, reason: "recovery claim CAS failed — retry next sweep" };
      }

      return { decision: "ADMITTED", record: out.record, release, reason: "recovery admitted" };
    } catch (err) {
      release();
      throw err;
    }
  }

  /**
   * Resolve a reconciling coordination — the single gate out of
   * RETRY_RECONCILING. NOT_COMMITTED → PENDING (safe to retry); COMMITTED →
   * SETTLED (outcome stands); ABANDONED → ABORTED (human/DLQ).
   */
  async resolveReconciliation(
    executionId: string,
    workerId: string,
    attempt: number,
    resolution: ReconcileResolution
  ): Promise<RetryCoordinationRecord | undefined> {
    const to: RetryState =
      resolution.verdict === "NOT_COMMITTED" ? "RETRY_PENDING" : resolution.verdict === "COMMITTED" ? "RETRY_SETTLED" : "RETRY_ABORTED";
    const out = await this.store.cas({
      executionId,
      expectedFrom: "RETRY_RECONCILING",
      to,
      claimant: { workerId, attempt, mode: "recovery" },
      ownership: "monotonic",
      ownershipKey: "attempt",
      restampOwner: true,
      patch: { reason: `reconciled:${resolution.verdict}` }
    });
    return out.outcome === "APPLIED" ? out.record : "record" in out ? out.record : undefined;
  }

  /**
   * Quarantine a coordination behind reconciliation (RT7). Called when an
   * ambiguous external side effect is detected mid-execution: no further
   * re-attempt may proceed until resolveReconciliation verifies the true
   * external outcome.
   */
  async enterReconciliation(executionId: string, workerId: string, attempt: number, mode: RetryMode = "normal"): Promise<void> {
    await this.routeToReconciling(executionId, workerId, attempt, mode);
  }

  /** Terminal — the execution reached a durable terminal outcome. */
  async settle(executionId: string, workerId: string, attempt: number): Promise<void> {
    const existing = await this.store.get(executionId);
    if (!existing || isRetryTerminal(existing.state)) return;
    await this.store.cas({
      executionId,
      expectedFrom: existing.state,
      to: "RETRY_SETTLED",
      claimant: { workerId, attempt, mode: existing.mode },
      ownership: "monotonic",
      ownershipKey: "attempt",
      restampOwner: false,
      patch: { reason: "settled" }
    });
  }

  /** Terminal — the retry was abandoned (exhausted/cancelled/non-retryable). */
  async abort(executionId: string, reason: string, workerId = "system", attempt?: number): Promise<void> {
    await this.abortInternal(executionId, reason, workerId, attempt);
  }

  // ── internals ──

  private async abortInternal(executionId: string, reason: string, workerId = "system", attempt?: number): Promise<void> {
    let existing = await this.store.get(executionId);
    if (existing && isRetryTerminal(existing.state)) return;
    if (!existing) {
      // Persist a durable ABORTED trace even for a never-coordinated execution
      // (e.g. a non-retryable first failure), so later duplicates see a terminal.
      const opened = await this.store.open({
        executionId,
        claimant: { workerId, attempt: attempt ?? 1, mode: "normal" },
        reason
      });
      existing = opened.record;
    }
    await this.store.cas({
      executionId,
      expectedFrom: existing.state,
      to: "RETRY_ABORTED",
      claimant: { workerId, attempt: attempt ?? existing.attempt, mode: existing.mode },
      ownership: "monotonic",
      ownershipKey: "attempt",
      restampOwner: false,
      patch: { reason }
    });
  }

  private async routeToReconciling(
    executionId: string,
    workerId: string,
    attempt: number,
    mode: RetryMode,
    parentExecutionId?: string
  ): Promise<void> {
    const claimant: RetryClaimant = { workerId, attempt, mode, ...(parentExecutionId ? { parentExecutionId } : {}) };
    let existing = await this.store.get(executionId);
    if (existing && isRetryTerminal(existing.state)) return;
    if (!existing) {
      const opened = await this.store.open({ executionId, claimant, reason: "ambiguous-effect-quarantine" });
      existing = opened.record;
    }
    // PENDING/BLOCKED/SCHEDULED/EXECUTING → RECONCILING are all legal.
    await this.store.cas({
      executionId,
      expectedFrom: existing.state,
      to: "RETRY_RECONCILING",
      claimant,
      ownership: "monotonic",
      ownershipKey: "attempt",
      restampOwner: true,
      patch: { reason: "ambiguous-effect-quarantine", mode }
    });
  }

  private async blockInternal(
    executionId: string,
    workerId: string,
    attempt: number,
    mode: RetryMode,
    reason: string,
    parentExecutionId?: string
  ): Promise<void> {
    const claimant: RetryClaimant = { workerId, attempt, mode, ...(parentExecutionId ? { parentExecutionId } : {}) };
    let existing = await this.store.get(executionId);
    if (existing && isRetryTerminal(existing.state)) return;
    if (!existing) {
      const opened = await this.store.open({ executionId, claimant, reason });
      existing = opened.record;
    }
    if (existing.state === "RETRY_RECONCILING") return; // never downgrade a reconcile to blocked
    await this.store.cas({
      executionId,
      expectedFrom: existing.state,
      to: "RETRY_BLOCKED",
      claimant,
      ownership: "monotonic",
      ownershipKey: "attempt",
      restampOwner: true,
      patch: { reason, mode }
    });
  }

  private async countInFlight(): Promise<number> {
    const active = await this.store.listActive();
    return active.filter((r) => r.state === "RETRY_SCHEDULED" || r.state === "RETRY_EXECUTING").length;
  }

  private shedBackoff(backoff: number): number {
    return Math.max(this.config.blockedBackoffFloorMs, backoff * this.config.blockedBackoffFactor);
  }

  /** Charge the per-execution + global storm windows. Returns the breach tier. */
  private chargeStorm(executionId: string): "OK" | "SOFT" | "HARD" {
    const now = this.now().getTime();

    if (now - this.globalWindow.windowStart >= this.config.globalStormWindowMs) {
      this.globalWindow = { windowStart: now, count: 0 };
    }
    this.globalWindow.count += 1;

    let win = this.perExecWindows.get(executionId);
    if (!win || now - win.windowStart >= this.config.stormWindowMs) {
      win = { windowStart: now, count: 0 };
      this.perExecWindows.set(executionId, win);
    }
    win.count += 1;

    if (win.count > this.config.stormHardLimit) return "HARD";
    if (win.count > this.config.stormSoftLimit) return "SOFT";
    if (this.globalWindow.count > this.config.globalStormSoftLimit) return "SOFT";
    return "OK";
  }
}

/** Re-export the transition assertion for callers that drive the store directly. */
export { assertRetryTransition, isRetryActive, isRetryTerminal };
