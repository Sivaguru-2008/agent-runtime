"use client";

/**
 * PHASE 6 — Operator Platform (Replay Experience + Operator Debugging)
 *
 * Master operator UI composition. Eight tabs, each answering a specific
 * operational question during an incident or routine health check.
 *
 *   Tab 1: Replay        → PRIMARY: full replay experience — timeline, scrubber,
 *                          node explorer, root cause, console, determinism
 *   Tab 2: Overview      → system health KPIs, real-time snapshot
 *   Tab 3: Workers       → per-worker health, utilisation, heartbeat
 *   Tab 4: Leases        → lease ownership map with TTL bars
 *   Tab 5: DLQ           → dead-letter queue browser with replay links
 *   Tab 6: Diagnosis     → full execution drilldown (events + warnings + trace)
 *   Tab 7: Failure       → failure intelligence + scrubber (DLQ-focused)
 *   Tab 8: Trace         → distributed event trace explorer
 *
 * Phase 6 additions:
 *   - Replay tab is now the primary operator product. It exposes:
 *     a) Causality-annotated execution timeline with health curve
 *     b) Step-by-step replay scrubber with snapshot + branch controls
 *     c) Cognition node explorer with lineage traversal
 *     d) Root cause panel: heatmap + causal chain + per-kind inspection
 *     e) Operator console: pause / branch / inject / compare
 *     f) Determinism panel: fingerprint verification + trust score
 *
 * Design principle: every screen improves debugging, replay visibility,
 * or operational diagnosis. No decorative charts.
 */

import { useState } from "react";
import { MetricsOverview } from "./metrics-overview";
import { WorkerHealthDashboard } from "./worker-health-dashboard";
import { LeaseOwnershipPanel } from "./lease-ownership-panel";
import { ExecutionDrilldownWithInput, ExecutionDrilldown } from "./execution-drilldown";
import { FailureDiagnosticsPanel, FailureDiagnosticsWithInput } from "./failure-diagnostics-panel";
import { EventTraceExplorer } from "./event-trace-explorer";
import { ReplayExperience } from "../replay/replay-experience";
import { MemoryTrustWithInput } from "./memory-trust-panel";
import { operatorApi, type DeadLetterEntry } from "../../services/operator-api";
import { useEffect, useCallback } from "react";
import { AlertTriangle, Activity, Server, Shield, Skull, Search, GitBranch, Zap, Play, Brain } from "lucide-react";
import { FrontendDiagnostics } from "../dashboard/frontend-diagnostics";

type Tab = "replay" | "overview" | "workers" | "leases" | "dlq" | "diagnosis" | "failure" | "trace" | "memory-trust";

const TABS: { id: Tab; label: string; icon: React.ReactNode; phase6?: boolean }[] = [
  { id: "replay", label: "Replay", icon: <Play className="h-4 w-4" />, phase6: true },
  { id: "memory-trust", label: "Memory", icon: <Brain className="h-4 w-4" />, phase6: true },
  { id: "overview", label: "Overview", icon: <Activity className="h-4 w-4" /> },
  { id: "workers", label: "Workers", icon: <Server className="h-4 w-4" /> },
  { id: "leases", label: "Leases", icon: <Shield className="h-4 w-4" /> },
  { id: "dlq", label: "DLQ", icon: <Skull className="h-4 w-4" /> },
  { id: "diagnosis", label: "Diagnose", icon: <Search className="h-4 w-4" /> },
  { id: "failure", label: "Failure", icon: <AlertTriangle className="h-4 w-4" /> },
  { id: "trace", label: "Trace", icon: <GitBranch className="h-4 w-4" /> }
];

// ── DLQ Browser ──────────────────────────────────────────────────────────

