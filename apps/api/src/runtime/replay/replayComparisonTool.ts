import type { DomainEvent } from "../../domain/events.js";
import type { ExecutionStep } from "../../domain/model.js";
import { extractCompletedSteps } from "./replayEquivalentSemantics.js";
import type { ReplayDivergenceClassification } from "../../domain/replay.js";
import { CentralizedReplayEnforcer } from "./replayEnforcer.js";

export interface ReplayComparisonReport {
  executionId: string;
  equivalenceStatus: ReplayDivergenceClassification;
  divergencePoint: {
    stepIndex: number | null;
    reason: string | null;
    narrative: string | null;
  };
  steps: Array<{
    stepIndex: number;
    type: string;
    original: {
      id: string;
      status: string;
      startedAt: string;
      completedAt: string;
      durationMs: number;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    } | null;
    replay: {
      id: string;
      status: string;
      startedAt: string;
      completedAt: string;
      durationMs: number;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    } | null;
    comparison: "MATCH" | "TIMING_DRIFT" | "MISMATCH" | "ORIGINAL_ONLY" | "REPLAY_ONLY";
  }>;
}

export class ReplayComparisonTool {
  static compare(
    executionId: string,
    originalEvents: DomainEvent[],
    replayEvents: DomainEvent[]
  ): ReplayComparisonReport {
    const originalSteps = extractCompletedSteps(originalEvents);
    const replaySteps = extractCompletedSteps(replayEvents);

    const maxLength = Math.max(originalSteps.length, replaySteps.length);
    const steps: ReplayComparisonReport["steps"] = [];

    let firstDivergenceIndex: number | null = null;
    let divergenceReason: string | null = null;
    let divergenceNarrative: string | null = null;
    let status: ReplayDivergenceClassification = "EQUIVALENT";

    // Detect if there were any explicit divergence detected events
    const divergenceEvent = replayEvents.find((e) => e.type === "REPLAY_DIVERGENCE_DETECTED");
    const lifecycleTransition = replayEvents.find(
      (e) => e.type === "REPLAY_LIFECYCLE_TRANSITIONED" && e.payload?.to === "REPLAY_UNSAFE"
    );

    if (divergenceEvent) {
      status = "DIVERGED";
      divergenceReason = String(divergenceEvent.payload?.reason ?? "FRAME_DIGEST");
      divergenceNarrative = String(divergenceEvent.payload?.narrative ?? "");
      firstDivergenceIndex = Number(divergenceEvent.payload?.divergenceStepIndex ?? null);
    }
    if (lifecycleTransition) {
      status = "UNSAFE_DIVERGENCE";
    }

    // Check for missing data or partial persistence
    if (originalSteps.length === 0 && replaySteps.length > 0) {
      status = "NON_RECONSTRUCTABLE";
      divergenceReason = "MISSING_STEP";
      divergenceNarrative = "Original event log contains no completed steps.";
    }

    for (let i = 0; i < maxLength; i++) {
      const orig = originalSteps[i] ?? null;
      const rep = replaySteps[i] ?? null;

      let comparison: ReplayComparisonReport["steps"][number]["comparison"] = "MATCH";

      if (orig && !rep) {
        comparison = "ORIGINAL_ONLY";
        if (firstDivergenceIndex === null) {
          firstDivergenceIndex = i;
          divergenceReason = "MISSING_STEP";
          divergenceNarrative = `Replay missing step at index ${i}`;
          status = "DIVERGED";
        }
      } else if (!orig && rep) {
        comparison = "REPLAY_ONLY";
        if (firstDivergenceIndex === null) {
          firstDivergenceIndex = i;
          divergenceReason = "BRANCH_DRIFT";
          divergenceNarrative = `Replay branched with extra step at index ${i}`;
          status = "DIVERGED";
        }
      } else if (orig && rep) {
        const check = CentralizedReplayEnforcer.runValidationCheckpoint({
          executionId,
          replayStepCount: i,
          lifecycle: "REPLAYING",
          expectedStep: orig,
          parentExternalityEvent: { type: "EXTERNALITY_RECORDED", payload: { externality: { stepSequence: i + 1 } } } as any,
          actualType: rep.type,
          actualInput: rep.input ?? {}
        });

        if (check.classification !== "EQUIVALENT") {
          comparison = "MISMATCH";
          if (firstDivergenceIndex === null) {
            firstDivergenceIndex = i;
            divergenceReason = check.reason;
            divergenceNarrative = check.narrative;
            status = check.classification;
          }
        } else {
          const origDur = orig.durationMs ?? 0;
          const repDur = rep.durationMs ?? 0;
          if (Math.abs(origDur - repDur) > 10000) {
            comparison = "TIMING_DRIFT";
            if (status === "EQUIVALENT") {
              status = "ACCEPTABLE_VARIANCE";
            }
          }
        }
      }

      steps.push({
        stepIndex: i,
        type: orig?.type ?? rep?.type ?? "UNKNOWN",
        original: orig
          ? {
              id: orig.id,
              status: orig.status,
              startedAt: orig.startedAt,
              completedAt: orig.completedAt ?? orig.startedAt,
              durationMs: orig.durationMs ?? 0,
              input: orig.input ?? {},
              output: (orig.output as Record<string, unknown>) ?? {}
            }
          : null,
        replay: rep
          ? {
              id: rep.id,
              status: rep.status,
              startedAt: rep.startedAt,
              completedAt: rep.completedAt ?? rep.startedAt,
              durationMs: rep.durationMs ?? 0,
              input: rep.input ?? {},
              output: (rep.output as Record<string, unknown>) ?? {}
            }
          : null,
        comparison
      });
    }

    return {
      executionId,
      equivalenceStatus: status,
      divergencePoint: {
        stepIndex: firstDivergenceIndex,
        reason: divergenceReason,
        narrative: divergenceNarrative
      },
      steps
    };
  }

  static renderConsoleReport(report: ReplayComparisonReport): string {
    let out = `======================================================================\n`;
    out += `  REPLAY COMPARISON AUDIT REPORT: ${report.executionId}\n`;
    out += `  Status: ${report.equivalenceStatus}\n`;
    if (report.divergencePoint.stepIndex !== null) {
      out += `  First Divergence: Step ${report.divergencePoint.stepIndex}\n`;
      out += `  Reason: ${report.divergencePoint.reason}\n`;
      out += `  Narrative: ${report.divergencePoint.narrative}\n`;
    }
    out += `======================================================================\n`;
    out += `Idx  Step Type            Comparison     Orig Dur   Rep Dur   Drift   \n`;
    out += `---  -------------------  -------------  ---------  ---------  -------\n`;

    for (const s of report.steps) {
      const origDurStr = s.original ? `${s.original.durationMs}ms` : "N/A";
      const repDurStr = s.replay ? `${s.replay.durationMs}ms` : "N/A";
      const drift =
        s.original && s.replay
          ? `${Math.abs(s.original.durationMs - s.replay.durationMs)}ms`
          : "N/A";
      out += `${String(s.stepIndex).padEnd(3)}  ${s.type.padEnd(19)}  ${s.comparison.padEnd(13)}  ${origDurStr.padEnd(9)}  ${repDurStr.padEnd(9)}  ${drift}\n`;
    }
    out += `======================================================================\n`;
    return out;
  }
}
