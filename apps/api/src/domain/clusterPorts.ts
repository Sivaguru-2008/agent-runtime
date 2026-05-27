import type { DomainEvent } from "./events.js";
import type { DeadLetterEntry, ExecutionCheckpoint, ExecutionLease, RuntimeWorker, WorkerStatus } from "./cluster.js";

/**
 * Fencing token — the immutable proof of ownership that lets a worker
 * authoritatively mutate durable state. The token is captured at lease-
 * acquisition time and threaded through every state-mutating write. The
 * durable store rejects writes whose token does not match the live lease
 * (worker_id + attempt + status='ACTIVE' + expires_at > now()).
 *
 * Why this exists:
 *   Advisory fencing (a SELECT against the lease store, then an unconditional
 *   UPSERT) is a TOCTOU pattern. Between the SELECT and the UPSERT, the lease
 *   can be reclaimed and re-acquired by another worker — and the stale
 *   worker's write will silently overwrite the legitimate owner's terminal
 *   state. Threading the token into the WRITE itself (as a WHERE EXISTS
 *   clause + FOR UPDATE on the lease row) collapses the race window because
 *   MVCC evaluates the fence against the same statement-level snapshot as
 *   the write.
 *
 * Monotonicity:
 *   `attempt` is strictly increasing on every (re-)acquire of the same
 *   execution_id. Stale tokens therefore cannot coincidentally match a
 *   future lease — the new lease will have attempt = old + 1.
 */
export interface FencingToken {
  executionId: string;
  workerId: string;
  attempt: number;
}

/**
 * Outcome of a fenced durable write.
 *
 * "COMMITTED" — the write landed atomically; the fence held throughout.
 * "FENCED"    — the write was rejected because the lease had been reclaimed,
 *               released, expired, or transferred. The caller MUST treat this
 *               as a graceful surrender: do not retry, do not emit success
 *               events, do not perform any further state-mutating side effect.
 *
 * The legitimate new lease holder is responsible for the eventual terminal
 * outcome; the surrendering worker stops cleanly.
 */
export type FencedWriteOutcome = "COMMITTED" | "FENCED";

export interface WorkerRegistry {
  register(worker: RuntimeWorker): Promise<RuntimeWorker>;
  heartbeat(workerId: string, load: RuntimeWorker["load"]): Promise<RuntimeWorker | undefined>;
  markStatus(workerId: string, status: WorkerStatus): Promise<RuntimeWorker | undefined>;
  getById(workerId: string): Promise<RuntimeWorker | undefined>;
  list(): Promise<RuntimeWorker[]>;
  expireStale(now: Date, ttlMs: number): Promise<RuntimeWorker[]>;
}

export interface AcquireLeaseInput {
  executionId: string;
  workerId: string;
  ttlMs: number;
  now: Date;
}

export interface LeaseStore {
  acquire(input: AcquireLeaseInput): Promise<ExecutionLease | undefined>;
  renew(executionId: string, workerId: string, now: Date, ttlMs: number): Promise<ExecutionLease | undefined>;
  release(executionId: string, workerId: string, now: Date): Promise<ExecutionLease | undefined>;
  reclaimExpired(now: Date): Promise<ExecutionLease[]>;
  reclaimByWorker(workerId: string, now: Date): Promise<ExecutionLease[]>;
  getByExecution(executionId: string): Promise<ExecutionLease | undefined>;
  listActive(): Promise<ExecutionLease[]>;
  /**
   * Atomically verify that `workerId` still holds the lease for `executionId`
   * with the expected `fencingToken` (= lease.attempt at acquisition time).
   *
   * Returns `false` if the lease was reclaimed, expired, or taken by another
   * worker — the caller must abort the in-progress execution immediately.
   */
  validateFencing(executionId: string, workerId: string, fencingToken: number): Promise<boolean>;
}

export interface CheckpointStore {
  write(checkpoint: ExecutionCheckpoint): Promise<ExecutionCheckpoint>;
  /**
   * Fence-guarded checkpoint write. Same contract as
   * ExecutionRepository.saveFenced — the row commits ONLY if the supplied
   * fence still matches a live ACTIVE lease. Returns FENCED otherwise.
   *
   * Why this matters: checkpoints are the authoritative recovery anchor.
   * A stale worker overwriting the legitimate owner's checkpoint silently
   * shifts every subsequent crash-recovery to a corrupt state. Unfenced
   * write() is preserved only for unleased operator paths (pause/resume
   * routes) where there is no lease holder to fence against.
   */
  writeFenced(checkpoint: ExecutionCheckpoint, fence: FencingToken): Promise<FencedWriteOutcome>;
  listByExecution(executionId: string): Promise<ExecutionCheckpoint[]>;
  latest(executionId: string): Promise<ExecutionCheckpoint | undefined>;
}

/**
 * Dead-letter queue port. Implementations must be durable — in-memory is
 * acceptable in development but production deployments must use Postgres to
 * survive process restarts.
 */
export interface DeadLetterQueue {
  /** Persist a poisoned execution. Idempotent on `executionId`. */
  push(entry: DeadLetterEntry): Promise<void>;
  list(): Promise<DeadLetterEntry[]>;
  getByExecution(executionId: string): Promise<DeadLetterEntry | undefined>;
}

export interface StreamConsumeOptions {
  group: string;
  consumer: string;
  blockMs?: number;
  count?: number;
}

export interface StreamMessage {
  streamId: string;
  event: DomainEvent;
}

export interface StreamEventBus {
  publish(event: DomainEvent): Promise<void>;
  publishToStream(event: DomainEvent): Promise<string>;
  ensureGroup(group: string): Promise<void>;
  consume(options: StreamConsumeOptions): AsyncIterable<StreamMessage>;
  ack(group: string, streamId: string): Promise<void>;
  pending(group: string): Promise<number>;
  replay(fromId: string, limit: number): Promise<StreamMessage[]>;
  close(): Promise<void>;
}
