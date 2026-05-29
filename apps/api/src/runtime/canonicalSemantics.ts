import { trace } from "@opentelemetry/api";
import type { ExecutionStatus } from "../domain/model.js";

/**
 * Canonical Runtime Constitution.
 *
 * This module is the single authoritative semantics layer for the runtime.
 * Execution state, replay safety, ambiguity handling, lease ownership,
 * recovery routing, and invariant enforcement are defined here and imported
 * by runtime modules. Compatibility modules may re-export these symbols, but
 * they must not redefine them.
 */

export const EXECUTION_STATES = [
  "CREATION",
  "SCHEDULING",
  "LEASE_ACQUISITION",
  "RUNNING",
  "SIDE_EFFECT_PENDING",
  "REPLAYING",
  "RECOVERING",
  "COMMITTED",
  "COMPLETED",
  "FAILED",
  "AMBIGUOUS",
  "RECONCILIATION_REQUIRED",
  "DEAD_LETTERED",
  "EXPIRED",
  "QUEUED",
  "CANCELLED"
] as const satisfies readonly ExecutionStatus[];

export const EXECUTION_STATE_SET = new Set<ExecutionStatus>(EXECUTION_STATES);

export class IllegalTransitionError extends Error {
  readonly name = "IllegalTransitionError";
  constructor(
    public readonly executionId: string,
    public readonly fromState: ExecutionStatus,
    public readonly toState: ExecutionStatus,
    message?: string
  ) {
    super(
      message ??
        `Illegal execution state transition: '${fromState}' -> '${toState}' for execution '${executionId}'`
    );
  }
}

const transitionTuples = {
  CREATION: ["SCHEDULING"],
  SCHEDULING: ["LEASE_ACQUISITION", "RECOVERING", "DEAD_LETTERED", "QUEUED", "CANCELLED"],
  LEASE_ACQUISITION: [
    "RUNNING",
    "REPLAYING",
    "RECOVERING",
    "SCHEDULING",
    "DEAD_LETTERED",
    "FAILED",
    "QUEUED"
  ],
  RUNNING: [
    "SIDE_EFFECT_PENDING",
    "COMMITTED",
    "FAILED",
    "EXPIRED",
    "AMBIGUOUS",
    "RECONCILIATION_REQUIRED",
    "CANCELLED"
  ],
  SIDE_EFFECT_PENDING: ["RUNNING", "FAILED", "AMBIGUOUS", "RECONCILIATION_REQUIRED"],
  REPLAYING: [
    "RUNNING",
    "COMPLETED",
    "FAILED",
    "AMBIGUOUS",
    "RECONCILIATION_REQUIRED",
    "SIDE_EFFECT_PENDING"
  ],
  RECOVERING: [
    "RUNNING",
    "AMBIGUOUS",
    "RECONCILIATION_REQUIRED",
    "DEAD_LETTERED",
    "FAILED",
    "SIDE_EFFECT_PENDING",
    "COMMITTED"
  ],
  COMMITTED: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: ["LEASE_ACQUISITION", "DEAD_LETTERED"],
  AMBIGUOUS: ["RECONCILIATION_REQUIRED", "FAILED", "COMPLETED", "RUNNING", "RECOVERING"],
  RECONCILIATION_REQUIRED: ["RECOVERING", "DEAD_LETTERED", "FAILED", "RUNNING"],
  DEAD_LETTERED: [],
  EXPIRED: ["RECONCILIATION_REQUIRED", "DEAD_LETTERED"],
  QUEUED: ["LEASE_ACQUISITION", "SCHEDULING", "RUNNING", "RECOVERING", "CANCELLED"],
  CANCELLED: []
} as const satisfies Record<ExecutionStatus, readonly ExecutionStatus[]>;

export const LEGAL_TRANSITIONS: Record<ExecutionStatus, Set<ExecutionStatus>> =
  Object.fromEntries(
    Object.entries(transitionTuples).map(([state, destinations]) => [
      state,
      new Set<ExecutionStatus>(destinations)
    ])
  ) as Record<ExecutionStatus, Set<ExecutionStatus>>;

export const ACTIVE_STATES = new Set<ExecutionStatus>([
  "CREATION",
  "SCHEDULING",
  "LEASE_ACQUISITION",
  "RUNNING",
  "SIDE_EFFECT_PENDING",
  "REPLAYING",
  "RECOVERING",
  "COMMITTED",
  "QUEUED"
]);

export const TERMINAL_STATES = new Set<ExecutionStatus>([
  "COMPLETED",
  "FAILED",
  "DEAD_LETTERED",
  "CANCELLED"
]);

/**
 * Terminal states that are permitted to leave the terminal set via an
 * explicit, policy-driven restart. FAILED is a *resting* terminal: an
 * execution settles there after a failure and is then either retried
 * (FAILED -> LEASE_ACQUISITION) or escalated (FAILED -> DEAD_LETTERED). It is
 * the only terminal state allowed to have outgoing transitions; every other
 * terminal state is absorbing. Encoded explicitly so the structural validator
 * enforces the rule from data instead of a hard-coded state-name exception.
 */
export const RESTARTABLE_TERMINAL_STATES = new Set<ExecutionStatus>(["FAILED"]);

export function isActiveState(status: ExecutionStatus): boolean {
  return ACTIVE_STATES.has(status);
}

export function isTerminalState(status: ExecutionStatus): boolean {
  return TERMINAL_STATES.has(status);
}

