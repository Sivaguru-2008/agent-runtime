import type { ExecutionCheckpoint, ExecutionLease, RuntimeWorker } from "./cluster.js";
import type { Agent, Execution, ExecutionStep, MemoryRecord, TokenUsage, ToolCallRecord, ReplayExternalityRecord } from "./model.js";
import type {
  AgentHandoff,
  AgentRole,
  CognitionGraph,
  CognitionNode,
  CognitionPhase,
  MemoryInfluence,
  TokenChunk,
  UncertaintyScore
} from "./cognition.js";
import type { BranchPointer, ReplayFrame, ReplaySnapshot } from "./replay.js";
import type { FailureSignal } from "./failure.js";

export type DomainEventType =
  | "AGENT_CREATED"
  | "AGENT_STARTED"
  | "AGENT_STOPPED"
  | "TASK_SCHEDULED"
  | "EXECUTION_STARTED"
  | "EXECUTION_STEP_STARTED"
  | "EXECUTION_STEP_COMPLETED"
  | "MEMORY_RETRIEVED"
  | "TOOL_CALLED"
  | "MODEL_COMPLETED"
  | "RETRY_TRIGGERED"
  | "OBSERVABILITY_WARNING"
  | "SUBAGENT_SPAWNED"
  | "EXECUTION_FAILED"
  | "EXECUTION_COMPLETED"
  | "EXECUTION_REPLAY_REQUESTED"
  | "WORKER_REGISTERED"
  | "WORKER_HEARTBEAT"
  | "WORKER_LOST"
  | "WORKER_STOPPED"
  | "WORKER_STATUS_CHANGED"
  | "EXECUTION_LEASED"
  | "EXECUTION_LEASE_RENEWED"
  | "EXECUTION_LEASE_RELEASED"
  | "EXECUTION_LEASE_RECLAIMED"
  | "EXECUTION_CHECKPOINT_WRITTEN"
  | "EXECUTION_RESUMED"
  | "EXECUTION_RECONCILIATION_REQUIRED"
  | "EXECUTION_RECONCILIATION_RESOLVED"
  // --- Phase 2: reliability hardening ---
  // Poison-pill: execution exceeded max attempt threshold → moved to DLQ
  | "EXECUTION_POISON_PILL_DETECTED"
  // Dead-letter: execution persisted to DLQ, will not be re-enqueued
  | "EXECUTION_DEAD_LETTERED"
  // Fencing: stale worker attempted to continue after its lease was lost
  | "EXECUTION_FENCE_VIOLATED"
  // Fencing: stale worker's terminal write was rejected by post-execution
  // lease check. Distinct from EXECUTION_FENCE_VIOLATED in that no exception
  // is raised — the stale worker silently stops and the legitimate owner's
  // outcome (already committed) is preserved.
  | "EXECUTION_FENCE_REJECTED"
  // Cancellation: execution was interrupted via AbortSignal. Distinct from
  // EXECUTION_FAILED because no error occurred — the worker was instructed
  // to stop (lease revocation, graceful shutdown, manual cancel). No state
  // mutation accompanies this event; the legitimate new owner (if any)
  // will produce the terminal outcome.
  | "EXECUTION_ABORTED"
  // Circuit breaker state transitions (one event type, name identifies circuit)
  | "CIRCUIT_BREAKER_OPENED"
  | "CIRCUIT_BREAKER_CLOSED"
  | "CIRCUIT_BREAKER_HALF_OPEN"
  // Generic observable system error (replaces silent catch-and-ignore)
  | "SYSTEM_ERROR_RAISED"
  // --- Sprint Next: cognition ---
  | "COGNITION_STARTED"
  | "COGNITION_PHASE_CHANGED"
  | "COGNITION_NODE_STARTED"
  | "COGNITION_NODE_STREAMING"
  | "COGNITION_NODE_COMPLETED"
  | "COGNITION_NODE_FAILED"
  | "COGNITION_HANDOFF"
  | "COGNITION_COMPLETED"
  | "COGNITION_FAILED"
  // --- Sprint Next: replay + branching ---
  | "REPLAY_SESSION_CREATED"
  | "REPLAY_SNAPSHOT_WRITTEN"
  | "REPLAY_FRAME_EMITTED"
  | "REPLAY_BRANCH_CREATED"
  | "REPLAY_DIVERGENCE_DETECTED"
  | "REPLAY_LIFECYCLE_TRANSITIONED"
  // Phase C: snapshot integrity validation. Raised when the SnapshotStore
  // detects a stored snapshot whose integrityHash does not match a recompute
  // over its { graph, eventSequence, frameIndex } projection. Used by recovery
  // to refuse to hydrate from a corrupt graph and by observability to surface
  // tampering or storage corruption.
  | "SNAPSHOT_INTEGRITY_VIOLATED"
  // --- Sprint Next: failure intelligence ---
  | "FAILURE_SIGNAL_RAISED"
  | "HALLUCINATION_DETECTED"
  | "CONTRADICTION_DETECTED"
  | "RECURSION_DETECTED"
  | "TOOL_MISUSE_DETECTED"
  | "CORRUPTED_MEMORY_DETECTED"
  | "UNCERTAINTY_SPIKE"
  // --- Phase 3: failure intelligence ---
  | "EXECUTION_LOOP_DETECTED"
  | "LOW_CONFIDENCE_DETECTED"
  // --- Phase 3: replay productization ---
  | "REPLAY_CHECKPOINT_CREATED"
  | "CAUSALITY_TRACED"
  | "BRANCH_COMPARISON_COMPUTED"
  // --- Phase 7: real failure intelligence ---
  // ExecutionHealthModel produced a new health snapshot for an execution.
  // Drives dashboards, gating policies, and SLO tracking.
  | "EXECUTION_HEALTH_COMPUTED"
  // FailureLearning recorded a signal that matched (or created) a signature.
  // One event per matched signature so consumers can react to *patterns*
  // not individual signals.
  | "FAILURE_PATTERN_OBSERVED"
  // An execution was indexed as anomalous on at least one dimension.
  | "EXECUTION_ANOMALY_INDEXED"
  // A branch's outcome was scored relative to its source — repair effective?
  | "REPAIR_OUTCOME_EVALUATED"
  // A terminal cognition outcome (SOURCE or BRANCH) was persisted into the
  // ReplayOutcomeStore. Activates the adaptive learning feedback loop.
  | "REPLAY_OUTCOME_RECORDED"
  // --- Sprint Next: memory influence ---
  | "MEMORY_INFLUENCE_RECORDED"
  // --- Confidence events ---
  | "runtime.confidence.degraded"
  | "runtime.confidence.recovered"
  | "runtime.confidence.critical"
  | "PLANNER_VALIDATION_PASSED"
  | "PLANNER_VALIDATION_FAILED"
  | "COGNITION_RECOVERY_TRIGGERED"
  | "COGNITION_RECOVERY_TRIGGERED"
  | "COGNITION_ORCHESTRATION_DECISION"
  | "EXTERNALITY_RECORDED";


