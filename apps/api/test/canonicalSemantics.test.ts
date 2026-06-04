import { describe, expect, it } from "vitest";
import {
  AmbiguityDetectedError,
  FAILURE_CODES,
  RECOVERABLE_BY_DEFAULT,
  RECOVERY_SEMANTICS_MAP,
  assertRetryAllowed,
  assertTransition,
  classifyRuntimeFailure,
  runStructuralValidation,
  validateFencingToken,
  validateRecoveryTable,
  validateReplayAction
} from "../src/runtime/canonicalSemantics.js";

describe("canonical runtime semantics constitution", () => {
  it("self-validates states, invariants, and recovery categories", () => {
    const result = runStructuralValidation();

    expect(result.states).toContain("RECOVERING");
    expect(result.states).toContain("RECONCILIATION_REQUIRED");
    expect(result.failureCategories).toContain("PARTIAL_COMMIT");
    expect(result.failureCategories).toContain("REPLAY_DIVERGENCE");
    expect(result.invariantIds).toContain("RP1");
    expect(result.invariantIds).toContain("L2");
  });

  it("simulates distributed recovery through legal transitions and retry policy", () => {
    expect(() => assertTransition("exec-recover", "QUEUED", "LEASE_ACQUISITION")).not.toThrow();
    expect(() => assertTransition("exec-recover", "LEASE_ACQUISITION", "RUNNING")).not.toThrow();
    expect(() => assertTransition("exec-recover", "RUNNING", "EXPIRED")).not.toThrow();
    expect(() => assertTransition("exec-recover", "EXPIRED", "RECONCILIATION_REQUIRED")).not.toThrow();
    expect(() => assertTransition("exec-recover", "RECONCILIATION_REQUIRED", "RECOVERING")).not.toThrow();
    expect(() => assertTransition("exec-recover", "RECOVERING", "RUNNING")).not.toThrow();

    validateFencingToken({
      executionId: "exec-recover",
      workerId: "worker-recovery",
      attempt: 2,
      currentStatus: "RECOVERING",
      targetStatus: "RUNNING",
      phase: "distributed-recovery"
    });
    expect(() => assertRetryAllowed("LEASE_EXPIRY", "exec-recover")).not.toThrow();
  });

  it("allows direct recovery transitions from active executing states", () => {
    expect(() => assertTransition("exec-recover", "RUNNING", "RECOVERING")).not.toThrow();
    expect(() => assertTransition("exec-recover", "SIDE_EFFECT_PENDING", "RECOVERING")).not.toThrow();
    expect(() => assertTransition("exec-recover", "REPLAYING", "RECOVERING")).not.toThrow();
    expect(() => assertTransition("exec-recover", "RECOVERING", "REPLAYING")).not.toThrow();
  });

  it("blocks replay divergence from executing unsafe side effects", () => {
    expect(() =>
      validateReplayAction({
        executionId: "exec-replay",
        stepType: "TOOL_CALL",
        toolName: "web.search",
        activeReplayState: { diverged: true, safety: "replay-diverged" }
      })
    ).not.toThrow();

    expect(() =>
      validateReplayAction({
        executionId: "exec-replay",
        stepType: "TOOL_CALL",
        toolName: "sandbox.payment_refund",
        activeReplayState: { diverged: true, safety: "replay-diverged" }
      })
    ).toThrow(/Replay Side-Effect Mutex violation/);

    expect(() => assertRetryAllowed("REPLAY_DIVERGENCE", "exec-replay")).toThrow(
      /Unsafe retry blocked/
    );
  });

  it("rejects stale lease mutations before durable state changes", () => {
    expect(() =>
      validateFencingToken({
        executionId: "exec-stale",
        workerId: "worker-old",
        attempt: 0,
        currentStatus: "RUNNING",
        targetStatus: "COMPLETED",
        phase: "terminal-write"
      })
    ).toThrow(/\[invariant:L1\]/);

    const failure = classifyRuntimeFailure(
      Object.assign(new Error("lease stolen during final write"), { name: "FencingViolationError" })
    );
    expect(failure.category).toBe("LEASE_STOLEN");
    expect(failure.recoverable).toBe(true);
  });

  it("models ambiguity escalation as quarantine before recovery", () => {
    const ambiguity = new AmbiguityDetectedError({
      executionId: "exec-ambiguous",
      toolName: "sandbox.payment_refund",
      args: { amount: 1200 },
      idempotencyKey: "idem-ambiguous",
      stepSequence: 3
    });

    expect(classifyRuntimeFailure(ambiguity).category).toBe("AMBIGUOUS_EXTERNAL_COMMIT");
    expect(() => assertTransition("exec-ambiguous", "SIDE_EFFECT_PENDING", "AMBIGUOUS")).not.toThrow();
    expect(() => assertTransition("exec-ambiguous", "AMBIGUOUS", "RECONCILIATION_REQUIRED")).not.toThrow();
    expect(() => assertTransition("exec-ambiguous", "RECONCILIATION_REQUIRED", "RECOVERING")).not.toThrow();
  });

  it("separates partial-failure reconciliation from unsafe concurrent retries", () => {
    expect(RECOVERY_SEMANTICS_MAP.PARTIAL_COMMIT.retryable).toBe(true);
    expect(RECOVERY_SEMANTICS_MAP.PARTIAL_COMMIT.replayable).toBe(false);
    expect(RECOVERY_SEMANTICS_MAP.PARTIAL_COMMIT.reconcilable).toBe(true);

    expect(() => assertRetryAllowed("TOOL_TIMEOUT", "exec-retry")).not.toThrow();
    expect(() => assertRetryAllowed("TOOL_NON_IDEMPOTENT", "exec-retry")).toThrow(
      /Unsafe retry blocked/
    );

    for (const attempt of [1, 2, 3]) {
      expect(() =>
        validateFencingToken({
          executionId: "exec-retry",
          workerId: `worker-${attempt}`,
          attempt,
          currentStatus: "FAILED",
          targetStatus: "LEASE_ACQUISITION",
          phase: "concurrent-retry"
        })
      ).not.toThrow();
    }
  });
});

