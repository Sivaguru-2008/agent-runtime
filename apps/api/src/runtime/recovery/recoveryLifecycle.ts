/**
 * Canonical distributed-recovery lifecycle state machine.
 *
 * This module is the single authoritative definition of the per-execution
 * *recovery orchestration* lifecycle. It is the fourth canonical state machine
 * in the runtime, and is deliberately distinct from the other three:
 *
 *   • execution states  (canonicalSemantics.ts) — where an execution sits in
 *     its overall lifecycle (RUNNING, RECOVERING, COMPLETED, ...).
 *   • fence states      (fence/fenceState.ts)    — the durable guard around ONE
 *     external side effect.
 *   • retry states      (retry/retryState.ts)    — WHO may re-drive an execution
 *     after a failure, WHEN, and under what restrictions.
 *   • recovery states   (here)                   — how a *distributed recovery*
 *     of a crashed / partitioned / ambiguous execution is orchestrated end to
 *     end: ownership transfer, replay reconstruction, reconciliation gating,
 *     dead-letter escalation, throttling, and arbitration.
 *
 * A "recovery coordination" is the record, keyed by executionId, that the
 * DistributedRecoveryOrchestrator drives through these states. It composes the
 * lower layers (lease takeoverRecovery, the retry coordinator's recovery gate,
 * the replay coordinator's divergence rules, the reconciliation engine, the
 * dead-letter queue) into one serialized, correctness-safe flow. Its purpose is
 * to make the classic distributed-recovery defects — two workers recovering the
 * same execution at once, a replay recovery leaking a diverged side effect, a
 * recovery silently bypassing reconciliation of an ambiguous commit, a stale
 * recovery owner resurrecting ownership — *unrepresentable* rather than merely
 * unlikely.
 *
 * The machine has seven explicit states, matching the canonical recovery
 * lifecycle required by the runtime constitution:
 *
 *   RECOVERY_PENDING     entry; recovery requested, not yet arbitrated/admitted.
 *   RECOVERING           this worker won arbitration; plain crash recovery
 *                        (re-establish ownership, hand the work back).
 *   REPLAY_RECOVERING    recovery proceeds via deterministic replay
 *                        reconstruction; bound by the replay divergence rules.
 *   RECONCILING          recovery is gated behind reconciliation of an ambiguous
 *                        external side effect; no re-drive until verified.
 *   RECOVERY_BLOCKED     parked: throttle/backpressure shed it, it lost
 *                        arbitration, a replay overlap blocks it, or its fence
 *                        went stale. Re-enters PENDING when the gate clears.
 *   RECOVERY_ABORTED     terminal; recovery abandoned (non-recoverable failure,
 *                        dead-letter escalation, stale-owner surrender, or an
 *                        unsafe-divergence quarantine give-up). Absorbing.
 *   RECOVERY_COMPLETED   terminal; recovery succeeded — ownership transferred and
 *                        the execution handed back to normal execution, or a
 *                        reconciliation verdict settled the outcome. Absorbing.
 *
 * Like the other canonical machines, this one is PURE: no I/O, no clock, no
 * ownership logic. The *legality* of a transition (this file) is a mathematical
 * property of the table; the *authority* to perform it (recoveryOrchestrator.ts)
 * is a property of recovery ownership + the durable lease epoch. The structural
 * properties below (total table, reachability, terminal absorption, exact
 * active/terminal partition, exclusivity ⊂ active) are validated at module load
 * (validateRecoveryStateMachine), so an illegal table is a startup failure, not
 * a runtime surprise.
 *
 * Spec: docs/specs/distributed-recovery-architecture.md
 */

import { InvariantViolation } from "../canonicalSemantics.js";
import type { ExecutionStatus } from "../../domain/model.js";

export const RECOVERY_STATES = [
  "RECOVERY_PENDING",
  "RECOVERING",
  "REPLAY_RECOVERING",
  "RECONCILING",
  "RECOVERY_BLOCKED",
  "RECOVERY_ABORTED",
  "RECOVERY_COMPLETED"
] as const;

export type RecoveryState = (typeof RECOVERY_STATES)[number];

export const RECOVERY_STATE_SET: ReadonlySet<RecoveryState> = new Set(RECOVERY_STATES);