export function assertTransition(
  executionId: string,
  from: ExecutionStatus,
  to: ExecutionStatus
): void {
  if (from === to) return;
  const allowed = LEGAL_TRANSITIONS[from];
  if (!allowed?.has(to)) {
    throw new IllegalTransitionError(executionId, from, to);
  }
}

export type ExecutionStartIntent = "normal" | "replay" | "recovery";

export function resolveExecutionStartStatus(input: {
  executionId: string;
  currentStatus: ExecutionStatus;
  parentExecutionId?: string;
  fenceAttempt?: number;
}): { intent: ExecutionStartIntent; status: ExecutionStatus } {
  const status: ExecutionStatus = input.parentExecutionId
    ? "REPLAYING"
    : input.currentStatus === "RECOVERING" || (input.fenceAttempt ?? 0) > 1
      ? "RECOVERING"
      : "RUNNING";
  assertTransition(input.executionId, input.currentStatus, status);
  return {
    intent: status === "REPLAYING" ? "replay" : status === "RECOVERING" ? "recovery" : "normal",
    status
  };
}

export class InvariantViolation extends Error {
  readonly code = "INVARIANT_VIOLATION" as const;
  constructor(message: string, public readonly invariant: string) {
    super(`[invariant:${invariant}] ${message}`);
  }
}

