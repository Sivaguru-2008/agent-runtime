"use client";

/**
 * PHASE 4 — Execution Drilldown
 *
 * Deep diagnostic view for a single execution. Combines:
 *   1. Status bar — current phase, worker, lease status, DLQ flag
 *   2. Summary stats — total duration, step count, tool calls, retries, failures
 *   3. Full event timeline — every domain event with type, timestamp, payload preview
 *   4. Failure warnings — from the FailureIntelligenceEngine
 *   5. Replay branch links — child executions from time-travel replay
 *
 * Operational purpose:
 *   The "break-glass" view for a stuck or failed execution.
 *   An operator can see exactly which phase the execution died in, what
 *   the failure was, and whether it has been retried or moved to DLQ.
 *
 * Debugging improvements:
 *   - Timeline shows raw event payloads (expandable) so nothing is hidden.
 *   - Warnings are surfaced from the failure intelligence engine with severity
 *     colour-coding so CRITICAL issues stand out immediately.
 *   - Checkpoint phase shows exactly where the execution was when it stopped.
 */

import { useEffect, useState, useCallback } from "react";
import { operatorApi, type ExecutionDiagnosis } from "../../services/operator-api";
import {
  AlertTriangle, CheckCircle, ChevronDown, ChevronRight,
  Clock, Hash, Layers, Search, Shield, Zap
} from "lucide-react";

function formatMs(ms: number | undefined): string {
  if (ms === undefined || ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3
  });
}

const SEVERITY_STYLE: Record<string, string> = {
  CRITICAL: "border-red-600 bg-red-950/30 text-red-300",
  HIGH: "border-orange-600 bg-orange-950/30 text-orange-300",
  MEDIUM: "border-yellow-600 bg-yellow-950/30 text-yellow-300",
  LOW: "border-zinc-600 bg-zinc-900 text-zinc-400",
  INFO: "border-zinc-700 bg-zinc-900/50 text-zinc-500"
};

const EVENT_TYPE_COLOUR: Record<string, string> = {
  EXECUTION_STARTED: "text-blue-400",
  EXECUTION_COMPLETED: "text-emerald-400",
  EXECUTION_FAILED: "text-red-400",
  EXECUTION_STEP_STARTED: "text-blue-300",
  EXECUTION_STEP_COMPLETED: "text-emerald-300",
  TOOL_CALLED: "text-purple-400",
  MODEL_COMPLETED: "text-cyan-400",
  MEMORY_RETRIEVED: "text-yellow-400",
  EXECUTION_RETRIED: "text-orange-400",
  CIRCUIT_BREAKER_OPENED: "text-red-500"
};

function eventColour(type: string): string {
  return (
    Object.entries(EVENT_TYPE_COLOUR).find(([k]) => type.includes(k))?.[1] ??
    "text-zinc-400"
  );
}

function PayloadPreview({ payload }: { payload: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const json = JSON.stringify(payload, null, 2);
  const isLong = json.length > 120;
  const preview = isLong ? json.slice(0, 120) + "…" : json;

  return (
    <div className="mt-1">
      <pre className="text-xs text-zinc-600 font-mono whitespace-pre-wrap break-all leading-relaxed">
        {expanded ? json : preview}
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1 mt-1"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {expanded ? "collapse" : "expand payload"}
        </button>
      )}
    </div>
  );
}

interface Props {
  executionId: string;
}

