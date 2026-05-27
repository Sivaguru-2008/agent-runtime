/**
 * Failure Learning — Phase 7 domain types.
 *
 * WHY THIS EXISTS:
 *   A single FailureSignal is useful for one execution. Across thousands of
 *   executions, raw signals become noise unless we (1) cluster recurring
 *   failures into a single signature, (2) index anomalous executions for
 *   replay, (3) measure whether operator-driven repairs (branches with
 *   overrides) actually fix the failures, and (4) compare successful vs
 *   failed replay paths to extract reusable knowledge.
 *
 *   This module is the "learning layer" of the platform: it turns the
 *   append-only signal stream into a queryable knowledge base that gets
 *   smarter with every execution.
 *
 * NON-GOALS:
 *   - No ML training, no embeddings, no LLM-derived clustering. Production
 *     reliability requires determinism: identical inputs must produce identical
 *     signatures. We use stable hash-based clustering on normalized signal
 *     content. Smarter clustering can sit on top of this layer later.
 *
 * REPLAY/DEBUGGING VALUE:
 *   - Every cluster member retains its source executionId so an operator can
 *     pull up "the original 47 instances" and replay any of them.
 *   - Repair effectiveness scoring tells operators which override strategies
 *     (model swap, input override, memory injection) actually fix which
 *     failure kinds — so the platform recommends fixes that have worked before.
 */

import type { FailureSeverity, FailureSignal, FailureSignalKind } from "./failure.js";
import type { AgentRole } from "./cognition.js";
import type { AnomalyDimension } from "./executionHealth.js";

// ─── Failure signatures + clustering ─────────────────────────────────────────

/**
 * Deterministic signature of a class of failure. Two signals with the same
 * signatureId are "the same kind of failure happening again".
 *
 * Signature is derived from:
 *   - kind (HALLUCINATION, CONTRADICTION, ...)
 *   - role of the node it occurred at (PLANNER, EXECUTOR, ...)
 *   - normalized summary (dynamic tokens replaced with <var>)
 *   - shape of evidence metrics (sorted metric key set)
 *
 * The signature is stable across executions: an operator who sees signature
 * "sig:abc123" today and sees it again tomorrow knows the same failure pattern
 * recurred without having to read either trace.
 */
export interface FailureSignature {
  id: string;
  kind: FailureSignalKind;
  role?: AgentRole;
  /** Normalised summary used to derive the signature. */
  summaryTemplate: string;
  /** Sorted list of metric keys observed on the evidence. */
  metricKeys: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  /** How many signals have matched this signature. */
  occurrenceCount: number;
  /** Severity distribution across all matched signals. */
  severityDistribution: Record<FailureSeverity, number>;
  /** Up to 5 most-recent example signals (for triage drill-down). */
  examples: FailureSignal[];
  /** Up to 5 distinct executions where this signature fired. */
  exampleExecutionIds: string[];
}

export interface FailureCluster {
  signature: FailureSignature;
  /** Total signals in cluster. Equal to signature.occurrenceCount; surfaced for convenience. */
  size: number;
  /**
   * Cluster "heat" — how recently and how often this cluster is firing.
   * Computed as: occurrencesInLast24h / 24h-decay-weighted total.
   * Higher = more active right now (triage priority). 0..1.
   */
  heatScore: number;
  /** Distinct executions affected. */
  affectedExecutionCount: number;
}

// ─── Anomaly index ───────────────────────────────────────────────────────────

/**
 * Single entry in the anomaly index. One per execution that scored anomalous
 * on at least one dimension. Queryable by dimension, score range, agent, time.
 */
export interface AnomalyIndexEntry {
  executionId: string;
  agentId?: string;
  /** 0..1 — overall anomaly score (matches ExecutionAnomalyScore.value). */
  anomalyScore: number;
  /** The dimension that drove the anomaly. */
  topDimension: AnomalyDimension;
  /** Robust z-score on the top dimension. */
  topRobustZScore: number;
  indexedAt: string;
}

export interface AnomalyIndexQuery {
  minScore?: number;
  dimension?: AnomalyDimension;
  agentId?: string;
  /** ISO timestamp. */
  since?: string;
  limit?: number;
}

// ─── Replay outcome comparison ───────────────────────────────────────────────

/**
 * A single observed outcome for a cognition execution. Used to compare paths.
 */