export const INVARIANT_REGISTRY = {
  S1: { id: "S1", category: "safety", statement: "Side-effect uniqueness; no duplicate external execution" },
  S2: { id: "S2", category: "safety", statement: "All external side effects require durable fences" },
  S3: { id: "S3", category: "safety", statement: "Ambiguous effects require reconciliation quarantine" },
  RP1: { id: "RP1", category: "replay", statement: "Replay side-effect mutex blocks unsafe live effects after divergence" },
  RP2: { id: "RP2", category: "replay", statement: "Deterministic prefix equivalence before replay divergence" },
  RP3: { id: "RP3", category: "replay", statement: "Isolated replay execution must not collide or be concurrently owned" },
  L1: { id: "L1", category: "lease", statement: "Lease attempt tokens are positive and monotonic" },
  L2: { id: "L2", category: "lease", statement: "Stale lease mutations are rejected before durable state changes" },
  P1: { id: "P1", category: "persistence", statement: "State and terminal events commit atomically" },
  P2: { id: "P2", category: "persistence", statement: "Tenant isolation is enforced on persisted execution data" },
  O1: { id: "O1", category: "ordering", statement: "Outbox FIFO order is preserved" },
  O2: { id: "O2", category: "ordering", statement: "Original event timestamps are preserved during dispatch" },
  R1: { id: "R1", category: "recovery", statement: "Recovery fence attempts are monotonic" },
  R2: { id: "R2", category: "recovery", statement: "Recovery and retry paths obey recovery policy" },
  // Retry-coordination invariants — see docs/specs/retry-coordination.md and
  // src/runtime/retry/. These harden the per-execution retry coordination
  // record into a transactionally-enforced single-flight correctness layer.
  RT1: { id: "RT1", category: "retry", statement: "Single-flight: at most one active retry coordination exists per execution; duplicate retries are deduplicated, never double-driven" },
  RT2: { id: "RT2", category: "retry", statement: "Exclusive ownership: at most one owner attempt may hold RETRY_EXECUTING for an execution at a time" },
  RT3: { id: "RT3", category: "retry", statement: "Recovery serialization: at most one recovery coordinator per execution, and concurrent recovery executions are throttled" },
  RT4: { id: "RT4", category: "retry", statement: "Replay and recovery never overlap for the same execution; replay retries are isolated" },
  RT5: { id: "RT5", category: "retry", statement: "Retry attempts are strictly monotonic; only legal retry-state transitions are admitted (no duplicate or replayed attempt)" },
  RT6: { id: "RT6", category: "retry", statement: "Retry storm amplification is bounded; per-execution and global retry fan-out cannot exceed the storm ceiling" },
  RT7: { id: "RT7", category: "retry", statement: "Retries cannot bypass reconciliation: an ambiguous side effect must be reconciled before any re-attempt" },
  RT8: { id: "RT8", category: "retry", statement: "Retries cannot bypass fence validation: a retry takes execution ownership only after the durable fence/lease is validated" },
  // Fence state-machine invariants — see docs/specs/fence-state-machine.md and
  // src/runtime/fence/. These harden the per-(executionId, stepSeq) side-effect
  // fence into a transactionally-enforced correctness layer.
  F1: { id: "F1", category: "fence", statement: "A durable fence in EXECUTING precedes every external side effect" },
  F2: { id: "F2", category: "fence", statement: "Side effects require a committed ownership context (claimant attempt == fence attempt == active lease)" },
  F3: { id: "F3", category: "fence", statement: "A committed/reconciled fence is terminal; no duplicate committed effect" },
  F4: { id: "F4", category: "fence", statement: "A stale lease holder cannot mutate fence state" },
  F5: { id: "F5", category: "fence", statement: "Only legal fence-state transitions are admitted" },
  F6: { id: "F6", category: "fence", statement: "Replay and retry resolve through the fence; they never bypass a committed fence or drift args silently" },
  F7: { id: "F7", category: "fence", statement: "Canonical ownership context is internally consistent: lease_epoch == fencing_token == ownership_version == attempt and worker_identity == workerId (fail-closed)" },
  // Coordination-authority invariants — see docs/specs/coordination-boundary.md
  // and src/runtime/coordinationAuthority.ts. These pin the Redis<->Postgres
  // durability boundary: Postgres is the sole authority for correctness state,
  // Redis is ephemeral coordination only, and the two can never silently
  // disagree about ownership.
  CA1: { id: "CA1", category: "coordination", statement: "Canonical correctness state (leases, fences, checkpoints, event log, outbox, dedup, execution state) is owned exclusively by Postgres; a durable concern may never be served by a Redis-backed adapter" },
  CA2: { id: "CA2", category: "coordination", statement: "Redis holds ephemeral coordination only; loss of all Redis state must not alter any committed correctness outcome (durable truth + reconstruction cover every ephemeral concern)" },
  CA3: { id: "CA3", category: "coordination", statement: "Ownership and fencing decisions resolve against the durable lease store; an ephemeral (Redis/in-process) ownership hint may seed work but can never authorize a state mutation" },
  CA4: { id: "CA4", category: "coordination", statement: "Recovery and replay reconstruct from durable sources (event log, checkpoints, lease table); reconstruction must never require Redis-resident state" },
  CA5: { id: "CA5", category: "coordination", statement: "An observed Redis<->Postgres disagreement for a coordination concern is resolved in favor of Postgres (fail-closed); the ephemeral view is discarded, never promoted" },
  CA6: { id: "CA6", category: "coordination", statement: "Every coordination concern carries an explicit authority classification; an unclassified concern may not participate in distributed coordination" },
  // Distributed-recovery orchestration invariants — see
  // docs/specs/distributed-recovery-architecture.md and src/runtime/recovery/.
  // These pin the canonical recovery lifecycle (RECOVERY_PENDING, RECOVERING,
  // REPLAY_RECOVERING, RECONCILING, RECOVERY_BLOCKED, RECOVERY_ABORTED,
  // RECOVERY_COMPLETED) into a serialized, fail-closed orchestration layer that
  // composes the lease, fence, retry, replay, and reconciliation subsystems.
  REC1: { id: "REC1", category: "recovery", statement: "Serialized recovery execution: at most one recovery owner may actively recover an execution at a time (no concurrent RECOVERING/REPLAY_RECOVERING/RECONCILING for the same execution)" },
  REC2: { id: "REC2", category: "recovery", statement: "No unsafe recovery replay: a replay-based recovery that has diverged may not execute a non-replay-safe side effect; it must quarantine to reconciliation or abort" },
  REC3: { id: "REC3", category: "recovery", statement: "No reconciliation bypass: an ambiguous external commit must be reconciled (RECONCILING) before any recovery re-drive or completion" },
  REC4: { id: "REC4", category: "recovery", statement: "Stale recovery ownership is invalidated: a recovery owner whose epoch is below the live durable lease epoch is fenced and cannot mutate recovery state (fail-closed)" },
  REC5: { id: "REC5", category: "recovery", statement: "No replay/recovery divergence leakage: a diverged replay recovery never leaks a live/production side effect; the diverged outcome is quarantined, never promoted to COMPLETED" },
  REC6: { id: "REC6", category: "recovery", statement: "Recovery cannot bypass fencing: recovery ownership and re-drive are granted only after the durable fence/lease is validated" },
  REC7: { id: "REC7", category: "recovery", statement: "Recovery backpressure is bounded: concurrent in-flight recoveries cannot exceed the recovery throttle ceiling" },
  REC8: { id: "REC8", category: "recovery", statement: "Recovery arbitration elects a single winner: monotonic recovery epoch admission guarantees ties are impossible and the highest epoch wins ownership" },
  REC9: { id: "REC9", category: "recovery", statement: "Only legal recovery-lifecycle transitions are admitted (the recovery state machine is the sole chokepoint)" },
  CAP1: { id: "CAP1", category: "safety", statement: "Every registered tool must have an explicit capability declaration" },
  CAP2: { id: "CAP2", category: "safety", statement: "Retry policy must conform to integration capability classification" },
  CAP3: { id: "CAP3", category: "safety", statement: "Replay behavior must strictly adhere to capability classification safety boundaries" },
  CAP4: { id: "CAP4", category: "safety", statement: "Reconciliation is mandatory for non-idempotent or ambiguous side effects" },
  S_SANDBOX_ESCAPE: { id: "S_SANDBOX_ESCAPE", category: "safety", statement: "Replay sandbox escape: attempt to mutate parent or publish production events" },
  S_UNSAFE_REPLAY: { id: "S_UNSAFE_REPLAY", category: "safety", statement: "Unsafe replay side effect blocked: cannot execute unsafe provider or tool" },
  S_POLICY_VIOLATION: { id: "S_POLICY_VIOLATION", category: "safety", statement: "Replay policy violation: blocked execution of non-safe or blocked integration" }
} as const;

export type InvariantId = keyof typeof INVARIANT_REGISTRY;

export function assertRuntimeInvariant(
  id: InvariantId,
  condition: boolean,
  message: string,
  context?: Record<string, unknown>
): void {
  if (condition) return;

  const errorMsg = `[invariant:${id}] ${message}`;
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    activeSpan.recordException(new Error(errorMsg));
    activeSpan.setStatus({ code: 2, message: errorMsg });
    activeSpan.addEvent("invariant.violation", {
      invariantId: id,
      category: INVARIANT_REGISTRY[id].category,
      statement: INVARIANT_REGISTRY[id].statement,
      ...context
    });
  }
  throw new InvariantViolation(message, id);
}

