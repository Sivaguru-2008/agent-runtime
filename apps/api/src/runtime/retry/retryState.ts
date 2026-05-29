/**
 * Canonical retry state machine.
 *
 * This module is the single authoritative definition of the per-execution
 * *retry coordination* lifecycle. It is distinct from both the execution state
 * machine (canonicalSemantics.ts) and the per-side-effect fence state machine
 * (fence/fenceState.ts):
 *
 *   • execution states  — where an execution is in its overall lifecycle.
 *   • fence states      — the durable guard around ONE external side effect.
 *   • retry states (here) — the coordination record that decides WHO may
 *     re-drive an execution after a failure, WHEN, and under what restrictions.
 *
 * A "retry coordination" is the durable-ish record, keyed by executionId, that
 * serialises every re-attempt of an execution: transient-failure retries,
 * crash/lease-loss recovery, and replay re-drives all flow through it. Its
 * purpose is to make duplicate retries, recovery races, and concurrent
 * execution corruption *unrepresentable* rather than merely unlikely.
 *
 * The machine has seven explicit states. The six required coordination states
 * plus one absorbing success terminal (RETRY_SETTLED) so the table is a clean,
 * total state machine with the same structural guarantees the rest of the
 * runtime relies on: every state reachable from the entry state, every terminal
 * absorbing (modulo the explicit restartable terminal back-edge), and only the
 * enumerated transitions admissible. These properties are validated at module
 * load (validateRetryStateMachine), so an illegal table is a startup failure,
 * not a runtime surprise.
 *
 * The state machine is pure: no I/O, no clock, no ownership logic. Ownership
 * arbitration, single-flight admission, recovery serialisation, backpressure,
 * and storm guarding live in retryCoordinator.ts. This separation is the same
 * one the fence layer uses — the *legality* of a transition (this file) is a
 * mathematical property of the table; the *authority* to perform it
 * (retryCoordinator.ts) is a property of retry ownership.
 *
 * Spec: docs/specs/retry-coordination.md
 */

import { InvariantViolation } from "../canonicalSemantics.js";

export const RETRY_STATES = [
  /**
   * A retry has been *requested* (a recoverable failure occurred and the
   * failure taxonomy permits a re-attempt) but the coordinator has not yet
   * admitted it. Entry state. No owner has been minted; nothing is enqueued.
   */
  "RETRY_PENDING",
  /**
   * The coordinator admitted the retry: a single-flight owner+attempt was
   * minted, a backoff/notBefore was assigned, and the work was (or is about to
   * be) enqueued. Exactly one coordination may hold this state per execution.
   */
  "RETRY_SCHEDULED",
  /**
   * A worker has claimed the scheduled retry as the sole execution owner
   * (lease acquired, fence validated) and is actively re-driving the
   * execution. Exactly one owner attempt may occupy this state.
   */
  "RETRY_EXECUTING",
  /**
   * The retry cannot proceed right now: backpressure or arbitration denied
   * admission, a storm shed it, or it lost a lease/slot race. It is parked,
   * not abandoned — it returns to RETRY_PENDING once the gating condition
   * clears (backoff elapsed, budget freed) or escalates to a terminal.
   */
  "RETRY_BLOCKED",
  /**
   * The retry is gated behind reconciliation of an ambiguous external side
   * effect. A reconciler owns the coordination; no re-dispatch may occur until
   * the true external outcome is verified. This is the chokepoint that makes
   * "retries cannot bypass reconciliation" structural rather than advisory.
   */
  "RETRY_RECONCILING",
  /**
   * Terminal. The retry was abandoned: non-retryable failure, exhausted
   * attempts (→ dead-letter), superseded/cancelled, reconciliation gave up, or
   * a stale owner surrendered. Absorbing.
   */
  "RETRY_ABORTED",
  /**
   * Terminal. The execution reached a durable terminal outcome (COMPLETED, or
   * a definitive non-retryable FAILED) so no further retry will ever be
   * coordinated for it. Absorbing. Distinct from RETRY_ABORTED: SETTLED is a
   * successful conclusion of coordination, ABORTED is a give-up.
   */
  "RETRY_SETTLED"
] as const;

export type RetryState = (typeof RETRY_STATES)[number];

export const RETRY_STATE_SET: ReadonlySet<RetryState> = new Set(RETRY_STATES);

