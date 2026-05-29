/**
 * Fence protocol orchestrator + durable store port.
 *
 * fenceState.ts answers "is this transition *legal*?" (a property of the
 * table). This module answers "is this caller *authorized* to perform it?"
 * (a property of lease ownership) and wires the two together into a small set
 * of lifecycle operations the runtime calls:
 *
 *     reserveOrResolve → beginSideEffect → commit | fail | markAmbiguous
 *                        beginReconciliation → resolveReconciliation
 *                        expire / reopen
 *
 * Every mutation goes through FenceStore.transition, a compare-and-set that
 * atomically checks BOTH the expected from-state AND the claimant's ownership
 * before writing. That single atomic primitive is what makes the protocol
 * "transactionally enforceable":
 *
 *   • F1  A durable PENDING/EXECUTING fence exists before any side effect.
 *   • F2  A side effect requires a committed ownership context.
 *   • F3  A committed/reconciled fence is absorbing — no duplicate effect.
 *   • F4  A stale lease holder's transition is rejected, never applied.
 *   • F5  Only legal transitions are admitted (assertFenceTransition).
 *   • F6  Replay/retry resolve through the fence and never bypass a commit.
 *
 * Ownership model (claimant = { workerId, attempt }):
 *   • "exact"     claimant.attempt === fence.leaseAttempt. Used for COMMIT and
 *                 FAIL — only the worker that *began* the in-flight call may
 *                 record its outcome.
 *   • "monotonic" claimant.attempt >= fence.leaseAttempt. Used for BEGIN,
 *                 RECLAIM, AMBIGUATE, RECONCILE-claim, EXPIRE — a newer owner
 *                 may take over an abandoned fence; a strictly older one (a
 *                 zombie) is always rejected.
 *
 * Spec: docs/specs/fence-state-machine.md
 */

import {
  InvariantViolation,
  assertRuntimeInvariant,
  assertCanonicalOwnershipConsistency
} from "../canonicalSemantics.js";
import {
  type FenceState,
  assertFenceTransition,
  isFenceTerminal,
  FENCE_RESTARTABLE_TERMINALS
} from "./fenceState.js";

/** The authority that owns (or wants to own) a fence. */
export interface FenceOwner {
  readonly workerId: string;
  /** The lease attempt token. Positive, monotonic per execution. */
  readonly attempt: number;
  readonly leaseEpoch?: number;
  readonly lease_epoch?: number;
  readonly fencingToken?: number;
  readonly fencing_token?: number;
  readonly ownershipVersion?: number;
  readonly ownership_version?: number;
  readonly workerIdentity?: string;
  readonly worker_identity?: string;
}

/** Definitive resolution recorded when a fence reaches a terminal state. */
export type FenceResolution = "COMMITTED" | "FAILED" | "ABANDONED";