function DLQBrowser({
  onAnalyse
}: {
  onAnalyse: (executionId: string) => void;
}) {
  const [entries, setEntries] = useState<DeadLetterEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await operatorApi.dlq();
      setEntries(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch DLQ");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-950/20 p-4 text-red-400 text-sm">
        <AlertTriangle className="inline mr-2 h-4 w-4" />
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">Dead-Letter Queue</h2>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded border ${
            entries.length > 0
              ? "border-red-600 bg-red-950/30 text-red-400"
              : "border-zinc-700 bg-zinc-900 text-zinc-500"
          }`}>
            {entries.length} {entries.length === 1 ? "entry" : "entries"}
          </span>
          <button
            onClick={refresh}
            className="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1 border border-zinc-700 rounded"
          >
            Refresh
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="text-zinc-500 text-sm p-6 text-center border border-zinc-800 rounded-lg">
          Dead-letter queue is empty. No poison pills detected.
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.executionId}
              className="rounded-lg border border-red-800/40 bg-zinc-900 p-4 space-y-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-xs text-red-400 truncate">{entry.executionId}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    agent: <span className="text-zinc-400 font-mono">{entry.agentId}</span>
                  </div>
                </div>
                <button
                  onClick={() => onAnalyse(entry.executionId)}
                  className="shrink-0 text-xs px-2.5 py-1 bg-red-900/50 hover:bg-red-800/50 border border-red-700 text-red-300 rounded transition-colors"
                >
                  Analyse
                </button>
              </div>

              <div className="text-xs text-red-300/80 font-mono bg-red-950/20 rounded px-2 py-1.5 border border-red-900/40">
                {entry.lastError}
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs text-zinc-500">
                <div>{entry.failureCount} attempts</div>
                <div suppressHydrationWarning>first: {new Date(entry.firstFailedAt).toLocaleDateString()}</div>
                <div suppressHydrationWarning>moved: {new Date(entry.movedAt).toLocaleString()}</div>
              </div>

              {entry.taskSnapshot && (
                <details className="text-xs">
                  <summary className="text-zinc-600 cursor-pointer hover:text-zinc-400">
                    Task snapshot
                  </summary>
                  <pre className="mt-1 text-zinc-600 font-mono whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
                    {JSON.stringify(entry.taskSnapshot, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Platform ─────────────────────────────────────────────────────────

export function OperatorPlatform() {
  const [activeTab, setActiveTab] = useState<Tab>("replay");
  const [diagnosisId, setDiagnosisId] = useState<string | null>(null);
  const [failureId, setFailureId] = useState<string | null>(null);

  const navigateToDiagnosis = (executionId: string) => {
    setDiagnosisId(executionId);
    setActiveTab("diagnosis");
  };

  const navigateToFailure = (executionId: string) => {
    setFailureId(executionId);
    setActiveTab("failure");
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Top bar */}
      <div className="border-b border-zinc-800 px-6 py-3 flex items-center gap-3">
        <Zap className="h-5 w-5 text-blue-400" />
        <span className="font-semibold text-white">Operator Platform</span>
        <span className="text-xs border rounded px-2 py-0.5 ml-1 bg-blue-950/40 border-blue-700/60 text-blue-300">
          Phase 6
        </span>
        <div className="ml-auto flex items-center gap-3">
          <FrontendDiagnostics />
          <a
            href="/"
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            ← Dashboard
          </a>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-zinc-800 px-6">
        <nav className="flex gap-0 overflow-x-auto">
          {TABS.map(({ id, label, icon, phase6 }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === id
                  ? phase6 ? "border-blue-400 text-blue-200" : "border-blue-500 text-white"
                  : "border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
              }`}
            >
              {icon}
              {label}
              {phase6 && activeTab !== id && (
                <span className="ml-1 text-[10px] bg-blue-900/50 text-blue-400 border border-blue-800/60 rounded px-1">NEW</span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className={`px-6 py-6 ${activeTab === "replay" ? "max-w-[1600px]" : "max-w-6xl"}`}>
        {activeTab === "replay" && (
          <ReplayExperience />
        )}

        {activeTab === "overview" && (
          <MetricsOverview />
        )}

        {activeTab === "workers" && (
          <WorkerHealthDashboard />
        )}

        {activeTab === "leases" && (
          <LeaseOwnershipPanel onDrilldown={navigateToDiagnosis} />
        )}

        {activeTab === "dlq" && (
          <DLQBrowser onAnalyse={navigateToFailure} />
        )}

        {activeTab === "diagnosis" && (
          diagnosisId
            ? (
              <div className="space-y-3">
                <button
                  onClick={() => setDiagnosisId(null)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
                >
                  ← enter a different execution ID
                </button>
                <ExecutionDrilldown executionId={diagnosisId} />
              </div>
            )
            : <ExecutionDrilldownWithInput />
        )}

        {activeTab === "failure" && (
          failureId
            ? (
              <div className="space-y-3">
                <button
                  onClick={() => setFailureId(null)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
                >
                  ← enter a different execution ID
                </button>
                <FailureDiagnosticsPanel executionId={failureId} />
              </div>
            )
            : <FailureDiagnosticsWithInput />
        )}

        {activeTab === "trace" && (
          <EventTraceExplorer />
        )}

        {activeTab === "memory-trust" && (
          <MemoryTrustWithInput />
        )}
      </div>
    </div>
  );
}
