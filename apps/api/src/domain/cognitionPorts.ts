import type { CognitionGraph, CognitionNode, NodeLineage } from "./cognition.js";
import type { BranchPointer, ReplayCertification, ReplaySession, ReplaySnapshot } from "./replay.js";
import type { FailureSignal } from "./failure.js";

export interface CognitionRepository {
  save(graph: CognitionGraph): Promise<void>;
  upsertNode(node: CognitionNode): Promise<void>;
  getById(id: string): Promise<CognitionGraph | undefined>;
  getByExecution(executionId: string): Promise<CognitionGraph | undefined>;
  listRecent(limit: number): Promise<CognitionGraph[]>;
  listChildren(parentCognitionId: string): Promise<CognitionGraph[]>;
}

export interface LineageStore {
  recordParent(child: string, parent: string): Promise<void>;
  recordSibling(a: string, b: string): Promise<void>;
  getLineage(nodeId: string): Promise<NodeLineage | undefined>;
  listFamily(rootNodeId: string): Promise<NodeLineage[]>;
}

/**
 * Optional read-time controls for SnapshotStore.listByCognition.
 *
 * Task A2 hardening: listByCognition() is fail-closed by default — every
 * snapshot it returns has been integrity-verified. Rendering an
 * unverified snapshot in the operator timeline UI would let silent
 * corruption flow into operator decisions (branch-from-here, replay,
 * remediation), so the default must NOT bypass.
 *
 * Forensic admin endpoints occasionally need to surface the raw bytes of
 * a corrupt snapshot to diagnose tampering — that is what
 * `bypassIntegrityForForensics` is for. It MUST only be set by handlers
 * behind an admin/forensic permission gate; ordinary operator endpoints
 * (including the timeline view) must never set it.
 */
export interface SnapshotListOptions {
  /**
   * Explicit forensic-only bypass. When true, listByCognition returns
   * snapshots WITHOUT verifying their integrity hash and WITHOUT throwing
   * on mismatch. The store still invokes the integrity reporter for every
   * mismatch so the SNAPSHOT_INTEGRITY_VIOLATED event reaches the bus —
   * forensic surfacing should not silence corruption telemetry.
   *
   * Default: false (fail-closed).
   */
  bypassIntegrityForForensics?: boolean;
}

export interface SnapshotStore {
  put(snapshot: ReplaySnapshot): Promise<void>;
  get(snapshotId: string): Promise<ReplaySnapshot | undefined>;
  /**
   * List snapshots for a cognition in frame_index order.
   *
   * Fail-closed by default: any row whose integrity hash does not match a
   * recompute throws SnapshotCorruptionError before any row is returned.
   * Pass `{ bypassIntegrityForForensics: true }` ONLY from explicit
   * admin/forensic endpoints — see SnapshotListOptions.
   */
  listByCognition(cognitionId: string, options?: SnapshotListOptions): Promise<ReplaySnapshot[]>;
  /** Nearest snapshot at or before `frameIndex`. */
  nearest(cognitionId: string, frameIndex: number): Promise<ReplaySnapshot | undefined>;
  /**
   * Phase C: wire a reporter the store invokes whenever integrity validation
   * detects a mismatch on get() / nearest() / list. The runtime container
   * wires this to the event publisher so SNAPSHOT_INTEGRITY_VIOLATED reaches
   * the bus before the typed SnapshotCorruptionError is thrown. Optional —
   * when absent, the store still throws but emits nothing.
   */
  setIntegrityViolationReporter?(reporter: SnapshotIntegrityViolationReporter): void;
}

/**
 * Phase C: integrity-violation reporter. Called by SnapshotStore.get/nearest
 * (and put, when a caller's pre-stamped hash mismatches the recompute)
 * before the typed SnapshotCorruptionError is thrown. The reporter is
 * fire-and-forget — the store does not await it, so a slow event publish
 * cannot block recovery from failing fast.
 *
 * `operation` disambiguates the read path that surfaced the violation so
 * operators reproducing the bug know which call site to attach to.
 */
export type SnapshotIntegrityViolationReporter = (violation: {
  snapshotId: string;
  cognitionId: string;
  executionId: string;
  frameIndex: number;
  storedHash: string | null;
  computedHash: string;
  /**
   * Read path that surfaced the violation. "list" was added in Task A2 so
   * listByCognition() can no longer silently render corrupted snapshots
   * into the operator timeline. "put" appears when a caller-supplied hash
   * disagrees with a recompute at write time.
   */
  operation: "get" | "nearest" | "put" | "list";
}) => void;

export interface ReplaySessionStore {
  put(session: ReplaySession): Promise<void>;
  get(sessionId: string): Promise<ReplaySession | undefined>;
  listByCognition(cognitionId: string): Promise<ReplaySession[]>;
}

export interface BranchRegistry {
  record(pointer: BranchPointer): Promise<void>;
  listForCognition(cognitionId: string): Promise<BranchPointer[]>;
  listAll(): Promise<BranchPointer[]>;
}

export interface FailureSignalStore {
  record(signal: FailureSignal): Promise<void>;
  listByExecution(executionId: string): Promise<FailureSignal[]>;
  listByCognition(cognitionId: string): Promise<FailureSignal[]>;
  listRecent(limit: number): Promise<FailureSignal[]>;
}

/**
 * Replay certification store — durable record of an execution's replay
 * fingerprint at a moment in time. Used by the divergence detector to prove
 * "same workflow + same event log → same state hash" across replays, and to
 * detect when a future replay yields a different hash (a determinism bug,
 * a non-canonical wallclock leak, or an out-of-band write that didn't
 * surface in the event log).
 *
 * Two entries are *comparable* only when their `workflowVersion` matches —
 * we cannot certify that v2 of a workflow replays identically to v1; that
 * would be a category error.
 *
 * Listing semantics: `listForExecution` returns all certifications for a
 * given execution in chronological order (oldest first) so an operator can
 * trace divergence across multiple replays.
 */
export interface ReplayCertificationStore {
  put(certification: ReplayCertification): Promise<void>;
  latest(executionId: string): Promise<ReplayCertification | undefined>;
  listForExecution(executionId: string): Promise<ReplayCertification[]>;
}
