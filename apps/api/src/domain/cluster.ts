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

export type LeaseStatus = "ACTIVE" | "RELEASED" | "EXPIRED" | "RECLAIMED";

export interface ExecutionLease {
  executionId: string;
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
