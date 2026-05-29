/**
 * Distributed recovery orchestrator + durable coordination store port.
 *
 * recoveryLifecycle.ts answers "is this recovery transition *legal*?" (a
 * property of the table). This module answers "is this worker *authorized* to
 * recover this execution, and *how* should it recover right now?" — the
 * property of recovery ownership, classification, arbitration, and policy. It is
 * the single chokepoint through which every distributed recovery of a crashed,
 * partitioned, lease-lost, or ambiguous execution must pass.
 *
 * It composes — rather than re-implements — the lower correctness layers:
 *
 *   • the durable LEASE (takeoverRecovery CAS) is the cross-process single
 *     winner for ownership transfer; this orchestrator adds the in-process
 *     canonical recovery state, arbitration, throttle, and policy on top.
 *   • the FENCE protocol gates every external side effect; recovery re-drive is
 *     granted only after the fence/lease validates (REC6).
 *   • the REPLAY coordinator owns divergence detection; a replay-based recovery
 *     here is bound by those rules — a diverged replay recovery may never leak a
 *     live side effect (REC2/REC5).
 *   • the RECONCILIATION engine verifies ambiguous external commits; an
 *     ambiguous recovery is quarantined to RECONCILING until verified (REC3).
 *   • the DEAD-LETTER queue absorbs poison executions; recovery escalates to
 *     RECOVERY_ABORTED when the failure is non-recoverable or attempts are
 *     exhausted.
 *
 * It makes the classic distributed-recovery defects unrepresentable:
 *
 *   REC1  concurrent recovery       — exclusive recovery ownership keyed on the
 *                                     durable lease epoch; at most one owner may
 *                                     hold an active recovery strategy at a time.
 *   REC2  unsafe recovery replay     — a diverged replay recovery cannot execute
 *                                     a non-replay-safe side effect.
 *   REC3  reconciliation bypass      — an ambiguous commit routes to RECONCILING
 *                                     before any re-drive or completion.
 *   REC4  stale recovery ownership   — a recovery owner below the live durable
 *                                     epoch is fenced (monotonic CAS).
 *   REC5  divergence leakage         — a diverged replay recovery never reaches
 *                                     RECOVERY_COMPLETED; it quarantines.
 *   REC6  fence bypass               — ownership/re-drive only after fence valid.
 *   REC7  recovery backpressure      — bounded concurrent recoveries + storm shed.
 *   REC8  arbitration single-winner  — strictly-monotonic recovery epoch admission.
 *
 * The store's `cas` is the sole atomic transition primitive: read current →
 * check expected state → check ownership (monotonic recovery epoch) → write,
 * with no read-then-write window. `open` is the create-or-reset primitive that
 * never disturbs a live coordination.
 *
 * Spec: docs/specs/distributed-recovery-architecture.md
 */

import {
  RECOVERY_SEMANTICS_MAP,
  assertRuntimeInvariant,
  isReplaySafeTool,
  type RuntimeFailureCategory
} from "../canonicalSemantics.js";
import type { ExecutionStatus } from "../../domain/model.js";
import {
  assertRecoveryTransition,
  isRecoveryActive,
  isRecoveryExclusive,
  isRecoveryTerminal,
  recoveryStrategyOf,
  type RecoveryState,
  type RecoveryStrategy
} from "./recoveryLifecycle.js";

// ─── Record + ownership model ────────────────────────────────────────────────

