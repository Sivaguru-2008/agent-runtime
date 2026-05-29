/**
 * Fence protocol scenario suite — docs/specs/fence-state-machine.md.
 *
 * Exercises the FenceProtocol over the InMemoryFenceStore through the full
 * matrix of correctness scenarios the protocol exists to survive:
 *   • crash-before-commit            • concurrent retries
 *   • crash-after-side-effect        • duplicate delivery
 *   • stale worker retries           • replay execution
 *   • reconciliation races
 *
 * Plus the runtime assertion guards: duplicate committed effect, invalid
 * transition, stale lease mutation, missing fence, replay bypass.
 *
 * The InMemoryFenceStore's transitions are atomic (single-threaded event loop),
 * which is exactly the guarantee the Postgres store buys with a row lock — so a
 * race here is modelled by ordering the awaited calls, which is faithful.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryFenceStore } from "../../src/infrastructure/persistence/inMemoryFenceStore.js";
import {
  FenceProtocol,
  StaleFenceOwnerError,
  DuplicateCommittedEffectError,
  MissingFenceError,
  type FenceReserveInput
} from "../../src/runtime/fence/fenceProtocol.js";
import { IllegalFenceTransitionError } from "../../src/runtime/fence/fenceState.js";

function reserveInput(over: Partial<FenceReserveInput> = {}): FenceReserveInput {
  return {
    fenceId: "exec-1:3",
    executionId: "exec-1",
    stepSeq: 3,
    tenantId: "t1",
    toolName: "stripe.refund",
    idempotencyKey: "exec-1:3",
    argsHash: "hashA",
    owner: { workerId: "w1", attempt: 1 },
    ...over
  };
}

describe("fence protocol — happy path & uniqueness", () => {
  let store: InMemoryFenceStore;
  let fence: FenceProtocol;

  beforeEach(() => {
    store = new InMemoryFenceStore();
    fence = new FenceProtocol(store);
  });

  it("reserve → begin → commit records the outcome exactly once", async () => {
    const r = await fence.reserveOrResolve(reserveInput());
    expect(r.kind).toBe("RESERVED");

    const begun = await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    expect(begun.fence.state).toBe("EXECUTING");

    const c = await fence.commit({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 }, output: { ok: true } });
    expect(c.outcome).toBe("COMMITTED");

    const rec = await fence.get("exec-1:3");
    expect(rec?.state).toBe("COMMITTED");
    expect(rec?.output).toEqual({ ok: true });
    expect(rec?.resolution).toBe("COMMITTED");
  });

  it("a retry after commit resolves to the cached output without re-dispatch (F3/F6)", async () => {
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    await fence.commit({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 }, output: { charge: "ch_1" } });

    // Duplicate delivery / retry of the same logical step.
    const retry = await fence.reserveOrResolve(reserveInput({ owner: { workerId: "w2", attempt: 2 } }));
    expect(retry.kind).toBe("RESOLVED_COMMITTED");
    if (retry.kind === "RESOLVED_COMMITTED") {
      expect(retry.output).toEqual({ charge: "ch_1" });
    }
  });
});

describe("fence protocol — crash recovery", () => {
  let store: InMemoryFenceStore;
  let fence: FenceProtocol;
  beforeEach(() => {
    store = new InMemoryFenceStore();
    fence = new FenceProtocol(store);
  });

  it("crash-before-commit: a newer owner finds an EXECUTING fence and quarantines it (AMBIGUOUS)", async () => {
    // Worker 1 begins the side effect, then "crashes" (never commits).
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });

    // Worker 2 (new lease attempt) recovers the execution.
    const recovered = await fence.reserveOrResolve(reserveInput({ owner: { workerId: "w2", attempt: 2 } }));
    expect(recovered.kind).toBe("AMBIGUOUS");
    const rec = await fence.get("exec-1:3");
    expect(rec?.state).toBe("AMBIGUOUS");
    expect(rec?.leaseAttempt).toBe(2);
  });

  it("crash-after-side-effect → reconcile COMMITTED makes the result available, no re-dispatch", async () => {
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    await fence.reserveOrResolve(reserveInput({ owner: { workerId: "w2", attempt: 2 } })); // → AMBIGUOUS

    const claim = await fence.beginReconciliation({ fenceId: "exec-1:3", claimant: { workerId: "w2", attempt: 2 } });
    expect(claim.outcome).toBe("CLAIMED");
    expect(claim.fence?.state).toBe("RECONCILING");

    const resolved = await fence.resolveReconciliation({
      fenceId: "exec-1:3",
      claimant: { workerId: "w2", attempt: 2 },
      verdict: "COMMITTED",
      output: { charge: "ch_recovered" }
    });
    expect(resolved.outcome).toBe("RESOLVED");
    expect(resolved.fence?.state).toBe("RECONCILED");

    // A subsequent reserve returns the reconciled output.
    const after = await fence.reserveOrResolve(reserveInput({ owner: { workerId: "w2", attempt: 2 } }));
    expect(after.kind).toBe("RESOLVED_COMMITTED");
    if (after.kind === "RESOLVED_COMMITTED") expect(after.output).toEqual({ charge: "ch_recovered" });
  });

  it("reconcile NOT-committed routes to FAILED, then re-opens for a safe re-run", async () => {
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    await fence.reserveOrResolve(reserveInput({ owner: { workerId: "w2", attempt: 2 } })); // → AMBIGUOUS
    await fence.beginReconciliation({ fenceId: "exec-1:3", claimant: { workerId: "w2", attempt: 2 } });

    const resolved = await fence.resolveReconciliation({
      fenceId: "exec-1:3",
      claimant: { workerId: "w2", attempt: 2 },
      verdict: "FAILED",
      error: "verified: refund never reached Stripe"
    });
    expect(resolved.outcome).toBe("RESOLVED");
    expect(resolved.fence?.state).toBe("FAILED");

    // Re-running the step re-opens the (restartable) FAILED fence under a fresh attempt.
    const reopened = await fence.reserveOrResolve(reserveInput({ owner: { workerId: "w3", attempt: 3 } }));
    expect(reopened.kind).toBe("RESERVED");
    const rec = await fence.get("exec-1:3");
    expect(rec?.state).toBe("PENDING");
    expect(rec?.leaseAttempt).toBe(3);
    expect(rec?.output).toBeUndefined();
  });
});

describe("fence protocol — stale worker rejection (F4)", () => {
  let store: InMemoryFenceStore;
  let fence: FenceProtocol;
  beforeEach(() => {
    store = new InMemoryFenceStore();
    fence = new FenceProtocol(store);
  });

  it("a stale worker cannot begin a side effect on a fence owned by a newer attempt", async () => {
    // New owner has claimed/reserved at attempt 2.
    await fence.reserveOrResolve(reserveInput({ owner: { workerId: "w2", attempt: 2 } }));
    // Stale worker (attempt 1) tries to begin.
    await expect(
      fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } })
    ).rejects.toBeInstanceOf(StaleFenceOwnerError);
    const rec = await fence.get("exec-1:3");
    expect(rec?.state).toBe("PENDING"); // unchanged — no mutation by the stale worker
    expect(rec?.leaseAttempt).toBe(2);
  });

  it("a stale worker's commit is FENCED (lease flipped mid-call), never applied", async () => {
    // w1 begins at attempt 1.
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    // w2 takes over → EXECUTING becomes AMBIGUOUS@2.
    await fence.reserveOrResolve(reserveInput({ owner: { workerId: "w2", attempt: 2 } }));
    // w1 finishes its in-flight call and tries to commit — it lost the fence.
    const c = await fence.commit({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 }, output: { ok: true } });
    expect(c.outcome).toBe("FENCED");
    const rec = await fence.get("exec-1:3");
    expect(rec?.state).toBe("AMBIGUOUS"); // w1 did NOT overwrite to COMMITTED
    expect(rec?.output).toBeUndefined();
  });

  it("a stale worker cannot re-open a settled fence", async () => {
    // Fence settled FAILED under attempt 2.
    await fence.reserveOrResolve(reserveInput({ owner: { workerId: "w2", attempt: 2 } }));
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w2", attempt: 2 } });
    await fence.fail({ fenceId: "exec-1:3", claimant: { workerId: "w2", attempt: 2 }, error: "boom" });

    // Stale worker (attempt 1) attempts to reopen via reserveOrResolve.
    const stale = await fence.reserveOrResolve(reserveInput({ owner: { workerId: "w1", attempt: 1 } }));
    expect(stale.kind).toBe("STALE");
    const rec = await fence.get("exec-1:3");
    expect(rec?.state).toBe("FAILED");
    expect(rec?.leaseAttempt).toBe(2);
  });
});

describe("fence protocol — concurrency & duplicate delivery", () => {
  let store: InMemoryFenceStore;
  let fence: FenceProtocol;
  beforeEach(() => {
    store = new InMemoryFenceStore();
    fence = new FenceProtocol(store);
  });

  it("concurrent commits at the same attempt admit exactly one (S1/F3)", async () => {
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });

    // Two duplicate deliveries to the same owner both finished the (deduped)
    // remote call and race to commit.
    const c1 = await fence.commit({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 }, output: { n: 1 } });
    const c2 = await fence.commit({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 }, output: { n: 2 } });

    const outcomes = [c1.outcome, c2.outcome].sort();
    expect(outcomes).toEqual(["COMMITTED", "FENCED"]);
    const rec = await fence.get("exec-1:3");
    expect(rec?.state).toBe("COMMITTED");
    expect(rec?.output).toEqual({ n: 1 }); // the first writer won; the second was rejected
  });

  it("duplicate delivery while in-flight reports IN_FLIGHT (caller surrenders to the holder)", async () => {
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    const dup = await fence.reserveOrResolve(reserveInput()); // same owner, same attempt
    expect(dup.kind).toBe("IN_FLIGHT");
  });

  it("concurrent reservers collapse onto a single fence row", async () => {
    const a = await fence.reserveOrResolve(reserveInput({ owner: { workerId: "wA", attempt: 1 } }));
    const b = await fence.reserveOrResolve(reserveInput({ owner: { workerId: "wB", attempt: 1 } }));
    expect(a.kind).toBe("RESERVED");
    expect(b.kind).toBe("RESERVED");
    expect(store.snapshot()).toHaveLength(1);
  });
});

describe("fence protocol — replay (F6)", () => {
  let store: InMemoryFenceStore;
  let fence: FenceProtocol;
  beforeEach(() => {
    store = new InMemoryFenceStore();
    fence = new FenceProtocol(store);
  });

  it("replay with identical args on a committed fence cannot bypass it — returns cached", async () => {
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    await fence.commit({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 }, output: { v: 42 } });

    const replay = await fence.reserveOrResolve(reserveInput({ owner: { workerId: "w1", attempt: 1 } }));
    expect(replay.kind).toBe("RESOLVED_COMMITTED");
  });

  it("replay with drifted args surfaces ARG_DRIFT and never re-dispatches", async () => {
    await fence.reserveOrResolve(reserveInput({ argsHash: "hashA" }));
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    await fence.commit({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 }, output: { v: 1 } });

    const drifted = await fence.reserveOrResolve(reserveInput({ argsHash: "hashB", owner: { workerId: "w2", attempt: 2 } }));
    expect(drifted.kind).toBe("ARG_DRIFT");
    if (drifted.kind === "ARG_DRIFT") {
      expect(drifted.recordedArgsHash).toBe("hashA");
      expect(drifted.observedArgsHash).toBe("hashB");
    }
  });

  it("arg drift is detected even before commit (mid-flight replay divergence)", async () => {
    await fence.reserveOrResolve(reserveInput({ argsHash: "hashA" }));
    const drifted = await fence.reserveOrResolve(reserveInput({ argsHash: "hashB" }));
    expect(drifted.kind).toBe("ARG_DRIFT");
  });
});

describe("fence protocol — reconciliation races", () => {
  let store: InMemoryFenceStore;
  let fence: FenceProtocol;
  beforeEach(() => {
    store = new InMemoryFenceStore();
    fence = new FenceProtocol(store);
  });

  it("only one reconciler claims an AMBIGUOUS fence", async () => {
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    await fence.markAmbiguous({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 }, reason: "self-report" });

    const x = await fence.beginReconciliation({ fenceId: "exec-1:3", claimant: { workerId: "rec-x", attempt: 3 } });
    const y = await fence.beginReconciliation({ fenceId: "exec-1:3", claimant: { workerId: "rec-y", attempt: 2 } });
    expect(x.outcome).toBe("CLAIMED");
    expect(y.outcome).toBe("LOST");
  });

  it("a losing reconciler cannot resolve a fence claimed by another", async () => {
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    await fence.markAmbiguous({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    await fence.beginReconciliation({ fenceId: "exec-1:3", claimant: { workerId: "rec-x", attempt: 3 } });

    // rec-y (attempt 2) never claimed; its resolve must be rejected.
    const lost = await fence.resolveReconciliation({
      fenceId: "exec-1:3",
      claimant: { workerId: "rec-y", attempt: 2 },
      verdict: "COMMITTED",
      output: { sneaky: true }
    });
    expect(lost.outcome).toBe("LOST");
    const rec = await fence.get("exec-1:3");
    expect(rec?.state).toBe("RECONCILING");
  });

  it("inconclusive verification re-quarantines for another pass", async () => {
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    await fence.markAmbiguous({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    await fence.beginReconciliation({ fenceId: "exec-1:3", claimant: { workerId: "rec-x", attempt: 3 } });

    const inconclusive = await fence.resolveReconciliation({
      fenceId: "exec-1:3",
      claimant: { workerId: "rec-x", attempt: 3 },
      verdict: "INCONCLUSIVE"
    });
    expect(inconclusive.outcome).toBe("RESOLVED");
    expect(inconclusive.fence?.state).toBe("AMBIGUOUS");
  });
});

describe("fence protocol — runtime assertion guards", () => {
  let store: InMemoryFenceStore;
  let fence: FenceProtocol;
  beforeEach(() => {
    store = new InMemoryFenceStore();
    fence = new FenceProtocol(store);
  });

  it("F3 — a second commit on a committed fence is FENCED, never double-applied", async () => {
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    await fence.commit({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 }, output: { ok: true } });
    const second = await fence.commit({
      fenceId: "exec-1:3",
      claimant: { workerId: "w1", attempt: 1 },
      output: { ok: false }
    });
    expect(second.outcome).toBe("FENCED");
    expect((await fence.get("exec-1:3"))?.output).toEqual({ ok: true }); // unchanged
  });

  it("F3 — starting a side effect on a committed fence throws DuplicateCommittedEffectError", async () => {
    await fence.reserveOrResolve(reserveInput());
    await fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } });
    await fence.commit({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 }, output: { ok: true } });
    // Bypassing reserveOrResolve's RESOLVED_COMMITTED gate to re-dispatch is a
    // logic bug; the deterministic CAS catches it as a hard stop.
    await expect(
      fence.beginSideEffect({ fenceId: "exec-1:3", claimant: { workerId: "w1", attempt: 1 } })
    ).rejects.toBeInstanceOf(DuplicateCommittedEffectError);
  });

  it("F1 — operating on a missing fence throws MissingFenceError", async () => {
    await expect(
      fence.beginSideEffect({ fenceId: "ghost", claimant: { workerId: "w1", attempt: 1 } })
    ).rejects.toBeInstanceOf(MissingFenceError);
    await expect(
      fence.commit({ fenceId: "ghost", claimant: { workerId: "w1", attempt: 1 }, output: {} })
    ).rejects.toBeInstanceOf(MissingFenceError);
  });

  it("F5 — the store rejects an illegal transition", async () => {
    await store.reserve(reserveInput());
    await expect(
      store.transition({
        fenceId: "exec-1:3",
        expectedFrom: "PENDING",
        to: "COMMITTED", // illegal — must pass through EXECUTING
        claimant: { workerId: "w1", attempt: 1 },
        ownership: "monotonic"
      })
    ).rejects.toBeInstanceOf(IllegalFenceTransitionError);
  });

  it("F4 — the store reports STALE_OWNER and applies nothing for a stale exact-owner write", async () => {
    await store.reserve(reserveInput());
    await store.transition({
      fenceId: "exec-1:3",
      expectedFrom: "PENDING",
      to: "EXECUTING",
      claimant: { workerId: "w1", attempt: 1 },
      ownership: "monotonic"
    });
    // attempt 99 != owner attempt 1 under exact ownership.
    const out = await store.transition({
      fenceId: "exec-1:3",
      expectedFrom: "EXECUTING",
      to: "COMMITTED",
      claimant: { workerId: "wX", attempt: 99 },
      ownership: "exact",
      patch: { output: { hacked: true } }
    });
    expect(out.outcome).toBe("STALE_OWNER");
    const rec = await store.get("exec-1:3");
    expect(rec?.state).toBe("EXECUTING");
    expect(rec?.output).toBeUndefined();
  });

  it("F4 — STALE_STATE is reported when another writer won the race", async () => {
    await store.reserve(reserveInput());
    await store.transition({
      fenceId: "exec-1:3",
      expectedFrom: "PENDING",
      to: "EXECUTING",
      claimant: { workerId: "w1", attempt: 1 },
      ownership: "monotonic"
    });
    // Expecting PENDING but the fence already advanced to EXECUTING.
    const out = await store.transition({
      fenceId: "exec-1:3",
      expectedFrom: "PENDING",
      to: "EXPIRED",
      claimant: { workerId: "w1", attempt: 1 },
      ownership: "monotonic"
    });
    expect(out.outcome).toBe("STALE_STATE");
  });

  it("missing fence transition reports MISSING (no row)", async () => {
    const out = await store.transition({
      fenceId: "nope",
      expectedFrom: "PENDING",
      to: "EXECUTING",
      claimant: { workerId: "w1", attempt: 1 },
      ownership: "monotonic"
    });
    expect(out.outcome).toBe("MISSING");
  });
});