export type RuntimeFailureCategory =
  | "LEASE_STOLEN"
  | "LEASE_EXPIRY"
  | "HEARTBEAT_TIMEOUT"
  | "CHECKPOINT_FENCE_REJECTED"
  | "STALE_WORKER_MUTATION"
  | "REPLAY_DIVERGENCE"
  | "TOOL_TIMEOUT"
  | "PROVIDER_TIMEOUT"
  | "TOOL_CRASH"
  | "PROCESS_CRASH"
  | "PARTIAL_COMMIT"
  | "TOOL_NON_IDEMPOTENT"
  | "AMBIGUOUS_EXTERNAL_COMMIT"
  | "RECOVERY_ABORTED"
  | "EXECUTION_CANCELLED"
  | "DLQ_ESCALATED"
  | "NETWORK_PARTITION"
  | "DUPLICATE_DELIVERY"
  | "OUTBOX_FAILURE"
  | "UNKNOWN_RUNTIME_FAILURE";

export type FailureType = RuntimeFailureCategory;

export interface RecoverySemantics {
  readonly retryable: boolean;
  readonly replayable: boolean;
  readonly reconcilable: boolean;
  readonly terminal: boolean;
  readonly requiresHumanIntervention: boolean;
}

export const FAILURE_CODES: Record<RuntimeFailureCategory, string> = {
  LEASE_STOLEN: "LEASE_STOLEN",
  LEASE_EXPIRY: "LEASE_EXPIRY",
  HEARTBEAT_TIMEOUT: "HEARTBEAT_TIMEOUT",
  CHECKPOINT_FENCE_REJECTED: "CHECKPOINT_FENCE_REJECTED",
  STALE_WORKER_MUTATION: "STALE_WORKER_MUTATION",
  REPLAY_DIVERGENCE: "REPLAY_DIVERGENCE",
  TOOL_TIMEOUT: "TOOL_TIMEOUT",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  TOOL_CRASH: "TOOL_CRASH",
  PROCESS_CRASH: "PROCESS_CRASH",
  PARTIAL_COMMIT: "PARTIAL_COMMIT",
  TOOL_NON_IDEMPOTENT: "TOOL_NON_IDEMPOTENT",
  AMBIGUOUS_EXTERNAL_COMMIT: "AMBIGUOUS_EXTERNAL_COMMIT",
  RECOVERY_ABORTED: "RECOVERY_ABORTED",
  EXECUTION_CANCELLED: "EXECUTION_CANCELLED",
  DLQ_ESCALATED: "DLQ_ESCALATED",
  NETWORK_PARTITION: "NETWORK_PARTITION",
  DUPLICATE_DELIVERY: "DUPLICATE_DELIVERY",
  OUTBOX_FAILURE: "OUTBOX_FAILURE",
  UNKNOWN_RUNTIME_FAILURE: "UNKNOWN_RUNTIME_FAILURE"
};

export const RECOVERABLE_BY_DEFAULT: Record<RuntimeFailureCategory, boolean> = {
  LEASE_STOLEN: true,
  LEASE_EXPIRY: true,
  HEARTBEAT_TIMEOUT: true,
  CHECKPOINT_FENCE_REJECTED: true,
  STALE_WORKER_MUTATION: false,
  REPLAY_DIVERGENCE: false,
  TOOL_TIMEOUT: true,
  PROVIDER_TIMEOUT: true,
  TOOL_CRASH: true,
  PROCESS_CRASH: true,
  PARTIAL_COMMIT: true,
  TOOL_NON_IDEMPOTENT: false,
  AMBIGUOUS_EXTERNAL_COMMIT: false,
  RECOVERY_ABORTED: false,
  EXECUTION_CANCELLED: false,
  DLQ_ESCALATED: false,
  NETWORK_PARTITION: true,
  DUPLICATE_DELIVERY: true,
  OUTBOX_FAILURE: true,
  UNKNOWN_RUNTIME_FAILURE: true
};

export const RECOVERY_SEMANTICS_MAP: Record<RuntimeFailureCategory, RecoverySemantics> = {
  LEASE_STOLEN: { retryable: true, replayable: true, reconcilable: false, terminal: false, requiresHumanIntervention: false },
  LEASE_EXPIRY: { retryable: true, replayable: true, reconcilable: false, terminal: false, requiresHumanIntervention: false },
  HEARTBEAT_TIMEOUT: { retryable: true, replayable: true, reconcilable: false, terminal: false, requiresHumanIntervention: false },
  CHECKPOINT_FENCE_REJECTED: { retryable: true, replayable: true, reconcilable: true, terminal: false, requiresHumanIntervention: false },
  STALE_WORKER_MUTATION: { retryable: false, replayable: false, reconcilable: false, terminal: true, requiresHumanIntervention: false },
  REPLAY_DIVERGENCE: { retryable: false, replayable: false, reconcilable: true, terminal: true, requiresHumanIntervention: true },
  TOOL_TIMEOUT: { retryable: true, replayable: true, reconcilable: false, terminal: false, requiresHumanIntervention: false },
  PROVIDER_TIMEOUT: { retryable: true, replayable: true, reconcilable: false, terminal: false, requiresHumanIntervention: false },
  TOOL_CRASH: { retryable: true, replayable: true, reconcilable: true, terminal: false, requiresHumanIntervention: false },
  PROCESS_CRASH: { retryable: true, replayable: true, reconcilable: true, terminal: false, requiresHumanIntervention: false },
  PARTIAL_COMMIT: { retryable: true, replayable: false, reconcilable: true, terminal: false, requiresHumanIntervention: false },
  TOOL_NON_IDEMPOTENT: { retryable: false, replayable: false, reconcilable: true, terminal: false, requiresHumanIntervention: true },
  AMBIGUOUS_EXTERNAL_COMMIT: { retryable: false, replayable: false, reconcilable: true, terminal: false, requiresHumanIntervention: true },
  RECOVERY_ABORTED: { retryable: false, replayable: false, reconcilable: false, terminal: true, requiresHumanIntervention: false },
  EXECUTION_CANCELLED: { retryable: false, replayable: false, reconcilable: false, terminal: true, requiresHumanIntervention: false },
  DLQ_ESCALATED: { retryable: false, replayable: false, reconcilable: false, terminal: true, requiresHumanIntervention: true },
  NETWORK_PARTITION: { retryable: true, replayable: true, reconcilable: false, terminal: false, requiresHumanIntervention: false },
  DUPLICATE_DELIVERY: { retryable: false, replayable: true, reconcilable: false, terminal: false, requiresHumanIntervention: false },
  OUTBOX_FAILURE: { retryable: true, replayable: true, reconcilable: true, terminal: false, requiresHumanIntervention: false },
  UNKNOWN_RUNTIME_FAILURE: { retryable: true, replayable: true, reconcilable: false, terminal: false, requiresHumanIntervention: false }
};

