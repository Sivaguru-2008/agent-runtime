"use client";

/**
 * PHASE 4 — Failure Diagnostics Panel
 *
 * Combines replay scrubber, failure warnings, DLQ status, and a step-through
 * timeline for a failed execution. Designed for operators doing post-mortem
 * analysis on a failed or DLQ'd execution.
 *
 * Operational purpose:
 *   Answers: "At which step did this execution fail and why?"
 *   - Replay scrubber lets the operator step through checkpoints to see
 *     exactly what state the execution was in at each phase
 *   - Failure warnings from the intelligence engine are shown with evidence
 *   - DLQ entry includes the raw task snapshot for replay diagnostics
 *   - Branch links navigate to child executions from time-travel replay
 *
 * Debugging improvements:
 *   - Checkpoint-indexed scrubber is more precise than a time-based scrubber
 *     because checkpoints represent semantically meaningful phase boundaries
 *   - "Replay this execution" button initiates a new replay session
 *   - Warnings are sorted by severity so CRITICAL issues appear first
 */

import { useCallback, useEffect, useState } from "react";
import {
  operatorApi,
  type ExecutionDiagnosis,
  type ReplayScrubberData
} from "../../services/operator-api";
import { AlertTriangle, ChevronLeft, ChevronRight, GitBranch, RefreshCw, ShieldCheck } from "lucide-react";
import { ExplainedEmptyState } from "../explain/empty-state";
import { ExecutionMetadataPanel } from "../ui/execution-metadata-panel";

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4
};

const SEVERITY_COLOUR: Record<string, string> = {
  CRITICAL: "text-red-400 bg-red-950/30 border-red-700",
  HIGH: "text-orange-400 bg-orange-950/30 border-orange-700",
  MEDIUM: "text-yellow-400 bg-yellow-950/30 border-yellow-700",
  LOW: "text-zinc-400 bg-zinc-900 border-zinc-700",
  INFO: "text-zinc-500 bg-zinc-900/40 border-zinc-800"
};

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 2
  });
}

// ── Replay Scrubber ────────────────────────────────────────────────────────

interface ScrubberProps {
  data: ReplayScrubberData;
}