/** The durable fence record — one per (executionId, stepSeq). */
export interface FenceRecord {
  /** Stable identity. By construction == idempotencyKey == sha256(executionId:stepSeq). */
  readonly fenceId: string;
  readonly executionId: string;
  readonly stepSeq: number;
  readonly tenantId: string;
  readonly toolName: string;
  readonly idempotencyKey: string;
  /** sha256(canonical_json(args)) recorded at reserve. Drift ⇒ replay divergence. */
  readonly argsHash: string;
  readonly state: FenceState;
  /** Worker currently responsible for the fence. */
  readonly ownerWorkerId: string;
  /** Lease attempt that owns the fence. */
  readonly leaseAttempt: number;
  readonly leaseEpoch?: number;
  readonly lease_epoch?: number;
  readonly fencingToken?: number;
  readonly fencing_token?: number;
  readonly ownershipVersion?: number;
  readonly ownership_version?: number;
  readonly workerIdentity?: string;
  readonly worker_identity?: string;
  readonly output?: Record<string, unknown>;
  readonly error?: string;
  /** Set when the fence settles via reconciliation (state === RECONCILED/FAILED/EXPIRED). */
  readonly resolution?: FenceResolution;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FenceReserveInput {
  fenceId: string;
  executionId: string;
  stepSeq: number;
  tenantId: string;
  toolName: string;
  idempotencyKey: string;
  argsHash: string;
  owner: FenceOwner;
}

export type OwnershipMode = "exact" | "monotonic" | "none";

/**
 * A single compare-and-set transition. The store applies it atomically:
 * read current → check state === expectedFrom → check ownership → write.
 * No read-then-write window is permitted; in Postgres this is one CTE
 * statement under a row lock, in memory it is a synchronous critical section.
 */
export interface FenceTransitionRequest {
  fenceId: string;
  expectedFrom: FenceState;
  to: FenceState;
  claimant: FenceOwner;
  ownership: OwnershipMode;
  /** When true, the claimant becomes the new owner (leaseAttempt/ownerWorkerId restamped). */
  restampOwner?: boolean;
  /**
   * Fields to write alongside the state change. A key that is *present* (even
   * with an explicit `undefined`) is applied — `undefined` is an explicit
   * clear, used by reopen to wipe a prior outcome. The `| undefined` unions
   * are intentional: they let callers pass an explicit clear under
   * `exactOptionalPropertyTypes`.
   */
  patch?: {
    output?: Record<string, unknown> | undefined;
    error?: string | undefined;
    resolution?: FenceResolution | undefined;
    argsHash?: string | undefined;
  };
}

export type FenceTransitionOutcome =
  /** Transition applied; `record` is the new state. */
  | { outcome: "APPLIED"; record: FenceRecord }
  /** Current state != expectedFrom — a concurrent writer won the race. */
  | { outcome: "STALE_STATE"; record: FenceRecord }
  /** Claimant failed the ownership check — a stale/zombie worker. */
  | { outcome: "STALE_OWNER"; record: FenceRecord }
  /** No fence exists for fenceId. */
  | { outcome: "MISSING" };

/**
 * Durable storage for fence records. Implementations MUST guarantee:
 *   • reserve() is atomic insert-if-absent.
 *   • transition() is an atomic compare-and-set over (state, ownership).
 *   • getByStep() resolves the fence for a logical step regardless of how the
 *     id was derived (used by replay/recovery).
 */
export interface FenceStore {
  /** Atomically create a PENDING fence if absent. Returns the live record either way. */
  reserve(input: FenceReserveInput): Promise<{ created: boolean; record: FenceRecord }>;
  transition(req: FenceTransitionRequest): Promise<FenceTransitionOutcome>;
  get(fenceId: string): Promise<FenceRecord | undefined>;
  getByStep(executionId: string, stepSeq: number): Promise<FenceRecord | undefined>;
}

// ─── Typed errors (all classified via InvariantViolation) ────────────────────

/** F4 — a stale/zombie lease holder attempted to mutate a fence. */
export class StaleFenceOwnerError extends InvariantViolation {
  readonly name = "StaleFenceOwnerError";
  constructor(
    readonly fenceId: string,
    readonly claimantAttempt: number,
    readonly ownerAttempt: number
  ) {
    super(
      `stale fence owner: claimant attempt ${claimantAttempt} cannot mutate fence ` +
        `'${fenceId}' owned by attempt ${ownerAttempt}`,
      "F4"
    );
  }
}

/** F3 — an attempt was made to re-commit an already-committed fence. */
export class DuplicateCommittedEffectError extends InvariantViolation {
  readonly name = "DuplicateCommittedEffectError";
  constructor(readonly fenceId: string, readonly state: FenceState) {
    super(
      `duplicate committed effect rejected: fence '${fenceId}' is already terminal-committed (${state})`,
      "F3"
    );
  }
}

/** F1 — a lifecycle op referenced a fence that does not durably exist. */
export class MissingFenceError extends InvariantViolation {
  readonly name = "MissingFenceError";
  constructor(readonly fenceId: string, readonly op: string) {
    super(`missing fence: '${op}' requires a durable fence '${fenceId}' but none exists`, "F1");
  }
}

/** F6 — recorded args drifted from the live call; replay/retry must not silently re-run. */
export class FenceArgDriftError extends InvariantViolation {
  readonly name = "FenceArgDriftError";
  constructor(
    readonly fenceId: string,
    readonly recordedArgsHash: string,
    readonly observedArgsHash: string
  ) {
    super(
      `fence arg drift: fence '${fenceId}' recorded args ${recordedArgsHash} ` +
        `but observed ${observedArgsHash}`,
      "F6"
    );
  }
}

// ─── reserveOrResolve result ─────────────────────────────────────────────────

export type FenceResolveResult =
  /** Caller owns a PENDING fence and should proceed to beginSideEffect. */
  | { kind: "RESERVED"; fence: FenceRecord }
  /** A prior call already committed; return `output`, do NOT re-dispatch (F3/F6). */
  | { kind: "RESOLVED_COMMITTED"; output: Record<string, unknown>; fence: FenceRecord }
  /** Recorded args drift from the live call (F6) — surface as replay divergence. */
  | { kind: "ARG_DRIFT"; recordedArgsHash: string; observedArgsHash: string; fence: FenceRecord }
  /** A prior in-flight call lost its fence; this step needs reconciliation (S3). */
  | { kind: "AMBIGUOUS"; fence: FenceRecord }
  /** A reconciler currently holds the fence; caller should wait/skip. */
  | { kind: "RECONCILING"; fence: FenceRecord }
  /** A same-attempt sibling is mid-flight (duplicate in-process delivery). */
  | { kind: "IN_FLIGHT"; fence: FenceRecord }
  /** Caller is a zombie (attempt older than the fence owner); must surrender. */
  | { kind: "STALE"; fence: FenceRecord };

export interface FenceProtocolOptions {
  clock?: { now(): Date };
}

export class FenceProtocol {
  private readonly now: () => Date;

