import { describe, expect, it } from "vitest";
import { assertTransition, LEGAL_TRANSITIONS, IllegalTransitionError } from "../src/runtime/stateMachine.js";
import type { ExecutionStatus } from "../src/domain/model.js";

describe("Execution State Machine canonical transitions", () => {
  it("allows all defined legal transitions", () => {
    for (const [from, allowed] of Object.entries(LEGAL_TRANSITIONS) as [ExecutionStatus, Set<ExecutionStatus>][]) {
      for (const to of allowed) {
        expect(() => assertTransition("test-exec", from, to)).not.toThrow();
      }
    }
  });

  it("rejects illegal transitions with IllegalTransitionError", () => {
    const allStates: ExecutionStatus[] = [
      "CREATION",
      "SCHEDULING",
      "LEASE_ACQUISITION",
      "RUNNING",
      "SIDE_EFFECT_PENDING",
      "REPLAYING",
      "RECOVERING",
      "COMMITTED",
      "COMPLETED",
      "FAILED",
      "AMBIGUOUS",
      "RECONCILIATION_REQUIRED",
      "DEAD_LETTERED",
      "EXPIRED",
      "QUEUED",
      "CANCELLED"
    ];

    for (const from of allStates) {
      const allowed = LEGAL_TRANSITIONS[from];
      for (const to of allStates) {
        if (from !== to && (!allowed || !allowed.has(to))) {
          expect(() => assertTransition("test-exec", from, to)).toThrow(IllegalTransitionError);
        }
      }
    }
  });

  it("handles identical-state transitions as no-ops", () => {
    const allStates: ExecutionStatus[] = [
      "CREATION",
      "SCHEDULING",
      "LEASE_ACQUISITION",
      "RUNNING",
      "SIDE_EFFECT_PENDING",
      "REPLAYING",
      "RECOVERING",
      "COMMITTED",
      "COMPLETED",
      "FAILED",
      "AMBIGUOUS",
      "RECONCILIATION_REQUIRED",
      "DEAD_LETTERED",
      "EXPIRED",
      "QUEUED",
      "CANCELLED"
    ];
    for (const state of allStates) {
      expect(() => assertTransition("test-exec", state, state)).not.toThrow();
    }
  });
});