describe("recovery-table consistency validator", () => {
  it("accepts the live failure taxonomy and returns every category", () => {
    const categories = validateRecoveryTable(
      FAILURE_CODES,
      RECOVERABLE_BY_DEFAULT,
      RECOVERY_SEMANTICS_MAP
    );
    expect(categories.length).toBe(Object.keys(FAILURE_CODES).length);
    expect(categories).toContain("REPLAY_DIVERGENCE");
  });

  it("rejects a category whose recoverability disagrees with retryable/replayable", () => {
    expect(() =>
      validateRecoveryTable(
        { TOOL_TIMEOUT: "TOOL_TIMEOUT" },
        { TOOL_TIMEOUT: false }, // claims non-recoverable...
        { TOOL_TIMEOUT: { retryable: true, replayable: true, reconcilable: false, terminal: false, requiresHumanIntervention: false } } // ...but is retryable
      )
    ).toThrow(/must equal \(retryable OR replayable\)/);
  });

  it("rejects a terminal failure that is also retryable or replayable", () => {
    expect(() =>
      validateRecoveryTable(
        { STALE_WORKER_MUTATION: "STALE_WORKER_MUTATION" },
        { STALE_WORKER_MUTATION: true },
        { STALE_WORKER_MUTATION: { retryable: true, replayable: false, reconcilable: false, terminal: true, requiresHumanIntervention: false } }
      )
    ).toThrow(/terminal failure .* cannot be retryable or replayable/);
  });

  it("rejects a failure code that does not round-trip to its category key", () => {
    expect(() =>
      validateRecoveryTable(
        { TOOL_TIMEOUT: "WRONG_CODE" },
        { TOOL_TIMEOUT: true },
        { TOOL_TIMEOUT: { retryable: true, replayable: false, reconcilable: false, terminal: false, requiresHumanIntervention: false } }
      )
    ).toThrow(/must round-trip to its category key/);
  });

  it("rejects a category missing its recovery semantics", () => {
    expect(() =>
      validateRecoveryTable(
        { TOOL_TIMEOUT: "TOOL_TIMEOUT" },
        { TOOL_TIMEOUT: true },
        {} // no semantics
      )
    ).toThrow(/missing recovery semantics/);
  });
});