  constructor(
    private readonly store: FenceStore,
    opts: FenceProtocolOptions = {}
  ) {
    this.now = opts.clock ? () => opts.clock!.now() : () => new Date();
  }

  /**
   * The entry gate. Establishes a durable PENDING fence for a fresh step, or
   * resolves what to do when a fence already exists (cached commit, reconcile,
   * reopen, surrender, …). This is the single point that prevents replay and
   * retry from bypassing a committed fence (F6) and from silently re-running
   * drifted args (F6).
   */
  async reserveOrResolve(input: FenceReserveInput): Promise<FenceResolveResult> {
    // L1 (positive monotonic token) + F7 (canonical aliases agree). The store
    // re-asserts this at the CAS, but failing here gives the cleanest error site.
    assertCanonicalOwnershipConsistency(input.owner, { fenceId: input.fenceId, op: "reserveOrResolve" });

    const { created, record } = await this.store.reserve(input);
    if (created) {
      return { kind: "RESERVED", fence: record };
    }

    // A fence already exists. Drift takes precedence over everything: a replay
    // with different args must never be served a cached commit or silently
    // re-run (F6).
    if (record.argsHash && input.argsHash && record.argsHash !== input.argsHash) {
      return {
        kind: "ARG_DRIFT",
        recordedArgsHash: record.argsHash,
        observedArgsHash: input.argsHash,
        fence: record
      };
    }

    switch (record.state) {
      case "COMMITTED":
      case "RECONCILED":
        // Absorbing committed terminals: return the recorded outcome (F3/F6).
        return { kind: "RESOLVED_COMMITTED", output: record.output ?? {}, fence: record };

      case "FAILED":
      case "EXPIRED":
        // Restartable terminals: re-open under a (monotonic) fresh attempt and
        // proceed. Verified-not-committed, so re-dispatch is safe.
        return this.reopen(input);

      case "PENDING": {
        // Reserved but never dispatched. If we are at least as new as the
        // owner, claim it and proceed; an older attempt is a zombie.
        if (input.owner.attempt < record.leaseAttempt) {
          return { kind: "STALE", fence: record };
        }
        return { kind: "RESERVED", fence: record };
      }

      case "EXECUTING": {
        if (input.owner.attempt < record.leaseAttempt) {
          // We are stale; the real owner is newer. Surrender.
          return { kind: "STALE", fence: record };
        }
        if (input.owner.attempt === record.leaseAttempt) {
          // Same attempt re-entered an in-flight call — duplicate delivery to
          // the same logical owner. The remote idempotency key dedupes; poll.
          return { kind: "IN_FLIGHT", fence: record };
        }
        // A newer owner found a prior owner's in-flight call. The prior owner
        // is presumed lost; the effect may or may not have fired. Move to
        // AMBIGUOUS and route to reconciliation (S3). Never re-dispatch blind.
        const out = await this.store.transition({
          fenceId: input.fenceId,
          expectedFrom: "EXECUTING",
          to: "AMBIGUOUS",
          claimant: input.owner,
          ownership: "monotonic",
          restampOwner: true
        });
        if (out.outcome === "APPLIED") return { kind: "AMBIGUOUS", fence: out.record };
        if (out.outcome === "STALE_OWNER") return { kind: "STALE", fence: out.record };
        // Lost the race — re-read and re-resolve from the fresh state.
        if (out.outcome === "STALE_STATE") return this.resolveExisting(out.record, input);
        throw new MissingFenceError(input.fenceId, "reserveOrResolve/ambiguate");
      }

      case "AMBIGUOUS":
        return { kind: "AMBIGUOUS", fence: record };

      case "RECONCILING":
        return { kind: "RECONCILING", fence: record };
    }
  }