export interface EventMetadata {
  traceId: string;
  correlationId: string;
  causationId?: string;
  tenantId?: string;
  schemaVersion: number;
  source: string;
  /**
   * Deterministic deduplication key derived from the business operation context
   * (type + aggregateId + traceId). The EventStore enforces uniqueness on this
   * key so that identical logical operations published more than once (e.g., on
   * network-timeout retries) produce exactly one persisted event.
   */
  idempotencyKey: string;
  originalAggregateId?: string;
}

export interface DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  type: DomainEventType;
  aggregateId: string;
  aggregateType: "AGENT" | "EXECUTION" | "MEMORY" | "SYSTEM";
  version: number;
  timestamp: string;
  payload: TPayload;
  metadata: EventMetadata;
  sequence?: number;
}

export type AgentCreatedEvent = DomainEvent<{ agent: Agent }>;
export type ExecutionStartedEvent = DomainEvent<{ execution: Execution }>;
export type ExecutionStepStartedEvent = DomainEvent<{ step: ExecutionStep }>;
export type ExecutionStepCompletedEvent = DomainEvent<{ step: ExecutionStep }>;
export type MemoryRetrievedEvent = DomainEvent<{ records: MemoryRecord[]; query: string }>;
export type ToolCalledEvent = DomainEvent<{ toolCall: ToolCallRecord }>;
export type ModelCompletedEvent = DomainEvent<{ output: Record<string, unknown>; tokenUsage: TokenUsage }>;
export type ExecutionFailedEvent = DomainEvent<{ execution: Execution }>;
export type ExecutionCompletedEvent = DomainEvent<{ execution: Execution }>;
export type WorkerRegisteredEvent = DomainEvent<{ worker: RuntimeWorker }>;
export type WorkerHeartbeatEvent = DomainEvent<{ worker: RuntimeWorker }>;
export type WorkerLostEvent = DomainEvent<{ worker: RuntimeWorker; reason: string }>;
export type ExecutionLeasedEvent = DomainEvent<{ lease: ExecutionLease }>;
export type ExecutionLeaseReclaimedEvent = DomainEvent<{ lease: ExecutionLease; reason: string }>;
export type ExecutionCheckpointEvent = DomainEvent<{ checkpoint: ExecutionCheckpoint }>;
export type ExecutionResumedEvent = DomainEvent<{ executionId: string; fromSequence: number; workerId: string }>;
export type ExternalityRecordedEvent = DomainEvent<{ externality: ReplayExternalityRecord }>;

