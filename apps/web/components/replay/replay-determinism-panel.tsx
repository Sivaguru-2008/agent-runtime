"use client";

/**
 * PHASE 6 — Replay Determinism Panel
 *
 * Operator debugging value:
 *   Deterministic replay is the platform's core correctness guarantee.
 *   If a replayed execution produces the same fingerprint at every frame,
 *   the operator can trust that replay exactly reproduces the original
 *   failure — not a different execution that happened to look similar.
 *   This panel verifies that guarantee and exposes anomalies when it breaks.
 *
 * Replay UX improvement:
 *   Operators see an overall determinism score (0–100%) before investing
 *   time in replay analysis. A score below 100% means some frames diverged
 *   from the original; the anomaly list shows exactly which frames and why.
 *   "Missing fingerprint" means the event was not stamped when captured;
 *   "Duplicate fingerprint" means the same state was reached twice (loop).
 *
 * Scaling implications:
 *   Fingerprint verification is O(n) over the frame list. The panel
 *   computes a Set of seen fingerprints and flags duplicates in a single pass.
 *   For large frame sets (1 000+), only the first 50 anomalies are shown.
 *
 * Failure diagnosis improvements:
 *   A duplicate fingerprint at two different frame indices is a strong
 *   indicator of an execution loop — the agent re-entered the same state.
 *   Missing fingerprints in the PLANNER or VERIFIER phase indicate those
 *   steps were not captured deterministically, making their replay unreliable.
 */

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ReplayFrame } from "@/lib/cognition-api";
import { cn } from "@/lib/utils";
import { CheckCircle, AlertTriangle, XCircle } from "lucide-react";

export interface ReplayDeterminismPanelProps {
  frames: ReplayFrame[];
  /** Called when operator clicks an anomalous frame */
  onSeekToFrame?: (frameIndex: number) => void;
}

type AnomalyKind = "MISSING_FINGERPRINT" | "DUPLICATE_FINGERPRINT";

interface FingerprintAnomaly {
  frameIndex: number;
  eventType: string;
  kind: AnomalyKind;
  fingerprint?: string;
  duplicateOf?: number;
}

interface DeterminismReport {
  totalFrames: number;
  verifiedFrames: number;
  missingFingerprintCount: number;
  duplicateFingerprintCount: number;
  determinismScore: number;
  anomalies: FingerprintAnomaly[];
}

function computeDeterminismReport(frames: ReplayFrame[]): DeterminismReport {
  const seen = new Map<string, number>(); // fingerprint → first frameIndex
  const anomalies: FingerprintAnomaly[] = [];
  let missing = 0;
  let duplicates = 0;

  for (const frame of frames) {
    const fp = frame.preview.fingerprint;
    if (!fp) {
      missing++;
      anomalies.push({
        frameIndex: frame.index,
        eventType: frame.eventType,
        kind: "MISSING_FINGERPRINT",
      });
    } else if (seen.has(fp)) {
      duplicates++;
      anomalies.push({
        frameIndex: frame.index,
        eventType: frame.eventType,
        kind: "DUPLICATE_FINGERPRINT",
        fingerprint: fp,
        duplicateOf: seen.get(fp),
      });
    } else {
      seen.set(fp, frame.index);
    }
  }

  const verifiedFrames = frames.length - missing - duplicates;
  const score = frames.length === 0 ? 100 : Math.round((verifiedFrames / frames.length) * 100);

  return {
    totalFrames: frames.length,
    verifiedFrames,
    missingFingerprintCount: missing,
    duplicateFingerprintCount: duplicates,
    determinismScore: score,
    anomalies: anomalies.slice(0, 50),
  };
}

