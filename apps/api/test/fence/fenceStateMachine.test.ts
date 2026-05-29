/**
 * Fence state-machine unit suite — docs/specs/fence-state-machine.md §State machine.
 *
 * These tests pin the *mathematical* properties of the pure state machine:
 * the legal transition table, terminal absorption, restartability, reachability
 * and the structural self-validation. They contain no I/O and no ownership
 * logic — that lives in fenceProtocol.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  FENCE_STATES,
  FENCE_TRANSITIONS,
  FENCE_TERMINAL_STATES,
  FENCE_ACTIVE_STATES,
  FENCE_RESTARTABLE_TERMINALS,
  FENCE_COMMITTED_TERMINALS,
  FENCE_STATE_MACHINE,
  type FenceState,
  assertFenceTransition,
  canFenceTransition,
  isFenceActive,
  isFenceTerminal,
  projectDedupStatus,
  validateFenceStateMachine,
  IllegalFenceTransitionError
} from "../../src/runtime/fence/fenceState.js";

const ALL: FenceState[] = [
  "PENDING",
  "EXECUTING",
  "COMMITTED",
  "FAILED",
  "AMBIGUOUS",
  "RECONCILING",
  "RECONCILED",
  "EXPIRED"
];

describe("fence state machine — shape", () => {
  it("declares exactly the eight canonical states", () => {
    expect(new Set(FENCE_STATES)).toEqual(new Set(ALL));
    expect(FENCE_STATES).toHaveLength(8);
  });

  it("partitions states into terminal and active with no overlap or gap", () => {
    for (const s of ALL) {
      const term = FENCE_TERMINAL_STATES.has(s);
      const active = FENCE_ACTIVE_STATES.has(s);
      expect(term).not.toBe(active); // exactly one
    }
    expect([...FENCE_TERMINAL_STATES].sort()).toEqual(
      ["COMMITTED", "EXPIRED", "FAILED", "RECONCILED"].sort()
    );
    expect([...FENCE_ACTIVE_STATES].sort()).toEqual(
      ["AMBIGUOUS", "EXECUTING", "PENDING", "RECONCILING"].sort()
    );
  });

  it("treats only FAILED and EXPIRED as restartable terminals", () => {
    expect([...FENCE_RESTARTABLE_TERMINALS].sort()).toEqual(["EXPIRED", "FAILED"]);
    for (const r of FENCE_RESTARTABLE_TERMINALS) {
      expect(FENCE_TERMINAL_STATES.has(r)).toBe(true);
      expect([...FENCE_TRANSITIONS[r]]).toEqual(["PENDING"]);
    }
  });

  it("keeps COMMITTED and RECONCILED absorbing", () => {
    expect(FENCE_TRANSITIONS.COMMITTED.size).toBe(0);
    expect(FENCE_TRANSITIONS.RECONCILED.size).toBe(0);
    expect(FENCE_COMMITTED_TERMINALS.has("COMMITTED")).toBe(true);
  });
});

describe("fence state machine — legal transitions", () => {
  const LEGAL: ReadonlyArray<[FenceState, FenceState]> = [
    ["PENDING", "EXECUTING"],
    ["PENDING", "EXPIRED"],
    ["PENDING", "FAILED"],
    ["EXECUTING", "COMMITTED"],
    ["EXECUTING", "FAILED"],
    ["EXECUTING", "AMBIGUOUS"],
    ["AMBIGUOUS", "RECONCILING"],
    ["AMBIGUOUS", "EXPIRED"],
    ["RECONCILING", "RECONCILED"],
    ["RECONCILING", "FAILED"],
    ["RECONCILING", "EXPIRED"],
    ["RECONCILING", "AMBIGUOUS"],
    ["FAILED", "PENDING"],
    ["EXPIRED", "PENDING"]
  ];

  it("admits every legal edge and only legal edges", () => {
    const legalSet = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    for (const from of ALL) {
      for (const to of ALL) {
        if (from === to) {
          expect(canFenceTransition(from, to)).toBe(true); // idempotent no-op
          continue;
        }
        const expected = legalSet.has(`${from}->${to}`);
        expect(canFenceTransition(from, to)).toBe(expected);
      }
    }
  });

  it("assertFenceTransition is a no-op for legal edges and self-edges", () => {
    for (const [from, to] of LEGAL) {
      expect(() => assertFenceTransition("f", from, to)).not.toThrow();
    }
    for (const s of ALL) {
      expect(() => assertFenceTransition("f", s, s)).not.toThrow();
    }
  });

  it("assertFenceTransition throws IllegalFenceTransitionError for illegal edges", () => {
    // A representative sample of illegal edges.
    const illegal: ReadonlyArray<[FenceState, FenceState]> = [
      ["PENDING", "COMMITTED"], // must pass through EXECUTING
      ["PENDING", "RECONCILED"],
      ["EXECUTING", "RECONCILED"],
      ["EXECUTING", "EXPIRED"], // mid-flight loss is AMBIGUOUS, never silently EXPIRED
      ["COMMITTED", "PENDING"], // committed is absorbing
      ["COMMITTED", "FAILED"],
      ["RECONCILED", "PENDING"], // committed-via-reconciliation is absorbing
      ["AMBIGUOUS", "COMMITTED"], // must reconcile first
      ["FAILED", "COMMITTED"] // restart only goes to PENDING
    ];
    for (const [from, to] of illegal) {
      expect(() => assertFenceTransition("fid", from, to)).toThrowError(IllegalFenceTransitionError);
    }
  });

  it("tags illegal-transition errors with invariant F5", () => {
    try {
      assertFenceTransition("fid", "COMMITTED", "EXECUTING");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalFenceTransitionError);
      expect((err as IllegalFenceTransitionError).invariant).toBe("F5");
    }
  });
});

describe("fence state machine — predicates and projection", () => {
  it("isFenceTerminal / isFenceActive agree with the sets", () => {
    for (const s of ALL) {
      expect(isFenceTerminal(s)).toBe(FENCE_TERMINAL_STATES.has(s));
      expect(isFenceActive(s)).toBe(FENCE_ACTIVE_STATES.has(s));
    }
  });

  it("projects legacy dedup statuses onto canonical fence states (safe coarsening)", () => {
    expect(projectDedupStatus("IN_FLIGHT")).toBe("PENDING");
    expect(projectDedupStatus("RESERVED")).toBe("PENDING");
    expect(projectDedupStatus("COMPLETED")).toBe("COMMITTED");
    expect(projectDedupStatus("SUCCEEDED")).toBe("COMMITTED");
    expect(projectDedupStatus("FAILED")).toBe("FAILED");
  });
});

describe("fence state machine — structural self-validation", () => {
  it("validates at module load without throwing", () => {
    expect(() => validateFenceStateMachine()).not.toThrow();
    expect(FENCE_STATE_MACHINE.states).toHaveLength(8);
  });

  it("every state is reachable from PENDING", () => {
    const visited = new Set<FenceState>(["PENDING"]);
    const stack: FenceState[] = ["PENDING"];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const next of FENCE_TRANSITIONS[cur]) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    expect([...visited].sort()).toEqual([...ALL].sort());
  });

  it("reports a stable edge count", () => {
    // 3 + 3 + 0 + 1 + 2 + 4 + 0 + 1 = 14
    expect(FENCE_STATE_MACHINE.edgeCount).toBe(14);
  });
});
