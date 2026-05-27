/**
 * Cognition domain: multi-agent orchestration state machine + node lineage.
 *
 * A CognitionGraph is the deterministic, replayable execution graph for one
 * top-level task. Each CognitionNode is one agent step (planner/executor/...).
 * Nodes are immutable once finalized; the graph grows append-only.
 */

export type AgentRole =
  | "PLANNER"
  | "EXECUTOR"
  | "VERIFIER"
  | "CRITIC"
  | "MEMORY_MANAGER";

export type CognitionPhase =
  | "INIT"
  | "PLAN"
  | "EXECUTE"
  | "VERIFY"
  | "CRITIQUE"
  | "MEMORY_COMMIT"
  | "COMPLETE"
  | "FAILED";

export type CognitionNodeStatus =
  | "PENDING"
  | "RUNNING"
  | "STREAMING"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED"
  | "REPLAYED";

export interface CognitionNode {
  /** Deterministic ID: hash(executionId, sequence, role, inputFingerprint). */
  id: string;
  cognitionId: string;
  executionId: string;
  parentNodeId?: string;
  /** Monotonic per-cognition node sequence — primary replay key. */
  sequence: number;
  role: AgentRole;
  phase: CognitionPhase;
  status: CognitionNodeStatus;
  /** Input fingerprint — stable hash of inputs for replay equivalence. */
  inputFingerprint: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  /** Streamed token chunks, ordered. Used by the streaming overlay. */
  tokenStream?: TokenChunk[];
  uncertainty?: UncertaintyScore;
  /** IDs of memory records consulted at this node, with influence weights. */
  memoryInfluence?: MemoryInfluence[];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  workerId?: string;
  /** If this node was reproduced by replay, the source node it was forked from. */
  replayedFromNodeId?: string;
  confidenceScore?: number;
  confidenceClassification?: "HIGH" | "MEDIUM" | "LOW" | "CRITICAL";
  confidenceLineage?: ConfidenceLineage;
  confidencePropagation?: ConfidencePropagation;
  degradationTracking?: DegradationTracking;
  instabilityAttribution?: InstabilityAttribution;
}

export interface ConfidenceLineage {
  /** The path of node IDs from root/parent to this node. */
  path: string[];
  /** The sequence of confidence scores along this path. */
  scores: number[];
}

export interface ConfidencePropagation {
  /** Average confidence of ancestors. */
  ancestorAverage: number;
  /** Minimum confidence in lineage so far. */
  lineageMin: number;
  /** Whether degradation is actively propagating. */
  propagatingDegradation: boolean;
}

export interface DegradationTracking {
  /** ID of the direct parent node that degraded. */
  parentId?: string;
  /** Parent's confidence score. */
  parentConfidence?: number;
  /** Amount of confidence lost from parent to child (parentConfidence - currentConfidence). */
  confidenceDrop: number;
  /** Severity of degradation (e.g. NONE, LOW, HIGH, CRITICAL). */
  severity: "NONE" | "LOW" | "HIGH" | "CRITICAL";
}

export interface InstabilityAttribution {
  /** Node ID or identifier that is attributed as the source of uncertainty. */
  sourceId: string;
  /** Type of source: "TOOL" | "LLM" | "PARENT" | "CONTEXT". */
  sourceType: "TOOL" | "LLM" | "PARENT" | "CONTEXT";
  /** Confidence/uncertainty score of the source. */
  uncertaintyScore: number;
  /** Qualitative reason for attribution. */
  reason: string;
}

export interface TokenChunk {
  sequence: number;
  text: string;
  /** Per-token logprob proxy ∈ [0,1] — higher = more confident. */
  confidence: number;
  emittedAt: string;
}

export interface UncertaintyScore {
  /** Aggregated 0..1 — 0 high confidence, 1 maximally uncertain. */
  overall: number;
  /** Variance of per-token confidence. */
  variance: number;
  /** Number of tokens below a low-confidence threshold. */
  lowConfidenceTokens: number;
  /** Optional self-reported confidence from the agent. */
  selfReport?: number;
}

export interface MemoryInfluence {
  memoryId: string;
  /** 0..1 — fraction of attention this memory received at this node. */
  weight: number;
  /** Free-text reason. */
  reason?: string;
}

export interface AgentHandoff {
  fromNodeId: string;
  toRole: AgentRole;
  /** Why the handoff happened — verifier-rejected, critic-revised, etc. */
  reason: string;
  /** Carry-over context passed to the next role. */
  carryOver: Record<string, unknown>;
}

export interface CognitionGraph {
  id: string;
  executionId: string;
  agentId: string;
  /** Root cognition has no parent; branches link to source. */
  parentCognitionId?: string;
  parentNodeId?: string;
  /**
   * Owning tenant. Resolved from the execution's tenant at orchestrator start.
   * Required by the postgres cognition repository so the cognition_graphs row
   * cannot silently default to the `system` tenant.
   */
  tenantId?: string;
  phase: CognitionPhase;
  startedAt: string;
  completedAt?: string;
  /** Final terminal output if reached. */
  output?: Record<string, unknown>;
  /** Worker that owns the live cognition; undefined when complete. */
  ownerWorkerId?: string;
  nodes: CognitionNode[];
  handoffs: AgentHandoff[];
  /** Aggregated uncertainty over all nodes — for heatmap rollups. */
  uncertainty?: UncertaintyScore;
  autonomyLevel?: "FULL" | "DEGRADED" | "HALTED";
  escalationRequired?: boolean;
  stabilizationActionsTaken?: string[];
}

export interface NodeLineage {
  nodeId: string;
  cognitionId: string;
  ancestors: string[];
  descendants: string[];
  /** Sibling branches that forked from the same parent node. */
  siblings: string[];
}

export interface CognitionStartInput {
  agentId: string;
  goal: string;
  task: Record<string, unknown>;
  parentCognitionId?: string;
  parentNodeId?: string;
  /** Optional seed for fully deterministic replays. */
  seed?: string;
  /**
   * Owning tenant. Stamped onto the resulting CognitionGraph so the
   * cognition repository can persist tenant_id alongside the graph row.
   */
  tenantId?: string;
}
