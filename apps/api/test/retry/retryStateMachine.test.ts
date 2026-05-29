import { describe, expect, it } from "vitest";
import {
  RETRY_ACTIVE_STATES,
  RETRY_EXCLUSIVE_STATES,
  RETRY_STATES,
  RETRY_STATE_MACHINE,
  RETRY_TERMINAL_STATES,
  RETRY_TRANSITIONS,
  IllegalRetryTransitionError,
  assertRetryTransition,
  canRetryTransition,
  isRetryActive,
  isRetryExclusive,
  isRetryTerminal,
  validateRetryStateMachine
} from "../../src/runtime/retry/retryState.js";

describe("canonical retry state machine", () => {
  it("declares the six required coordination states plus a settled terminal", () => {
    for (const required of [
      "RETRY_PENDING",
      "RETRY_SCHEDULED",
      "RETRY_EXECUTING",
      "RETRY_BLOCKED",
      "RETRY_RECONCILING",
      "RETRY_ABORTED"
    ] as const) {
      expect(RETRY_STATES).toContain(required);
    }
    expect(RETRY_STATES).toContain("RETRY_SETTLED");
  });

  it("self-validates structure at module load", () => {
    const report = RETRY_STATE_MACHINE;
    expect(report.states.length).toBe(RETRY_STATES.length);
    expect([...report.terminalStates].sort()).toEqual(["RETRY_ABORTED", "RETRY_SETTLED"]);
    expect(report.edgeCount).toBeGreaterThan(0);
    // Re-running the validator must not throw.
    expect(() => validateRetryStateMachine()).not.toThrow();
  });

  it("partitions every state into exactly one of active/terminal", () => {
    for (const state of RETRY_STATES) {
      expect(isRetryActive(state) !== isRetryTerminal(state)).toBe(true);
    }
    expect([...RETRY_ACTIVE_STATES].length + [...RETRY_TERMINAL_STATES].length).toBe(RETRY_STATES.length);
  });

  it("keeps every terminal absorbing (no outgoing edges)", () => {
    for (const terminal of RETRY_TERMINAL_STATES) {
      expect(RETRY_TRANSITIONS[terminal].size).toBe(0);
    }
  });

  it("treats exclusive states as a subset of active states", () => {
    for (const ex of RETRY_EXCLUSIVE_STATES) {
      expect(isRetryExclusive(ex)).toBe(true);
      expect(RETRY_ACTIVE_STATES.has(ex)).toBe(true);
    }
  });

  it("admits the canonical happy path PENDING→SCHEDULED→EXECUTING→SETTLED", () => {
    expect(() => assertRetryTransition("e", "RETRY_PENDING", "RETRY_SCHEDULED")).not.toThrow();
    expect(() => assertRetryTransition("e", "RETRY_SCHEDULED", "RETRY_EXECUTING")).not.toThrow();
    expect(() => assertRetryTransition("e", "RETRY_EXECUTING", "RETRY_SETTLED")).not.toThrow();
  });

  it("admits the failure/retry loop EXECUTING→PENDING→SCHEDULED", () => {
    expect(canRetryTransition("RETRY_EXECUTING", "RETRY_PENDING")).toBe(true);
    expect(canRetryTransition("RETRY_PENDING", "RETRY_SCHEDULED")).toBe(true);
  });

  it("admits the ambiguity quarantine path into and out of RECONCILING", () => {
    expect(canRetryTransition("RETRY_EXECUTING", "RETRY_RECONCILING")).toBe(true);
    expect(canRetryTransition("RETRY_RECONCILING", "RETRY_PENDING")).toBe(true); // NOT_COMMITTED → retry
    expect(canRetryTransition("RETRY_RECONCILING", "RETRY_SETTLED")).toBe(true); // COMMITTED → done
    expect(canRetryTransition("RETRY_RECONCILING", "RETRY_ABORTED")).toBe(true); // abandoned
  });

  it("treats self-transitions as idempotent no-ops", () => {
    for (const state of RETRY_STATES) {
      expect(() => assertRetryTransition("e", state, state)).not.toThrow();
      expect(canRetryTransition(state, state)).toBe(true);
    }
  });

  it("rejects illegal edges with a classified IllegalRetryTransitionError", () => {
    // SCHEDULED cannot jump straight back to PENDING (must go via BLOCKED/EXECUTING).
    expect(() => assertRetryTransition("e", "RETRY_SCHEDULED", "RETRY_PENDING")).toThrow(IllegalRetryTransitionError);
    // A terminal can never re-open.
    expect(() => assertRetryTransition("e", "RETRY_SETTLED", "RETRY_PENDING")).toThrow(IllegalRetryTransitionError);
    expect(() => assertRetryTransition("e", "RETRY_ABORTED", "RETRY_SCHEDULED")).toThrow(IllegalRetryTransitionError);
    try {
      assertRetryTransition("exec-x", "RETRY_RECONCILING", "RETRY_EXECUTING");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalRetryTransitionError);
      expect((err as IllegalRetryTransitionError).invariant).toBe("RT5");
    }
  });

  it("makes both terminals reachable from every active state (settle/abort anywhere)", () => {
    for (const active of RETRY_ACTIVE_STATES) {
      expect(canRetryTransition(active, "RETRY_ABORTED")).toBe(true);
      if (active !== "RETRY_EXECUTING") {
        // EXECUTING settles via its own SETTLED edge too.
        expect(canRetryTransition(active, "RETRY_SETTLED")).toBe(true);
      }
    }
    expect(canRetryTransition("RETRY_EXECUTING", "RETRY_SETTLED")).toBe(true);
  });
});