/**
 * Legal transitions. A transition `from -> to` is admissible iff
 * `to ∈ RETRY_TRANSITIONS[from]`. Self-transitions (`from === to`) are treated
 * as idempotent no-ops by assertRetryTransition and are not listed here.
 *
 * Rationale per edge:
 *   PENDING     → SCHEDULED    coordinator admitted the retry (single-flight)
 *   PENDING     → BLOCKED      backpressure/arbitration/storm denied admission
 *   PENDING     → RECONCILING  the failure was an ambiguous side effect (S3)
 *   PENDING     → ABORTED      non-retryable failure, or attempts exhausted
 *   PENDING     → SETTLED      a legitimate owner concluded the execution first
 *   SCHEDULED   → EXECUTING    a worker claimed sole execution ownership
 *   SCHEDULED   → BLOCKED      lost the lease/slot race; park and re-evaluate
 *   SCHEDULED   → RECONCILING  ambiguity discovered at claim time
 *   SCHEDULED   → ABORTED      superseded by a newer attempt, or cancelled
 *   SCHEDULED   → SETTLED      a legitimate owner concluded the execution first
 *   EXECUTING   → SETTLED      execution reached a durable terminal outcome
 *   EXECUTING   → PENDING      transient failure mid-attempt → request another
 *   EXECUTING   → RECONCILING  an ambiguous effect fired mid-attempt (S3)
 *   EXECUTING   → BLOCKED      fence lost / lease stolen → surrender, re-eval
 *   EXECUTING   → ABORTED      cancelled, or surrendered to a newer owner
 *   BLOCKED     → PENDING      gating condition cleared; eligible again
 *   BLOCKED     → RECONCILING  unblocked into an ambiguity gate
 *   BLOCKED     → ABORTED      gave up while blocked (exhausted/cancelled)
 *   BLOCKED     → SETTLED      a legitimate owner concluded the execution first
 *   RECONCILING → PENDING      verified NOT_COMMITTED → safe to re-attempt
 *   RECONCILING → SETTLED      verified COMMITTED → outcome stands, done
 *   RECONCILING → ABORTED      reconciliation abandoned → human/DLQ
 *
 * RETRY_PENDING is the restartable re-entry hub: BLOCKED, EXECUTING, and
 * RECONCILING all route *back* to PENDING when a fresh attempt is legal. The
 * two terminals are reachable from every active state — an execution can
 * conclude (SETTLED) or be abandoned (ABORTED) no matter where coordination
 * stood, because the *execution's* terminal outcome is authoritative over the
 * coordination's local view. There is deliberately no edge out of a terminal —
 * SETTLED and ABORTED are absorbing.
 */
const RETRY_TRANSITION_TUPLES = {
  RETRY_PENDING: ["RETRY_SCHEDULED", "RETRY_BLOCKED", "RETRY_RECONCILING", "RETRY_ABORTED", "RETRY_SETTLED"],
  RETRY_SCHEDULED: ["RETRY_EXECUTING", "RETRY_BLOCKED", "RETRY_RECONCILING", "RETRY_ABORTED", "RETRY_SETTLED"],
  RETRY_EXECUTING: ["RETRY_SETTLED", "RETRY_PENDING", "RETRY_RECONCILING", "RETRY_BLOCKED", "RETRY_ABORTED"],
  RETRY_BLOCKED: ["RETRY_PENDING", "RETRY_RECONCILING", "RETRY_ABORTED", "RETRY_SETTLED"],
  RETRY_RECONCILING: ["RETRY_PENDING", "RETRY_SETTLED", "RETRY_ABORTED"],
  RETRY_ABORTED: [],
  RETRY_SETTLED: []
} as const satisfies Record<RetryState, readonly RetryState[]>;

export const RETRY_TRANSITIONS: Record<RetryState, ReadonlySet<RetryState>> =
  Object.fromEntries(
    Object.entries(RETRY_TRANSITION_TUPLES).map(([from, tos]) => [
      from,
      new Set<RetryState>(tos)
    ])
  ) as unknown as Record<RetryState, ReadonlySet<RetryState>>;

/** Absorbing states — coordination concluded. */
export const RETRY_TERMINAL_STATES: ReadonlySet<RetryState> = new Set<RetryState>([
  "RETRY_ABORTED",
  "RETRY_SETTLED"
]);

/** Non-terminal states — coordination still live. */
export const RETRY_ACTIVE_STATES: ReadonlySet<RetryState> = new Set<RetryState>([
  "RETRY_PENDING",
  "RETRY_SCHEDULED",
  "RETRY_EXECUTING",
  "RETRY_BLOCKED",
  "RETRY_RECONCILING"
]);

/**
 * States in which exactly ONE owner may hold the coordination. RETRY_EXECUTING
 * is the strongest: at most one worker may be re-driving an execution at a time
 * (the "only one retry may own execution at a time" guarantee). RETRY_SCHEDULED
 * is single-flight at the admission level. These are checked by the coordinator
 * via compare-and-set; this set lets the structural validator and assertions
 * reason about exclusivity from data.
 */
export const RETRY_EXCLUSIVE_STATES: ReadonlySet<RetryState> = new Set<RetryState>([
  "RETRY_SCHEDULED",
  "RETRY_EXECUTING",
  "RETRY_RECONCILING"
]);

export function isRetryTerminal(state: RetryState): boolean {
  return RETRY_TERMINAL_STATES.has(state);
}