export interface ReplayOutcome {
  cognitionId: string;
  executionId: string;
  /** SOURCE = original execution; BRANCH = forked from a source for repair. */
  kind: "SOURCE" | "BRANCH";
  /** If BRANCH, the source it was forked from. */
  sourceCognitionId?: string;
  /** If BRANCH, the override applied at the fork point. */
  branchOverride?: {
    type: RepairType;
    description: string;
  };
  /** Whether the execution reached COMPLETED status. */
  succeeded: boolean;
  healthScore: number;
  failureSignalCount: number;
  /** Failure signal kinds observed during this execution. */
  observedSignalKinds: FailureSignalKind[];
  totalTokens?: number;
  durationMs?: number;
  recordedAt: string;
}

/**
 * Comparison between a source outcome and one or more branch outcomes.
 * The platform produces this when an operator branches a failing execution
 * and re-runs it: we compare the source's failure footprint against each
 * branch to tell the operator which fix worked.
 */
export interface ReplayOutcomeComparison {
  sourceOutcome: ReplayOutcome;
  branches: BranchOutcomeDelta[];
  /** Branch with the largest positive healthScoreDelta, if any. */
  bestBranchCognitionId?: string;
  comparedAt: string;
}

export interface BranchOutcomeDelta {
  branchOutcome: ReplayOutcome;
  /** branch.healthScore - source.healthScore. Positive = branch is healthier. */
  healthScoreDelta: number;
  /** Signal kinds present in source that no longer appear in branch. */
  resolvedSignalKinds: FailureSignalKind[];
  /** Signal kinds that newly appeared in branch (regression). */
  newSignalKinds: FailureSignalKind[];
  /** Signal kinds present in both — the override didn't fix these. */
  persistentSignalKinds: FailureSignalKind[];
  /** Net effectiveness: resolved.length - newSignalKinds.length, range -∞..+∞. */
  netSignalDelta: number;
  /** Token cost delta (branch - source). Positive = branch was more expensive. */
  tokenDelta?: number;
}

// ─── Repair effectiveness ────────────────────────────────────────────────────

/**
 * Aggregated effectiveness of a *repair strategy* for a given *failure kind*.
 *
 * Example: across 200 branches that swapped the model in response to a
 * HALLUCINATION signal, 146 (73%) resolved the original signal and only 12
 * regressed. This is the platform's institutional memory.
 *
 * Calibration: each branch contributes one observation. We avoid double-counting
 * by deduping on branchCognitionId. We require minSampleSize before reporting
 * a recommendation; below that, the score is `unknown`.
 */
export type RepairType = "INPUT" | "MODEL" | "SEED" | "MEMORY_INJECTION";

export interface RepairEffectivenessScore {
  failureKind: FailureSignalKind;
  repairType: RepairType;
  /** Number of branches observed with this (kind, type) pair. */
  sampleSize: number;
  /** 0..1 — fraction of branches that resolved the target signal kind. */
  resolutionRate: number;
  /** 0..1 — fraction of branches that introduced a new signal kind. */
  regressionRate: number;
  /** Mean health-score delta across all sampled branches. */
  meanHealthDelta: number;
  /** Mean token cost delta. */
  meanTokenDelta: number;
  /** True when sampleSize ≥ minSampleSize so the score can drive recommendations. */
  confident: boolean;
  computedAt: string;
}

// ─── Repository ports ────────────────────────────────────────────────────────

export interface FailureSignatureStore {
  /**
   * Record an observed signal under its signature. Upserts: creates the
   * signature if missing, otherwise updates occurrence count + examples.
   */
  observe(signal: FailureSignal): Promise<FailureSignature>;
  getById(signatureId: string): Promise<FailureSignature | undefined>;
  listClusters(limit: number): Promise<FailureCluster[]>;
  /** Find clusters whose heat (recent activity) exceeds the threshold. */
  listHot(minHeatScore: number, limit: number): Promise<FailureCluster[]>;
}

export interface AnomalyIndex {
  index(entry: AnomalyIndexEntry): Promise<void>;
  query(q: AnomalyIndexQuery): Promise<AnomalyIndexEntry[]>;
}

export interface ReplayOutcomeStore {
  record(outcome: ReplayOutcome): Promise<void>;
  getByExecution(executionId: string): Promise<ReplayOutcome | undefined>;
  listBranchesOf(sourceCognitionId: string): Promise<ReplayOutcome[]>;
  /** All outcomes across all sources — used by repair-effectiveness aggregation. */
  listAll(): Promise<ReplayOutcome[]>;
}
