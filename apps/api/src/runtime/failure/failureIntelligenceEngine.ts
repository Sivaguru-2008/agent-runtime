import type { DomainEvent } from "../../domain/events.js";
import type { CognitionGraph } from "../../domain/cognition.js";
import type { AnalyzerContext, FailureReport, FailureSeverity, FailureSignal, FailureSignalKind } from "../../domain/failure.js";
import type { CognitionRepository, FailureSignalStore } from "../../domain/cognitionPorts.js";
import type { EventStore } from "../../domain/ports.js";
import type { EventFactory } from "../../infrastructure/events/eventFactory.js";
import type { PersistedEventPublisher } from "../../infrastructure/events/persistedEventPublisher.js";
import type { Clock } from "../../shared/clock.js";
import { toIso } from "../../shared/clock.js";
import { createId } from "../../shared/id.js";
import type { FailureAnalyzer } from "./analyzer.js";
import { HallucinationScorer } from "./analyzers/hallucinationScorer.js";
import { ContradictionDetector } from "./analyzers/contradictionDetector.js";
import { RecursionDetector } from "./analyzers/recursionDetector.js";
import { ExecutionLoopDetector } from "./analyzers/executionLoopDetector.js";
import { ToolFailureClassifier } from "./analyzers/toolFailureClassifier.js";
import { CorruptedMemoryDetector } from "./analyzers/corruptedMemoryDetector.js";
import { ConfidenceScorer } from "./analyzers/confidenceScorer.js";
import {
  ExecutionHealthModel,
  buildBaselineFromMetrics,
  type HistoricalExecutionProjection
} from "./executionHealthModel.js";
import { FailureLearning } from "./failureLearning.js";
import type { ExecutionHealthSnapshot, HealthSnapshotStore } from "../../domain/executionHealth.js";
import { syncFingerprint } from "../../shared/determinism.js";

const SEVERITY_WEIGHT: Record<FailureSeverity, number> = {
  INFO: 0,
  LOW: 5,
  MEDIUM: 12,
  HIGH: 25,
  CRITICAL: 45
};

/**
 * Maps failure signal kinds to the specific domain event type that fires
 * when that kind is detected.
 *
 * Every signal also publishes a generic FAILURE_SIGNAL_RAISED so consumers
 * that don't care about the specific kind still get one event.
 */
const EVENT_TYPE_BY_KIND: Record<FailureSignalKind, string> = {
  HALLUCINATION: "HALLUCINATION_DETECTED",
  CONTRADICTION: "CONTRADICTION_DETECTED",
  RECURSION: "RECURSION_DETECTED",
  EXECUTION_LOOP: "EXECUTION_LOOP_DETECTED",
  TOOL_MISUSE: "TOOL_MISUSE_DETECTED",
  CORRUPTED_MEMORY: "CORRUPTED_MEMORY_DETECTED",
  UNCERTAINTY_SPIKE: "UNCERTAINTY_SPIKE",
  LOW_CONFIDENCE: "LOW_CONFIDENCE_DETECTED",
  PLAN_DRIFT: "FAILURE_SIGNAL_RAISED"
};

/**
 * Failure Intelligence Engine — Phase 3 production implementation.
 *
 * Orchestrates all failure analyzers over the event log + cognition graph,
 * persists the resulting signals, emits kind-specific domain events, and
 * produces an aggregate FailureReport with a health score 0..100.
 *
 * Analyzers are pure functions: they take (events, graph) and return signals.
 * This engine handles all side effects: persistence, event publication.
 *
 * Analyzer pipeline (order matters: earlier analyzers inform later ones
 * indirectly via the signal list, though analyzers themselves are independent):
 *   1. HallucinationScorer   — executor output grounding + confidence
 *   2. ContradictionDetector — verdict flips + verifier rejection chains
 *   3. RecursionDetector     — DFS cycle detection + input fingerprint loops
 *   4. ExecutionLoopDetector — execution-level spin + retry error identity
 *   5. ToolFailureClassifier — categorized tool call failures
 *   6. CorruptedMemoryDetector — memory implicated in multiple failures
 *   7. ConfidenceScorer      — confidence decay trend + spikes
 */