export interface RetryLineageEntry {
  attempt: number;
  category: RuntimeFailureCategory;
  message: string;
  at: string;
}

export interface RuntimeFailureRecord {
  category: RuntimeFailureCategory;
  code: string;
  message: string;
  recoverable: boolean;
  cause?: RuntimeFailureRecord[];
  retryLineage?: RetryLineageEntry[];
  metadata?: Record<string, unknown>;
}

export function classifyRuntimeFailure(
  err: unknown,
  hint?: { category?: RuntimeFailureCategory; metadata?: Record<string, unknown> }
): RuntimeFailureRecord {
  if (hint?.category) return buildFailure(hint.category, errMessage(err), hint.metadata);
  if (!(err instanceof Error)) {
    return buildFailure("UNKNOWN_RUNTIME_FAILURE", String(err ?? "unknown failure"), hint?.metadata);
  }

  const name = err.name;
  const msg = err.message ?? "";
  const lower = msg.toLowerCase();

  if (name === "FencingViolationError" || name === "StaleWorkerSurrender") {
    return buildFailure("LEASE_STOLEN", msg, hint?.metadata);
  }
  if (name === "AbortError") return buildFailure("EXECUTION_CANCELLED", msg, hint?.metadata);
  if (name === "ReplaySandboxViolationError") return buildFailure("REPLAY_DIVERGENCE", msg, hint?.metadata);
  if (name === "AmbiguityDetectedError") return buildFailure("AMBIGUOUS_EXTERNAL_COMMIT", msg, hint?.metadata);
  if (msg.includes("fence-rejected")) return buildFailure("LEASE_STOLEN", msg, hint?.metadata);
  if (lower.includes("heartbeat") && lower.includes("expired")) return buildFailure("HEARTBEAT_TIMEOUT", msg, hint?.metadata);
  if (lower.includes("checkpoint") && lower.includes("fence")) return buildFailure("CHECKPOINT_FENCE_REJECTED", msg, hint?.metadata);
  if (lower.includes("replay divergence")) return buildFailure("REPLAY_DIVERGENCE", msg, hint?.metadata);
  if (lower.includes("timeout") && lower.includes("provider")) return buildFailure("PROVIDER_TIMEOUT", msg, hint?.metadata);
  if (lower.includes("timeout") && lower.includes("tool")) return buildFailure("TOOL_TIMEOUT", msg, hint?.metadata);
  if (lower.includes("arg drift") || msg.includes("ARG_DRIFT")) return buildFailure("TOOL_NON_IDEMPOTENT", msg, hint?.metadata);
  if (lower.includes("partial commit")) return buildFailure("PARTIAL_COMMIT", msg, hint?.metadata);
  if (lower.includes("network partition")) return buildFailure("NETWORK_PARTITION", msg, hint?.metadata);
  if (lower.includes("outbox")) return buildFailure("OUTBOX_FAILURE", msg, hint?.metadata);

  return buildFailure("UNKNOWN_RUNTIME_FAILURE", msg, hint?.metadata);
}