/** The durable-ish recovery coordination record — one per executionId. */
export interface RecoveryCoordinationRecord {
  readonly executionId: string;
  readonly state: RecoveryState;
  /**
   * Durable lease epoch of the current recovery owner. This is BOTH the
   * arbitration key (REC8 — strictly-monotonic, the highest epoch wins) and the
   * exclusivity / staleness key (REC1/REC4 — a lower epoch is a zombie that
   * surrenders). It mirrors `lease.attempt` minted by takeoverRecovery.
   */
  readonly ownerEpoch: number;
  readonly ownerWorkerId: string;
  /** The recovery strategy in flight (derived from the active state). */
  readonly strategy: RecoveryStrategy;
  /** Higher = more urgent. The orchestrator processes higher priority first. */
  readonly priority: number;
  readonly reason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The authority requesting or holding a recovery coordination. */
export interface RecoveryClaimant {
  readonly workerId: string;
  /** Durable lease epoch (arbitration + exclusivity key). */
  readonly ownerEpoch: number;
  readonly strategy?: RecoveryStrategy;
  readonly priority?: number;
}

export type RecoveryOwnership = "monotonic" | "exact" | "none";

/** A single compare-and-set transition over the recovery coordination record. */
export interface RecoveryCasRequest {
  executionId: string;
  /** Current state must equal this. */
  expectedFrom: RecoveryState;
  to: RecoveryState;
  claimant: RecoveryClaimant;
  ownership: RecoveryOwnership;
  /** When true, the claimant becomes the new owner (ownerEpoch + workerId + strategy restamped). */
  restampOwner?: boolean;
  patch?: {
    reason?: string | undefined;
    strategy?: RecoveryStrategy | undefined;
    priority?: number | undefined;
  };
}

export type RecoveryCasOutcome =
  | { outcome: "APPLIED"; record: RecoveryCoordinationRecord }
  | { outcome: "STALE_STATE"; record: RecoveryCoordinationRecord }
  | { outcome: "STALE_OWNER"; record: RecoveryCoordinationRecord }
  | { outcome: "MISSING" };

/**
 * Durable storage for recovery coordination records. Implementations MUST
 * guarantee `cas` and `open` are atomic over (state, ownerEpoch).
 */
export interface RecoveryCoordinationStore {
  get(executionId: string): Promise<RecoveryCoordinationRecord | undefined>;
  /**
   * Create a fresh RECOVERY_PENDING coordination, or reset a terminal one. A
   * live (active) coordination is NOT disturbed — `opened` is false and the
   * existing record is returned. This is the only way a terminal record
   * re-enters the active set.
   */
  open(input: {
    executionId: string;
    claimant: RecoveryClaimant;
    reason?: string;
  }): Promise<{ opened: boolean; record: RecoveryCoordinationRecord }>;
  cas(req: RecoveryCasRequest): Promise<RecoveryCasOutcome>;
  listActive(): Promise<RecoveryCoordinationRecord[]>;
}

// ─── Assertions (REC1..REC8) ─────────────────────────────────────────────────

/** REC1 — at most one recovery owner may actively recover an execution. */
export function assertRecoverySerialized(
  executionId: string,
  condition: boolean,
  detail: string,
  context?: Record<string, unknown>
): void {
  assertRuntimeInvariant("REC1", condition, `concurrent recovery for '${executionId}': ${detail}`, {
    executionId,
    ...context
  });
}

/** REC2 — a diverged replay recovery may not execute a non-replay-safe side effect. */
export function assertReplayRecoverySafe(
  executionId: string,
  input: { diverged: boolean; toolName: string },
  context?: Record<string, unknown>
): void {
  const safe = !input.diverged || isReplaySafeTool(input.toolName);
  assertRuntimeInvariant(
    "REC2",
    safe,
    `unsafe recovery replay for '${executionId}': cannot execute non-replay-safe side effect '${input.toolName}' after divergence`,
    { executionId, toolName: input.toolName, ...context }
  );
}

/** REC3 — an ambiguous commit must be reconciled before any re-drive/completion. */
export function assertReconciliationNotBypassed(
  executionId: string,
  condition: boolean,
  detail: string,
  context?: Record<string, unknown>
): void {
  assertRuntimeInvariant("REC3", condition, `recovery reconciliation bypass for '${executionId}': ${detail}`, {
    executionId,
    ...context
  });
}

/** REC4 — a recovery owner below the live durable epoch is invalidated. */
export function assertRecoveryOwnershipFresh(
  executionId: string,
  condition: boolean,
  detail: string,
  context?: Record<string, unknown>
): void {
  assertRuntimeInvariant("REC4", condition, `stale recovery ownership for '${executionId}': ${detail}`, {
    executionId,
    ...context
  });
}

/** REC5 — a diverged replay recovery never leaks into RECOVERY_COMPLETED. */
export function assertNoDivergenceLeak(
  executionId: string,
  condition: boolean,
  detail: string,
  context?: Record<string, unknown>
): void {
  assertRuntimeInvariant("REC5", condition, `replay/recovery divergence leakage for '${executionId}': ${detail}`, {
    executionId,
    ...context
  });
}

/** REC6 — recovery ownership/re-drive only after the durable fence validates. */
export function assertFenceValidatedBeforeRecovery(
  executionId: string,
  condition: boolean,
  detail: string,
  context?: Record<string, unknown>
): void {
  assertRuntimeInvariant("REC6", condition, `recovery fence bypass for '${executionId}': ${detail}`, {
    executionId,
    ...context
  });
}

/** REC7 — concurrent in-flight recoveries cannot exceed the throttle ceiling. */
export function assertRecoveryBackpressureBounded(
  executionId: string,
  condition: boolean,
  detail: string,
  context?: Record<string, unknown>
): void {
  assertRuntimeInvariant("REC7", condition, `recovery backpressure for '${executionId}': ${detail}`, {
    executionId,
    ...context
  });
}

/** REC8 — recovery arbitration elects a single winner (monotonic epoch). */
export function assertRecoveryArbitrationSingleWinner(
  executionId: string,
  condition: boolean,
  detail: string,
  context?: Record<string, unknown>
): void {
  assertRuntimeInvariant("REC8", condition, `recovery arbitration conflict for '${executionId}': ${detail}`, {
    executionId,
    ...context
  });
}

// ─── Pure recovery classification (the recovery legality matrix) ─────────────

export interface RecoveryClassificationInput {
  executionStatus: ExecutionStatus;
  failureCategory?: RuntimeFailureCategory;
  /** Present iff the execution is a replay child (replay-based recovery). */
  parentExecutionId?: string;
  /** True iff a replay recovery of this execution has already diverged. */
  replayDiverged?: boolean;
  /** True iff the ambiguity that gated this recovery has already been reconciled. */
  reconciled?: boolean;
  /** Durable attempt count (lease.attempt) for poison-pill / dead-letter escalation. */
  attemptCount?: number;
  maxAttempts?: number;
}

export interface RecoveryClassification {
  strategy: RecoveryStrategy;
  /** The recovery lifecycle state this classification routes into. */
  state: Exclude<RecoveryState, "RECOVERY_PENDING" | "RECOVERY_BLOCKED">;
  /** Set when the classification escalates to the dead-letter queue. */
  escalate?: "DEAD_LETTER";
  reason: string;
}

const EXECUTION_TERMINAL: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>([
  "COMPLETED",
  "DEAD_LETTERED",
  "CANCELLED"
]);

const AMBIGUOUS_EXECUTION_STATUS: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>([
  "AMBIGUOUS",
  "RECONCILIATION_REQUIRED"
]);

const RECONCILE_REQUIRED_FAILURES: ReadonlySet<RuntimeFailureCategory> = new Set<RuntimeFailureCategory>([
  "AMBIGUOUS_EXTERNAL_COMMIT",
  "TOOL_NON_IDEMPOTENT"
]);

/**
 * Classify how a reclaimed execution must be recovered. PURE and total — the
 * canonical recovery legality matrix, evaluated in strict precedence order so
 * that no ambiguity is silently dead-lettered without reconciliation and no
 * divergence is silently re-driven:
 *
 *   1. Already-concluded execution      → RECOVERY_COMPLETED (no-op).
 *   2. Ambiguous commit, not reconciled → RECONCILING        (REC3).
 *   3. Replay divergence                → RECONCILING        (REC2/REC5 quarantine).
 *   4. Non-recoverable / attempts spent → RECOVERY_ABORTED   (dead-letter).
 *   5. Replay child                     → REPLAY_RECOVERING.
 *   6. Otherwise                        → RECOVERING          (crash recovery).
 */
export function classifyRecovery(input: RecoveryClassificationInput): RecoveryClassification {
  // 1. Nothing to recover.
  if (EXECUTION_TERMINAL.has(input.executionStatus)) {
    return {
      strategy: "NONE",
      state: "RECOVERY_COMPLETED",
      reason: `execution already concluded in '${input.executionStatus}'`
    };
  }

  // 2. Ambiguity gate — reconciliation may never be bypassed (REC3).
  const ambiguous =
    (input.failureCategory !== undefined && RECONCILE_REQUIRED_FAILURES.has(input.failureCategory)) ||
    AMBIGUOUS_EXECUTION_STATUS.has(input.executionStatus);
  if (ambiguous && !input.reconciled) {
    return {
      strategy: "RECONCILE",
      state: "RECONCILING",
      reason: `ambiguous external commit must be reconciled before recovery (status='${input.executionStatus}', failure='${input.failureCategory ?? "n/a"}')`
    };
  }

  // 3. Divergence gate — a diverged replay recovery quarantines, never re-drives
  // a live side effect (REC2/REC5). REPLAY_DIVERGENCE is terminal+reconcilable+
  // human-gated in the recovery matrix, so it routes to reconciliation.
  if (input.failureCategory === "REPLAY_DIVERGENCE" || input.replayDiverged) {
    return {
      strategy: "RECONCILE",
      state: "RECONCILING",
      reason: "replay recovery diverged — quarantined to reconciliation (human-gated), never re-driven live"
    };
  }

  // 4. Dead-letter escalation — exhausted attempts or a non-recoverable failure.
  const attemptsExhausted =
    input.attemptCount !== undefined &&
    input.maxAttempts !== undefined &&
    input.attemptCount > input.maxAttempts;
  const sem = input.failureCategory ? RECOVERY_SEMANTICS_MAP[input.failureCategory] : undefined;
  const nonRecoverable = sem !== undefined && sem.terminal && !sem.reconcilable;
  if (attemptsExhausted || nonRecoverable) {
    return {
      strategy: "NONE",
      state: "RECOVERY_ABORTED",
      escalate: "DEAD_LETTER",
      reason: attemptsExhausted
        ? `attempts exhausted (${input.attemptCount} > ${input.maxAttempts})`
        : `non-recoverable failure '${input.failureCategory}'`
    };
  }

  // 5. Replay-based recovery for a replay child.
  if (input.parentExecutionId) {
    return {
      strategy: "REPLAY",
      state: "REPLAY_RECOVERING",
      reason: `replay child of '${input.parentExecutionId}' — deterministic reconstruction`
    };
  }

  // 6. Plain crash recovery.
  return { strategy: "CRASH", state: "RECOVERING", reason: "crash recovery — re-establish ownership and re-dispatch" };
}

// ─── Recovery arbitration + prioritization ───────────────────────────────────

export type ArbitrationVerdict = "WIN" | "TAKEOVER" | "LOSE";

/**
 * REC8 — arbitrate a prospective recovery epoch against the current
 * coordination. PURE. The durable lease epoch is strictly monotonic per
 * execution (the lease store mints it), so ties are impossible:
 *   WIN      — no active recovery owner; the candidate may claim.
 *   TAKEOVER — the candidate's epoch strictly exceeds the active owner's; it is
 *              a legitimate failover and seizes ownership.
 *   LOSE     — the candidate's epoch is <= the active owner's; it is a zombie or
 *              a duplicate and must surrender.
 */
export function arbitrateRecovery(
  existing: RecoveryCoordinationRecord | undefined,
  candidateEpoch: number
): ArbitrationVerdict {
  if (!existing || isRecoveryTerminal(existing.state)) return "WIN";
  if (candidateEpoch > existing.ownerEpoch) return "TAKEOVER";
  return "LOSE";
}

export interface RecoveryPriorityInput {
  failureCategory?: RuntimeFailureCategory;
  /** Milliseconds the execution has been awaiting recovery (age since reclaim). */
  ageMs?: number;
  attemptCount?: number;
  maxAttempts?: number;
  /** True iff this recovery is gating an ambiguous external commit. */
  ambiguous?: boolean;
}

/**
 * Compute a recovery priority score (higher = recover sooner). PURE and
 * deterministic so a distributed sweep orders identical batches identically.
 * The ordering encodes operational policy:
 *   • ambiguous / human-gated failures rank highest — an un-reconciled external
 *     commit is the most dangerous to leave dangling.
 *   • older waits rank higher (anti-starvation).
 *   • executions near the dead-letter threshold rank lower — they are likely
 *     poison and should not crowd out healthy recoveries.
 */
export function recoveryPriority(input: RecoveryPriorityInput): number {
  let score = 0;
  const sem = input.failureCategory ? RECOVERY_SEMANTICS_MAP[input.failureCategory] : undefined;
  if (input.ambiguous || sem?.requiresHumanIntervention) score += 1000;
  if (sem?.reconcilable) score += 200;
  // Anti-starvation: 1 point per second of wait, capped so age never dominates
  // the ambiguity signal.
  score += Math.min(500, Math.floor((input.ageMs ?? 0) / 1000));
  // Penalize executions close to the poison-pill ceiling.
  if (input.attemptCount !== undefined && input.maxAttempts !== undefined) {
    score -= Math.max(0, input.attemptCount - Math.floor(input.maxAttempts / 2)) * 50;
  }
  return score;
}

/** Order a batch of recovery candidates highest-priority-first (stable). */
export function orderByRecoveryPriority<T>(
  items: readonly T[],
  priorityOf: (item: T) => number
): T[] {
  return items
    .map((item, index) => ({ item, index, p: priorityOf(item) }))
    .sort((a, b) => (b.p - a.p) || (a.index - b.index))
    .map((x) => x.item);
}

// ─── Orchestration result types ──────────────────────────────────────────────

export type RecoveryDecision =
  /** Proceed with plain crash recovery (re-establish ownership, re-dispatch). */
  | "RECOVER"
  /** Proceed with replay-based recovery (deterministic reconstruction). */
  | "REPLAY_RECOVER"
  /** Route through reconciliation before any re-drive (ambiguous/diverged). */
  | "RECONCILE"
  /** Parked: throttle/backpressure/arbitration-loss/fence-not-yet-valid. */
  | "BLOCKED"
  /** Escalated to dead-letter (non-recoverable / attempts exhausted). */
  | "ABORTED"
  /** Nothing to recover — already concluded. */
  | "COMPLETED"
  /** A newer/equal recovery epoch already owns this execution. */
  | "ALREADY_OWNED";

export interface OrchestrateRecoveryInput {
  executionId: string;
  recoveryWorkerId: string;
  /** Prospective durable lease epoch the recovery takeover will mint (lease.attempt + 1). */
  ownerEpoch: number;
  executionStatus: ExecutionStatus;
  failureCategory?: RuntimeFailureCategory;
  parentExecutionId?: string;
  /** A replay child of this execution is currently active (would overlap). */
  replayActive?: boolean;
  /** The replay recovery has already diverged. */
  replayDiverged?: boolean;
  reconciled?: boolean;
  attemptCount?: number;
  maxAttempts?: number;
  priority?: number;
  /**
   * Validates the durable fence/lease BEFORE recovery ownership is granted
   * (REC6). When supplied and it resolves false, the recovery is BLOCKED — a
   * recovery may never seize ownership behind a stale or absent fence.
   */
  validateFence?: () => Promise<boolean>;
}

export interface OrchestrateRecoveryResult {
  decision: RecoveryDecision;
  state: RecoveryState;
  record?: RecoveryCoordinationRecord;
  /** Release the recovery throttle slot. No-op unless a slot was reserved. */
  release: () => void;
  reason: string;
}

export interface ReconcileRecoveryResolution {
  verdict: "NOT_COMMITTED" | "COMMITTED" | "ABANDONED";
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface RecoveryOrchestratorConfig {
  /** REC7 — max simultaneous in-flight recoveries across all executions. */
  maxConcurrentRecoveries: number;
  /** Per-execution storm window (recovery retry storm guard). */
  stormWindowMs: number;
  /** Per-execution recovery admissions/window above which recoveries are shed (BLOCKED). */
  stormSoftLimit: number;
  /** Per-execution recovery admissions/window above which REC7 asserts (amplification bug). */
  stormHardLimit: number;
  /** Global recovery storm window. */
  globalStormWindowMs: number;
  /** Global recovery admissions/window above which recoveries are shed. */
  globalStormSoftLimit: number;
}

export const DEFAULT_RECOVERY_ORCHESTRATOR_CONFIG: RecoveryOrchestratorConfig = {
  maxConcurrentRecoveries: 8,
  stormWindowMs: 60_000,
  stormSoftLimit: 8,
  stormHardLimit: 64,
  globalStormWindowMs: 1_000,
  globalStormSoftLimit: 2_000
};

interface StormWindow {
  windowStart: number;
  count: number;
}

export interface RecoveryOrchestratorOptions {
  clock?: { now(): Date };
  config?: Partial<RecoveryOrchestratorConfig>;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export class DistributedRecoveryOrchestrator {
  private readonly now: () => Date;
  private readonly config: RecoveryOrchestratorConfig;
  private recoverySlots = 0;
  private readonly perExecWindows = new Map<string, StormWindow>();
  private globalWindow: StormWindow = { windowStart: 0, count: 0 };

  constructor(
    private readonly store: RecoveryCoordinationStore,
    opts: RecoveryOrchestratorOptions = {}
  ) {
    this.now = opts.clock ? () => opts.clock!.now() : () => new Date();
    this.config = { ...DEFAULT_RECOVERY_ORCHESTRATOR_CONFIG, ...(opts.config ?? {}) };
  }

  getConfig(): Readonly<RecoveryOrchestratorConfig> {
    return this.config;
  }

  inFlightRecoveries(): number {
    return this.recoverySlots;
  }

  async get(executionId: string): Promise<RecoveryCoordinationRecord | undefined> {
    return this.store.get(executionId);
  }

  /**
   * The single recovery-orchestration entry point. Arbitrates ownership,
   * applies backpressure, classifies the recovery strategy, validates the
   * fence, and drives the canonical recovery lifecycle to the classified state.
   * Returns a decision plus a `release()` that frees the throttle slot once the
   * caller has finished (or surrendered) the recovery.
   */
  async orchestrateRecovery(input: OrchestrateRecoveryInput): Promise<OrchestrateRecoveryResult> {
    const noop = () => undefined;

    // REC8 — the recovery epoch must be a positive integer (a valid lease epoch).
    assertRecoveryArbitrationSingleWinner(
      input.executionId,
      Number.isInteger(input.ownerEpoch) && input.ownerEpoch > 0,
      `recovery epoch ${input.ownerEpoch} is not a positive integer`,
      { ownerEpoch: input.ownerEpoch }
    );

    const existing = await this.store.get(input.executionId);

    // REC8/REC4 — arbitration. A strictly-lower-or-equal epoch loses to the
    // live owner. An equal epoch held by the same worker is an idempotent
    // re-entry; a different worker at the identical durable epoch is impossible
    // under a monotonic lease store and surfaces corruption.
    if (existing && isRecoveryActive(existing.state)) {
      if (input.ownerEpoch < existing.ownerEpoch) {
        assertRecoveryOwnershipFresh(
          input.executionId,
          true,
          `epoch ${input.ownerEpoch} < live owner epoch ${existing.ownerEpoch} — surrendering`,
          { candidateEpoch: input.ownerEpoch, liveEpoch: existing.ownerEpoch }
        );
        return {
          decision: "ALREADY_OWNED",
          state: existing.state,
          record: existing,
          release: noop,
          reason: `a newer recovery epoch ${existing.ownerEpoch} already owns this execution`
        };
      }
      if (input.ownerEpoch === existing.ownerEpoch && existing.ownerWorkerId !== input.recoveryWorkerId) {
        assertRecoveryArbitrationSingleWinner(
          input.executionId,
          false,
          `workers '${input.recoveryWorkerId}' and '${existing.ownerWorkerId}' both claim recovery epoch ${input.ownerEpoch}`,
          { ownerEpoch: input.ownerEpoch }
        );
      }
      if (
        input.ownerEpoch === existing.ownerEpoch &&
        existing.ownerWorkerId === input.recoveryWorkerId &&
        isRecoveryExclusive(existing.state)
      ) {
        // Idempotent re-entry: this worker already actively owns the recovery at
        // this epoch. A PENDING/BLOCKED record is NOT short-circuited — a
        // re-request from the same worker is a legitimate re-evaluation now that
        // the gating condition (throttle, backpressure) may have cleared.
        return {
          decision: this.decisionForState(existing.state),
          state: existing.state,
          record: existing,
          release: noop,
          reason: "recovery already owned by this worker at this epoch (idempotent)"
        };
      }
    }

    // REC1 — recovery cannot overlap an active replay child of the same
    // execution. Block and re-evaluate on the next sweep.
    if (input.replayActive) {
      const blocked = await this.driveBlocked(input, existing, "replay child active — recovery would overlap replay");
      return { decision: "BLOCKED", state: "RECOVERY_BLOCKED", ...(blocked ? { record: blocked } : {}), release: noop, reason: "replay active — recovery overlap blocked (REC1)" };
    }

    // REC7 — storm guard. Charge per-execution + global windows exactly once.
    const storm = this.chargeStorm(input.executionId);
    if (storm === "HARD") {
      assertRecoveryBackpressureBounded(
        input.executionId,
        false,
        `per-execution recoveries exceeded hard ceiling ${this.config.stormHardLimit} within ${this.config.stormWindowMs}ms`,
        { stormHardLimit: this.config.stormHardLimit }
      );
    }
    if (storm === "SOFT") {
      const blocked = await this.driveBlocked(input, existing, "recovery storm — shed");
      return { decision: "BLOCKED", state: "RECOVERY_BLOCKED", ...(blocked ? { record: blocked } : {}), release: noop, reason: "recovery storm — shed via block" };
    }

    // REC7 — global throttle. The ceiling check and the slot reserve are one
    // synchronous critical section (no `await` between them), so under the
    // single-threaded event loop no concurrent recovery slips through the gate.
    if (this.recoverySlots >= this.config.maxConcurrentRecoveries) {
      const blocked = await this.driveBlocked(input, existing, "recovery throttle — at ceiling");
      return {
        decision: "BLOCKED",
        state: "RECOVERY_BLOCKED",
        ...(blocked ? { record: blocked } : {}),
        release: noop,
        reason: `recovery throttle — ${this.recoverySlots} >= ${this.config.maxConcurrentRecoveries}`
      };
    }
    this.recoverySlots += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.recoverySlots = Math.max(0, this.recoverySlots - 1);
    };
    assertRecoveryBackpressureBounded(
      input.executionId,
      this.recoverySlots <= this.config.maxConcurrentRecoveries,
      `in-flight recoveries ${this.recoverySlots} exceeded ceiling ${this.config.maxConcurrentRecoveries}`,
      { recoverySlots: this.recoverySlots }
    );

    try {
      // Classify the recovery strategy (the recovery legality matrix).
      const classification = classifyRecovery(input);

      // REC6 — validate the durable fence/lease BEFORE granting recovery
      // ownership for any strategy that mutates (RECOVER/REPLAY/RECONCILE). A
      // terminal classification (COMPLETED/ABORTED) does not require a fence —
      // it records a conclusion, it does not seize ownership.
      const seizesOwnership =
        classification.state === "RECOVERING" ||
        classification.state === "REPLAY_RECOVERING" ||
        classification.state === "RECONCILING";
      if (seizesOwnership && input.validateFence) {
        const ok = await input.validateFence();
        if (!ok) {
          release();
          const blocked = await this.driveBlocked(input, existing, "durable fence invalid — recovery ownership withheld");
          return {
            decision: "BLOCKED",
            state: "RECOVERY_BLOCKED",
            ...(blocked ? { record: blocked } : {}),
            release: noop,
            reason: "fence/lease invalid — recovery ownership withheld (REC6)"
          };
        }
      }

      const record = await this.driveTo(input, classification.state, classification.strategy, classification.reason);
      if (!record) {
        release();
        const fresh = await this.store.get(input.executionId);
        return {
          decision: "ALREADY_OWNED",
          state: fresh?.state ?? "RECOVERY_PENDING",
          ...(fresh ? { record: fresh } : {}),
          release: noop,
          reason: "recovery claim lost to a newer epoch during arbitration"
        };
      }

      // REC1 — the monotonic CAS granted THIS requester exclusive ownership at
      // its epoch. Serialization is structural (one coordination record per
      // execution, single-winner arbitration); this is the non-racy local
      // post-condition that the ownership grant landed on us. A subsequent
      // strictly-higher epoch may still take over — that is legitimate failover,
      // not a concurrency violation.
      if (isRecoveryExclusive(record.state)) {
        assertRecoverySerialized(
          record.executionId,
          record.ownerEpoch === input.ownerEpoch && record.ownerWorkerId === input.recoveryWorkerId,
          `exclusive recovery ownership not granted to requester (record owner ${record.ownerWorkerId}@${record.ownerEpoch}, requester ${input.recoveryWorkerId}@${input.ownerEpoch})`,
          { recordEpoch: record.ownerEpoch, requestEpoch: input.ownerEpoch }
        );
      }

      // Terminal classifications conclude immediately; release the slot.
      if (isRecoveryTerminal(record.state)) {
        release();
        return {
          decision: record.state === "RECOVERY_COMPLETED" ? "COMPLETED" : "ABORTED",
          state: record.state,
          record,
          release: noop,
          reason: classification.reason
        };
      }

      return {
        decision: this.decisionForState(record.state),
        state: record.state,
        record,
        release,
        reason: classification.reason
      };
    } catch (err) {
      release();
      throw err;
    }
  }