/**
 * Legal transitions. A transition `from -> to` is admissible iff
 * `to ∈ RECOVERY_TRANSITIONS[from]`. Self-transitions (`from === to`) are
 * treated as idempotent no-ops by assertRecoveryTransition and are not listed.
 *
 * Rationale per edge:
 *   PENDING           → RECOVERING          arbitration won; crash recovery
 *   PENDING           → REPLAY_RECOVERING   arbitration won; replay-based recovery
 *   PENDING           → RECONCILING         ambiguous effect must reconcile (REC3)
 *   PENDING           → RECOVERY_BLOCKED    throttle/arbitration-loss/overlap (REC7/REC8)
 *   PENDING           → RECOVERY_ABORTED    non-recoverable / dead-letter / stale (REC4)
 *   PENDING           → RECOVERY_COMPLETED  a legitimate owner already concluded
 *   RECOVERING        → REPLAY_RECOVERING   discovered the execution needs replay
 *   RECOVERING        → RECONCILING         ambiguous effect found mid-recovery (REC3)
 *   RECOVERING        → RECOVERY_BLOCKED    fence/lease lost mid-recovery (REC4/REC6)
 *   RECOVERING        → RECOVERY_PENDING    transient — re-arbitrate
 *   RECOVERING        → RECOVERY_ABORTED    escalate to dead-letter / non-recoverable
 *   RECOVERING        → RECOVERY_COMPLETED  ownership transferred, work re-dispatched
 *   REPLAY_RECOVERING → RECONCILING         replay diverged into ambiguity (REC2/REC5)
 *   REPLAY_RECOVERING → RECOVERY_BLOCKED    replay overlap / fence lost
 *   REPLAY_RECOVERING → RECOVERY_PENDING    transient — re-arbitrate
 *   REPLAY_RECOVERING → RECOVERY_ABORTED    unsafe divergence quarantine (REC2/REC5)
 *   REPLAY_RECOVERING → RECOVERY_COMPLETED  replay verified equivalent; re-dispatch
 *   RECONCILING       → RECOVERING          verdict NOT_COMMITTED → safe to re-drive
 *   RECONCILING       → RECOVERY_ABORTED    reconciliation abandoned → human/DLQ
 *   RECONCILING       → RECOVERY_COMPLETED  verdict COMMITTED → outcome stands
 *   RECOVERY_BLOCKED  → RECOVERY_PENDING    gate cleared; eligible again
 *   RECOVERY_BLOCKED  → RECONCILING         unblocked into an ambiguity gate
 *   RECOVERY_BLOCKED  → RECOVERY_ABORTED    gave up while blocked
 *   RECOVERY_BLOCKED  → RECOVERY_COMPLETED  a legitimate owner concluded first
 *
 * RECOVERY_PENDING is the restartable re-entry hub: RECOVERING,
 * REPLAY_RECOVERING, and RECOVERY_BLOCKED all route *back* to PENDING when a
 * fresh arbitration round is legal. Both terminals are reachable from every
 * active state — a recovery can conclude (COMPLETED) or be abandoned (ABORTED)
 * no matter where the orchestration stood, because the *execution's* terminal
 * outcome and the durable lease epoch are authoritative over the coordination's
 * local view. There is deliberately no edge out of a terminal — ABORTED and
 * COMPLETED are absorbing.
 */
const RECOVERY_TRANSITION_TUPLES = {
  RECOVERY_PENDING: [
    "RECOVERING",
    "REPLAY_RECOVERING",
    "RECONCILING",
    "RECOVERY_BLOCKED",
    "RECOVERY_ABORTED",
    "RECOVERY_COMPLETED"
  ],
  RECOVERING: [
    "REPLAY_RECOVERING",
    "RECONCILING",
    "RECOVERY_BLOCKED",
    "RECOVERY_PENDING",
    "RECOVERY_ABORTED",
    "RECOVERY_COMPLETED"
  ],
  REPLAY_RECOVERING: [
    "RECONCILING",
    "RECOVERY_BLOCKED",
    "RECOVERY_PENDING",
    "RECOVERY_ABORTED",
    "RECOVERY_COMPLETED"
  ],
  RECONCILING: ["RECOVERING", "RECOVERY_ABORTED", "RECOVERY_COMPLETED"],
  RECOVERY_BLOCKED: ["RECOVERY_PENDING", "RECONCILING", "RECOVERY_ABORTED", "RECOVERY_COMPLETED"],
  RECOVERY_ABORTED: [],
  RECOVERY_COMPLETED: []
} as const satisfies Record<RecoveryState, readonly RecoveryState[]>;

