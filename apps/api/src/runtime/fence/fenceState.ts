/**
 * Canonical fence state machine.
 *
 * This module is the single authoritative definition of the per-side-effect
 * fence lifecycle. A "fence" is the durable coordination record that guards
 * exactly one external side effect, identified by (executionId, stepSeq). It
 * is distinct from the *execution* state machine in canonicalSemantics.ts:
 * an execution runs many steps; each step that produces an external effect
 * owns one fence.
 *
 * The fence has eight explicit states. Every state is reachable from PENDING,
 * every terminal state is absorbing (no outgoing transitions), and only the
 * transitions enumerated in FENCE_TRANSITIONS are admissible. These structural
 * properties are validated at module load (see validateFenceStateMachine),
 * so an illegal table is a startup-time failure, not a runtime surprise.
 *
 * The state machine is pure: no I/O, no clock, no ownership logic. Ownership
 * validation and durable CAS live in fenceProtocol.ts + the FenceStore. This
 * separation is deliberate — the legality of a transition (this file) is a
 * mathematical property of the table; the *authority* to perform it
 * (fenceProtocol.ts) is a property of lease ownership.
 *
 * Spec: docs/specs/fence-state-machine.md
 */

import { InvariantViolation } from "../canonicalSemantics.js";

export const FENCE_STATES = [
  /** Fence durably reserved; the external side effect has NOT been dispatched. */
  "PENDING",
  /** Owner authorized to dispatch; the external call is in flight. The ONLY
   *  state from which a side effect may legally fire. */
  "EXECUTING",
  /** External side effect confirmed to have succeeded; outcome recorded. Terminal. */
  "COMMITTED",
  /** External side effect confirmed to have NOT taken effect (definitive
   *  negative); outcome recorded. Terminal. */
  "FAILED",
  /** Owner lost the fence (lease loss / crash) while EXECUTING; the outcome is
   *  unknown. Quarantine — no further dispatch until reconciled. */
  "AMBIGUOUS",
  /** A reconciler holds the fence and is verifying the true external outcome. */
  "RECONCILING",
  /** Ambiguity resolved via reconciliation; the verified outcome is recorded
   *  (see FenceRecord.resolution). Terminal. */
  "RECONCILED",
  /** The owning lease expired before dispatch (safe), or an ambiguous fence's
   *  reconciliation window elapsed (gave up). Terminal; a retry mints a fresh
   *  fence under a new attempt. */
  "EXPIRED"
] as const;

export type FenceState = (typeof FENCE_STATES)[number];

export const FENCE_STATE_SET: ReadonlySet<FenceState> = new Set(FENCE_STATES);

/**
 * Legal transitions. A transition `from -> to` is admissible iff
 * `to ∈ FENCE_TRANSITIONS[from]`. Self-transitions (`from === to`) are treated
 * as idempotent no-ops by assertFenceTransition and are not listed here.
 *
 * Rationale per edge:
 *   PENDING     → EXECUTING    owner authorized to dispatch (lease valid)
 *   PENDING     → EXPIRED      lease expired before dispatch — provably no effect
 *   PENDING     → FAILED       pre-dispatch rejection (arg drift / invalid) — no effect
 *   EXECUTING   → COMMITTED    call returned ok; owner still valid; recorded
 *   EXECUTING   → FAILED       call returned a definitive error; owner valid; recorded
 *   EXECUTING   → AMBIGUOUS    owner lost the fence mid-call; outcome unknown
 *   AMBIGUOUS   → RECONCILING  a reconciler claimed the fence
 *   AMBIGUOUS   → EXPIRED      reconciliation window elapsed; quarantine abandoned
 *   RECONCILING → RECONCILED   verified: the effect DID commit (absorbing)
 *   RECONCILING → FAILED       verified: the effect did NOT take (restartable)
 *   RECONCILING → EXPIRED      verification abandoned (restartable, human-gated)
 *   RECONCILING → AMBIGUOUS    verification inconclusive; re-quarantine for retry
 *   FAILED      → PENDING      explicit retry: re-open the stable fence under a fresh attempt
 *   EXPIRED     → PENDING      reclaim: a new owner re-opens an expired fence
 *
 * FAILED and EXPIRED are *restartable terminals* (FENCE_RESTARTABLE_TERMINALS):
 * a fence settles there and is then either re-opened (→ PENDING under a strictly
 * monotonic attempt) or left at rest. This mirrors the execution machine's
 * FAILED → LEASE_ACQUISITION restart edge and keeps the fence id — and therefore
 * the remote idempotency key — stable across retries. COMMITTED and RECONCILED
 * are absorbing: a committed external effect is never re-opened.
 */
