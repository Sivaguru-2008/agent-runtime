"use client";

/**
 * PHASE 4 — Worker Health Dashboard
 *
 * Shows per-worker health: status, load (cpu/memory/in-flight), heartbeat
 * recency, active leases, and utilisation bar.
 *
 * Operational purpose:
 *   Answers: "Which worker is struggling and why?"
 *   - Red heartbeat age → worker is stalling (GC pause, crash loop, network split)
 *   - Utilisation 100% + queue depth rising → need more workers
 *   - LOST status → recovery loop should be reclaiming its leases
 *   - DRAINING → scheduled maintenance, executions migrating out
 */

import { useEffect, useState, useCallback } from "react";
import { operatorApi, type WorkerHealthEntry } from "../../services/operator-api";
import { AlertTriangle, CheckCircle, Clock, Cpu, HardDrive, Zap } from "lucide-react";

function UtilBar({ pct }: { pct: number }) {
  const colour =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-yellow-500" : "bg-emerald-500";
  return (
    <div className="w-full h-1.5 rounded-full bg-zinc-700 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${colour}`}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
  );
}

function StatusChip({ status }: { status: WorkerHealthEntry["worker"]["status"] }) {
  const map: Record<string, string> = {
    READY: "bg-emerald-900/60 text-emerald-300 border-emerald-700",
    BUSY: "bg-blue-900/60 text-blue-300 border-blue-700",
    DRAINING: "bg-yellow-900/60 text-yellow-300 border-yellow-700",
    LOST: "bg-red-900/60 text-red-300 border-red-700",
    REGISTERED: "bg-zinc-800 text-zinc-400 border-zinc-600",
    STOPPED: "bg-zinc-900 text-zinc-600 border-zinc-700"
  };
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded border ${map[status] ?? map["REGISTERED"]}`}>
      {status}
    </span>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function WorkerHealthDashboard() {
  const [entries, setEntries] = useState<WorkerHealthEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await operatorApi.workers();
      setEntries(data);
      setLastFetch(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch workers");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 5_000);
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

  if (!entries.length && lastFetch !== null) {
    return (
      <div className="text-zinc-500 text-sm p-4">No workers registered.</div>
    );
  }

  if (!entries.length) {
    return <div className="text-zinc-500 text-sm animate-pulse p-4">Loading workers…</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">Worker Health</h2>
        <span className="text-xs text-zinc-500">{entries.length} worker{entries.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="space-y-3">
        {entries.map(({ worker, heartbeatAgeMs, activeLeases, executionIds, utilizationPct }) => {
          const heartbeatWarn = heartbeatAgeMs > 8_000;
          const heartbeatAlert = heartbeatAgeMs > 15_000;

          return (
            <div
              key={worker.id}
              className="rounded-lg border border-zinc-700/50 bg-zinc-900 p-4 space-y-3"
            >
              {/* Header row */}
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <div className="font-mono text-xs text-zinc-400">{worker.id}</div>
                  <div className="text-sm font-medium text-white mt-0.5">
                    {worker.host}
                    {worker.region && (
                      <span className="ml-2 text-xs text-zinc-500">({worker.region})</span>
                    )}
                  </div>
                </div>
                <StatusChip status={worker.status} />
              </div>

              {/* Utilisation bar */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-zinc-500">
                  <span>Utilisation</span>
                  <span className="text-white font-medium">{utilizationPct}%</span>
                </div>
                <UtilBar pct={utilizationPct} />
                <div className="text-xs text-zinc-600">
                  {worker.load.inFlight} / {worker.capacity} capacity slots in use
                </div>
              </div>

              {/* Load row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <Cpu className="h-3 w-3 shrink-0" />
                  <span>CPU</span>
                  <span className="ml-auto text-white font-medium tabular-nums">
                    {worker.load.cpu.toFixed(1)}%
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <HardDrive className="h-3 w-3 shrink-0" />
                  <span>Heap</span>
                  <span className="ml-auto text-white font-medium tabular-nums">
                    {worker.load.memory.toFixed(1)}%
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <Zap className="h-3 w-3 shrink-0" />
                  <span>In-flight</span>
                  <span className="ml-auto text-white font-medium tabular-nums">
                    {worker.load.inFlight}
                  </span>
                </div>
                <div className={`flex items-center gap-1.5 ${heartbeatAlert ? "text-red-400" : heartbeatWarn ? "text-yellow-400" : "text-zinc-400"}`}>
                  <Clock className="h-3 w-3 shrink-0" />
                  <span>Heartbeat</span>
                  <span className="ml-auto font-medium tabular-nums">
                    {formatMs(heartbeatAgeMs)} ago
                  </span>
                </div>
              </div>

              {/* Active leases */}
              {activeLeases.length > 0 && (
                <div>
                  <div className="text-xs text-zinc-500 mb-1.5">
                    Active leases ({activeLeases.length})
                  </div>
                  <div className="space-y-1">
                    {activeLeases.map((lease) => (
                      <div
                        key={lease.executionId}
                        className="flex items-center gap-2 text-xs bg-zinc-800/50 rounded px-2 py-1"
                      >
                        <CheckCircle className="h-3 w-3 text-emerald-500 shrink-0" />
                        <span className="font-mono text-zinc-400 truncate">{lease.executionId}</span>
                        <span className="ml-auto text-zinc-600 shrink-0">
                          attempt #{lease.attempt}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {worker.version && (
                <div className="text-xs text-zinc-600 border-t border-zinc-800 pt-2">
                  v{worker.version} · capacity {worker.capacity}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
