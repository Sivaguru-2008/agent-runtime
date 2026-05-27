/**
 * ExecutionJobQueue — true distributed execution dispatch boundary.
 *
 * The API runtime is the SOLE producer:
 *   API.runTask → executions.save(QUEUED) → publish TASK_SCHEDULED → queue.enqueue(...)
 *
 * Worker runtimes are the SOLE consumers:
 *   queue.consume() → lease.acquire → engine.execute → ack | nack | DLQ
 *
 * The queue is the ONLY mechanism by which work crosses the API ⇄ worker
 * process boundary. There is no in-API embedded execution path. A failure of
 * the queue is an availability incident, not a silent fallback.
 *
 * Implementations:
 *   - InMemoryExecutionJobQueue  → single-process (tests, dev, RUNTIME_MODE=single)
 *   - RedisExecutionJobQueue     → cross-process (RUNTIME_MODE=distributed)
 *
 * Both implementations honor:
 *   1. At-least-once delivery (a nack returns the job to the queue)
 *   2. Visibility timeout (an un-acked job is re-delivered after timeout)
 *   3. Retry attempts (carried on the envelope, NOT the queue — the queue is
 *      a transport, retry policy lives in the WorkerExecutionLoop)
 *   4. Backpressure observability (depth() is real-time)
 */

import type { Agent, Execution } from "./model.js";
import type { EventContext } from "../infrastructure/events/eventFactory.js";

/**
 * The job envelope crossing the API → worker boundary.
 *
 * Both `agentSnapshot` and `executionSnapshot` are denormalised onto the
 * envelope so a worker can begin processing without first reading the
 * agent/execution rows. This eliminates a round-trip per dispatch and makes
 * recovery cleaner: if the database is briefly slow, the worker can still
 * make progress on the cached snapshot and write the result back when the
 * DB returns. The actual durable store remains the source of truth for
 * mutations — workers re-read latest state before mutating.
 */
export interface ExecutionJob {
  /** Unique job id (independent of executionId for queue idempotency). */
  jobId: string;
  agentId: string;
  executionId: string;
  agentSnapshot: Agent;
  executionSnapshot: Execution;
  task: Record<string, unknown>;
  context?: EventContext;
  /** ISO timestamp the job was first enqueued. */
  enqueuedAt: string;
  /** Logical attempt number — increments on each nack/retry. */
  attempt: number;
  /** ISO timestamp before which the job must not be visible to consumers. */
  notBefore?: string;
  /** Total prior failures (carried for telemetry; lease.attempt is authoritative). */
  priorFailures: number;
  /**
   * D4 — W3C TraceContext carrier captured at enqueue time. Stored as a
   * flat string map (the exact shape OTel's propagation.inject/extract
   * consumes), so the worker can re-hydrate the parent context and
   * parent its execution span under the API's enqueue span. Optional
   * because legacy enqueues and tests may not carry one; absence means
   * the worker starts a fresh root span. Persisted in the queue payload
   * so it survives Redis restarts as well as any retry loop.
   *
   * Fields are the OTel-canonical W3C names: `traceparent`, optional
   * `tracestate`, and optional `baggage` for correlationId pass-through.
   */
  traceContext?: Record<string, string>;
}

export interface QueuedJobMessage {
  /** Opaque queue-specific receipt (used by ack/nack). */
  receiptId: string;
  job: ExecutionJob;
}

export interface ConsumeOptions {
  /** Worker identity — used for distributed claim tracking and observability. */
  workerId: string;
  /** Consumer group — all workers in the same group share the queue. */
  group: string;
  /** Max time to block waiting for a message before returning. Default 5000ms. */
  blockMs?: number;
}

export interface QueueDepthSnapshot {
  /** Jobs awaiting delivery (visible). */
  ready: number;
  /** Jobs delivered but not yet ack'd (in-flight, may be re-delivered after visibility timeout). */
  inFlight: number;
  /** Jobs that have been nack'd with a future notBefore (delayed retry). */
  delayed: number;
}

export interface ExecutionJobQueue {
  /**
   * Enqueue a job. Honors `job.notBefore` for delayed delivery (retry backoff).
   * Idempotent on `jobId` — the same jobId enqueued twice is a no-op.
   *
   * Backpressure is communicated via `depth()`; producers must check that
   * value and reject before calling enqueue() if over threshold.
   */
  enqueue(job: ExecutionJob): Promise<void>;

  /**
   * Consume an async stream of jobs. Each delivered message must be ack()'d
   * or nack()'d. Unacked messages are re-delivered after the visibility
   * timeout (queue-implementation specific, typically lease TTL).
   *
   * The iterator terminates when the queue is closed.
   */
  consume(opts: ConsumeOptions): AsyncIterable<QueuedJobMessage>;

  /** Acknowledge successful processing — message is removed from the queue. */
  ack(receiptId: string): Promise<void>;

  /**
   * Reject a delivered message. If `retryDelayMs > 0`, the job is re-queued
   * with `notBefore = now + retryDelayMs` (delayed-retry semantics). The
   * caller is responsible for incrementing job.attempt before nacking.
   *
   * A nack with `retryDelayMs <= 0` makes the job immediately re-deliverable.
   */
  nack(receiptId: string, reason: string, retryDelayMs: number): Promise<void>;

  /** Current depth snapshot for backpressure and observability. */
  depth(): Promise<QueueDepthSnapshot>;

  /** Tear down connections / timers. */
  close(): Promise<void>;
}
