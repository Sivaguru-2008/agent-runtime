/**
 * In-memory RetryCoordinationStore.
 *
 * The reference implementation of the retry-coordination CAS. `cas` and `open`
 * are atomic by construction: each method body performs its read and its write
 * with no `await` in between, so under Node's single-threaded event loop no
 * other microtask can interleave a read-then-write window. This is the same
 * "synchronous critical section" guarantee InMemoryLeaseStore /
 * InMemoryFenceStore rely on, and it makes the in-memory store a faithful model
 * of the Postgres CTE-under-row-lock the distributed deployment uses.
 *
 * Production cross-process coordination is provided by the durable lease store
 * (which already serialises ownership transactionally); this store provides the
 * in-process single-flight, arbitration, storm, and backpressure layer plus the
 * canonical retry state model and its RT1..RT8 assertions.
 */

import {
  type OwnershipKey,
  type RetryCasOutcome,
  type RetryCasRequest,
  type RetryClaimant,
  type RetryCoordinationRecord,
  type RetryCoordinationStore
} from "./retryCoordinator.js";
import { assertRetryTransition, isRetryActive } from "./retryState.js";

export class InMemoryRetryCoordinationStore implements RetryCoordinationStore {
  private readonly records = new Map<string, RetryCoordinationRecord>();
  private readonly now: () => Date;

  constructor(opts: { clock?: { now(): Date } } = {}) {
    this.now = opts.clock ? () => opts.clock!.now() : () => new Date();
  }

  async get(executionId: string): Promise<RetryCoordinationRecord | undefined> {
    return this.records.get(executionId);
  }

  async listActive(): Promise<RetryCoordinationRecord[]> {
    return [...this.records.values()].filter((r) => isRetryActive(r.state));
  }

  async open(input: {
    executionId: string;
    claimant: RetryClaimant;
    reason?: string;
  }): Promise<{ opened: boolean; record: RetryCoordinationRecord }> {
    const current = this.records.get(input.executionId);
    // A live coordination is never disturbed — this is the single-flight gate.
    if (current && isRetryActive(current.state)) {
      return { opened: false, record: current };
    }
    const ts = this.now().toISOString();
    const record: RetryCoordinationRecord = {
      executionId: input.executionId,
      state: "RETRY_PENDING",
      attempt: input.claimant.attempt,
      ...(input.claimant.ownerEpoch !== undefined ? { ownerEpoch: input.claimant.ownerEpoch } : {}),
      ownerWorkerId: input.claimant.workerId,
      mode: input.claimant.mode,
      ...(input.claimant.parentExecutionId !== undefined ? { parentExecutionId: input.claimant.parentExecutionId } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      createdAt: current?.createdAt ?? ts,
      updatedAt: ts
    };
    this.records.set(input.executionId, record);
    return { opened: true, record };
  }

  async cas(req: RetryCasRequest): Promise<RetryCasOutcome> {
    const current = this.records.get(req.executionId);
    if (!current) return { outcome: "MISSING" };

    // State gate.
    if (current.state !== req.expectedFrom) {
      return { outcome: "STALE_STATE", record: current };
    }

    // Legality gate (F5-equivalent for retries — RT5). Throws on an illegal
    // edge, surfacing a coordinator logic bug rather than corrupting state.
    assertRetryTransition(req.executionId, current.state, req.to);

    // Ownership gate.
    const key: OwnershipKey = req.ownershipKey ?? "attempt";
    if (req.ownership !== "none") {
      const claimantVal = key === "ownerEpoch" ? req.claimant.ownerEpoch : req.claimant.attempt;
      const recordVal = key === "ownerEpoch" ? current.ownerEpoch : current.attempt;
      if (claimantVal === undefined) {
        return { outcome: "STALE_OWNER", record: current };
      }
      if (recordVal !== undefined) {
        if (req.ownership === "monotonic" && claimantVal < recordVal) {
          return { outcome: "STALE_OWNER", record: current };
        }
        if (req.ownership === "exact" && claimantVal !== recordVal) {
          return { outcome: "STALE_OWNER", record: current };
        }
      }
    }

    // Apply.
    const ts = this.now().toISOString();
    let next: RetryCoordinationRecord = { ...current, state: req.to, updatedAt: ts };

    if (req.restampOwner) {
      next = {
        ...next,
        ownerWorkerId: req.claimant.workerId,
        mode: req.claimant.mode,
        ...(req.claimant.parentExecutionId !== undefined ? { parentExecutionId: req.claimant.parentExecutionId } : {})
      };
      if (key === "attempt") {
        next = { ...next, attempt: req.claimant.attempt };
      } else if (req.claimant.ownerEpoch !== undefined) {
        next = { ...next, ownerEpoch: req.claimant.ownerEpoch };
      }
    }

    if (req.patch) {
      if (req.patch.reason !== undefined) next = { ...next, reason: req.patch.reason };
      if (req.patch.scheduledFor !== undefined) next = { ...next, scheduledFor: req.patch.scheduledFor };
      if (req.patch.ownerEpoch !== undefined) next = { ...next, ownerEpoch: req.patch.ownerEpoch };
      if (req.patch.mode !== undefined) next = { ...next, mode: req.patch.mode };
    }

    this.records.set(req.executionId, next);
    return { outcome: "APPLIED", record: next };
  }
}