const FENCE_TRANSITION_TUPLES = {
  PENDING: ["EXECUTING", "EXPIRED", "FAILED"],
  EXECUTING: ["COMMITTED", "FAILED", "AMBIGUOUS"],
  COMMITTED: [],
  FAILED: ["PENDING"],
  AMBIGUOUS: ["RECONCILING", "EXPIRED"],
  RECONCILING: ["RECONCILED", "FAILED", "EXPIRED", "AMBIGUOUS"],
  RECONCILED: [],
  EXPIRED: ["PENDING"]
} as const satisfies Record<FenceState, readonly FenceState[]>;

export const FENCE_TRANSITIONS: Record<FenceState, ReadonlySet<FenceState>> =
  Object.fromEntries(
    Object.entries(FENCE_TRANSITION_TUPLES).map(([from, tos]) => [
      from,
      new Set<FenceState>(tos)
    ])
  ) as unknown as Record<FenceState, ReadonlySet<FenceState>>;

/** Absorbing states — a fence at rest. */
export const FENCE_TERMINAL_STATES: ReadonlySet<FenceState> = new Set<FenceState>([
  "COMMITTED",
  "FAILED",
  "RECONCILED",
  "EXPIRED"
]);

/** Non-terminal states — a fence still in motion. */
export const FENCE_ACTIVE_STATES: ReadonlySet<FenceState> = new Set<FenceState>([
  "PENDING",
  "EXECUTING",
  "AMBIGUOUS",
  "RECONCILING"
]);

/**
 * Terminal states permitted to leave the terminal set via an explicit,
 * policy-driven re-open back to PENDING. A re-open requires a strictly
 * monotonic lease attempt (enforced in fenceProtocol.ts), so it can never be
 * used by a stale worker to resurrect a settled fence. COMMITTED and
 * RECONCILED are deliberately excluded — a committed external effect is
 * absorbing. Encoded as data so validateFenceStateMachine enforces the rule
 * structurally rather than via a hard-coded state-name exception.
 */
export const FENCE_RESTARTABLE_TERMINALS: ReadonlySet<FenceState> = new Set<FenceState>([
  "FAILED",
  "EXPIRED"
]);

/**
 * Terminal states in which the external side effect is known to have
 * durably committed. A retry/replay that lands on one of these MUST return
 * the recorded outcome and MUST NOT re-dispatch (invariant F3/F6).
 */
export const FENCE_COMMITTED_TERMINALS: ReadonlySet<FenceState> = new Set<FenceState>([
  "COMMITTED"
]);

export function isFenceTerminal(state: FenceState): boolean {
  return FENCE_TERMINAL_STATES.has(state);
}

export function isFenceActive(state: FenceState): boolean {
  return FENCE_ACTIVE_STATES.has(state);
}