  /**
   * Transition PENDING → EXECUTING. After this returns APPLIED the fence is
   * durably in EXECUTING and the caller is its owner — the only state from
   * which the external side effect may fire (F1). A side effect dispatched
   * without this returning EXECUTING is a protocol violation.
   */
  async beginSideEffect(input: {
    fenceId: string;
    claimant: FenceOwner;
  }): Promise<{ fence: FenceRecord }> {
    const out = await this.store.transition({
      fenceId: input.fenceId,
      expectedFrom: "PENDING",
      to: "EXECUTING",
      claimant: input.claimant,
      ownership: "monotonic",
      restampOwner: true
    });
    if (out.outcome === "MISSING") {
      throw new MissingFenceError(input.fenceId, "beginSideEffect");
    }
    if (out.outcome === "STALE_OWNER") {
      throw new StaleFenceOwnerError(
        input.fenceId,
        input.claimant.attempt,
        out.record.leaseAttempt
      );
    }
    if (out.outcome === "STALE_STATE") {
      // F3 — refuse to start a side effect for an already-committed fence. The
      // CAS reports the live committed state directly, so this is deterministic
      // (no read-then-act race). In the normal flow reserveOrResolve already
      // short-circuits committed fences to RESOLVED_COMMITTED; reaching here
      // means a caller bypassed that gate — a logic bug worth a hard stop.
      if (out.record.state === "COMMITTED" || out.record.state === "RECONCILED") {
        throw new DuplicateCommittedEffectError(input.fenceId, out.record.state);
      }
      // Someone else advanced the fence. If it is already EXECUTING under us,
      // accept; otherwise this is a lost race we cannot dispatch from.
      if (out.record.state === "EXECUTING" && out.record.leaseAttempt === input.claimant.attempt) {
        return { fence: out.record };
      }
      throw new StaleFenceOwnerError(
        input.fenceId,
        input.claimant.attempt,
        out.record.leaseAttempt
      );
    }
    // F1: the fence is durably EXECUTING before any side effect can fire.
    assertRuntimeInvariant(
      "F1",
      out.record.state === "EXECUTING",
      "beginSideEffect must leave the fence in EXECUTING before dispatch",
      { fenceId: input.fenceId, state: out.record.state }
    );
    return { fence: out.record };
  }

  /**
   * Transition EXECUTING → COMMITTED. Requires *exact* ownership: only the
   * worker that began the in-flight call may record its success. A claimant
   * whose attempt no longer matches has lost the lease mid-call → FENCED; the
   * caller must surrender and let the new owner reconcile (case C). F3 guards
   * against re-committing an absorbing terminal.
   */
  async commit(input: {
    fenceId: string;
    claimant: FenceOwner;
    output: Record<string, unknown>;
  }): Promise<{ outcome: "COMMITTED" | "FENCED"; fence?: FenceRecord }> {
    const current = await this.store.get(input.fenceId);
    if (!current) throw new MissingFenceError(input.fenceId, "commit");
    // The CAS below is the sole enforcement of single-commit: EXECUTING→COMMITTED
    // applies at most once, so a second commit (race-loser, or a fence already
    // moved to AMBIGUOUS/COMMITTED by another owner) matches zero rows and is
    // FENCED. We surrender idempotently rather than throwing, because "I lost
    // the fence" and "it was already committed" are the same safe outcome from
    // the caller's perspective: do not re-dispatch, do not double-write.
    const out = await this.store.transition({
      fenceId: input.fenceId,
      expectedFrom: "EXECUTING",
      to: "COMMITTED",
      claimant: input.claimant,
      ownership: "exact",
      patch: { output: input.output, resolution: "COMMITTED" }
    });
    if (out.outcome === "APPLIED") return { outcome: "COMMITTED", fence: out.record };
    // STALE_OWNER / STALE_STATE / MISSING → we lost the fence. Surrender.
    if (out.outcome === "MISSING") return { outcome: "FENCED" };
    return { outcome: "FENCED", fence: out.record };
  }