export const RECOVERY_TRANSITIONS: Record<RecoveryState, ReadonlySet<RecoveryState>> =
  Object.fromEntries(
    Object.entries(RECOVERY_TRANSITION_TUPLES).map(([from, tos]) => [
      from,
      new Set<RecoveryState>(tos)
    ])
  ) as unknown as Record<RecoveryState, ReadonlySet<RecoveryState>>;

/** Absorbing states — recovery orchestration concluded. */
export const RECOVERY_TERMINAL_STATES: ReadonlySet<RecoveryState> = new Set<RecoveryState>([
  "RECOVERY_ABORTED",
  "RECOVERY_COMPLETED"
]);

/** Non-terminal states — recovery orchestration still live. */
export const RECOVERY_ACTIVE_STATES: ReadonlySet<RecoveryState> = new Set<RecoveryState>([
  "RECOVERY_PENDING",
  "RECOVERING",
  "REPLAY_RECOVERING",
  "RECONCILING",
  "RECOVERY_BLOCKED"
]);

/**
 * States in which exactly ONE recovery owner may hold the coordination. These
 * are the states where a recovery worker is *actively* driving the recovery
 * (re-establishing ownership, replaying, or reconciling). At most one owner
 * epoch may occupy any of them for a given execution at a time — this set is
 * what makes "no concurrent recovery execution" (REC1) decidable from data.
 * RECOVERY_PENDING and RECOVERY_BLOCKED are explicitly NOT exclusive: many
 * contenders may sit pending/blocked while arbitration picks the single winner.
 */
export const RECOVERY_EXCLUSIVE_STATES: ReadonlySet<RecoveryState> = new Set<RecoveryState>([
  "RECOVERING",
  "REPLAY_RECOVERING",
  "RECONCILING"
]);

export function isRecoveryTerminal(state: RecoveryState): boolean {
  return RECOVERY_TERMINAL_STATES.has(state);
}

export function isRecoveryActive(state: RecoveryState): boolean {
  return RECOVERY_ACTIVE_STATES.has(state);
}

export function isRecoveryExclusive(state: RecoveryState): boolean {
  return RECOVERY_EXCLUSIVE_STATES.has(state);
}

