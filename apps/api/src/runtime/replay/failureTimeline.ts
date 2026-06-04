import type { FailureSignal, FailureTimeline, AnnotatedFrame } from "../../domain/failure.js";
import type { ReplayFrame } from "../../domain/replay.js";
import type { CognitionGraph } from "../../domain/cognition.js";

/**
 * Failure Timeline Builder — Phase 3 replay product module.
 *
 * Maps failure signals onto replay frames to produce a fully annotated
 * timeline. Operators get a single data structure that combines:
 *   - The replay scrubber data (every frame with its event type and tone)
 *   - The failure intelligence layer (which signals fired and when)
 *   - Causal role annotations (ROOT_CAUSE / PROPAGATION / TERMINAL / CLEAN)
 *   - A health degradation curve sampled at 10-frame windows
 *
 * This is the visualization data for the "failure timeline inspection" product
 * requirement: operators scrub the timeline, see where signals concentrate,
 * and can branch replay at any annotated frame.
 *
 * ALGORITHM:
 *   1. Build frame index → signal list by matching signal evidence to frames
 *   2. Classify each frame's causal role based on signal severity distribution
 *   3. Compute health curve as rolling window of health penalty
 *   4. Find first failure frame and hotspot frame
 */
export class FailureTimelineBuilder {
  build(
    frames: ReplayFrame[],
    signals: FailureSignal[],
    graph?: CognitionGraph
  ): FailureTimeline {
    // Inputs originate from store reads and frame materialization; either can be
    // null/undefined/non-array for a malformed or partially-persisted execution.
    // Normalize once so no downstream `.length`/iteration can throw.
    frames = Array.isArray(frames) ? frames.filter((f) => !!f) : [];
    signals = Array.isArray(signals) ? signals.filter((s) => !!s) : [];
    if (frames.length === 0) {
      return emptyTimeline(signals, graph);
    }

    // ── Index signals by frame ────────────────────────────────────────────────
    // Map each signal to the frame(s) it relates to via:
    //   a) evidence.eventSequence → match frame.eventSequence
    //   b) evidence.nodeId → find the frame whose event node matches
    // A signal may appear on multiple frames (multi-evidence signals).
    const frameSignals = new Map<number, FailureSignal[]>();
    const eventSeqToFrameIdx = new Map<number, number>(
      frames.map((f) => [f.eventSequence, f.index])
    );

    // nodeId → frame index: derived from graph if available
    const nodeIdToFrameIdx = buildNodeIdFrameMap(frames, graph);

    for (const signal of signals) {
      const frameIndices = new Set<number>();

      // `evidence` is typed as an array but can be null/undefined on legacy or
      // malformed signal rows — guard before iterating so one bad signal can't
      // collapse the whole timeline with "evidence is not iterable".
      const evidence = Array.isArray(signal.evidence) ? signal.evidence : [];
      for (const ev of evidence) {
        if (!ev) continue;
        if (ev.eventSequence !== undefined) {
          const idx = eventSeqToFrameIdx.get(ev.eventSequence);
          if (idx !== undefined) frameIndices.add(idx);
        }
        if (ev.nodeId) {
          const idx = nodeIdToFrameIdx.get(ev.nodeId);
          if (idx !== undefined) frameIndices.add(idx);
        }
      }

      // If we couldn't map to any frame, pin it to the last frame.
      if (frameIndices.size === 0 && frames.length > 0) {
        frameIndices.add(frames[frames.length - 1].index);
      }

      for (const idx of frameIndices) {
        const list = frameSignals.get(idx) ?? [];
        list.push(signal);
        frameSignals.set(idx, list);
      }
    }

    // ── Determine first-failure and hotspot frame ─────────────────────────────
    let firstFailureFrameIndex: number | null = null;
    let hotspotFrameIndex: number | null = null;
    let maxSignalsAtFrame = 0;

    for (const [idx, sigs] of frameSignals) {
      // First failure: first frame with any non-INFO signal
      const hasNonInfo = sigs.some((s) => s.severity !== "INFO");
      if (hasNonInfo && (firstFailureFrameIndex === null || idx < firstFailureFrameIndex)) {
        firstFailureFrameIndex = idx;
      }
      // Hotspot: frame with most signals
      if (sigs.length > maxSignalsAtFrame) {
        maxSignalsAtFrame = sigs.length;
        hotspotFrameIndex = idx;
      }
    }

    // ── Causal role classification ────────────────────────────────────────────
    // ROOT_CAUSE: earliest frame with HIGH/CRITICAL signals
    // TERMINAL: last frame with HIGH/CRITICAL signals
    // PROPAGATION: intermediate frames with signals
    // CLEAN: no signals
    const highFrames = [...frameSignals.entries()]
      .filter(([, sigs]) => sigs.some((s) => s.severity === "HIGH" || s.severity === "CRITICAL"))
      .map(([idx]) => idx)
      .sort((a, b) => a - b);

    const rootCauseFrame = highFrames[0] ?? firstFailureFrameIndex;
    const terminalFrame = highFrames[highFrames.length - 1] ?? firstFailureFrameIndex;

    // ── Build annotated frames ────────────────────────────────────────────────
    const annotatedFrames: AnnotatedFrame[] = frames.map((frame) => {
      const sigs = frameSignals.get(frame.index) ?? [];
      let causalRole: AnnotatedFrame["causalRole"] = "CLEAN";
      if (sigs.length > 0) {
        if (frame.index === rootCauseFrame) {
          causalRole = "ROOT_CAUSE";
        } else if (frame.index === terminalFrame && terminalFrame !== rootCauseFrame) {
          causalRole = "TERMINAL";
        } else {
          causalRole = "PROPAGATION";
        }
      }
      // `preview` is normally always present, but a malformed/partial frame
      // (e.g. a row written by an older builder) may lack it. Fall back to a
      // neutral preview rather than throwing on `.label`/`.tone`.
      const preview = frame.preview ?? { label: frame.eventType ?? "", tone: "neutral" as const };
      return {
        frameIndex: frame.index,
        eventSequence: frame.eventSequence,
        eventType: frame.eventType,
        label: preview.label ?? frame.eventType ?? "",
        tone: sigs.length > 0 ? overrideTone(sigs, preview.tone) : preview.tone,
        signals: sigs,
        causalRole
      };
    });

    // ── Health degradation curve ──────────────────────────────────────────────
    // Compute health score in 10-frame windows. Each frame in the window
    // contributes penalty based on the worst signal in that frame.
    const BUCKET_SIZE = 10;
    const healthCurve: FailureTimeline["healthCurve"] = [];
    for (let start = 0; start < frames.length; start += BUCKET_SIZE) {
      const bucket = annotatedFrames.slice(start, start + BUCKET_SIZE);
      const bucketPenalty = bucket.reduce((acc, f) => {
        const worst = f.signals.reduce((a, s) => {
          const score = Number.isFinite(s.score) ? s.score : 0;
          return Math.max(a, severityWeight(s.severity) * score);
        }, 0);
        return acc + worst;
      }, 0);
      const bucketHealth = Math.max(0, Math.round(100 - bucketPenalty * 10));
      healthCurve.push({ bucketStart: start, healthScore: bucketHealth });
    }

    return {
      cognitionId: graph?.id ?? signals[0]?.cognitionId,
      executionId: signals[0]?.executionId ?? "",
      frames: annotatedFrames,
      totalSignals: signals.length,
      firstFailureFrameIndex,
      hotspotFrameIndex,
      healthCurve
    };
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function buildNodeIdFrameMap(frames: ReplayFrame[], graph: CognitionGraph | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!graph) return map;
  // Build sequence → nodeId from graph, then find the frame for that sequence.
  for (const node of graph.nodes) {
    // Find the COGNITION_NODE_STARTED or COGNITION_NODE_COMPLETED frame for this node
    // by matching against node.sequence (frame index is correlated with event sequence).
    // We use a heuristic: find the frame whose eventType relates to cognition nodes
    // and whose index is near the node's sequence.
    for (const frame of frames) {
      if (
        (frame.eventType === "COGNITION_NODE_COMPLETED" ||
          frame.eventType === "COGNITION_NODE_STARTED" ||
          frame.eventType === "COGNITION_NODE_FAILED") &&
        Math.abs(frame.index - node.sequence) <= 3
      ) {
        if (!map.has(node.id)) {
          map.set(node.id, frame.index);
        }
      }
    }
  }
  return map;
}

function overrideTone(
  signals: FailureSignal[],
  originalTone: AnnotatedFrame["tone"]
): AnnotatedFrame["tone"] {
  const hasCritical = signals.some((s) => s.severity === "CRITICAL");
  const hasHigh = signals.some((s) => s.severity === "HIGH");
  const hasMedium = signals.some((s) => s.severity === "MEDIUM");
  if (hasCritical || hasHigh) return "error";
  if (hasMedium) return "warning";
  return originalTone;
}

function severityWeight(severity: string): number {
  const weights: Record<string, number> = { INFO: 0, LOW: 0.5, MEDIUM: 1.2, HIGH: 2.5, CRITICAL: 4.5 };
  return weights[severity] ?? 0;
}

function emptyTimeline(signals: FailureSignal[], graph?: CognitionGraph): FailureTimeline {
  return {
    cognitionId: graph?.id ?? signals[0]?.cognitionId,
    executionId: signals[0]?.executionId ?? "",
    frames: [],
    totalSignals: signals.length,
    firstFailureFrameIndex: null,
    hotspotFrameIndex: null,
    healthCurve: []
  };
}