export function isRetryActive(state: RetryState): boolean {
  return RETRY_ACTIVE_STATES.has(state);
}

export function isRetryExclusive(state: RetryState): boolean {
  return RETRY_EXCLUSIVE_STATES.has(state);
}

export function canRetryTransition(from: RetryState, to: RetryState): boolean {
  if (from === to) return true;
  return RETRY_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Thrown when a retry transition violates the state machine. Extends
 * InvariantViolation (code RT_TRANSITION via RT5 family) so it is classified
 * and traced uniformly with the runtime's other correctness failures.
 */
export class IllegalRetryTransitionError extends InvariantViolation {
  readonly name = "IllegalRetryTransitionError";
  constructor(
    readonly executionId: string,
    readonly fromState: RetryState,
    readonly toState: RetryState
  ) {
    super(
      `illegal retry transition '${fromState}' -> '${toState}' for execution '${executionId}'`,
      "RT5"
    );
  }
}

/**
 * Assert that `from -> to` is admissible. Self-transitions are idempotent
 * no-ops. Any other unlisted edge throws IllegalRetryTransitionError. This is
 * the single chokepoint every coordination state change passes through.
 */
export function assertRetryTransition(
  executionId: string,
  from: RetryState,
  to: RetryState
): void {
  if (from === to) return;
  if (!RETRY_TRANSITIONS[from]?.has(to)) {
    throw new IllegalRetryTransitionError(executionId, from, to);
  }
}

export interface RetryStateMachineReport {
  states: readonly RetryState[];
  terminalStates: readonly RetryState[];
  activeStates: readonly RetryState[];
  exclusiveStates: readonly RetryState[];
  edgeCount: number;
}

/**
 * Validate the structural integrity of the retry state machine. Run at module
 * load so a malformed table fails fast. Enforces:
 *   1. Every state has a transition entry.
 *   2. Every transition destination is a defined state.
 *   3. Every state is reachable from RETRY_PENDING (no dead states).
 *   4. Every terminal state is absorbing (no outgoing edges).
 *   5. Terminal ∪ Active partition the state set exactly (no overlap, no gap).
 *   6. Every exclusive state is an active state (exclusivity only applies to
 *      live coordinations).
 */
export function validateRetryStateMachine(): RetryStateMachineReport {
  for (const state of RETRY_STATES) {
    if (!RETRY_TRANSITIONS[state]) {
      throw new Error(`retry state-machine invalid: state '${state}' has no transition entry`);
    }
  }

  let edgeCount = 0;
  for (const [from, tos] of Object.entries(RETRY_TRANSITIONS)) {
    if (!RETRY_STATE_SET.has(from as RetryState)) {
      throw new Error(`retry state-machine invalid: transition source '${from}' is not a state`);
    }
    for (const to of tos) {
      edgeCount++;
      if (!RETRY_STATE_SET.has(to)) {
        throw new Error(
          `retry state-machine invalid: edge '${from}' -> '${to}' targets an undefined state`
        );
      }
    }
  }

  // Reachability from RETRY_PENDING (the sole entry state).
  const visited = new Set<RetryState>(["RETRY_PENDING"]);
  const stack: RetryState[] = ["RETRY_PENDING"];
  while (stack.length) {
    const current = stack.pop()!;
    for (const next of RETRY_TRANSITIONS[current]) {
      if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  for (const state of RETRY_STATES) {
    if (!visited.has(state)) {
      throw new Error(`retry state-machine invalid: state '${state}' is unreachable from RETRY_PENDING`);
    }
  }

  // Terminal absorption — terminals have no outgoing edges.
  for (const terminal of RETRY_TERMINAL_STATES) {
    if (RETRY_TRANSITIONS[terminal].size !== 0) {
      throw new Error(`retry state-machine invalid: terminal '${terminal}' has outgoing edges`);
    }
  }

  // Active/terminal partition.
  for (const state of RETRY_STATES) {
    const term = RETRY_TERMINAL_STATES.has(state);
    const active = RETRY_ACTIVE_STATES.has(state);
    if (term === active) {
      throw new Error(
        `retry state-machine invalid: state '${state}' must be exactly one of terminal/active`
      );
    }
  }

  // Exclusivity is a property of live coordinations only.
  for (const state of RETRY_EXCLUSIVE_STATES) {
    if (!RETRY_ACTIVE_STATES.has(state)) {
      throw new Error(
        `retry state-machine invalid: exclusive state '${state}' is not an active state`
      );
    }
  }

  return {
    states: RETRY_STATES,
    terminalStates: [...RETRY_TERMINAL_STATES],
    activeStates: [...RETRY_ACTIVE_STATES],
    exclusiveStates: [...RETRY_EXCLUSIVE_STATES],
    edgeCount
  };
}

/** Validated at module load — importing this module proves the table is sound. */
export const RETRY_STATE_MACHINE: RetryStateMachineReport = validateRetryStateMachine();