function buildFailure(
  category: RuntimeFailureCategory,
  message: string,
  metadata?: Record<string, unknown>
): RuntimeFailureRecord {
  return {
    category,
    code: FAILURE_CODES[category],
    message,
    recoverable: RECOVERABLE_BY_DEFAULT[category],
    ...(metadata !== undefined ? { metadata } : {})
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Error";
  return String(err ?? "unknown");
}

export function chainFailure(
  outer: RuntimeFailureRecord,
  inner: RuntimeFailureRecord
): RuntimeFailureRecord {
  return {
    ...outer,
    cause: [inner, ...(outer.cause ?? [])]
  };
}

export function appendLineage(
  record: RuntimeFailureRecord,
  entry: RetryLineageEntry
): RuntimeFailureRecord {
  return {
    ...record,
    retryLineage: [...(record.retryLineage ?? []), entry]
  };
}

export type ExternalVerificationStatus = "COMMITTED" | "NOT_COMMITTED" | "AMBIGUOUS";

export interface ExternalVerificationResult {
  status: ExternalVerificationStatus;
  output?: Record<string, unknown>;
  error?: string;
}

export interface ReconciliationContext {
  readonly executionId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly stepSequence: number;
}

export type ExternalVerificationHook = (
  ctx: ReconciliationContext
) => Promise<ExternalVerificationResult>;

export class AmbiguityDetectedError extends InvariantViolation {
  readonly name = "AmbiguityDetectedError";
  constructor(
    readonly context: ReconciliationContext,
    message: string = `ambiguous execution state: double-fire risk for side effect '${context.toolName}' with key '${context.idempotencyKey}'`
  ) {
    super(message, "S3");
  }
}

class VerificationHookRegistry {
  private hooks = new Map<string, ExternalVerificationHook>();

  register(toolName: string, hook: ExternalVerificationHook): void {
    this.hooks.set(toolName, hook);
  }

  get(toolName: string): ExternalVerificationHook | undefined {
    return this.hooks.get(toolName);
  }

  clear(): void {
    this.hooks.clear();
  }
}

export const verificationRegistry = new VerificationHookRegistry();

export type ReplaySafetyStatus =
  | "replay-safe"
  | "replay-equivalent"
  | "replay-diverged"
  | "replay-unsafe";

export type SideEffectCapability =
  | "SAFE_IDEMPOTENT"
  | "CONDITIONALLY_IDEMPOTENT"
  | "NON_IDEMPOTENT"
  | "UNSAFE";

export class SideEffectCapabilityRegistry {
  private readonly capabilities = new Map<string, SideEffectCapability>();

  constructor() {
    this.reset();
  }

  register(toolName: string, capability: SideEffectCapability): void {
    this.capabilities.set(toolName, capability);
  }

  get(toolName: string): SideEffectCapability | undefined {
    return this.capabilities.get(toolName);
  }

  reset(): void {
    this.capabilities.clear();
    this.capabilities.set("web.search", "SAFE_IDEMPOTENT");
    this.capabilities.set("file.read", "SAFE_IDEMPOTENT");
    this.capabilities.set("code.execute", "SAFE_IDEMPOTENT");
    this.capabilities.set("memory.summarize", "SAFE_IDEMPOTENT");
    this.capabilities.set("runtime.inspect", "SAFE_IDEMPOTENT");
    this.capabilities.set("sandbox.db_write", "CONDITIONALLY_IDEMPOTENT");
    this.capabilities.set("sandbox.payment_refund", "NON_IDEMPOTENT");
    this.capabilities.set("stripe.payment", "UNSAFE");
    this.capabilities.set("aws.infrastructure", "UNSAFE");
    this.capabilities.set("infrastructure.mutate", "UNSAFE");
    this.capabilities.set("operator.restart", "UNSAFE");
    this.capabilities.set("email.send", "NON_IDEMPOTENT");
    this.capabilities.set("slack.post", "NON_IDEMPOTENT");
  }

  clear(): void {
    this.reset();
  }
}

export const sideEffectCapabilityRegistry = new SideEffectCapabilityRegistry();

export const REPLAY_SAFE_TOOLS = new Set<string>([
  "web.search",
  "file.read",
  "code.execute",
  "memory.summarize",
  "runtime.inspect"
]);

export const REPLAY_SIMULATED_TOOLS = new Set<string>([
  "sandbox.db_write",
  "email.send",
  "slack.post"
]);

export const REPLAY_BLOCKED_TOOLS = new Set<string>([
  "stripe.payment",
  "aws.infrastructure",
  "infrastructure.mutate",
  "sandbox.payment_refund"
]);

export const REPLAY_MANUAL_TOOLS = new Set<string>([
  "operator.restart"
]);

export function isReplaySafeTool(toolName: string): boolean {
  const cap = sideEffectCapabilityRegistry.get(toolName);
  return cap === "SAFE_IDEMPOTENT";
}

export function isReplaySimulatedTool(toolName: string): boolean {
  return REPLAY_SIMULATED_TOOLS.has(toolName);
}

export function isReplayManualTool(toolName: string): boolean {
  return REPLAY_MANUAL_TOOLS.has(toolName);
}

export function isToolSafe(toolName: string): boolean {
  return isReplaySafeTool(toolName);
}

export class ReplaySandboxViolationError extends Error {
  readonly name = "ReplaySandboxViolationError";
  constructor(public readonly idempotencyKey: string, public readonly toolName: string) {
    super(
      `Replay sandbox violation: blocked execution of non-safe tool '${toolName}' under key '${idempotencyKey}' during replay execution.`
    );
  }
}

export function validateReplayAction(
  input: {
    executionId: string;
    stepType: string;
    activeReplayState?: { diverged: boolean; safety: ReplaySafetyStatus };
    toolName?: string;
  }
): void {
  if (
    input.activeReplayState?.diverged &&
    input.stepType === "TOOL_CALL" &&
    input.toolName &&
    !isReplaySafeTool(input.toolName) &&
    !isReplaySimulatedTool(input.toolName) &&
    !isReplayManualTool(input.toolName)
  ) {
    assertRuntimeInvariant(
      "RP1",
      false,
      `Replay Side-Effect Mutex violation: cannot execute unsafe side-effect '${input.toolName}' after replay divergence`,
      { executionId: input.executionId, toolName: input.toolName }
    );
  }
}

/**
 * Canonical ownership context.
 *
 * The fencing token is a single strictly-positive, strictly-monotonic integer
 * (`attempt`). `lease_epoch`, `fencing_token`, and `ownership_version` are
 * canonical *aliases* of that one value — they exist so the durable schema and
 * cross-system contracts can name the dimension explicitly, but they MUST never
 * diverge from `attempt`. `worker_identity` is an alias of `workerId`.
 *
 * Keeping a single source of truth (rather than four independently-advanced
 * counters) is what makes "stale epochs can NEVER mutate" decidable: a stale
 * holder is exactly one whose `attempt` is below the live owner's. If the
 * aliases were allowed to drift, an ownership check that consulted one alias
 * could admit a holder that another alias would reject — the fail-open
 * "ownership resurrection" hole. F7 forbids that drift; ownership checks then
 * compare every dimension with AND semantics (fail-closed).
 */
export interface CanonicalOwnershipContext {
  readonly workerId: string;
  readonly attempt: number;
  readonly leaseEpoch?: number;
  readonly lease_epoch?: number;
  readonly fencingToken?: number;
  readonly fencing_token?: number;
  readonly ownershipVersion?: number;
  readonly ownership_version?: number;
  readonly workerIdentity?: string;
  readonly worker_identity?: string;
}

/** The single canonical fencing token / epoch for an ownership context. */
export function canonicalEpochOf(owner: CanonicalOwnershipContext): number {
  return owner.attempt;
}

/**
 * F7 — assert that every supplied canonical alias agrees with the single
 * fencing token. Aliases left `undefined` are treated as "not asserted" (the
 * durable stores derive them from `attempt`, so absence is consistent by
 * construction); a *present* alias that disagrees is a hard invariant
 * violation. This is the guard that prevents a divergent canonical context from
 * ever reaching a compare-and-set, where an OR-style check could otherwise let
 * a stale epoch resurrect ownership.
 */
export function assertCanonicalOwnershipConsistency(
  owner: CanonicalOwnershipContext,
  context?: Record<string, unknown>
): void {
  assertRuntimeInvariant(
    "L1",
    Number.isInteger(owner.attempt) && owner.attempt > 0,
    `fencing token must be a positive integer, got ${owner.attempt}`,
    { ...context, workerId: owner.workerId }
  );

  const epochAliases: ReadonlyArray<readonly [string, number | undefined]> = [
    ["leaseEpoch", owner.leaseEpoch],
    ["lease_epoch", owner.lease_epoch],
    ["fencingToken", owner.fencingToken],
    ["fencing_token", owner.fencing_token],
    ["ownershipVersion", owner.ownershipVersion],
    ["ownership_version", owner.ownership_version]
  ];
  for (const [name, value] of epochAliases) {
    if (value === undefined) continue;
    assertRuntimeInvariant(
      "F7",
      value === owner.attempt,
      `canonical epoch alias '${name}'=${value} diverges from fencing token attempt=${owner.attempt}`,
      { ...context, workerId: owner.workerId, alias: name, value, attempt: owner.attempt }
    );
  }

  const identityAliases: ReadonlyArray<readonly [string, string | undefined]> = [
    ["workerIdentity", owner.workerIdentity],
    ["worker_identity", owner.worker_identity]
  ];
  for (const [name, value] of identityAliases) {
    if (value === undefined) continue;
    assertRuntimeInvariant(
      "F7",
      value === owner.workerId,
      `canonical worker identity alias '${name}'='${value}' diverges from workerId='${owner.workerId}'`,
      { ...context, workerId: owner.workerId, alias: name, value }
    );
  }
}

export interface LeaseMutationIntent {
  executionId: string;
  workerId: string;
  attempt: number;
  currentStatus?: ExecutionStatus;
  targetStatus?: ExecutionStatus;
  phase?: string;
  leaseId?: string;
  expiration?: string;
}

export function validateFencingToken(intent: LeaseMutationIntent): void {
  assertRuntimeInvariant(
    "L1",
    Number.isInteger(intent.attempt) && intent.attempt > 0,
    `Lease token attempt must be a positive integer, got ${intent.attempt}`,
    { ...intent }
  );
  assertRuntimeInvariant(
    "L2",
    intent.executionId.length > 0 && intent.workerId.length > 0 && (intent.leaseId === undefined || intent.leaseId.length > 0),
    "Lease mutation requires executionId, workerId, and leaseId ownership identity",
    { ...intent }
  );
  if (intent.currentStatus && intent.targetStatus) {
    assertTransition(intent.executionId, intent.currentStatus, intent.targetStatus);
    
    // RP3 Replay Isolation assertion:
    if (intent.executionId.endsWith("-replay") && intent.targetStatus !== "REPLAYING") {
      assertRuntimeInvariant(
        "RP3",
        false,
        `Replay ownership collision: replay execution ${intent.executionId} has illegal transition context`
      );
    }

    // Serialized recovery transition assertion:
    if (intent.targetStatus === "RECOVERING") {
      assertRuntimeInvariant(
        "R1",
        intent.attempt > 1,
        `Recovery Fence Monotonicity violation: duplicate recovery attempt ${intent.attempt} is not strictly monotonic`
      );
    }
  }
}

export function validateFencingMonotonicity(
  attempt: number,
  executionStatus: ExecutionStatus,
  workerId?: string
): void {
  validateFencingToken({
    executionId: "unknown",
    workerId: workerId ?? "unknown",
    attempt,
    currentStatus: executionStatus,
    phase: "recovery-monotonicity"
  });
  if (executionStatus === "RECOVERING" && workerId !== "worker-recovery") {
    assertRuntimeInvariant(
      "R1",
      attempt > 1,
      `Recovery Fence Monotonicity violation: duplicate recovery attempt ${attempt} is not strictly monotonic`,
      { attempt, workerId }
    );
  }
}

export function assertRetryAllowed(
  failureType: RuntimeFailureCategory | undefined,
  executionId: string
): void {
  // Capability-aware retry assertions
  if (failureType === "TOOL_NON_IDEMPOTENT" || failureType === "AMBIGUOUS_EXTERNAL_COMMIT") {
    assertRuntimeInvariant(
      "CAP4",
      false,
      `Unsafe retry blocked: execution '${executionId}' failed due to non-idempotent side effect and cannot be retried without reconciliation.`
    );
  }

  const retryable = failureType ? RECOVERY_SEMANTICS_MAP[failureType]?.retryable !== false : true;
  assertRuntimeInvariant(
    "R2",
    retryable,
    `Unsafe retry blocked: execution '${executionId}' failed with non-retryable failure type '${failureType}'`,
    { executionId, failureType }
  );
}

export function isAmbiguityError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AmbiguityDetectedError" || err.message.includes("ambiguous"));
}