export function ExecutionDrilldown({ executionId }: Props) {
  const [diagnosis, setDiagnosis] = useState<ExecutionDiagnosis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [traceIdFilter, setTraceIdFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await operatorApi.diagnose(executionId);
      setDiagnosis(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load diagnosis");
    } finally {
      setLoading(false);
    }
  }, [executionId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <div className="text-zinc-500 text-sm animate-pulse p-4">Loading execution diagnosis…</div>;
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

  const { execution, checkpoint, lease, dlqEntry, timeline, warnings, summary } = diagnosis;
  const filteredTimeline = traceIdFilter
    ? timeline.filter((e) => e.traceId?.includes(traceIdFilter))
    : timeline;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-white">Execution Diagnosis</h3>
          <div className="font-mono text-xs text-zinc-500 mt-0.5">{executionId}</div>
        </div>
        <div className="flex items-center gap-2">
          {execution && (
            <span
              className={`text-xs px-2 py-0.5 rounded border font-medium ${
                execution.status === "FAILED"
                  ? "border-red-600 bg-red-950/30 text-red-300"
                  : execution.status === "COMPLETED"
                  ? "border-emerald-600 bg-emerald-950/30 text-emerald-300"
                  : "border-blue-600 bg-blue-950/30 text-blue-300"
              }`}
            >
              {execution.status}
            </span>
          )}
          {dlqEntry && (
            <span className="text-xs px-2 py-0.5 rounded border border-red-700 bg-red-950/40 text-red-400 font-medium">
              DLQ
            </span>
          )}
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {[
          { label: "Duration", value: formatMs(summary.totalDurationMs), icon: <Clock className="h-3 w-3" /> },
          { label: "Steps", value: summary.stepCount, icon: <Layers className="h-3 w-3" /> },
          { label: "Tool Calls", value: summary.toolCallCount, icon: <Zap className="h-3 w-3" /> },
          { label: "Model Calls", value: summary.modelCallCount, icon: <Hash className="h-3 w-3" /> },
          { label: "Retries", value: summary.retryCount, icon: <Shield className="h-3 w-3" />, warn: summary.retryCount > 0 },
          { label: "Events", value: diagnosis.eventCount, icon: <Hash className="h-3 w-3" /> }
        ].map(({ label, value, icon, warn }) => (
          <div key={label} className="bg-zinc-900 border border-zinc-800 rounded p-2.5 text-center">
            <div className={`flex items-center justify-center gap-1 text-xs mb-1 ${warn ? "text-yellow-400" : "text-zinc-500"}`}>
              {icon} {label}
            </div>
            <div className={`text-sm font-bold tabular-nums ${warn ? "text-yellow-300" : "text-white"}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* Checkpoint + Lease + Telemetry */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {checkpoint && (
          <div className="bg-zinc-900 border border-zinc-800 rounded p-3 space-y-1">
            <div className="text-xs text-zinc-500 uppercase tracking-wide">Last Checkpoint</div>
            <div className="text-sm font-medium text-white">{checkpoint.phase}</div>
            <div className="text-xs text-zinc-500">seq {checkpoint.sequence} · {formatTimestamp(checkpoint.createdAt)}</div>
          </div>
        )}
        {lease && (
          <div className="bg-zinc-900 border border-zinc-800 rounded p-3 space-y-1">
            <div className="text-xs text-zinc-500 uppercase tracking-wide">Active Lease Owner</div>
            <div className="text-sm font-medium text-white font-mono text-xs truncate" title={lease.workerId}>{lease.workerId}</div>
            <div className="text-xs text-zinc-500 flex items-center justify-between">
              <span>attempt #{lease.attempt} · {lease.status}</span>
              {diagnosis.heartbeatFreshnessMs !== undefined && (
                <span className="text-[10px] text-zinc-400">fresh: {formatMs(diagnosis.heartbeatFreshnessMs)}</span>
              )}
            </div>
            {diagnosis.heartbeatFreshnessMs !== undefined && (
              <div className="w-full bg-zinc-800 rounded-full h-1 mt-1.5 overflow-hidden">
                <div 
                  className={`h-1 rounded-full ${diagnosis.heartbeatFreshnessMs > 10000 ? "bg-emerald-500" : "bg-rose-500 animate-pulse"}`}
                  style={{ width: `${Math.min(100, (diagnosis.heartbeatFreshnessMs / 60000) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}
        <div className="bg-zinc-900 border border-zinc-800 rounded p-3 space-y-2">
          <div className="text-xs text-zinc-500 uppercase tracking-wide">Orchestration Health</div>
          <div className="text-xs space-y-1.5 text-zinc-300">
            <div className="flex justify-between">
              <span className="text-zinc-500">Fencing Token (Lease):</span>
              <span className="font-mono text-blue-300 font-bold">#{diagnosis.leaseToken ?? "—"}</span>
            </div>
            {diagnosis.cancellationStatus?.isCancelled && (
              <div className="flex justify-between">
                <span className="text-zinc-500">Cancellation:</span>
                <span className="text-rose-400 font-medium">ABORTED ({diagnosis.cancellationStatus.reason ?? "manual"})</span>
              </div>
            )}
            {diagnosis.cancellationStatus?.isCancelled && diagnosis.cancellationStatus.latencyMs !== undefined && (
              <div className="flex justify-between">
                <span className="text-zinc-500">Abort Latency:</span>
                <span className="font-mono text-rose-300">{formatMs(diagnosis.cancellationStatus.latencyMs)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-zinc-500">Recovery Status:</span>
              <span>
                {diagnosis.recoveryStatus?.isRecovered ? (
                  <span className="text-amber-400 font-medium">RECOVERED ({diagnosis.recoveryStatus.recoveryCount}x)</span>
                ) : (
                  <span className="text-zinc-500">stable</span>
                )}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* DLQ Entry */}
      {dlqEntry && (
        <div className="rounded-lg border border-red-600/50 bg-red-950/20 p-3 space-y-2">
          <div className="text-xs text-red-400 font-medium uppercase tracking-wide flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            Dead-Letter Queue Entry
          </div>
          <div className="text-xs text-red-300 font-mono">{dlqEntry.lastError}</div>
          <div className="text-xs text-zinc-500">
            {dlqEntry.failureCount} attempts · first failed {new Date(dlqEntry.firstFailedAt).toLocaleString()}
          </div>
        </div>
      )}

      {/* Failure Warnings */}
      {warnings.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500 uppercase tracking-wide font-medium">
            Failure Intelligence ({warnings.length})
          </div>
          {warnings.map((w, i) => (
            <div key={i} className={`rounded-lg border p-3 space-y-1 ${SEVERITY_STYLE[w.severity] ?? SEVERITY_STYLE["INFO"]}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">{w.title}</span>
                <span className="text-xs opacity-70">{w.severity}</span>
              </div>
              <div className="text-xs opacity-80">{w.description}</div>
              <div className="text-xs opacity-50">{w.kind} · {formatTimestamp(w.timestamp)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Event Timeline */}
      <div className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-xs text-zinc-500 uppercase tracking-wide font-medium">
            Event Timeline ({filteredTimeline.length})
          </div>
          <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-700 rounded px-2 py-1">
            <Search className="h-3 w-3 text-zinc-500" />
            <input
              value={traceIdFilter}
              onChange={(e) => setTraceIdFilter(e.target.value)}
              placeholder="filter by traceId…"
              className="bg-transparent text-xs text-zinc-300 placeholder-zinc-600 outline-none w-40"
            />
          </div>
        </div>

        <div className="space-y-0.5 max-h-96 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent pr-1">
          {filteredTimeline.map((event, i) => (
            <div
              key={i}
              className="flex items-start gap-2 py-1.5 border-b border-zinc-800/50 last:border-0"
            >
              {/* Sequence */}
              <span className="text-xs text-zinc-700 tabular-nums w-8 shrink-0 mt-0.5">
                {event.sequence || i + 1}
              </span>

              {/* Type */}
              <span className={`text-xs font-mono shrink-0 leading-relaxed ${eventColour(event.type)}`}>
                {event.type}
              </span>

              {/* Right side: timestamp + phase + payload */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs text-zinc-600 flex-wrap">
                  <span>{formatTimestamp(event.timestamp)}</span>
                  {event.phase && <span className="text-zinc-500">phase: {event.phase}</span>}
                  {event.toolName && <span className="text-purple-500">tool: {event.toolName}</span>}
                  {event.durationMs !== undefined && (
                    <span className="text-zinc-600">{formatMs(event.durationMs)}</span>
                  )}
                </div>
                {!!event.payload && <PayloadPreview payload={event.payload} />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Re-export a wrapper that adds an execution ID input field for standalone use
export function ExecutionDrilldownWithInput() {
  const [inputId, setInputId] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          value={inputId}
          onChange={(e) => setInputId(e.target.value)}
          placeholder="Paste execution ID…"
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-blue-500"
        />
        <button
          onClick={() => setActiveId(inputId.trim() || null)}
          disabled={!inputId.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded font-medium transition-colors"
        >
          Diagnose
        </button>
      </div>
      {activeId && <ExecutionDrilldown executionId={activeId} />}
    </div>
  );
}
