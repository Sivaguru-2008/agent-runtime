/**
 * Tool-call dedup port — audit CRITICAL-1.
 *
 * Tools with external side effects (HTTP, payments, file writes, email, code
 * execution) MUST consult this store before executing. The store is keyed by
 * a stable `idempotencyKey` derived deterministically from the execution
 * identity, the step identity, the tool name, and the canonicalized args —
 * see ExecutionEngine.runToolStep for the construction.
 *
 * Concurrency contract:
 *   • beginCall returns { mode } indicating whether this call is the FIRST
 *     ("FIRST_CALL") and should execute the underlying tool, or a sibling
 *     in-flight retry that should poll ("POLL_FOR_RESULT"), or a duplicate
 *     of an already-completed call that should return the cached output
 *     ("RETURN_CACHED").
 *   • markCompleted is called once with the captured output.
 *   • markFailed is called once with the error message.
 *
 * Implementations MUST be durable in production. The in-memory implementation
 * is acceptable only for unit tests and explicit ALLOW_MEMORY_FALLBACK dev.
 */

export type BeginCallMode =
  | { mode: "FIRST_CALL" }
  | { mode: "RETURN_CACHED"; output: Record<string, unknown> }
  | { mode: "POLL_FOR_RESULT"; sinceMs: number }
  /**
   * Fence protocol §B.5/I5: the recorded args_hash for this (executionId,
   * stepSeq) differs from the current call's args_hash. Replay or a stale
   * retry has drifted. Callers MUST NOT proceed silently — surface as
   * `ReplayDivergence` to the user.
   */
  | { mode: "ARG_DRIFT"; recordedArgsHash: string; observedArgsHash: string };

export interface ToolCallDedupRecord {
  idempotencyKey: string;
  executionId: string;
  agentId: string;
  toolName: string;
  attempt: number;
  status: "IN_FLIGHT" | "RESERVED" | "COMPLETED" | "SUCCEEDED" | "FAILED";
  output?: Record<string, unknown>;
  lastError?: string;
  createdAt: string;
  completedAt?: string;
  tenantId: string;
  /** docs/specs/fence-protocol.md §2 — present on rows reserved post-0015. */
  fenceTokenAtReserve?: number;
  /** docs/specs/fence-protocol.md §2 — present on rows reserved post-0015. */
  argsHash?: string;
  /** docs/specs/fence-protocol.md §2 — present on rows reserved post-0015. */
  stepSeq?: number;
}

export interface ToolCallDedupBegin {
  idempotencyKey: string;
  executionId: string;
  agentId: string;
  toolName: string;
  attempt: number;
  tenantId: string;
  /**
   * docs/specs/fence-protocol.md §2 — when provided, the store records and
   * enforces the canonical fence protocol: arg-drift detection on retry,
   * fence-token-at-reserve forensic record, replay-by-step-seq lookup.
   * Optional for back-compat with callers (tests, legacy entry points)
   * that have not yet migrated. When absent the store behaves exactly as
   * before migration 0015.
   */
  stepSeq?: number;
  /** sha256(canonical_json(args)). See spec §2 and invariant I5. */
  argsHash?: string;
  /** Lease attempt observed at reserve time. Diagnostic only. */
  fenceTokenAtReserve?: number;
}

/**
 * Outcome of a fence-aware terminal write. The store re-reads
 * `execution_leases.attempt` inside the UPDATE statement and aborts when
 * it no longer matches the expected token. This is the §B.4 / I4 gate:
 * a stale worker CANNOT transition a `tool_call_dedup` row out of
 * RESERVED.
 */
export type FencedMarkOutcome =
  | { outcome: "COMMITTED" }
  | { outcome: "FENCED" };

export interface ToolCallDedupStore {
  /**
   * Stake a claim to execute this tool call. Returns FIRST_CALL if this is
   * the first time we're seeing the key (the caller proceeds to execute).
   * Returns RETURN_CACHED if a previous call already COMPLETED with output
   * (the caller short-circuits and returns the cached output). Returns
   * POLL_FOR_RESULT if a sibling call is currently IN_FLIGHT (the caller
   * polls until the sibling reaches a terminal status). Returns ARG_DRIFT
   * when `argsHash` is provided and differs from the recorded value for
   * the matching (executionId, stepSeq) row — the canonical fence
   * protocol's replay-divergence signal.
   */
  beginCall(input: ToolCallDedupBegin): Promise<BeginCallMode>;

  /** Record a successful tool execution. Idempotent. Legacy non-fenced path. */
  markCompleted(idempotencyKey: string, output: Record<string, unknown>): Promise<void>;

  /** Record a failed tool execution. Idempotent. Legacy non-fenced path. */
  markFailed(idempotencyKey: string, errorMessage: string): Promise<void>;

  /**
   * Fence-aware completion. The store re-reads `execution_leases.attempt`
   * inside the same statement as the dedup UPDATE and aborts when it does
   * not match `expectedFencingToken`. Returns FENCED when the lease has
   * been reclaimed and `executionId` is provided; callers MUST surrender
   * the result in that case — the new owner will retry with the same
   * `idempotencyKey` and the remote service will return the cached
   * response. See docs/specs/fence-protocol.md §3 and invariant I4.
   *
   * Optional for back-compat: implementations that have not been updated
   * may delegate to `markCompleted`. The fence-aware Postgres
   * implementation is authoritative.
   */
  markCompletedFenced?(input: {
    idempotencyKey: string;
    executionId: string;
    expectedFencingToken: number;
    output: Record<string, unknown>;
  }): Promise<FencedMarkOutcome>;

  /** Fence-aware failure. See `markCompletedFenced`. */
  markFailedFenced?(input: {
    idempotencyKey: string;
    executionId: string;
    expectedFencingToken: number;
    errorMessage: string;
  }): Promise<FencedMarkOutcome>;

  /** Read a record by key — primarily for testing / forensics. */
  get(idempotencyKey: string): Promise<ToolCallDedupRecord | undefined>;

  /**
   * Read by replay coordinates. Returns the row reserved for
   * (executionId, stepSeq) regardless of idempotency key derivation.
   * Used by the replay engine to look up recorded tool outputs without
   * re-deriving the key. See docs/specs/replay-equivalent-execution.md §8.
   * Optional — implementations may omit if the underlying store predates
   * step_seq.
   */
  getByStep?(executionId: string, stepSeq: number): Promise<ToolCallDedupRecord | undefined>;
}
