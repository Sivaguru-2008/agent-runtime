/**
 * In-memory RecoveryCoordinationStore.
 *
 * The reference implementation of the recovery-coordination CAS. `cas` and
 * `open` are atomic by construction: each method body performs its read and its
 * write with no `await` in between, so under Node's single-threaded event loop
 * no other microtask can interleave a read-then-write window. This is the same
 * "synchronous critical section" guarantee InMemoryLeaseStore /
 * InMemoryRetryCoordinationStore rely on, and it makes the in-memory store a
 * faithful model of the Postgres CTE-under-row-lock the distributed deployment
 * uses (the durable lease's takeoverRecovery already serializes ownership
 * transactionally; this store adds the canonical recovery state + REC1..REC8
 * orchestration on top, which is process-local / reconstructable per the
 * coordination-authority matrix — RETRY_COORDINATION class).
 *
 * Ownership is keyed on a single dimension — the durable lease epoch
 * (`ownerEpoch`) — so arbitration (REC8), exclusivity (REC1), and staleness
 * (REC4) all reduce to one strictly-monotonic comparison.
 */

import {
  type RecoveryCasOutcome,
  type RecoveryCasRequest,
  type RecoveryClaimant,
  type RecoveryCoordinationRecord,
  type RecoveryCoordinationStore
} from "./recoveryOrchestrator.js";
import { assertRecoveryTransition, isRecoveryActive, recoveryStrategyOf } from "./recoveryLifecycle.js";

export class InMemoryRecoveryCoordinationStore implements RecoveryCoordinationStore {
  private readonly records = new Map<string, RecoveryCoordinationRecord>();
  private readonly now: () => Date;

  constructor(opts: { clock?: { now(): Date } } = {}) {
    this.now = opts.clock ? () => opts.clock!.now() : () => new Date();
  }

  async get(executionId: string): Promise<RecoveryCoordinationRecord | undefined> {
    return this.records.get(executionId);
  }

  async listActive(): Promise<RecoveryCoordinationRecord[]> {
    return [...this.records.values()].filter((r) => isRecoveryActive(r.state));
  }

  async open(input: {
    executionId: string;
    claimant: RecoveryClaimant;
    reason?: string;
  }): Promise<{ opened: boolean; record: RecoveryCoordinationRecord }> {
    const current = this.records.get(input.executionId);
    // A live coordination is never disturbed — this is the arbitration gate.
    if (current && isRecoveryActive(current.state)) {
      return { opened: false, record: current };
    }
    const ts = this.now().toISOString();
    const record: RecoveryCoordinationRecord = {
      executionId: input.executionId,
      state: "RECOVERY_PENDING",
      ownerEpoch: input.claimant.ownerEpoch,
      ownerWorkerId: input.claimant.workerId,
      strategy: input.claimant.strategy ?? "NONE",
      priority: input.claimant.priority ?? 0,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      createdAt: current?.createdAt ?? ts,
      updatedAt: ts
    };
    this.records.set(input.executionId, record);
    return { opened: true, record };
  }

  async cas(req: RecoveryCasRequest): Promise<RecoveryCasOutcome> {
    const current = this.records.get(req.executionId);
    if (!current) return { outcome: "MISSING" };

    // State gate.
    if (current.state !== req.expectedFrom) {
      return { outcome: "STALE_STATE", record: current };
    }

    // Legality gate (REC9). Throws on an illegal edge, surfacing an orchestrator
    // logic bug rather than corrupting state.
    assertRecoveryTransition(req.executionId, current.state, req.to);

    // Ownership gate — single dimension: the durable recovery epoch.
    if (req.ownership !== "none") {
      const claimantVal = req.claimant.ownerEpoch;
      const recordVal = current.ownerEpoch;
      if (req.ownership === "monotonic" && claimantVal < recordVal) {
        return { outcome: "STALE_OWNER", record: current };
      }
      if (req.ownership === "exact" && claimantVal !== recordVal) {
        return { outcome: "STALE_OWNER", record: current };
      }
    }

    // Apply.
    const ts = this.now().toISOString();
    let next: RecoveryCoordinationRecord = { ...current, state: req.to, updatedAt: ts };

    if (req.restampOwner) {
      next = {
        ...next,
        ownerEpoch: req.claimant.ownerEpoch,
        ownerWorkerId: req.claimant.workerId,
        strategy: req.claimant.strategy ?? recoveryStrategyOf(req.to)
      };
    }

    if (req.patch) {
      if (req.patch.reason !== undefined) next = { ...next, reason: req.patch.reason };
      if (req.patch.strategy !== undefined) next = { ...next, strategy: req.patch.strategy };
      if (req.patch.priority !== undefined) next = { ...next, priority: req.patch.priority };
    }

    this.records.set(req.executionId, next);
    return { outcome: "APPLIED", record: next };
  }
}