export function ReplayDeterminismPanel({ frames, onSeekToFrame }: ReplayDeterminismPanelProps) {
  const report = useMemo(() => computeDeterminismReport(frames), [frames]);

  if (frames.length === 0) {
    return (
      <div className="text-zinc-500 text-sm p-4 text-center border border-zinc-800 rounded">
        No replay frames to verify. Create a replay session first.
      </div>
    );
  }

  const scoreColor =
    report.determinismScore === 100
      ? "text-emerald-400"
      : report.determinismScore >= 90
      ? "text-amber-400"
      : "text-rose-400";

  const ScoreIcon =
    report.determinismScore === 100
      ? CheckCircle
      : report.determinismScore >= 90
      ? AlertTriangle
      : XCircle;

  const scoreIconColor =
    report.determinismScore === 100
      ? "text-emerald-400"
      : report.determinismScore >= 90
      ? "text-amber-400"
      : "text-rose-400";

  return (
    <div className="space-y-3">
      {/* Score header */}
      <Card className="p-4 bg-zinc-950/70 border-zinc-800">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <ScoreIcon className={cn("h-8 w-8", scoreIconColor)} />
            <div>
              <div className={cn("text-3xl font-bold font-mono", scoreColor)}>
                {report.determinismScore}%
              </div>
              <div className="text-xs text-zinc-500">deterministic replay score</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-zinc-300">
              {report.verifiedFrames} / {report.totalFrames} frames verified
            </div>
            {report.determinismScore === 100 ? (
              <div className="text-xs text-emerald-400 mt-0.5">
                Replay is fully deterministic — results can be trusted.
              </div>
            ) : (
              <div className="text-xs text-amber-400 mt-0.5">
                {report.anomalies.length} anomalies detected — replay may diverge.
              </div>
            )}
          </div>
        </div>

        {/* Score bar */}
        <div className="mt-3 h-2 bg-zinc-800 rounded overflow-hidden">
          <div
            className={cn(
              "h-full rounded transition-all",
              report.determinismScore === 100
                ? "bg-emerald-500"
                : report.determinismScore >= 90
                ? "bg-amber-500"
                : "bg-rose-500"
            )}
            style={{ width: `${report.determinismScore}%` }}
          />
        </div>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <StatCell label="total frames" value={report.totalFrames} />
        <StatCell label="verified" value={report.verifiedFrames} tone="success" />
        <StatCell label="missing fp" value={report.missingFingerprintCount} tone={report.missingFingerprintCount > 0 ? "warning" : "success"} />
        <StatCell label="duplicates" value={report.duplicateFingerprintCount} tone={report.duplicateFingerprintCount > 0 ? "error" : "success"} />
      </div>

      {/* Frame fingerprint grid */}
      <Card className="p-3 bg-zinc-950/70 border-zinc-800 space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">Frame fingerprint map</div>
        <div className="flex flex-wrap gap-[2px]">
          {frames.slice(0, 200).map((frame) => {
            const hasFingerprint = Boolean(frame.preview.fingerprint);
            const isDuplicate = report.anomalies.some(
              (a) => a.frameIndex === frame.index && a.kind === "DUPLICATE_FINGERPRINT"
            );
            return (
              <button
                key={frame.index}
                title={`f${frame.index}: ${frame.eventType} · ${hasFingerprint ? `fp: ${frame.preview.fingerprint?.slice(0, 8)}…` : "NO FINGERPRINT"}${isDuplicate ? " · DUPLICATE" : ""}`}
                onClick={() => onSeekToFrame?.(frame.index)}
                className={cn(
                  "w-2 h-3 rounded-sm transition-transform hover:scale-125",
                  isDuplicate
                    ? "bg-rose-500/80"
                    : hasFingerprint
                    ? "bg-emerald-600/60"
                    : "bg-amber-500/60"
                )}
              />
            );
          })}
          {frames.length > 200 && (
            <span className="text-[10px] text-zinc-600 self-center ml-1">
              +{frames.length - 200} more
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-zinc-600 flex-wrap">
          <div className="flex items-center gap-1"><div className="w-2 h-3 rounded-sm bg-emerald-600/60" /> verified</div>
          <div className="flex items-center gap-1"><div className="w-2 h-3 rounded-sm bg-amber-500/60" /> missing</div>
          <div className="flex items-center gap-1"><div className="w-2 h-3 rounded-sm bg-rose-500/80" /> duplicate (loop)</div>
        </div>
      </Card>

      {/* Anomaly list */}
      {report.anomalies.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500 uppercase tracking-wide font-medium">
            Anomalies ({report.anomalies.length}{report.anomalies.length === 50 ? ", showing first 50" : ""})
          </div>
          {report.anomalies.map((anomaly) => (
            <AnomalyRow key={`${anomaly.frameIndex}-${anomaly.kind}`} anomaly={anomaly} onSeekToFrame={onSeekToFrame} />
          ))}
        </div>
      )}

      {/* Guidance */}
      {report.determinismScore < 100 && (
        <Card className="p-3 bg-zinc-950/70 border-zinc-800 space-y-1.5">
          <div className="text-xs font-medium text-zinc-400">Interpretation guidance</div>
          {report.missingFingerprintCount > 0 && (
            <div className="text-xs text-zinc-500">
              <span className="text-amber-400">Missing fingerprints:</span> These frames were not
              stamped with a deterministic ID when first captured. Replay of these frames cannot
              be verified — the execution engine may have used a non-deterministic code path.
              Check event factory configuration for these event types.
            </div>
          )}
          {report.duplicateFingerprintCount > 0 && (
            <div className="text-xs text-zinc-500">
              <span className="text-rose-400">Duplicate fingerprints:</span> The same execution
              state was reached at two different frame indices. This is a strong indicator of an
              execution loop where the agent re-entered an identical input state without making
              progress. Check the loop detector signals in the root cause panel.
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AnomalyRow({
  anomaly,
  onSeekToFrame,
}: {
  anomaly: FingerprintAnomaly;
  onSeekToFrame?: (i: number) => void;
}) {
  const isMissing = anomaly.kind === "MISSING_FINGERPRINT";
  return (
    <div
      className={cn(
        "flex items-start gap-3 border rounded px-3 py-2 text-xs",
        isMissing
          ? "border-amber-800/40 bg-amber-950/20"
          : "border-rose-800/40 bg-rose-950/20"
      )}
    >
      {isMissing ? (
        <AlertTriangle className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />
      ) : (
        <XCircle className="h-3.5 w-3.5 text-rose-400 mt-0.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => onSeekToFrame?.(anomaly.frameIndex)}
            className={cn(
              "font-mono font-medium hover:underline",
              isMissing ? "text-amber-300" : "text-rose-300"
            )}
          >
            f{anomaly.frameIndex}
          </button>
          <span className="text-zinc-400">{anomaly.eventType}</span>
          <Badge
            variant="muted"
            className={cn(
              "text-[10px]",
              isMissing ? "border-amber-700 text-amber-400" : "border-rose-700 text-rose-400"
            )}
          >
            {anomaly.kind.replace("_", " ")}
          </Badge>
        </div>
        {anomaly.kind === "DUPLICATE_FINGERPRINT" && (
          <div className="text-zinc-500 mt-0.5">
            Duplicate of frame {anomaly.duplicateOf} · fp: <span className="font-mono">{anomaly.fingerprint?.slice(0, 16)}…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCell({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "warning" | "error";
}) {
  return (
    <div
      className={cn(
        "px-2 py-1.5 rounded border bg-zinc-900/60",
        tone === "success" && "border-emerald-800",
        tone === "warning" && "border-amber-800",
        tone === "error" && "border-rose-800",
        tone === "neutral" && "border-zinc-800"
      )}
    >
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-zinc-200 font-mono">{value}</div>
    </div>
  );
}
