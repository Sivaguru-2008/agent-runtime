import type { DomainEvent } from "./events.js";
import type { Agent, Execution, MemoryRecord } from "./model.js";
import type { FencingToken, FencedWriteOutcome } from "./clusterPorts.js";

/**
 * Outcome of an attempted fenced event append.
 *
 *   "COMMITTED" — the event was durably persisted; fence held at the moment
 *                 of the INSERT. The returned event carries its assigned
 *                 sequence number, identical to a successful append().
 *   "FENCED"    — the lease referenced by `fence` was no longer ACTIVE for
 *                 this worker/attempt at the moment of the INSERT. The event
 *                 was NOT persisted and MUST NOT be broadcast on the bus.
 *                 Callers handle this as a silent surrender (a stale worker
 *                 is the only realistic source) — emit a diagnostic counter
 *                 but never pollute replay.
 */
export type FencedAppendOutcome =
  | { outcome: "COMMITTED"; event: DomainEvent }
  | { outcome: "FENCED" };

export interface EventStore {
  append(event: DomainEvent): Promise<DomainEvent>;
  /**
   * Atomic fenced append for execution-scoped events.
   *
   * Contract: the event is persisted ONLY if a row exists in
   * `execution_leases` whose `execution_id=fence.executionId`,
   * `worker_id=fence.workerId`, `attempt=fence.attempt`, `status='ACTIVE'`,
   * and `expires_at > now()` — verified inside the SAME transaction as the
   * INSERT, with a row-level SHARE lock on the lease row that holds until
   * COMMIT. A stale worker whose lease was reclaimed CANNOT slip an event
   * past this gate, because the row it would be locking is either gone,
   * status-mismatched, or attempt-mismatched.
   *
   * Implementations MUST:
   *   - never persist on FENCED
   *   - never write to event_execution_links / event_cognition_links on FENCED
   *   - treat fence failure as a non-error (return; don't throw)
   *
   * Implementations MAY emit a diagnostic on FENCED but the contract is
   * purely return-value based; callers consult `outcome` and decide.
   */
  appendFenced(event: DomainEvent, fence: FencingToken): Promise<FencedAppendOutcome>;
  listByAggregate(aggregateType: DomainEvent["aggregateType"], aggregateId: string): Promise<DomainEvent[]>;
  listByExecution(executionId: string): Promise<DomainEvent[]>;
  listRecent(limit: number): Promise<DomainEvent[]>;
  /**
   * Fetch the last (newest/highest sequence) event published for a given execution ID.
   * Used during worker recovery and lease reclamation to cleanly propagate trace
   * lineage, correlation context, and tenant isolation metadata.
   */
  lastForExecution(executionId: string): Promise<DomainEvent | undefined>;
  /**
   * Resume cursor support for distributed consumers and SSE catch-up.
   * Returns events with `sequence > afterSequence`, ordered ascending.
   */
  listAfterSequence(afterSequence: number, limit: number): Promise<DomainEvent[]>;
}

export type EventHandler = (event: DomainEvent) => void | Promise<void>;

export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(handler: EventHandler): () => void;
}

export interface AgentRepository {
  save(agent: Agent): Promise<void>;
  getById(id: string): Promise<Agent | undefined>;
  list(): Promise<Agent[]>;
}

export interface CommitTerminalInput {
  execution: Execution;
  event: DomainEvent;
  memoryRecord?: MemoryRecord;
  checkpoint?: Record<string, unknown>; // holds the state to write to execution_checkpoints
  checkpointSequence?: number;
  fence?: FencingToken;
}

