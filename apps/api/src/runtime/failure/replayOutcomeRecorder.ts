import type { CognitionGraph } from "../../domain/cognition.js";
import type {
  FailureReport,
  FailureSignalKind
} from "../../domain/failure.js";
import type { ReplayOutcome } from "../../domain/failureLearning.js";
import type { EventFactory } from "../../infrastructure/events/eventFactory.js";
import type { PersistedEventPublisher } from "../../infrastructure/events/persistedEventPublisher.js";
import type { Clock } from "../../shared/clock.js";
import { toIso } from "../../shared/clock.js";
import { FailureLearning } from "./failureLearning.js";

/**
 * Minimal logger surface — structurally compatible with pino. Mirrors the
 * pattern used by FailureIntelligenceEngine so callers can pass the same
 * logger without picking up a hard dependency on pino types.
 */
export interface ReplayOutcomeLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Optional metadata the caller can override when the terminal lifecycle hook
 * has already computed (or can cheaply derive) totals that we'd otherwise have
 * to recompute. Keeps recording deterministic without duplicating logic.
 */
export interface ReplayOutcomeOverrides {
  /** Total tokens across the cognition; if omitted we derive from tokenStream chunks. */
  totalTokens?: number;
  /** Execution wall-clock duration in ms; if omitted we derive from graph timestamps. */
  durationMs?: number;
  /** Repair override applied at the branch point. Only meaningful for BRANCH kind. */
  branchOverride?: ReplayOutcome["branchOverride"];
  /** ISO timestamp of the recording. Defaults to the clock's `now()`. */
  recordedAt?: string;
}

/**
 * Build a deterministic ReplayOutcome from a terminal CognitionGraph and the
 * corresponding FailureReport. Pure function — same inputs always produce the
 * same outcome (modulo `recordedAt`, which is normalized via the supplied
 * clock so tests with a frozen clock stay stable).
 *
 * Source-vs-branch classification follows the existing convention: a graph
 * with `parentCognitionId` set is treated as a BRANCH, everything else is a
 * SOURCE. No new lineage assumptions are introduced.
 */
export function buildReplayOutcome(
  graph: CognitionGraph,
  report: FailureReport,
  nowIso: string,
  overrides: ReplayOutcomeOverrides = {}
): ReplayOutcome {
  const isBranch = typeof graph.parentCognitionId === "string" && graph.parentCognitionId.length > 0;
  const observedSignalKinds = normalizeObservedKinds(report.byKind);
  const totalTokens = overrides.totalTokens ?? deriveTotalTokensFromGraph(graph);
  const durationMs = overrides.durationMs ?? deriveDurationMsFromGraph(graph);

  const outcome: ReplayOutcome = {
    cognitionId: graph.id,
    executionId: graph.executionId,
    kind: isBranch ? "BRANCH" : "SOURCE",
    sourceCognitionId: isBranch ? graph.parentCognitionId : undefined,
    branchOverride: isBranch ? overrides.branchOverride : undefined,
    succeeded: graph.phase === "COMPLETE",
    healthScore: clampHealthScore(report.healthScore),
    failureSignalCount: Math.max(0, Math.floor(report.totalSignals ?? 0)),
    observedSignalKinds,
    totalTokens,
    durationMs,
    recordedAt: overrides.recordedAt ?? nowIso
  };

  return outcome;
}

/**
 * ReplayOutcomeRecorder — failure-safe wiring between the cognition lifecycle
 * and the FailureLearning module.
 *
 * Responsibilities:
 *   1. Build a ReplayOutcome from (graph, report) deterministically.
 *   2. Persist via failureLearning.recordOutcome(...).
 *   3. Emit a REPLAY_OUTCOME_RECORDED event so downstream consumers can react.
 *   4. When the outcome is a BRANCH with a known source already recorded,
 *      emit REPAIR_OUTCOME_EVALUATED with the branch's delta (reuses the
 *      existing Phase 7 event surface — no new infrastructure).
 *
 * Failure isolation: every learning-side write is wrapped in its own try/catch.
 * A storage or event-publish error MUST NEVER break execution completion.
 */
export class ReplayOutcomeRecorder {
  constructor(
    private readonly failureLearning: FailureLearning,
    private readonly publisher: PersistedEventPublisher,
    private readonly eventFactory: EventFactory,
    private readonly clock: Clock,
    private readonly logger?: ReplayOutcomeLogger
  ) {}