// --- Sprint Next event payloads ---

export type CognitionStartedEvent = DomainEvent<{ graph: CognitionGraph }>;
export type CognitionPhaseChangedEvent = DomainEvent<{ cognitionId: string; from: CognitionPhase; to: CognitionPhase }>;
export type CognitionNodeStartedEvent = DomainEvent<{ node: CognitionNode }>;
export type CognitionNodeStreamingEvent = DomainEvent<{ nodeId: string; cognitionId: string; chunk: TokenChunk }>;
export type CognitionNodeCompletedEvent = DomainEvent<{ node: CognitionNode; uncertainty?: UncertaintyScore }>;
export type CognitionNodeFailedEvent = DomainEvent<{ node: CognitionNode; error: string }>;
export type CognitionHandoffEvent = DomainEvent<{ cognitionId: string; handoff: AgentHandoff; toRole: AgentRole }>;
export type CognitionCompletedEvent = DomainEvent<{ graph: CognitionGraph }>;

export type ReplaySessionCreatedEvent = DomainEvent<{
  sessionId: string;
  cognitionId: string;
  executionId: string;
  forkedFrom?: { sessionId: string; frameIndex: number };
}>;
export type ReplaySnapshotWrittenEvent = DomainEvent<{ snapshot: ReplaySnapshot }>;
export type ReplayFrameEmittedEvent = DomainEvent<{ sessionId: string; frame: ReplayFrame }>;
export type ReplayBranchCreatedEvent = DomainEvent<{ pointer: BranchPointer; reason?: string }>;
export type ReplayDivergenceDetectedEvent = DomainEvent<{
  sourceCognitionId: string;
  branchCognitionId: string;
  divergenceFrameIndex: number;
}>;

// Phase C: snapshot integrity. Emitted by SnapshotStore.get/nearest when a
// stored snapshot's recomputed integrityHash does not match its persisted
// value. The `operation` field disambiguates the read path that surfaced it
// (helps operators reproduce); `storedHash` / `computedHash` are surfaced
// for forensics.
export type SnapshotIntegrityViolatedEvent = DomainEvent<{
  snapshotId: string;
  cognitionId: string;
  executionId: string;
  frameIndex: number;
  storedHash: string | null;
  computedHash: string;
  operation: "get" | "nearest" | "put";
}>;

export type FailureSignalRaisedEvent = DomainEvent<{ signal: FailureSignal }>;
export type MemoryInfluenceRecordedEvent = DomainEvent<{
  cognitionId: string;
  nodeId: string;
  influence: MemoryInfluence[];
}>;

// --- Phase 7: real failure intelligence event payloads ---

export type ExecutionHealthComputedEvent = DomainEvent<{
  executionId: string;
  cognitionId?: string;
  healthScore: number;
  grade: "A" | "B" | "C" | "D" | "F";
  /** Sub-score values (null when insufficient data). */
  components: {
    confidence: number | null;
    stability: number | null;
    toolReliability: number | null;
    consistency: number | null;
    anomaly: number | null;
  };
}>;