  /**
   * Conclude a successful recovery → RECOVERY_COMPLETED. REC5: a replay-based
   * recovery may only complete if it did NOT diverge; a diverged replay recovery
   * must be reconciled, never promoted to completion.
   */
  async completeRecovery(input: {
    executionId: string;
    workerId: string;
    ownerEpoch: number;
    replayDiverged?: boolean;
  }): Promise<RecoveryCoordinationRecord | undefined> {
    const existing = await this.store.get(input.executionId);
    if (!existing || isRecoveryTerminal(existing.state)) return existing;

    assertNoDivergenceLeak(
      input.executionId,
      !(existing.state === "REPLAY_RECOVERING" && input.replayDiverged === true),
      "cannot complete a diverged replay recovery — it must be reconciled",
      { state: existing.state }
    );

    return this.casOrSettle(existing, "RECOVERY_COMPLETED", input.workerId, input.ownerEpoch, "recovery-completed");
  }

  /** Escalate a recovery to the dead-letter terminal → RECOVERY_ABORTED. */
  async abortRecovery(input: {
    executionId: string;
    workerId: string;
    ownerEpoch: number;
    reason: string;
  }): Promise<RecoveryCoordinationRecord | undefined> {
    let existing = await this.store.get(input.executionId);
    if (existing && isRecoveryTerminal(existing.state)) return existing;
    if (!existing) {
      const opened = await this.store.open({
        executionId: input.executionId,
        claimant: { workerId: input.workerId, ownerEpoch: input.ownerEpoch },
        reason: input.reason
      });
      existing = opened.record;
    }
    return this.casOrSettle(existing, "RECOVERY_ABORTED", input.workerId, input.ownerEpoch, input.reason);
  }