  /** Transition EXECUTING → FAILED (definitive negative). Exact ownership. */
  async fail(input: {
    fenceId: string;
    claimant: FenceOwner;
    error: string;
  }): Promise<{ outcome: "FAILED" | "FENCED"; fence?: FenceRecord }> {
    const out = await this.store.transition({
      fenceId: input.fenceId,
      expectedFrom: "EXECUTING",
      to: "FAILED",
      claimant: input.claimant,
      ownership: "exact",
      patch: { error: input.error, resolution: "FAILED" }
    });
    if (out.outcome === "APPLIED") return { outcome: "FAILED", fence: out.record };
    if (out.outcome === "MISSING") return { outcome: "FENCED" };
    return { outcome: "FENCED", fence: out.record };
  }

  /**
   * Transition EXECUTING → AMBIGUOUS. Called when the owner detects it lost the
   * fence mid-flight (self-report) or a recovery sweep declares an in-flight
   * call ambiguous. Monotonic ownership.
   */
  async markAmbiguous(input: {
    fenceId: string;
    claimant: FenceOwner;
    reason?: string;
  }): Promise<{ fence: FenceRecord }> {
    const out = await this.store.transition({
      fenceId: input.fenceId,
      expectedFrom: "EXECUTING",
      to: "AMBIGUOUS",
      claimant: input.claimant,
      ownership: "monotonic",
      restampOwner: true,
      ...(input.reason ? { patch: { error: input.reason } } : {})
    });
    if (out.outcome !== "APPLIED") {
      if (out.outcome === "MISSING") throw new MissingFenceError(input.fenceId, "markAmbiguous");
      // If it's already AMBIGUOUS/RECONCILING someone beat us; return current.
      const current = "record" in out ? out.record : undefined;
      if (current) return { fence: current };
      throw new MissingFenceError(input.fenceId, "markAmbiguous");
    }
    return { fence: out.record };
  }

  /** Claim an AMBIGUOUS fence for reconciliation (→ RECONCILING). Monotonic. */
  async beginReconciliation(input: {
    fenceId: string;
    claimant: FenceOwner;
  }): Promise<{ outcome: "CLAIMED" | "LOST"; fence?: FenceRecord }> {
    const out = await this.store.transition({
      fenceId: input.fenceId,
      expectedFrom: "AMBIGUOUS",
      to: "RECONCILING",
      claimant: input.claimant,
      ownership: "monotonic",
      restampOwner: true
    });
    if (out.outcome === "APPLIED") return { outcome: "CLAIMED", fence: out.record };
    if (out.outcome === "MISSING") return { outcome: "LOST" };
    return { outcome: "LOST", fence: out.record };
  }

  /**
   * Resolve a RECONCILING fence. Exact ownership — only the reconciler that
   * claimed it may resolve. The verified outcome routes to the correct
   * terminal:
   *   COMMITTED  → RECONCILED (absorbing; output recorded)
   *   FAILED     → FAILED     (restartable; effect did not take)
   *   ABANDONED  → EXPIRED    (restartable; verification gave up)
   *   INCONCLUSIVE → AMBIGUOUS (re-quarantine for another pass)
   */
  async resolveReconciliation(input: {
    fenceId: string;
    claimant: FenceOwner;
    verdict: "COMMITTED" | "FAILED" | "ABANDONED" | "INCONCLUSIVE";
    output?: Record<string, unknown>;
    error?: string;
  }): Promise<{ outcome: "RESOLVED" | "LOST"; fence?: FenceRecord }> {
    const to: FenceState =
      input.verdict === "COMMITTED"
        ? "RECONCILED"
        : input.verdict === "FAILED"
          ? "FAILED"
          : input.verdict === "ABANDONED"
            ? "EXPIRED"
            : "AMBIGUOUS";
    const patch: FenceTransitionRequest["patch"] = {};
    if (input.output) patch.output = input.output;
    if (input.error) patch.error = input.error;
    if (input.verdict === "COMMITTED") patch.resolution = "COMMITTED";
    else if (input.verdict === "FAILED") patch.resolution = "FAILED";
    else if (input.verdict === "ABANDONED") patch.resolution = "ABANDONED";

    const out = await this.store.transition({
      fenceId: input.fenceId,
      expectedFrom: "RECONCILING",
      to,
      claimant: input.claimant,
      ownership: "exact",
      patch
    });
    if (out.outcome === "APPLIED") return { outcome: "RESOLVED", fence: out.record };
    if (out.outcome === "MISSING") return { outcome: "LOST" };
    return { outcome: "LOST", fence: out.record };
  }