export interface StructuralValidationResult {
  states: readonly ExecutionStatus[];
  terminalStates: readonly ExecutionStatus[];
  activeStates: readonly ExecutionStatus[];
  failureCategories: readonly RuntimeFailureCategory[];
  invariantIds: readonly InvariantId[];
}

/**
 * Validates that the failure taxonomy, its recoverability flags, and its
 * recovery semantics are mutually consistent. Parameterized over the three
 * tables so the rules can be exercised in isolation (including with
 * deliberately-inconsistent inputs) rather than only against the live maps.
 *
 * Enforced invariants:
 *   - Every code round-trips to its category key (`FAILURE_CODES[c] === c`).
 *   - `recoverable` equals `retryable OR replayable` — a category is
 *     recoverable-by-default iff some recovery path (retry or replay) exists.
 *   - A `terminal` failure can be neither retryable nor replayable, and
 *     therefore cannot be recoverable-by-default.
 *
 * Returns the validated category keys.
 */
export function validateRecoveryTable(
  failureCodes: Record<string, string>,
  recoverableByDefault: Record<string, boolean>,
  recoverySemantics: Record<string, RecoverySemantics>
): string[] {
  const categories = Object.keys(failureCodes);
  for (const category of categories) {
    if (recoverableByDefault[category] === undefined) {
      throw new Error(`Structural semantic validation failed: failure '${category}' is missing recoverability policy`);
    }
    const semantics = recoverySemantics[category];
    if (!semantics) {
      throw new Error(`Structural semantic validation failed: failure '${category}' is missing recovery semantics`);
    }
    if (failureCodes[category] !== category) {
      throw new Error(`Structural semantic validation failed: failure code for '${category}' must round-trip to its category key`);
    }
    if (recoverableByDefault[category] !== (semantics.retryable || semantics.replayable)) {
      throw new Error(
        `Structural semantic validation failed: failure '${category}' recoverability (${recoverableByDefault[category]}) must equal (retryable OR replayable)`
      );
    }
    if (semantics.terminal && (semantics.retryable || semantics.replayable)) {
      throw new Error(`Structural semantic validation failed: terminal failure '${category}' cannot be retryable or replayable`);
    }
    if (recoverableByDefault[category] && semantics.terminal) {
      throw new Error(`Structural semantic validation failed: terminal failure '${category}' cannot be recoverable`);
    }
  }
  return categories;
}