  /**
   * Resolve a RECONCILING recovery — the single gate out of reconciliation.
   * NOT_COMMITTED → RECOVERING (safe to re-drive); COMMITTED → RECOVERY_COMPLETED
   * (outcome stands); ABANDONED → RECOVERY_ABORTED (human/DLQ). REC3: this is the
   * only path that legally leaves RECONCILING toward a re-drive.
   */
  async resolveReconciliation(input: {
    executionId: string;
    workerId: string;
    ownerEpoch: number;
    resolution: ReconcileRecoveryResolution;
  }): Promise<RecoveryCoordinationRecord | undefined> {
    const existing = await this.store.get(input.executionId);
    if (!existing) return undefined;

    assertReconciliationNotBypassed(
      input.executionId,
      existing.state === "RECONCILING",
      `resolveReconciliation called while coordination is in '${existing.state}', not RECONCILING`,
      { state: existing.state }
    );

    const to: RecoveryState =
      input.resolution.verdict === "NOT_COMMITTED"
        ? "RECOVERING"
        : input.resolution.verdict === "COMMITTED"
          ? "RECOVERY_COMPLETED"
          : "RECOVERY_ABORTED";
    const strategy: RecoveryStrategy = to === "RECOVERING" ? "CRASH" : "NONE";
    const out = await this.store.cas({
      executionId: input.executionId,
      expectedFrom: "RECONCILING",
      to,
      claimant: { workerId: input.workerId, ownerEpoch: input.ownerEpoch, strategy },
      ownership: "monotonic",
      restampOwner: true,
      patch: { reason: `reconciled:${input.resolution.verdict}`, strategy }
    });
    return out.outcome === "APPLIED" ? out.record : "record" in out ? out.record : undefined;
  }