/**
 * Minimal logger surface — structurally compatible with pino. Kept as a local
 * interface so the engine does not pick up a hard dependency on pino types.
 */
export interface Phase7Logger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface Phase7Collaborators {
  /** Optional health snapshot store. When present, analyzeExecution computes + persists a health snapshot. */
  healthStore?: HealthSnapshotStore;
  /** Optional failure-learning module. When present, signals are clustered and outcomes can be compared. */
  learning?: FailureLearning;
  /** Health model instance — share across calls for cache locality. Defaults to a fresh model per call. */
  healthModel?: ExecutionHealthModel;
  /** Per-agent baseline cache (computed once per agent per analyzer run). */
  baselineHistoryLimit?: number;
  /**
   * Optional logger. When present, the three learning-layer catch blocks
   * (health compute, anomaly index, signal-pattern persistence) emit a
   * structured warn instead of silently swallowing the error. Absent =
   * preserves prior silent-catch behavior for callers that don't inject one.
   */
  logger?: Phase7Logger;
}

export class FailureIntelligenceEngine {
  private readonly analyzers: FailureAnalyzer[];
  private readonly healthModel: ExecutionHealthModel;

  constructor(
    private readonly events: EventStore,
    private readonly cognitions: CognitionRepository,
    private readonly store: FailureSignalStore,
    private readonly publisher: PersistedEventPublisher,
    private readonly eventFactory: EventFactory,
    private readonly clock: Clock,
    private readonly phase7: Phase7Collaborators = {}
  ) {
    this.analyzers = [
      new HallucinationScorer(),
      new ContradictionDetector(),
      new RecursionDetector(),
      new ExecutionLoopDetector(),
      new ToolFailureClassifier(),
      new CorruptedMemoryDetector(),
      new ConfidenceScorer()
    ];
    this.healthModel = phase7.healthModel ?? new ExecutionHealthModel();
  }

  async analyzeExecution(executionId: string): Promise<FailureReport> {
    const events = await this.events.listByExecution(executionId);
    const graph = await this.cognitions.getByExecution(executionId);
    const detectedAt = toIso(this.clock.now());
    const ctx: AnalyzerContext = { executionId, cognitionId: graph?.id, detectedAt };

    const allSignals: FailureSignal[] = [];
    for (const analyzer of this.analyzers) {
      try {
        const signals = analyzer.analyze(events, graph, ctx);
        for (const signal of signals) {
          await this.store.record(signal);
          await this.publish(signal, graph);
          allSignals.push(signal);
          // Phase 7: route through failure-learning clustering. We deliberately
          // observe AFTER persisting + publishing so a learning-layer failure
          // never blocks the signal pipeline.
          if (this.phase7.learning) {
            await this.safeObserveSignal(this.phase7.learning, signal, graph?.executionId);
          }
        }
      } catch {
        // Analyzer failures must not break the pipeline. In production, emit
        // an OBSERVABILITY_WARNING event here for operator visibility.
      }
    }

    // Phase 7: compute and persist an execution health snapshot. Built on the
    // same (events, graph, signals) tuple the analyzers just consumed so it
    // reflects the post-analysis state. Best-effort: a health failure does
    // not invalidate the FailureReport.
    if (this.phase7.healthStore) {
      try {
        await this.computeAndStoreHealth(executionId, graph?.id, graph?.agentId, events, graph, allSignals);
      } catch (err) {
        // intentional: never block the report on a health computation failure
        this.phase7.logger?.warn(
          { err, executionId, stage: "health-compute" },
          "phase7 health computation failed"
        );
      }
    }

    return this.buildReport(executionId, graph?.id, allSignals);
  }