export interface ExecutionRepository {
  save(execution: Execution): Promise<void>;
  /**
   * Fence-guarded variant of save(). The durable write commits ONLY if the
   * supplied token still matches a live, active, unexpired lease on the
   * named execution. Returns "FENCED" otherwise — the caller MUST surrender
   * (no events, no further writes, no retries).
   *
   * This is the authoritative concurrency boundary: callers SHOULD prefer
   * saveFenced for every status-mutating write when running under a leased
   * worker. Plain save() is preserved for single-worker / unleased contexts
   * (initial QUEUED row, projections that don't compete for ownership).
   */
  saveFenced(execution: Execution, fence: FencingToken): Promise<FencedWriteOutcome>;
  /**
   * Atomic Terminal Commit. Executes fence verification, execution status update,
   * final task-history memory record insertion, terminal checkpoint write, and terminal
   * event + outbox queue insertion in a single, isolated database transaction.
   * Returns FENCED if the lease fence is violated at execution time.
   */
  commitTerminal(input: CommitTerminalInput): Promise<FencedWriteOutcome>;
  /**
   * Check if the database-backed outbox is enabled for this repository.
   * If true, terminal events can be safely queued in the outbox and dispatched
   * asynchronously; if false, the caller should publish them to the bus directly.
   */
  isOutboxEnabled?(): boolean;
  getById(id: string): Promise<Execution | undefined>;
  listByAgent(agentId: string): Promise<Execution[]>;
}

export interface MemoryRepository {
  add(record: MemoryRecord): Promise<void>;
  /**
   * Fence-guarded variant of add(). Tenant-tagged TASK_HISTORY records flow
   * into downstream RAG search; a stale-worker write would attribute the
   * legitimate owner's tenant with the stale worker's content. addFenced
   * rejects the write when the fence does not match a live lease.
   */
  addFenced(record: MemoryRecord, fence: FencingToken): Promise<FencedWriteOutcome>;
  search(agentId: string, query: string, limit: number): Promise<MemoryRecord[]>;
  listByAgent(agentId: string): Promise<MemoryRecord[]>;
}

export interface ModelProvider {
  complete(input: {
    agent: Agent;
    execution: Execution;
    prompt: string;
    context: MemoryRecord[];
    /**
     * Called for each token as it streams from the provider. Confidence is
     * 1.0 for real provider tokens; synthetic providers may vary it.
     * Optional — callers that don't need per-token events may omit this.
     */
    onToken?: (token: string, confidence: number) => void;
    /** AbortSignal to cancel in-flight requests. */
    signal?: AbortSignal;
  }): Promise<{
    output: Record<string, unknown>;
    tokenUsage: {
      prompt: number;
      completion: number;
      total: number;
    };
  }>;
}

export interface ToolExecutor {
  execute(input: {
    toolName: string;
    args: Record<string, unknown>;
    executionId: string;
    agentId: string;
    signal?: AbortSignal;
    /**
     * Audit CRITICAL-1: stable identity of this logical tool call. When set,
     * a dedup-aware wrapper (DedupingToolExecutor) consults a durable
     * dedup table BEFORE invoking the underlying tool. Two redeliveries
     * of the same execution producing the same idempotencyKey share a
     * single side effect. Mint via deterministicId([executionId, stepId,
     * toolName, canonicalize(args)]).
     *
     * Optional for back-compat with callers (tests, legacy entry points)
     * that have not yet been updated. When absent the wrapper transparently
     * forwards — the tool runs exactly once per call as before, with no
     * cross-call dedup.
     */
    idempotencyKey?: string;
    /**
     * Lease attempt at the time of this call. Persisted into the dedup
     * row so forensics can correlate which lease attempt produced a given
     * tool output. Also used by the fence-aware dedup store to verify
     * the worker still holds the lease at commit time — see
     * docs/specs/fence-protocol.md §3 and invariant I4.
     */
    attempt?: number;
    /**
     * Canonical fence protocol §B.2 — planner-assigned step ordinal for
     * this call within the execution. Stable across retries. Forms half of
     * the canonical idempotency key (`sha256(executionId || ':' || stepSeq)`).
     * Optional for back-compat with callers that have not yet migrated to
     * the canonical key formula.
     */
    stepSeq?: number;
    /**
     * Canonical fence protocol §B.2 — `sha256(canonical_json(args))` at the
     * call site. The dedup store records this on first reserve and refuses
     * silent re-execution on retry when it differs (invariant I5). When
     * absent, drift detection is disabled for this call.
     */
    argsHash?: string;
  }): Promise<Record<string, unknown>>;
}