export function runStructuralValidation(): StructuralValidationResult {
  for (const state of EXECUTION_STATES) {
    if (!LEGAL_TRANSITIONS[state]) {
      throw new Error(`Structural semantic validation failed: state '${state}' is missing from transition mapping`);
    }
  }

  for (const [from, destinations] of Object.entries(LEGAL_TRANSITIONS)) {
    if (!EXECUTION_STATE_SET.has(from as ExecutionStatus)) {
      throw new Error(`Structural semantic validation failed: transition source '${from}' is not a defined state`);
    }
    for (const to of destinations) {
      if (!EXECUTION_STATE_SET.has(to)) {
        throw new Error(
          `Structural semantic validation failed: illegal transition destination '${to}' defined from state '${from}'`
        );
      }
    }
  }

  const visited = new Set<ExecutionStatus>(["CREATION"]);
  const stack: ExecutionStatus[] = ["CREATION"];
  while (stack.length) {
    const current = stack.pop()!;
    for (const next of LEGAL_TRANSITIONS[current]) {
      if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  for (const state of EXECUTION_STATES) {
    if (!visited.has(state)) {
      throw new Error(`Structural semantic validation failed: state '${state}' is unreachable from CREATION`);
    }
  }

  for (const terminal of TERMINAL_STATES) {
    if (LEGAL_TRANSITIONS[terminal].size !== 0 && !RESTARTABLE_TERMINAL_STATES.has(terminal)) {
      throw new Error(`Structural semantic validation failed: terminal state '${terminal}' has outgoing transitions`);
    }
  }
  for (const restartable of RESTARTABLE_TERMINAL_STATES) {
    if (!TERMINAL_STATES.has(restartable)) {
      throw new Error(`Structural semantic validation failed: restartable-terminal state '${restartable}' is not a terminal state`);
    }
  }

  const categories = validateRecoveryTable(
    FAILURE_CODES,
    RECOVERABLE_BY_DEFAULT,
    RECOVERY_SEMANTICS_MAP
  ) as RuntimeFailureCategory[];

  return {
    states: EXECUTION_STATES,
    terminalStates: [...TERMINAL_STATES],
    activeStates: [...ACTIVE_STATES],
    failureCategories: categories,
    invariantIds: Object.keys(INVARIANT_REGISTRY) as InvariantId[]
  };
}

export const RUNTIME_CONSTITUTION = runStructuralValidation();