  // ── internals ──

  private decisionForState(state: RecoveryState): RecoveryDecision {
    switch (state) {
      case "RECOVERING":
        return "RECOVER";
      case "REPLAY_RECOVERING":
        return "REPLAY_RECOVER";
      case "RECONCILING":
        return "RECONCILE";
      case "RECOVERY_BLOCKED":
        return "BLOCKED";
      case "RECOVERY_COMPLETED":
        return "COMPLETED";
      case "RECOVERY_ABORTED":
        return "ABORTED";
      default:
        return "BLOCKED";
    }
  }

  /**
   * Drive the coordination to `target` for the requesting owner, normalising
   * through RECOVERY_PENDING when the current state cannot reach `target`
   * directly. One CAS per turn, re-reading on every contended write, bounded so
   * a pathological race can never spin forever. Returns the new record, or
   * undefined when the claim was lost to a strictly-newer epoch (STALE_OWNER).
   */
  private async driveTo(
    input: OrchestrateRecoveryInput,
    target: RecoveryState,
    strategy: RecoveryStrategy,
    reason: string
  ): Promise<RecoveryCoordinationRecord | undefined> {
    const priority = input.priority ?? 0;
    const claimant: RecoveryClaimant = {
      workerId: input.recoveryWorkerId,
      ownerEpoch: input.ownerEpoch,
      strategy,
      priority
    };

    for (let turn = 0; turn < 8; turn++) {
      const cur = await this.store.get(input.executionId);

      if (!cur || isRecoveryTerminal(cur.state)) {
        await this.store.open({ executionId: input.executionId, claimant, reason });
        continue; // re-read; we (or a racer) are now PENDING
      }

      // A strictly-lower epoch is a zombie — surrender (REC4).
      if (input.ownerEpoch < cur.ownerEpoch) return undefined;

      if (cur.state === target) {
        // Already there; restamp ownership if we are an equal/higher epoch.
        if (input.ownerEpoch >= cur.ownerEpoch) {
          const out = await this.store.cas({
            executionId: input.executionId,
            expectedFrom: cur.state,
            to: target,
            claimant,
            ownership: "monotonic",
            restampOwner: true,
            patch: { reason, strategy, priority }
          });
          if (out.outcome === "APPLIED") return out.record;
          if (out.outcome === "STALE_OWNER") return undefined;
          continue;
        }
        return cur;
      }

      // Step legally toward target. Direct edge if legal, else normalise via
      // RECOVERY_PENDING (the restartable re-entry hub).
      const direct = cur.state === "RECOVERY_PENDING" || this.canStep(cur.state, target);
      const next: RecoveryState = direct ? target : "RECOVERY_PENDING";
      const out = await this.store.cas({
        executionId: input.executionId,
        expectedFrom: cur.state,
        to: next,
        claimant,
        ownership: "monotonic",
        restampOwner: true,
        patch: { reason, strategy: next === target ? strategy : recoveryStrategyOf(next), priority }
      });
      if (out.outcome === "STALE_OWNER") return undefined;
      if (out.outcome === "APPLIED" && out.record.state === target) return out.record;
      // APPLIED (intermediate PENDING) or STALE_STATE — loop and re-read.
    }

    return this.store.get(input.executionId).then((r) => (r && r.state === target ? r : undefined));
  }