export type FailurePatternObservedEvent = DomainEvent<{
  signatureId: string;
  signalId: string;
  signalKind: string;
  occurrenceCount: number;
  /** First time this signature has been observed. */
  isNew: boolean;
}>;

export type ExecutionAnomalyIndexedEvent = DomainEvent<{
  executionId: string;
  agentId?: string;
  anomalyScore: number;
  topDimension: string;
  topRobustZScore: number;
}>;

export type RepairOutcomeEvaluatedEvent = DomainEvent<{
  sourceCognitionId: string;
  branchCognitionId: string;
  healthScoreDelta: number;
  netSignalDelta: number;
  /** Signal kinds the branch resolved vs the source. */
  resolvedKinds: string[];
}>;

export type ReplayOutcomeRecordedEvent = DomainEvent<{
  cognitionId: string;
  executionId: string;
  /** SOURCE = original execution; BRANCH = forked from a source. */
  kind: "SOURCE" | "BRANCH";
  sourceCognitionId?: string;
  succeeded: boolean;
  healthScore: number;
  failureSignalCount: number;
  observedSignalKinds: string[];
  totalTokens?: number;
  durationMs?: number;
  recordedAt: string;
}>;

// --- Phase 2: reliability hardening event payloads ---

export type ExecutionPoisonPillDetectedEvent = DomainEvent<{
  executionId: string;
  workerId: string;
  /** How many times this execution was attempted before detection. */
  attemptCount: number;
  maxAttempts: number;
}>;

export type ExecutionDeadLetteredEvent = DomainEvent<{
  executionId: string;
  workerId: string;
  failureCount: number;
  lastError: string;
  movedAt: string;
}>;

export type ExecutionFenceViolatedEvent = DomainEvent<{
  executionId: string;
  workerId: string;
  /** Fencing token the worker held when executing. */
  heldToken: number;
  /** Fencing token found in the lease store — must equal heldToken to proceed. */
  currentToken: number;
}>;

export type ExecutionFenceRejectedEvent = DomainEvent<{
  executionId: string;
  workerId: string;
  /** Terminal status the stale worker was about to write before the fence rejected it. */
  attemptedStatus: "FAILED";
  /** Underlying error message that drove the worker into its failure branch. */
  originalError: string;
}>;

export type ExecutionAbortedEvent = DomainEvent<{
  executionId: string;
  workerId: string;
  /**
   * Why the abort was issued. Used by dashboards to distinguish operator
   * action ("manual"), lease-recovery ("lease-lost"), and graceful drain
   * ("shutdown") without re-deriving from log context.
   */
  reason: "lease-lost" | "shutdown" | "manual";
}>;

export type CircuitBreakerOpenedEvent = DomainEvent<{
  /** Logical name of the protected resource, e.g. "postgres", "claude", "tools". */
  circuit: string;
  consecutiveFailures: number;
  failureThreshold: number;
}>;

export type CircuitBreakerClosedEvent = DomainEvent<{
  circuit: string;
  /** Consecutive successes that triggered closure. */
  consecutiveSuccesses: number;
}>;

export type CircuitBreakerHalfOpenEvent = DomainEvent<{
  circuit: string;
  /** How long the circuit was open before transitioning. */
  openDurationMs: number;
}>;

export type SystemErrorRaisedEvent = DomainEvent<{
  /** Subsystem where the error originated, e.g. "scheduler-tick", "heartbeat". */
  subsystem: string;
  message: string;
  /** Stack trace or cause chain for audit trail. */
  stack?: string;
}>;

// --- Confidence event payloads ---

export type ConfidenceDegradedEvent = DomainEvent<{
  cognitionId: string;
  nodeId: string;
  confidenceScore: number;
  previousConfidenceScore?: number;
  degradation: number;
}>;

export type ConfidenceRecoveredEvent = DomainEvent<{
  cognitionId: string;
  nodeId: string;
  confidenceScore: number;
  previousConfidenceScore: number;
  recovery: number;
}>;

export type ConfidenceCriticalEvent = DomainEvent<{
  cognitionId: string;
  nodeId: string;
  confidenceScore: number;
  requireEscalation: boolean;
}>;