  /**
   * Compute the execution health snapshot, persist it, and emit a
   * EXECUTION_HEALTH_COMPUTED event. Also indexes the execution as anomalous
   * via FailureLearning when applicable.
   */
  private async computeAndStoreHealth(
    executionId: string,
    cognitionId: string | undefined,
    agentId: string | undefined,
    events: DomainEvent[],
    graph: CognitionGraph | undefined,
    signals: FailureSignal[]
  ): Promise<ExecutionHealthSnapshot | undefined> {
    const healthStore = this.phase7.healthStore;
    if (!healthStore) return undefined;

    let historical: HistoricalExecutionProjection[] = [];
    let baseline: ReturnType<typeof buildBaselineFromMetrics> | undefined;
    if (agentId) {
      const historyLimit = this.phase7.baselineHistoryLimit ?? 50;

      // Stability projections: scan recent cognitions, filter by agent.
      // CognitionRepository doesn't yet expose listByAgent; listRecent + filter
      // is fine for the in-memory store and the realistic Postgres workload
      // (recent cognitions fits in a single page).
      const recentGraphs = (await this.cognitions.listRecent(historyLimit * 2))
        .filter((g) => g.agentId === agentId && g.executionId !== executionId)
        .slice(0, historyLimit);
      historical = recentGraphs.map((g) => projectGraphForStability(g));

      // Anomaly baseline: pull the per-execution dimensional metrics from the
      // health store. Need ≥5 samples before we'll declare anomalies.
      const metrics = await healthStore.listMetricsForAgent(agentId, historyLimit);
      const filteredMetrics = metrics.filter((m) => m.executionId !== executionId);
      baseline = filteredMetrics.length >= 5
        ? buildBaselineFromMetrics(agentId, filteredMetrics)
        : undefined;
    }

    const snapshot = this.healthModel.compute({
      executionId,
      graph,
      events,
      signals,
      baseline,
      historicalForAgent: historical,
      now: this.clock.now().getTime()
    });

    await healthStore.put(snapshot);
    await this.publishHealthComputed(snapshot);

    // Hand the snapshot off to FailureLearning so it can index anomalies.
    if (this.phase7.learning) {
      try {
        const entry = await this.phase7.learning.indexAnomaly(snapshot);
        if (entry) await this.publishAnomalyIndexed(entry);
      } catch (err) {
        // never block on learning-layer errors
        this.phase7.logger?.warn(
          { err, executionId, stage: "anomaly-index" },
          "phase7 anomaly indexing failed"
        );
      }
    }

    return snapshot;
  }

  private async safeObserveSignal(learning: FailureLearning, signal: FailureSignal, executionAggregateId: string | undefined): Promise<void> {
    try {
      const { signature, isNew } = await learning.observeSignal(signal);
      await this.publisher.publish(
        this.eventFactory.create({
          type: "FAILURE_PATTERN_OBSERVED",
          aggregateId: executionAggregateId ?? signal.executionId,
          aggregateType: "EXECUTION",
          payload: {
            signatureId: signature.id,
            signalId: signal.id,
            signalKind: signal.kind,
            occurrenceCount: signature.occurrenceCount,
            isNew
          }
        })
      );
    } catch (err) {
      // intentional: do not let learning-layer storage errors break analysis
      this.phase7.logger?.warn(
        { err, signalId: signal.id, signalKind: signal.kind, stage: "pattern-observe" },
        "phase7 signal-pattern persistence failed"
      );
    }
  }

  private async publishHealthComputed(snapshot: ExecutionHealthSnapshot): Promise<void> {
    await this.publisher.publish(
      this.eventFactory.create({
        type: "EXECUTION_HEALTH_COMPUTED",
        aggregateId: snapshot.executionId,
        aggregateType: "EXECUTION",
        payload: {
          executionId: snapshot.executionId,
          cognitionId: snapshot.cognitionId,
          healthScore: snapshot.healthScore,
          grade: snapshot.grade,
          components: {
            confidence: snapshot.confidence.value,
            stability: snapshot.stability.value,
            toolReliability: snapshot.toolReliability.value,
            consistency: snapshot.consistency.value,
            anomaly: snapshot.anomaly.value
          }
        }
      })
    );
  }

