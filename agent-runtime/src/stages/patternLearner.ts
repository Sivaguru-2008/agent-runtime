/**
 * STAGE 7 — Pattern learner.
 *
 * Records EVERY run (win or loss) and rebuilds the cross-run model: which fault
 * types occur, how often the fence prevented them, what they cost, and how
 * accurate pre-flight was at predicting them. This aggregate is the thing that
 * gets smarter with every run.
 */
import type { FaultPattern, FaultType, PatternIntelligence, RunContext } from "../types.js";
import type { RuntimeDB } from "../db/database.js";

const SIGNAL_TO_FAULT: Record<string, FaultType> = {
  HALLUCINATION_FORMING: "HALLUCINATION",
  SILENT_FAILURE: "SILENT_FAILURE",
  LOOP_STARTING: "LOOP_WASTE",
  INTENT_DRIFT: "INTENT_DRIFT",
  CONTEXT_COLLAPSE: "CONTEXT_COLLAPSE",
  OVERCONFIDENCE: "OVERCONFIDENT",
};

/** Rough cost of each fault type when it reaches production, in USD. */
const DAMAGE_BY_TYPE: Partial<Record<FaultType, number>> = {
  SILENT_FAILURE: 0.34,
  HALLUCINATION: 0.12,
  LOOP_WASTE: 2.1,
  INTENT_DRIFT: 0.15,
  OVERCONFIDENT: 0.2,
  CONTEXT_COLLAPSE: 0.18,
  FENCE_SUPPRESSED: 0.4,
  WRONG_ANSWER: 0.25,
  TOOL_FAILURE: 0.1,
  INCOMPLETE_ANSWER: 0.08,
};

export class PatternLearner {
  constructor(private readonly db: RuntimeDB) {}

  /** Store this run's outcomes, then refresh the aggregates. */
  recordRun(ctx: RunContext): void {
    const actual = this.observedFaults(ctx);
    const predicted = new Set(ctx.preFlight.predictedFailures.map((f) => f.type));
    const fencePrevented = ctx.fenceEvents.some((e) => e.decision === "SUPPRESSED");
    const abortPrevented = ctx.interventions.some((i) => i.type === "ABORT" || i.type === "FENCE");

    for (const fault of actual) {
      const prevented = fencePrevented || abortPrevented;
      const interventionFired = ctx.interventions.some((i) => i.reason.toUpperCase().includes(fault) || i.step >= 0) && ctx.interventions.length > 0;
      this.db.recordFault({
        runId: ctx.runId,
        faultType: fault,
        preventedByFence: fault === "FENCE_SUPPRESSED" ? true : prevented,
        costOfDamage: fault === "FENCE_SUPPRESSED" ? ctx.damagePreventedUSD || 0.4 : DAMAGE_BY_TYPE[fault] ?? 0.1,
        costOfIntervention: interventionFired ? 0.002 : 0,
        preFlightPredicted: predicted.has(fault),
      });
    }

    // Pre-flight accuracy for this run: of the types we predicted, how many
    // actually happened?
    const hits = [...predicted].filter((t) => actual.has(t)).length;
    const accuracy = predicted.size > 0 ? hits / predicted.size : actual.size === 0 ? 1 : 0;
    this.db.recordPreflightScore(ctx.runId, predicted.size, hits, accuracy);

    this.refreshAggregates();
  }

  private observedFaults(ctx: RunContext): Set<FaultType> {
    const faults = new Set<FaultType>();
    for (const s of ctx.streamSignals) {
      const f = SIGNAL_TO_FAULT[s.type];
      if (f) faults.add(f);
    }
    if (ctx.stepValidations.some((v) => v.silentFailureDetected)) faults.add("SILENT_FAILURE");
    if (ctx.stepValidations.some((v) => v.duplicateCallDetected)) faults.add("LOOP_WASTE");
    if (ctx.fenceEvents.some((e) => e.decision === "SUPPRESSED")) faults.add("FENCE_SUPPRESSED");
    if (ctx.causalChain) faults.add(ctx.causalChain.failureType);
    if (ctx.finalEvaluation.hallucinations.length) faults.add("HALLUCINATION");
    if (ctx.finalEvaluation.overallVerdict === "FAILURE") faults.add("WRONG_ANSWER");
    if (ctx.finalEvaluation.missingElements.length && ctx.finalEvaluation.overallVerdict !== "SUCCESS") {
      faults.add("INCOMPLETE_ANSWER");
    }
    return faults;
  }

  private refreshAggregates(): void {
    for (const row of this.db.aggregateFaults()) {
      this.db.upsertPatternAggregate({
        faultType: row.fault_type as FaultType,
        occurrences: row.occurrences,
        fenceHelpRate: row.fence_help_rate ?? 0,
        avgDamageUSD: row.avg_damage_usd ?? 0,
        avgInterventionUSD: row.avg_intervention_usd ?? 0,
        predictionAccuracy: row.prediction_accuracy ?? 0,
      });
    }
  }

  /** The cross-run intelligence shown at the bottom of the panel. */
  getIntelligence(window = 5): PatternIntelligence {
    const patterns: FaultPattern[] = this.db.aggregateFaults().map((row) => {
      const t = this.db.faultTrend(row.fault_type, window);
      return {
        faultType: row.fault_type as FaultType,
        occurrences: row.occurrences,
        fenceHelpRate: row.fence_help_rate ?? 0,
        avgDamageUSD: row.avg_damage_usd ?? 0,
        avgInterventionUSD: row.avg_intervention_usd ?? 0,
        predictionAccuracy: row.prediction_accuracy ?? 0,
        trend: t.recent > t.prior ? "UP" : t.recent < t.prior ? "DOWN" : "FLAT",
      };
    });
    const acc = this.db.preflightAccuracy();
    const fence = this.db.fenceCounts();
    return {
      patterns,
      preFlightAccuracy: acc.overall,
      preFlightAccuracyTrend: acc.recent > acc.prior ? "UP" : acc.recent < acc.prior ? "DOWN" : "FLAT",
      fenceSaveRate: fence.saveRate,
      fenceCommitted: fence.committed,
      fenceSuppressed: fence.suppressed,
      totalRuns: this.db.countRuns(),
    };
  }
}
