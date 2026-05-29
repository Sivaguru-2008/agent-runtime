/**
 * Canonical fencing-token enforcement (invariant F7).
 *
 * The runtime models a single, strictly-monotonic fencing token (`attempt`).
 * `lease_epoch`, `fencing_token`, and `ownership_version` are canonical aliases
 * that MUST equal it; `worker_identity` must equal `workerId`. If those aliases
 * were allowed to drift, an ownership check could become fail-open ("ownership
 * resurrection"): a stale holder matching one drifted alias slips through.
 *
 * These tests pin the two enforcement points:
 *   1. assertCanonicalOwnershipConsistency — the pure F7 guard.
 *   2. The fence store / protocol — every reserve and every CAS transition runs
 *      the guard, so a divergent canonical context can never reach durable
 *      state. Plus the ordinary stale-epoch rejection (a zombie attempt cannot
 *      mutate a fence restamped to a newer attempt).
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  assertCanonicalOwnershipConsistency,
  canonicalEpochOf,
  InvariantViolation
} from "../../src/runtime/canonicalSemantics.js";
import { InMemoryFenceStore } from "../../src/infrastructure/persistence/inMemoryFenceStore.js";
import {
  FenceProtocol,
  type FenceReserveInput
} from "../../src/runtime/fence/fenceProtocol.js";

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

describe("F7 — canonical ownership consistency assertion", () => {
  it("accepts a context with no aliases (derived from attempt by the store)", () => {
    expect(() =>
      assertCanonicalOwnershipConsistency({ workerId: "w1", attempt: 5 })
    ).not.toThrow();
    expect(canonicalEpochOf({ workerId: "w1", attempt: 5 })).toBe(5);
  });

  it("accepts a fully-specified, internally-consistent context", () => {
    expect(() =>
      assertCanonicalOwnershipConsistency({
        workerId: "w1",
        attempt: 7,
        leaseEpoch: 7,
        lease_epoch: 7,
        fencingToken: 7,
        fencing_token: 7,
        ownershipVersion: 7,
        ownership_version: 7,
        workerIdentity: "w1",
        worker_identity: "w1"
      })
    ).not.toThrow();
  });

  it("rejects a non-positive / non-integer fencing token (L1)", () => {
    expect(() => assertCanonicalOwnershipConsistency({ workerId: "w1", attempt: 0 })).toThrow(
      InvariantViolation
    );
    expect(() => assertCanonicalOwnershipConsistency({ workerId: "w1", attempt: -3 })).toThrow();
    expect(() => assertCanonicalOwnershipConsistency({ workerId: "w1", attempt: 1.5 })).toThrow();
  });

  it.each([
    ["leaseEpoch", { leaseEpoch: 9 }],
    ["lease_epoch", { lease_epoch: 9 }],
    ["fencingToken", { fencingToken: 9 }],
    ["fencing_token", { fencing_token: 9 }],
    ["ownershipVersion", { ownershipVersion: 9 }],
    ["ownership_version", { ownership_version: 9 }]
  ])("rejects a divergent epoch alias (%s)", (_name, alias) => {
    expect(() =>
      assertCanonicalOwnershipConsistency({ workerId: "w1", attempt: 4, ...alias })
    ).toThrow(/diverges from fencing token/);
  });

  it.each([
    ["workerIdentity", { workerIdentity: "intruder" }],
    ["worker_identity", { worker_identity: "intruder" }]
  ])("rejects a divergent identity alias (%s)", (_name, alias) => {
    expect(() =>
      assertCanonicalOwnershipConsistency({ workerId: "w1", attempt: 4, ...alias })
    ).toThrow(/diverges from workerId/);
  });
});

describe("F7 — fence protocol rejects divergent canonical claimants", () => {
  let store: InMemoryFenceStore;
  let fence: FenceProtocol;

  beforeEach(() => {
    store = new InMemoryFenceStore();
    fence = new FenceProtocol(store);
  });

  it("reserveOrResolve refuses a claimant whose fencing_token disagrees with attempt", async () => {
    await expect(
      fence.reserveOrResolve(
        reserveInput({ owner: { workerId: "w1", attempt: 2, fencingToken: 99 } })
      )
    ).rejects.toThrow(/diverges from fencing token/);
    // Nothing was persisted.
    expect(await fence.get("exec-1:3")).toBeUndefined();
  });

  it("beginSideEffect refuses a claimant with a forged worker_identity", async () => {
    await fence.reserveOrResolve(reserveInput());
    await expect(
      fence.beginSideEffect({
        fenceId: "exec-1:3",
        claimant: { workerId: "w1", attempt: 1, worker_identity: "intruder" }
      })
    ).rejects.toThrow(/diverges from workerId/);
    // Fence stayed PENDING — no EXECUTING leaked through.
    expect((await fence.get("exec-1:3"))?.state).toBe("PENDING");
  });
});

describe("F7 — ownership resurrection is impossible after a newer attempt restamps", () => {
  let store: InMemoryFenceStore;
  let fence: FenceProtocol;

  beforeEach(() => {
    store = new InMemoryFenceStore();
    fence = new FenceProtocol(store);
  });

  it("a stale (older) attempt cannot begin a side effect once a newer owner restamped the fence", async () => {
    // Worker w2 (attempt 2) reserves and owns the fence.
    await fence.reserveOrResolve(reserveInput({ owner: { workerId: "w2", attempt: 2 } }));
    const begun = await fence.beginSideEffect({
      fenceId: "exec-1:3",
      claimant: { workerId: "w2", attempt: 2 }
    });
    expect(begun.fence.state).toBe("EXECUTING");
    expect(begun.fence.leaseAttempt).toBe(2);

    // A zombie w1 at the older attempt 1 tries to commit — it must be FENCED,
    // never applied. The canonical epoch of the live owner (2) dominates.
    const c = await fence.commit({
      fenceId: "exec-1:3",
      claimant: { workerId: "w1", attempt: 1 },
      output: { charge: "zombie" }
    });
    expect(c.outcome).toBe("FENCED");

    const rec = await fence.get("exec-1:3");
    expect(rec?.state).toBe("EXECUTING");
    expect(rec?.output).toBeUndefined();
  });
});