  private canStep(from: RecoveryState, to: RecoveryState): boolean {
    // Pure legality probe against the lifecycle table (no throw).
    try {
      assertRecoveryTransition("probe", from, to);
      return true;
    } catch {
      return false;
    }
  }

  private async driveBlocked(
    input: OrchestrateRecoveryInput,
    existing: RecoveryCoordinationRecord | undefined,
    reason: string
  ): Promise<RecoveryCoordinationRecord | undefined> {
    // Never downgrade an active reconciliation to blocked — that would bypass
    // the reconciliation gate (REC3). Leave it where it is.
    if (existing && existing.state === "RECONCILING") return existing;
    const record = await this.driveTo(input, "RECOVERY_BLOCKED", "NONE", reason);
    return record;
  }

  private async casOrSettle(
    existing: RecoveryCoordinationRecord,
    to: RecoveryState,
    workerId: string,
    ownerEpoch: number,
    reason: string
  ): Promise<RecoveryCoordinationRecord | undefined> {
    // Normalise through PENDING if a direct edge does not exist.
    let from = existing.state;
    if (!this.canStep(from, to) && from !== "RECOVERY_PENDING") {
      const step = await this.store.cas({
        executionId: existing.executionId,
        expectedFrom: from,
        to: "RECOVERY_PENDING",
        claimant: { workerId, ownerEpoch, strategy: "NONE" },
        ownership: "monotonic",
        restampOwner: true,
        patch: { reason: "re-pending", strategy: "NONE" }
      });
      if (step.outcome !== "APPLIED") return "record" in step ? step.record : undefined;
      from = "RECOVERY_PENDING";
    }
    const out = await this.store.cas({
      executionId: existing.executionId,
      expectedFrom: from,
      to,
      claimant: { workerId, ownerEpoch, strategy: "NONE" },
      ownership: "monotonic",
      restampOwner: true,
      patch: { reason, strategy: "NONE" }
    });
    return out.outcome === "APPLIED" ? out.record : "record" in out ? out.record : undefined;
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
