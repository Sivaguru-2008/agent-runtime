/**
 * In-memory FenceStore — the reference implementation of the fence protocol's
 * durable substrate.
 *
 * JavaScript's single-threaded event loop gives us atomicity for free: every
 * method below performs its read → check → write entirely synchronously
 * (no `await` between the compare and the set), so two concurrent callers can
 * never interleave inside a transition. This is exactly the guarantee the
 * Postgres implementation buys with a row lock + single-statement CTE. The
 * two implementations are behaviourally identical for the protocol's purposes;
 * this one is used in tests and single-process dev, the Postgres one in
 * distributed production.
 *
 * Spec: docs/specs/fence-state-machine.md
 */

import {
  type FenceRecord,
  type FenceReserveInput,
  type FenceStore,
  type FenceTransitionOutcome,
  type FenceTransitionRequest
} from "../../runtime/fence/fenceProtocol.js";
import { assertFenceTransition } from "../../runtime/fence/fenceState.js";
import { assertCanonicalOwnershipConsistency } from "../../runtime/canonicalSemantics.js";

export interface InMemoryFenceStoreOptions {
  clock?: { now(): Date };
}

export class InMemoryFenceStore implements FenceStore {
  private readonly byId = new Map<string, FenceRecord>();
  private readonly byStep = new Map<string, string>();
  private readonly now: () => Date;

  constructor(opts: InMemoryFenceStoreOptions = {}) {
    this.now = opts.clock ? () => opts.clock!.now() : () => new Date();
  }

  private stepKey(executionId: string, stepSeq: number): string {
    return `${executionId}::${stepSeq}`;
  }

  async reserve(input: FenceReserveInput): Promise<{ created: boolean; record: FenceRecord }> {
    // F7: a divergent canonical context must never establish a fence.
    assertCanonicalOwnershipConsistency(input.owner, { fenceId: input.fenceId, op: "reserve" });
    const existing = this.byId.get(input.fenceId);
    if (existing) {
      return { created: false, record: existing };
    }
    const ts = this.now().toISOString();
    const record: FenceRecord = {
      fenceId: input.fenceId,
      executionId: input.executionId,
      stepSeq: input.stepSeq,
      tenantId: input.tenantId,
      toolName: input.toolName,
      idempotencyKey: input.idempotencyKey,
      argsHash: input.argsHash,
      state: "PENDING",
      ownerWorkerId: input.owner.workerId,
      leaseAttempt: input.owner.attempt,
      leaseEpoch: input.owner.attempt,
      lease_epoch: input.owner.attempt,
      fencingToken: input.owner.attempt,
      fencing_token: input.owner.attempt,
      ownershipVersion: input.owner.attempt,
      ownership_version: input.owner.attempt,
      workerIdentity: input.owner.workerId,
      worker_identity: input.owner.workerId,
      createdAt: ts,
      updatedAt: ts
    };
    this.byId.set(record.fenceId, record);
    this.byStep.set(this.stepKey(input.executionId, input.stepSeq), record.fenceId);
    return { created: true, record };
  }

  async transition(req: FenceTransitionRequest): Promise<FenceTransitionOutcome> {
    // F7: reject a divergent canonical claimant before any compare-and-set.
    assertCanonicalOwnershipConsistency(req.claimant, { fenceId: req.fenceId, op: "transition", to: req.to });
    const current = this.byId.get(req.fenceId);
    if (!current) return { outcome: "MISSING" };

    // 1. Compare-and-set on state.
    if (current.state !== req.expectedFrom) {
      return { outcome: "STALE_STATE", record: current };
    }

    // 2. Ownership gate (F4). A failed check NEVER mutates.
    if (!ownershipSatisfied(req.ownership, req.claimant.attempt, current.leaseAttempt)) {
      return { outcome: "STALE_OWNER", record: current };
    }

    // 3. Legality gate (F5). Defense-in-depth: protocol methods only pass legal
    //    edges, but the table is the final authority.
    assertFenceTransition(req.fenceId, current.state, req.to);

    // 4. Apply.
    const next: FenceRecord = {
      ...current,
      state: req.to,
      updatedAt: this.now().toISOString(),
      ...(req.restampOwner
        ? {
            ownerWorkerId: req.claimant.workerId,
            leaseAttempt: req.claimant.attempt,
            leaseEpoch: req.claimant.attempt,
            lease_epoch: req.claimant.attempt,
            fencingToken: req.claimant.attempt,
            fencing_token: req.claimant.attempt,
            ownershipVersion: req.claimant.attempt,
            ownership_version: req.claimant.attempt,
            workerIdentity: req.claimant.workerId,
            worker_identity: req.claimant.workerId
          }
        : {})
    };
    applyPatch(next, req.patch);
    this.byId.set(req.fenceId, next);
    return { outcome: "APPLIED", record: next };
  }

  async get(fenceId: string): Promise<FenceRecord | undefined> {
    return this.byId.get(fenceId);
  }

  async getByStep(executionId: string, stepSeq: number): Promise<FenceRecord | undefined> {
    const id = this.byStep.get(this.stepKey(executionId, stepSeq));
    return id ? this.byId.get(id) : undefined;
  }

  /** Test/forensic helper — snapshot of all fence records. */
  snapshot(): FenceRecord[] {
    return [...this.byId.values()];
  }
}

export function ownershipSatisfied(
  mode: FenceTransitionRequest["ownership"],
  claimantAttempt: number,
  ownerAttempt: number
): boolean {
  switch (mode) {
    case "exact":
      return claimantAttempt === ownerAttempt;
    case "monotonic":
      return claimantAttempt >= ownerAttempt;
    case "none":
      return true;
  }
}

/**
 * Apply a transition patch onto a mutable record copy. A key that is *present*
 * in the patch is applied even when its value is `undefined` (an explicit
 * clear — used by reopen to wipe a prior outcome). A key that is *absent* is
 * left untouched.
 */
function applyPatch(target: FenceRecord, patch: FenceTransitionRequest["patch"]): void {
  if (!patch) return;
  const mutable = target as {
    output?: Record<string, unknown> | undefined;
    error?: string | undefined;
    resolution?: FenceRecord["resolution"] | undefined;
    argsHash: string;
  };
  if ("output" in patch) mutable.output = patch.output;
  if ("error" in patch) mutable.error = patch.error;
  if ("resolution" in patch) mutable.resolution = patch.resolution;
  if ("argsHash" in patch && patch.argsHash !== undefined) mutable.argsHash = patch.argsHash;
}