export function canRecoveryTransition(from: RecoveryState, to: RecoveryState): boolean {
  if (from === to) return true;
  return RECOVERY_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Thrown when a recovery transition violates the state machine. Extends
 * InvariantViolation (code REC_TRANSITION via the REC family) so it is
 * classified and traced uniformly with the runtime's other correctness
 * failures.
 */
export class IllegalRecoveryTransitionError extends InvariantViolation {
  readonly name = "IllegalRecoveryTransitionError";
  constructor(
    readonly executionId: string,
    readonly fromState: RecoveryState,
    readonly toState: RecoveryState
  ) {
    super(
      `illegal recovery transition '${fromState}' -> '${toState}' for execution '${executionId}'`,
      "REC9"
    );
  }
}

/**
 * Assert that `from -> to` is admissible. Self-transitions are idempotent
 * no-ops. Any other unlisted edge throws IllegalRecoveryTransitionError. This is
 * the single chokepoint every recovery coordination state change passes through.
 */
export function assertRecoveryTransition(
  executionId: string,
  from: RecoveryState,
  to: RecoveryState
): void {
  if (from === to) return;
  if (!RECOVERY_TRANSITIONS[from]?.has(to)) {
    throw new IllegalRecoveryTransitionError(executionId, from, to);
  }
}

/**
 * The recovery strategy a coordination is pursuing, derived from the active
 * recovery state. CRASH = plain re-establish-and-redispatch; REPLAY =
 * deterministic reconstruction; RECONCILE = verify an ambiguous external
 * effect; NONE = pending/blocked/terminal (not actively executing a strategy).
 */
export type RecoveryStrategy = "CRASH" | "REPLAY" | "RECONCILE" | "NONE";

export function recoveryStrategyOf(state: RecoveryState): RecoveryStrategy {
  switch (state) {
    case "RECOVERING":
      return "CRASH";
    case "REPLAY_RECOVERING":
      return "REPLAY";
    case "RECONCILING":
      return "RECONCILE";
    default:
      return "NONE";
  }
}

/**
 * Map an active recovery state to the execution status the recovery owner must
 * drive the execution row into. CRASH and REPLAY recovery both resolve the
 * execution to RECOVERING (the canonical recovery execution status — the
 * REPLAYING status is reserved for a replay *child* execution, while a replay-
 * based recovery of the parent still runs under RECOVERING). RECONCILING maps to
 * RECONCILIATION_REQUIRED, the canonical ambiguity-quarantine execution status.
 * Returns undefined for non-executing states.
 */
export function recoveryStateToExecutionStatus(
  state: RecoveryState
): ExecutionStatus | undefined {
  switch (state) {
    case "RECOVERING":
    case "REPLAY_RECOVERING":
      return "RECOVERING";
    case "RECONCILING":
      return "RECONCILIATION_REQUIRED";
    default:
      return undefined;
  }
}

export interface RecoveryStateMachineReport {
  states: readonly RecoveryState[];
  terminalStates: readonly RecoveryState[];
  activeStates: readonly RecoveryState[];
  exclusiveStates: readonly RecoveryState[];
  edgeCount: number;
}

/**
 * Validate the structural integrity of the recovery state machine. Run at
 * module load so a malformed table fails fast. Enforces:
 *   1. Every state has a transition entry.
 *   2. Every transition destination is a defined state.
 *   3. Every state is reachable from RECOVERY_PENDING (no dead states).
 *   4. Every terminal state is absorbing (no outgoing edges).
 *   5. Terminal ∪ Active partition the state set exactly (no overlap, no gap).
 *   6. Every exclusive state is an active state (exclusivity only applies to
 *      live coordinations).
 */
export function validateRecoveryStateMachine(): RecoveryStateMachineReport {
  for (const state of RECOVERY_STATES) {
    if (!RECOVERY_TRANSITIONS[state]) {
      throw new Error(`recovery state-machine invalid: state '${state}' has no transition entry`);
    }
  }

  let edgeCount = 0;
  for (const [from, tos] of Object.entries(RECOVERY_TRANSITIONS)) {
    if (!RECOVERY_STATE_SET.has(from as RecoveryState)) {
      throw new Error(`recovery state-machine invalid: transition source '${from}' is not a state`);
    }
    for (const to of tos) {
      edgeCount++;
      if (!RECOVERY_STATE_SET.has(to)) {
        throw new Error(
          `recovery state-machine invalid: edge '${from}' -> '${to}' targets an undefined state`
        );
      }
    }
  }

  // Reachability from RECOVERY_PENDING (the sole entry state).
  const visited = new Set<RecoveryState>(["RECOVERY_PENDING"]);
  const stack: RecoveryState[] = ["RECOVERY_PENDING"];
  while (stack.length) {
    const current = stack.pop()!;
    for (const next of RECOVERY_TRANSITIONS[current]) {
      if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  for (const state of RECOVERY_STATES) {
    if (!visited.has(state)) {
      throw new Error(`recovery state-machine invalid: state '${state}' is unreachable from RECOVERY_PENDING`);
    }
  }

  // Terminal absorption — terminals have no outgoing edges.
  for (const terminal of RECOVERY_TERMINAL_STATES) {
    if (RECOVERY_TRANSITIONS[terminal].size !== 0) {
      throw new Error(`recovery state-machine invalid: terminal '${terminal}' has outgoing edges`);
    }
  }

  // Active/terminal partition.
  for (const state of RECOVERY_STATES) {
    const term = RECOVERY_TERMINAL_STATES.has(state);
    const active = RECOVERY_ACTIVE_STATES.has(state);
    if (term === active) {
      throw new Error(
        `recovery state-machine invalid: state '${state}' must be exactly one of terminal/active`
      );
    }
  }

  // Exclusivity is a property of live coordinations only.
  for (const state of RECOVERY_EXCLUSIVE_STATES) {
    if (!RECOVERY_ACTIVE_STATES.has(state)) {
      throw new Error(
        `recovery state-machine invalid: exclusive state '${state}' is not an active state`
      );
    }
  }

  return {
    states: RECOVERY_STATES,
    terminalStates: [...RECOVERY_TERMINAL_STATES],
    activeStates: [...RECOVERY_ACTIVE_STATES],
    exclusiveStates: [...RECOVERY_EXCLUSIVE_STATES],
    edgeCount
  };
}

/** Validated at module load — importing this module proves the table is sound. */
export const RECOVERY_STATE_MACHINE: RecoveryStateMachineReport = validateRecoveryStateMachine();