  /**
   * Expire a PENDING or AMBIGUOUS fence (lease expiry before dispatch, or
   * reconciliation window elapsed). Monotonic — a reaper at a fresh attempt.
   */
  async expire(input: {
    fenceId: string;
    claimant: FenceOwner;
    from: "PENDING" | "AMBIGUOUS";
    reason?: string;
  }): Promise<{ outcome: "EXPIRED" | "LOST"; fence?: FenceRecord }> {
    const out = await this.store.transition({
      fenceId: input.fenceId,
      expectedFrom: input.from,
      to: "EXPIRED",
      claimant: input.claimant,
      ownership: "monotonic",
      restampOwner: true,
      patch: { resolution: "ABANDONED", ...(input.reason ? { error: input.reason } : {}) }
    });
    if (out.outcome === "APPLIED") return { outcome: "EXPIRED", fence: out.record };
    if (out.outcome === "MISSING") return { outcome: "LOST" };
    return { outcome: "LOST", fence: out.record };
  }

  async get(fenceId: string): Promise<FenceRecord | undefined> {
    return this.store.get(fenceId);
  }

  async getByStep(executionId: string, stepSeq: number): Promise<FenceRecord | undefined> {
    return this.store.getByStep(executionId, stepSeq);
  }

  /** Re-open a restartable terminal (FAILED/EXPIRED) → PENDING under a fresh attempt. */
  private async reopen(input: FenceReserveInput): Promise<FenceResolveResult> {
    const current = await this.store.get(input.fenceId);
    if (!current) {
      // Raced with a reaper that deleted it — treat as a clean fresh reserve.
      const { record } = await this.store.reserve(input);
      return { kind: "RESERVED", fence: record };
    }
    if (!FENCE_RESTARTABLE_TERMINALS.has(current.state)) {
      // State moved out from under us; re-resolve.
      return this.resolveExisting(current, input);
    }
    // F4: re-opening requires a strictly monotonic attempt — a zombie cannot
    // resurrect a settled fence.
    if (input.owner.attempt < current.leaseAttempt) {
      return { kind: "STALE", fence: current };
    }
    const out = await this.store.transition({
      fenceId: input.fenceId,
      expectedFrom: current.state,
      to: "PENDING",
      claimant: input.owner,
      ownership: "monotonic",
      restampOwner: true,
      patch: { output: undefined, error: undefined, resolution: undefined, argsHash: input.argsHash }
    });
    if (out.outcome === "APPLIED") return { kind: "RESERVED", fence: out.record };
    if (out.outcome === "STALE_OWNER") return { kind: "STALE", fence: out.record };
    if (out.outcome === "STALE_STATE") return this.resolveExisting(out.record, input);
    throw new MissingFenceError(input.fenceId, "reopen");
  }

  /** Re-derive a resolve result from a freshly-read record after a lost race. */
  private resolveExisting(record: FenceRecord, input: FenceReserveInput): FenceResolveResult {
    if (record.argsHash && input.argsHash && record.argsHash !== input.argsHash) {
      return {
        kind: "ARG_DRIFT",
        recordedArgsHash: record.argsHash,
        observedArgsHash: input.argsHash,
        fence: record
      };
    }
    switch (record.state) {
      case "COMMITTED":
      case "RECONCILED":
        return { kind: "RESOLVED_COMMITTED", output: record.output ?? {}, fence: record };
      case "AMBIGUOUS":
        return { kind: "AMBIGUOUS", fence: record };
      case "RECONCILING":
        return { kind: "RECONCILING", fence: record };
      case "EXECUTING":
        return input.owner.attempt === record.leaseAttempt
          ? { kind: "IN_FLIGHT", fence: record }
          : input.owner.attempt < record.leaseAttempt
            ? { kind: "STALE", fence: record }
            : { kind: "AMBIGUOUS", fence: record };
      case "PENDING":
        return input.owner.attempt < record.leaseAttempt
          ? { kind: "STALE", fence: record }
          : { kind: "RESERVED", fence: record };
      case "FAILED":
      case "EXPIRED":
        // Still restartable but we already lost one race; report RESERVED so the
        // caller retries reserveOrResolve cleanly.
        return { kind: "RESERVED", fence: record };
    }
  }
}

/** Re-export the transition assertion for callers that drive the store directly. */
export { assertFenceTransition, isFenceTerminal };
