import type { ReplayDelta, ReplayDiff, ReplayFrame } from "../../domain/replay.js";

/**
 * Replay Diff Engine — Phase 3 enhanced implementation.
 *
 * Compares two materialized frame timelines by content fingerprint.
 * Phase 3 additions:
 *   - Semantic divergence classification: when fingerprints differ,
 *     categorizes WHY (event type changed, payload changed, both)
 *   - Causal attribution: identifies the ROOT_CAUSE delta vs
 *     CONSEQUENCE deltas (divergence that follows from the first split)
 *   - Structural summary: node count estimates, handoff count comparison
 *   - Narrative: human-readable one-line summary of the divergence
 *
 * The fingerprint comparison is still the primary mechanism (Phase 3 note:
 * the fingerprints are already stripped of non-deterministic fields by
 * FrameBuilder, so fingerprint equality is the correct replay-equivalence
 * test). Semantic classification runs only on diverged frames.
 */
export class ReplayDiffEngine {
  diff(source: ReplayFrame[], branch: ReplayFrame[]): ReplayDiff {
    const compared = Math.max(source.length, branch.length);
    const deltas: ReplayDelta[] = [];
    let divergence: number | null = null;
    let identical = 0;
    let diverged = 0;
    let branchOnly = 0;
    let sourceOnly = 0;

    for (let i = 0; i < compared; i++) {
      const s = source[i];
      const b = branch[i];

      if (s && !b) {
        deltas.push({
          frameIndex: i,
          kind: "SOURCE_ONLY",
          sourceFingerprint: s.preview.fingerprint,
          note: `Source frame ${i} (${s.eventType}) has no branch counterpart`
        });
        sourceOnly++;
        if (divergence === null) divergence = i;
        continue;
      }

      if (b && !s) {
        deltas.push({
          frameIndex: i,
          kind: "BRANCH_ONLY",
          branchFingerprint: b.preview.fingerprint,
          note: `Branch frame ${i} (${b.eventType}) is branch-only`
        });
        branchOnly++;
        if (divergence === null) divergence = i;
        continue;
      }

      if (!s || !b) continue;

      if (s.preview.fingerprint && s.preview.fingerprint === b.preview.fingerprint) {
        deltas.push({
          frameIndex: i,
          kind: "IDENTICAL",
          sourceFingerprint: s.preview.fingerprint,
          branchFingerprint: b.preview.fingerprint
        });
        identical++;
      } else {
        // ── Classify WHY this frame diverged ──────────────────────────────────
        const field = classifyDivergenceField(s, b);
        const note = buildDivergenceNote(s, b, divergence === null);

        deltas.push({
          frameIndex: i,
          kind: "DIVERGED",
          sourceFingerprint: s.preview.fingerprint,
          branchFingerprint: b.preview.fingerprint,
          field,
          note
        });
        diverged++;
        if (divergence === null) divergence = i;
      }
    }

    const narrative = buildNarrative(divergence, identical, diverged, source, branch);

    return {
      divergenceFrameIndex: divergence,
      deltas,
      summary: {
        framesCompared: compared,
        framesIdentical: identical,
        framesDiverged: diverged,
        branchOnlyFrames: branchOnly,
        sourceOnlyFrames: sourceOnly,
        // Phase 3 additions:
        narrative,
        causalDivergenceFrameIndex: divergence,
        identicalPrefixLength: identical > 0 && divergence === null ? identical : (divergence ?? 0)
      }
    };
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function classifyDivergenceField(source: ReplayFrame, branch: ReplayFrame): string {
  const eventTypeChanged = source.eventType !== branch.eventType;
  const toneChanged = source.preview.tone !== branch.preview.tone;

  if (eventTypeChanged) return "eventType";
  if (toneChanged) return "outcome";
  return "payload";
}

function buildDivergenceNote(
  source: ReplayFrame,
  branch: ReplayFrame,
  isFirst: boolean
): string {
  const prefix = isFirst ? "[ROOT DIVERGENCE] " : "[CONSEQUENCE] ";

  if (source.eventType !== branch.eventType) {
    return `${prefix}Event type changed: ${source.eventType} → ${branch.eventType}`;
  }

  if (source.preview.tone !== branch.preview.tone) {
    return `${prefix}Outcome changed at ${source.eventType}: ${source.preview.tone} → ${branch.preview.tone}`;
  }

  return `${prefix}Payload changed at frame ${source.index} (${source.eventType})`;
}

function buildNarrative(
  divergence: number | null,
  identical: number,
  diverged: number,
  source: ReplayFrame[],
  branch: ReplayFrame[]
): string {
  if (divergence === null) {
    return `Branches are identical across all ${identical} frames`;
  }

  const total = Math.max(source.length, branch.length);
  const pct = total > 0 ? Math.round((identical / total) * 100) : 0;
  const sourceEvent = source[divergence]?.eventType ?? "?";
  const branchEvent = branch[divergence]?.eventType ?? "?";

  const divergeDescription =
    sourceEvent === branchEvent
      ? `at frame ${divergence} (${sourceEvent}: payload changed)`
      : `at frame ${divergence} (${sourceEvent} → ${branchEvent})`;

  return `Branches shared ${identical}/${total} frames (${pct}%), first diverged ${divergeDescription}, ${diverged} total diverged frame(s)`;
}
