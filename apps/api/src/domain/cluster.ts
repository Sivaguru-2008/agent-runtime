import type { ExecutionStepType } from "./model.js";

export type WorkerStatus = "REGISTERED" | "READY" | "BUSY" | "DRAINING" | "LOST" | "STOPPED";

export interface RuntimeWorkerLoad {
  cpu: number;
  memory: number;
  inFlight: number;
  queueDepth: number;
  eventsPerSecond: number;
}

export interface RuntimeWorker {
  id: string;
  host: string;
  region?: string;
  version: string;
  capacity: number;
  status: WorkerStatus;
  load: RuntimeWorkerLoad;
  startedAt: string;
  lastHeartbeatAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * Worker statuses under which a worker is still part of the live fleet — it is
 * actively heartbeating (or expected to). LOST (missed heartbeats, presumed
 * dead) and STOPPED (gracefully shut down) are deliberately excluded: they are
 * terminal and must NOT be counted toward live-fleet aggregates such as the
 * mean heartbeat age, otherwise a single long-dead worker skews the figure
 * arbitrarily (a worker dead for days dragged the "mean across live workers"
 * to nonsensical values).
 */
export const LIVE_WORKER_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
  "REGISTERED",
  "READY",
  "BUSY",
  "DRAINING"
]);

export function isLiveWorker(status: WorkerStatus): boolean {
  return LIVE_WORKER_STATUSES.has(status);
}

/**
 * Terminal worker statuses — the worker has left the fleet and is eligible for
 * reaping (permanent removal from the registry) once it has been terminal
 * beyond the retention window.
 */
export function isTerminatedWorker(status: WorkerStatus): boolean {
  return status === "LOST" || status === "STOPPED";
}

export type LeaseStatus =
  | "LEASE_PENDING"
  | "LEASED"
  | "RENEWING"
  | "EXPIRED"
  | "INVALIDATED"
  | "TRANSFERRED"
  | "RECOVERY_OWNED";

/**
 * Lease statuses under which a worker is the live, authoritative owner and
 * may mutate durable state. LEASE_PENDING is deliberately excluded: a pending
 * lease has not yet been confirmed as owned, so it must not be treated as an
 * active fence holder.
 */
export const ACTIVE_LEASE_STATUSES: ReadonlySet<LeaseStatus> = new Set<LeaseStatus>([
  "LEASED",
  "RENEWING",
  "RECOVERY_OWNED"
]);

export function isActiveLease(status: LeaseStatus): boolean {
  return ACTIVE_LEASE_STATUSES.has(status);
}

export interface ExecutionLease {
  executionId: string;
  leaseId?: string;
  leaseEpoch?: number;
  lease_epoch?: number;
  fencingToken?: number;
  fencing_token?: number;
  ownershipVersion?: number;
  ownership_version?: number;
  workerIdentity?: string;
  worker_identity?: string;
  workerId: string;
  acquiredAt: string;
  expiresAt: string;
  renewedAt: string;
  status: LeaseStatus;
  attempt: number;
}

export interface ExecutionCheckpoint {
  id: string;
  executionId: string;
  workerId: string;
  sequence: number;
  phase: ExecutionStepType | "INITIALIZED" | "PERSISTED" | "COMPLETION";
  state: Record<string, unknown>;
  createdAt: string;
}

/**
 * Dead-letter entry: an execution that exceeded the poison-pill attempt
 * threshold. It will not be re-enqueued. Operators must inspect `lastError`
 * and decide whether to replay, discard, or fix-and-retry manually.
 */
export interface DeadLetterEntry {
  id: string;
  executionId: string;
  agentId: string;
  workerId: string;
  /** Total number of execution attempts before poisoning. */
  failureCount: number;
  lastError: string;
  firstFailedAt: string;
  movedAt: string;
  /** Snapshot of the task payload at the time of poisoning, for replay diagnostics. */
  taskSnapshot?: Record<string, unknown>;
}

export interface ClusterOverview {
  workers: {
    total: number;
    ready: number;
    busy: number;
    lost: number;
    draining: number;
  };
  leases: {
    active: number;
    expired: number;
    reclaimed: number;
  };
  throughput: {
    eventsPerSecond: number;
    runningExecutions: number;
    queueDepth: number;
  };
  meanHeartbeatAgeMs: number;
}