export function canFenceTransition(from: FenceState, to: FenceState): boolean {
  if (from === to) return true;
  return FENCE_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Thrown when a fence transition violates the state machine (invariant F5).
 * Extends InvariantViolation so it is classified and traced uniformly with
 * the rest of the runtime's correctness failures.
 */
export class IllegalFenceTransitionError extends InvariantViolation {
  readonly name = "IllegalFenceTransitionError";
  constructor(
    readonly fenceId: string,
    readonly fromState: FenceState,
    readonly toState: FenceState
  ) {
    super(
      `illegal fence transition '${fromState}' -> '${toState}' for fence '${fenceId}'`,
      "F5"
    );
  }
}

/**
 * Assert that `from -> to` is admissible. Self-transitions are idempotent
 * no-ops. Any other unlisted edge throws IllegalFenceTransitionError. This is
 * the single chokepoint every state change passes through, in-memory and in
 * SQL (the Postgres store mirrors the same table).
 */
export function assertFenceTransition(
  fenceId: string,
  from: FenceState,
  to: FenceState
): void {
  if (from === to) return;
  if (!FENCE_TRANSITIONS[from]?.has(to)) {
    throw new IllegalFenceTransitionError(fenceId, from, to);
  }
}

/**
 * Legacy `tool_call_dedup.status` values projected onto the canonical fence
 * states. The dedup table predates this state machine and only distinguishes
 * RESERVED/IN_FLIGHT/SUCCEEDED/COMPLETED/FAILED — it cannot tell PENDING from
 * EXECUTING or AMBIGUOUS from RECONCILING. The projection is therefore a
 * coarsening: it maps a reserved-but-unknown row to PENDING (the safe lower
 * bound — "no effect proven yet"). Code that needs the finer distinction must
 * read the authoritative fence record, not the projection.
 */
export type LegacyDedupStatus =
  | "IN_FLIGHT"
  | "RESERVED"
  | "COMPLETED"
  | "SUCCEEDED"
  | "FAILED";

export function projectDedupStatus(status: LegacyDedupStatus): FenceState {
  switch (status) {
    case "IN_FLIGHT":
    case "RESERVED":
      return "PENDING";
    case "COMPLETED":
    case "SUCCEEDED":
      return "COMMITTED";
    case "FAILED":
      return "FAILED";
  }
}

export interface FenceStateMachineReport {
  states: readonly FenceState[];
  terminalStates: readonly FenceState[];
  activeStates: readonly FenceState[];
  edgeCount: number;
}

/**
 * Validate the structural integrity of the fence state machine. Run at module
 * load so a malformed table fails fast. Enforces:
 *   1. Every state has a transition entry.
 *   2. Every transition destination is a defined state.
 *   3. Every state is reachable from PENDING (no dead states).
 *   4. Every terminal state is absorbing (no outgoing edges).
 *   5. Terminal ∪ Active partition the state set exactly (no overlap, no gap).
 */
export function validateFenceStateMachine(): FenceStateMachineReport {
  for (const state of FENCE_STATES) {
    if (!FENCE_TRANSITIONS[state]) {
      throw new Error(`fence state-machine invalid: state '${state}' has no transition entry`);
    }
  }

  let edgeCount = 0;
  for (const [from, tos] of Object.entries(FENCE_TRANSITIONS)) {
    if (!FENCE_STATE_SET.has(from as FenceState)) {
      throw new Error(`fence state-machine invalid: transition source '${from}' is not a state`);
    }
    for (const to of tos) {
      edgeCount++;
      if (!FENCE_STATE_SET.has(to)) {
        throw new Error(
          `fence state-machine invalid: edge '${from}' -> '${to}' targets an undefined state`
        );
      }
    }
  }

  // Reachability from PENDING (the sole entry state).
  const visited = new Set<FenceState>(["PENDING"]);
  const stack: FenceState[] = ["PENDING"];
  while (stack.length) {
    const current = stack.pop()!;
    for (const next of FENCE_TRANSITIONS[current]) {
      if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  for (const state of FENCE_STATES) {
    if (!visited.has(state)) {
      throw new Error(`fence state-machine invalid: state '${state}' is unreachable from PENDING`);
    }
  }

  // Terminal absorption — terminals have no outgoing edges UNLESS they are
  // explicitly restartable, in which case their sole edge must be back to
  // PENDING.
  for (const terminal of FENCE_TERMINAL_STATES) {
    const edges = FENCE_TRANSITIONS[terminal];
    if (FENCE_RESTARTABLE_TERMINALS.has(terminal)) {
      if (edges.size !== 1 || !edges.has("PENDING")) {
        throw new Error(
          `fence state-machine invalid: restartable terminal '${terminal}' must have exactly one edge -> PENDING`
        );
      }
    } else if (edges.size !== 0) {
      throw new Error(`fence state-machine invalid: absorbing terminal '${terminal}' has outgoing edges`);
    }
  }
  for (const restartable of FENCE_RESTARTABLE_TERMINALS) {
    if (!FENCE_TERMINAL_STATES.has(restartable)) {
      throw new Error(
        `fence state-machine invalid: restartable terminal '${restartable}' is not a terminal state`
      );
    }
  }

  // Active/terminal partition.
  for (const state of FENCE_STATES) {
    const term = FENCE_TERMINAL_STATES.has(state);
    const active = FENCE_ACTIVE_STATES.has(state);
    if (term === active) {
      throw new Error(
        `fence state-machine invalid: state '${state}' must be exactly one of terminal/active`
      );
    }
  }

  return {
    states: FENCE_STATES,
    terminalStates: [...FENCE_TERMINAL_STATES],
    activeStates: [...FENCE_ACTIVE_STATES],
    edgeCount
  };
}

/** Validated at module load — importing this module proves the table is sound. */
export const FENCE_STATE_MACHINE: FenceStateMachineReport = validateFenceStateMachine();