  /**
   * Record a terminal outcome. Safe to call from any completion or failure
   * terminalization path — all internal failures are caught and logged.
   */
  async recordTerminalOutcome(
    graph: CognitionGraph,
    report: FailureReport,
    overrides: ReplayOutcomeOverrides = {}
  ): Promise<ReplayOutcome | undefined> {
    let outcome: ReplayOutcome | undefined;
    try {
      outcome = buildReplayOutcome(graph, report, toIso(this.clock.now()), overrides);
    } catch (err) {
      this.logger?.warn(
        { err, executionId: graph.executionId, stage: "build-outcome" },
        "replay-outcome build failed"
      );
      return undefined;
    }

    try {
      await this.failureLearning.recordOutcome(outcome);
    } catch (err) {
      this.logger?.warn(
        { err, executionId: outcome.executionId, stage: "record-outcome" },
        "replay-outcome persistence failed"
      );
      return undefined;
    }

    await this.safeEmitOutcomeRecorded(outcome);

    if (outcome.kind === "BRANCH" && outcome.sourceCognitionId) {
      await this.safeEmitRepairOutcomeEvaluated(outcome);
    }

    return outcome;
  }

  private async safeEmitOutcomeRecorded(outcome: ReplayOutcome): Promise<void> {
    try {
      await this.publisher.publish(
        this.eventFactory.create({
          type: "REPLAY_OUTCOME_RECORDED",
          aggregateId: outcome.executionId,
          aggregateType: "EXECUTION",
          payload: {
            cognitionId: outcome.cognitionId,
            executionId: outcome.executionId,
            kind: outcome.kind,
            sourceCognitionId: outcome.sourceCognitionId,
            succeeded: outcome.succeeded,
            healthScore: outcome.healthScore,
            failureSignalCount: outcome.failureSignalCount,
            observedSignalKinds: outcome.observedSignalKinds,
            totalTokens: outcome.totalTokens,
            durationMs: outcome.durationMs,
            recordedAt: outcome.recordedAt
          }
        })
      );
    } catch (err) {
      this.logger?.warn(
        { err, executionId: outcome.executionId, stage: "emit-outcome-recorded" },
        "replay-outcome event emission failed"
      );
    }
  }

  private async safeEmitRepairOutcomeEvaluated(branchOutcome: ReplayOutcome): Promise<void> {
    if (!branchOutcome.sourceCognitionId) return;
    try {
      const comparison = await this.failureLearning.compareOutcomes(branchOutcome.sourceCognitionId);
      if (!comparison) return;
      const delta = comparison.branches.find(
        (b) => b.branchOutcome.cognitionId === branchOutcome.cognitionId
      );
      if (!delta) return;
      await this.publisher.publish(
        this.eventFactory.create({
          type: "REPAIR_OUTCOME_EVALUATED",
          aggregateId: branchOutcome.executionId,
          aggregateType: "EXECUTION",
          payload: {
            sourceCognitionId: branchOutcome.sourceCognitionId,
            branchCognitionId: branchOutcome.cognitionId,
            healthScoreDelta: delta.healthScoreDelta,
            netSignalDelta: delta.netSignalDelta,
            resolvedKinds: delta.resolvedSignalKinds as string[]
          }
        })
      );
    } catch (err) {
      this.logger?.warn(
        { err, executionId: branchOutcome.executionId, stage: "emit-repair-evaluated" },
        "repair-outcome evaluation emission failed"
      );
    }
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function normalizeObservedKinds(
  byKind: FailureReport["byKind"]
): FailureSignalKind[] {
  const kinds: FailureSignalKind[] = [];
  for (const key of Object.keys(byKind) as FailureSignalKind[]) {
    const count = byKind[key];
    if (typeof count === "number" && count > 0) kinds.push(key);
  }
  kinds.sort();
  return kinds;
}

function clampHealthScore(score: number | undefined): number {
  if (typeof score !== "number" || Number.isNaN(score)) return 0;
  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}

function deriveTotalTokensFromGraph(graph: CognitionGraph): number | undefined {
  let total = 0;
  let seenAny = false;
  for (const node of graph.nodes) {
    const stream = node.tokenStream;
    if (!stream || stream.length === 0) continue;
    seenAny = true;
    total += stream.length;
  }
  return seenAny ? total : undefined;
}

function deriveDurationMsFromGraph(graph: CognitionGraph): number | undefined {
  if (!graph.completedAt || !graph.startedAt) return undefined;
  const start = Date.parse(graph.startedAt);
  const end = Date.parse(graph.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}