function ReplayScrubber({ data }: ScrubberProps) {
  const [frame, setFrame] = useState(0);
  const frames = data.frames;
  const total = frames.length;
  const current = frames[frame];

  if (!total) return <div className="text-xs text-zinc-500 p-2">No replay frames captured for this execution yet — there are no recorded steps to scrub through.</div>;

  return (
    <div className="space-y-3">
      {/* Frame navigation */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setFrame((f) => Math.max(0, f - 1))}
          disabled={frame === 0}
          className="p-1 rounded border border-zinc-700 hover:border-zinc-500 disabled:opacity-30 text-zinc-400"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        {/* Scrubber bar */}
        <div className="flex-1 relative">
          <input
            type="range"
            min={0}
            max={total - 1}
            value={frame}
            onChange={(e) => setFrame(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
          <div className="flex justify-between text-xs text-zinc-600 mt-0.5">
            <span>frame 0</span>
            <span className="text-zinc-400 font-medium">
              {frame + 1} / {total}
            </span>
            <span>frame {total - 1}</span>
          </div>
        </div>

        <button
          onClick={() => setFrame((f) => Math.min(total - 1, f + 1))}
          disabled={frame === total - 1}
          className="p-1 rounded border border-zinc-700 hover:border-zinc-500 disabled:opacity-30 text-zinc-400"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Current frame detail */}
      {current && (
        <div className="bg-zinc-900 border border-zinc-800 rounded p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <span className="text-xs font-medium text-blue-400">{current.eventType}</span>
              <span className="text-xs text-zinc-600 ml-2">phase: {current.phase}</span>
            </div>
            <span className="text-xs text-zinc-600">{formatTimestamp(current.timestamp)}</span>
          </div>
          <div className="text-xs text-zinc-600">seq {current.sequence}</div>
          {!!current.payload && (
            <pre className="text-xs text-zinc-600 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
              {JSON.stringify(current.payload, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Checkpoints reference */}
      {data.checkpoints.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs text-zinc-600 uppercase tracking-wide">Checkpoints</div>
          <div className="flex flex-wrap gap-1.5">
            {data.checkpoints.map((cp, i) => (
              <span
                key={cp.id}
                className={`text-xs px-2 py-0.5 rounded border cursor-pointer transition-colors ${
                  i === frame
                    ? "border-blue-500 bg-blue-950/30 text-blue-300"
                    : "border-zinc-700 bg-zinc-900 text-zinc-500 hover:border-zinc-500"
                }`}
                onClick={() => {
                  // Jump to the frame closest to this checkpoint's sequence
                  const closest = frames.reduce((best, f, fi) =>
                    Math.abs(f.sequence - cp.sequence) < Math.abs(frames[best]!.sequence - cp.sequence) ? fi : best, 0
                  );
                  setFrame(closest);
                }}
              >
                {cp.phase}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Branch links */}
      {data.branches.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs text-zinc-600 uppercase tracking-wide flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            Replay Branches
          </div>
          {data.branches.map((b) => (
            <div key={b.branchExecutionId} className="text-xs bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5">
              <span className="font-mono text-purple-400">{b.branchExecutionId}</span>
              <span className="text-zinc-600 ml-2">{new Date(b.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────

interface Props {
  executionId: string;
  onReplay?: (executionId: string) => void;
}

export function FailureDiagnosticsPanel({ executionId, onReplay }: Props) {
  const [diagnosis, setDiagnosis] = useState<ExecutionDiagnosis | null>(null);
  const [scrubberData, setScrubberData] = useState<ReplayScrubberData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, s] = await Promise.all([
        operatorApi.diagnose(executionId),
        operatorApi.replay(executionId)
      ]);
      setDiagnosis(d);
      setScrubberData(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load diagnosis");
    } finally {
      setLoading(false);
    }
  }, [executionId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <div className="text-zinc-500 text-sm animate-pulse p-4">Loading failure diagnostics…</div>;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-950/20 p-4 text-red-400 text-sm">
        <AlertTriangle className="inline mr-2 h-4 w-4" />
        {error}
      </div>
    );
  }

  if (!diagnosis) return null;

  const sortedWarnings = [...diagnosis.warnings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99)
  );

  const primaryTraceId = diagnosis.traceId ?? diagnosis.timeline.find((e) => e.traceId)?.traceId;
  const topWarning = sortedWarnings[0];
  const failureReason =
    diagnosis.execution?.status === "FAILED" || diagnosis.dlqEntry
      ? {
          message:
            diagnosis.dlqEntry?.lastError ?? topWarning?.description ?? topWarning?.title ?? "Execution failed",
          code: diagnosis.dlqEntry ? "DEAD_LETTERED" : topWarning?.kind,
          recoverable: !diagnosis.dlqEntry
        }
      : undefined;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Failure Diagnostics</h3>
          <div className="font-mono text-xs text-zinc-500 mt-0.5">{executionId}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="p-1.5 rounded border border-zinc-700 hover:border-zinc-500 text-zinc-400 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {onReplay && (
            <button
              onClick={() => onReplay(executionId)}
              className="px-3 py-1.5 bg-purple-700 hover:bg-purple-600 text-white text-xs rounded font-medium transition-colors flex items-center gap-1.5"
            >
              <GitBranch className="h-3.5 w-3.5" />
              Replay
            </button>
          )}
        </div>
      </div>

      {/* Execution identity + failure reason */}
      <ExecutionMetadataPanel
        executionId={executionId}
        traceId={primaryTraceId}
        runtimeId={diagnosis.runtimeId}
        status={diagnosis.execution?.status}
        failure={failureReason}
      />

      {/* DLQ alert banner */}
      {diagnosis.dlqEntry && (
        <div className="rounded-lg border border-red-700/60 bg-red-950/25 p-3 space-y-1.5">
          <div className="text-xs font-semibold text-red-400 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            Execution is in Dead-Letter Queue
          </div>
          <div className="text-xs text-red-300 font-mono">
            {diagnosis.dlqEntry.lastError}
          </div>
          <div className="text-xs text-zinc-500">
            {diagnosis.dlqEntry.failureCount} attempts · poisoned{" "}
            {new Date(diagnosis.dlqEntry.movedAt).toLocaleString()}
          </div>
        </div>
      )}

      {/* Failure Warnings — sorted by severity */}
      {sortedWarnings.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500 uppercase tracking-wide font-medium">
            Intelligence Signals ({sortedWarnings.length})
          </div>
          {sortedWarnings.map((w, i) => (
            <div
              key={i}
              className={`rounded border px-3 py-2.5 space-y-1 ${SEVERITY_COLOUR[w.severity] ?? SEVERITY_COLOUR["INFO"]}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">{w.title}</span>
                <span className="text-xs opacity-60 border border-current rounded px-1">{w.severity}</span>
              </div>
              <div className="text-xs opacity-75">{w.description}</div>
              <div className="text-xs opacity-40">{w.kind} · {formatTimestamp(w.timestamp)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Replay Scrubber */}
      {scrubberData && scrubberData.frames.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500 uppercase tracking-wide font-medium">
            Execution Timeline Scrubber
          </div>
          <div className="border border-zinc-800 rounded-lg p-3">
            <ReplayScrubber data={scrubberData} />
          </div>
        </div>
      )}

      {/* No warnings + no DLQ = healthy indication */}
      {sortedWarnings.length === 0 && !diagnosis.dlqEntry && (
        <ExplainedEmptyState
          concept="self-healing-diagnostics"
          icon={<ShieldCheck className="h-5 w-5 text-emerald-300" />}
          title="No failure signals detected"
          body="The platform's diagnostics found no anomalies, drift, or risks in this execution — it ran cleanly. This is the healthy state."
        />
      )}
    </div>
  );
}

export function FailureDiagnosticsWithInput() {
  const [inputId, setInputId] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          value={inputId}
          onChange={(e) => setInputId(e.target.value)}
          placeholder="Paste execution ID for failure analysis…"
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-blue-500"
        />
        <button
          onClick={() => setActiveId(inputId.trim() || null)}
          disabled={!inputId.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded font-medium transition-colors"
        >
          Analyse
        </button>
      </div>
      {activeId && <FailureDiagnosticsPanel executionId={activeId} />}
    </div>
  );
}