  private async publishAnomalyIndexed(entry: { executionId: string; agentId?: string; anomalyScore: number; topDimension: string; topRobustZScore: number }): Promise<void> {
    await this.publisher.publish(
      this.eventFactory.create({
        type: "EXECUTION_ANOMALY_INDEXED",
        aggregateId: entry.executionId,
        aggregateType: "EXECUTION",
        payload: {
          executionId: entry.executionId,
          agentId: entry.agentId,
          anomalyScore: entry.anomalyScore,
          topDimension: entry.topDimension,
          topRobustZScore: entry.topRobustZScore
        }
      })
    );
  }

  buildReport(executionId: string, cognitionId: string | undefined, signals: FailureSignal[]): FailureReport {
    const bySeverity: Record<FailureSeverity, number> = { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    const byKind: Record<FailureSignalKind, number> = {
      HALLUCINATION: 0,
      CONTRADICTION: 0,
      RECURSION: 0,
      EXECUTION_LOOP: 0,
      TOOL_MISUSE: 0,
      CORRUPTED_MEMORY: 0,
      UNCERTAINTY_SPIKE: 0,
      LOW_CONFIDENCE: 0,
      PLAN_DRIFT: 0
    };
    let penalty = 0;
    for (const signal of signals) {
      bySeverity[signal.severity] += 1;
      byKind[signal.kind] += 1;
      penalty += SEVERITY_WEIGHT[signal.severity] * signal.score;
    }
    const healthScore = Math.max(0, Math.round(100 - penalty));
    return {
      executionId,
      cognitionId,
      totalSignals: signals.length,
      bySeverity,
      byKind,
      topSignals: [...signals].sort((a, b) => b.score - a.score).slice(0, 8),
      healthScore
    };
  }

  private async publish(signal: FailureSignal, graph: CognitionGraph | undefined): Promise<void> {
    const eventType = EVENT_TYPE_BY_KIND[signal.kind] ?? "FAILURE_SIGNAL_RAISED";
    const aggregateId = graph?.executionId ?? signal.executionId;
    const traceId = createId();

    // Kind-specific event (for consumers that subscribe to a specific failure type).
    await this.publisher.publish(
      this.eventFactory.create({
        type: eventType as Parameters<typeof this.eventFactory.create>[0]["type"],
        aggregateId,
        aggregateType: "EXECUTION",
        payload: { signal },
        context: { traceId }
      })
    );

    // Generic failure event (for consumers that aggregate all failures).
    if (eventType !== "FAILURE_SIGNAL_RAISED") {
      await this.publisher.publish(
        this.eventFactory.create({
          type: "FAILURE_SIGNAL_RAISED",
          aggregateId,
          aggregateType: "EXECUTION",
          payload: { signal },
          context: { traceId }
        })
      );
    }
  }
}

/**
 * Project a prior cognition graph into the minimal shape ExecutionHealthModel
 * needs for stability scoring. Centralizes fingerprint derivation so the
 * health model and the engine wiring agree on what "the same input" means.
 */
function projectGraphForStability(graph: CognitionGraph): HistoricalExecutionProjection {
  const sortedAsc = [...graph.nodes].sort((a, b) => a.sequence - b.sequence);
  const firstNode = sortedAsc[0];
  const lastNode = sortedAsc[sortedAsc.length - 1];
  const outputFp = graph.output
    ? syncFingerprint(graph.output)
    : lastNode?.output ? syncFingerprint(lastNode.output) : undefined;
  const toolCallCount = graph.nodes.filter(
    (n) => n.role === "EXECUTOR" && n.output && JSON.stringify(n.output).toLowerCase().includes("tool")
  ).length;
  return {
    executionId: graph.executionId,
    inputFingerprint: firstNode?.inputFingerprint ?? syncFingerprint(graph.id),
    outputFingerprint: outputFp,
    nodeCount: graph.nodes.length,
    toolCallCount
  };
}
