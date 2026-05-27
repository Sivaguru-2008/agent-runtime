import type { AgentRole, CognitionPhase } from "../../domain/cognition.js";

/**
 * Cognition State Machine.
 *
 * Drives the multi-agent loop:
 *
 *   INIT → PLAN → EXECUTE → VERIFY ─┬─ pass ─→ CRITIQUE → MEMORY_COMMIT → COMPLETE
 *                                   └─ fail ─→ EXECUTE (retry budget)
 *
 * The transitions are pure / deterministic. Side-effects live in the
 * orchestrator that wraps this machine.
 */
export interface StateContext {
  retryBudget: number;
  retriesUsed: number;
}

export interface Transition {
  from: CognitionPhase;
  to: CognitionPhase;
  role: AgentRole;
  /** Whether this transition consumes the retry budget. */
  consumesRetry?: boolean;
}

const ROLE_BY_PHASE: Record<CognitionPhase, AgentRole | undefined> = {
  INIT: "PLANNER",
  PLAN: "PLANNER",
  EXECUTE: "EXECUTOR",
  VERIFY: "VERIFIER",
  CRITIQUE: "CRITIC",
  MEMORY_COMMIT: "MEMORY_MANAGER",
  COMPLETE: undefined,
  FAILED: undefined
};

export class CognitionStateMachine {
  static initialPhase(): CognitionPhase {
    return "INIT";
  }

  static roleForPhase(phase: CognitionPhase): AgentRole | undefined {
    return ROLE_BY_PHASE[phase];
  }

  /**
   * Compute the next transition based on the current phase, the role result,
   * and the state context (retries). Returns null when terminal.
   */
  static next(
    current: CognitionPhase,
    requested: CognitionPhase,
    ctx: StateContext
  ): Transition | null {
    if (current === "FAILED" || current === "COMPLETE") return null;
    // Honour retry budget: VERIFY→EXECUTE only allowed within budget.
    if (current === "VERIFY" && requested === "EXECUTE") {
      if (ctx.retriesUsed >= ctx.retryBudget) {
        return { from: current, to: "FAILED", role: "VERIFIER" };
      }
      const role = ROLE_BY_PHASE[requested];
      if (!role) return null;
      return { from: current, to: requested, role, consumesRetry: true };
    }
    if (requested === "FAILED" || requested === "COMPLETE") {
      const role = ROLE_BY_PHASE[current] ?? "EXECUTOR";
      return { from: current, to: requested, role };
    }
    const role = ROLE_BY_PHASE[requested];
    if (!role) return null;
    return { from: current, to: requested, role };
  }

  static isTerminal(phase: CognitionPhase): boolean {
    return phase === "COMPLETE" || phase === "FAILED";
  }
}
