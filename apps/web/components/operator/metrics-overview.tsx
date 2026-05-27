"use client";

/**
 * PHASE 4 — Metrics Overview
 *
 * Displays the real-time operational health snapshot from /operator/snapshot.
 * Every number shown is an operational signal, not a vanity metric:
 *
 *   Running executions  → are agents working?
 *   Queue depth         → is the scheduler saturated?
 *   DLQ volume          → are poison pills accumulating?
 *   Worker lost count   → cluster topology problem?
 *   Oldest lease age    → stalled execution, worker not renewing?
 *   Token totals        → cost burn rate since server start
 *
 * Auto-refreshes every 5 seconds. Shows staleness indicator if the last
 * fetch is >10s old so operators know when the feed is degraded.
 */

import { useEffect, useState, useCallback } from "react";
import { operatorApi, type MetricsSnapshot } from "../../services/operator-api";
import { Activity, AlertTriangle, CheckCircle, Clock, Cpu, Layers, Zap } from "lucide-react";

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface KpiCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ReactNode;
  alert?: boolean;
  warn?: boolean;
}

function KpiCard({ label, value, sub, icon, alert, warn }: KpiCardProps) {
  const border = alert
    ? "border-red-500/60 bg-red-950/20"
    : warn
    ? "border-yellow-500/60 bg-yellow-950/20"
    : "border-zinc-700/50 bg-zinc-900";

  return (
    <div className={`rounded-lg border p-4 flex flex-col gap-2 ${border}`}>
      <div className="flex items-center gap-2 text-zinc-400 text-xs font-medium uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-bold text-white tabular-nums">{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

export function MetricsOverview() {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await operatorApi.snapshot();
      setSnapshot(data);
      setLastFetch(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch snapshot");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  const isStale = lastFetch !== null && Date.now() - lastFetch > 10_000;

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-950/20 p-4 text-red-400 text-sm">
        <AlertTriangle className="inline mr-2 h-4 w-4" />
        {error}
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="text-zinc-500 text-sm animate-pulse p-4">Loading metrics snapshot…</div>
    );
  }

  const { executions, workers, leases, scheduler, dlq, tokens } = snapshot;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">System Health</h2>
        <div className={`text-xs ${isStale ? "text-red-400" : "text-zinc-500"}`}>
          {isStale ? "⚠ stale" : "● live"} · {new Date(snapshot.ts).toLocaleTimeString()}
        </div>
      </div>

      {/* Execution KPIs */}
      <div>
        <div className="text-xs text-zinc-500 uppercase tracking-wide font-medium mb-2">Executions</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard
            label="Running"
            value={executions.running}
            icon={<Activity className="h-3 w-3" />}
            warn={executions.running > 20}
          />
          <KpiCard
            label="Queue Depth"
            value={scheduler.queueDepth}
            sub="pending lease"
            icon={<Layers className="h-3 w-3" />}
            warn={scheduler.queueDepth > 10}
            alert={scheduler.queueDepth > 50}
          />
          <KpiCard
            label="Completed"
            value={formatNumber(executions.completed)}
            icon={<CheckCircle className="h-3 w-3" />}
          />
          <KpiCard
            label="Failed"
            value={executions.failed}
            icon={<AlertTriangle className="h-3 w-3" />}
            warn={executions.failed > 0}
            alert={executions.failed > 10}
          />
        </div>
      </div>

      {/* Worker KPIs */}
      <div>
        <div className="text-xs text-zinc-500 uppercase tracking-wide font-medium mb-2">Workers</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard
            label="Ready"
            value={workers.ready}
            icon={<CheckCircle className="h-3 w-3" />}
          />
          <KpiCard
            label="Busy"
            value={workers.busy}
            sub={`${workers.total} total`}
            icon={<Cpu className="h-3 w-3" />}
            warn={workers.busy === workers.total && workers.total > 0}
          />
          <KpiCard
            label="Lost"
            value={workers.lost}
            icon={<AlertTriangle className="h-3 w-3" />}
            warn={workers.lost > 0}
            alert={workers.lost > 2}
          />
          <KpiCard
            label="Heartbeat Age"
            value={formatMs(workers.meanHeartbeatAgeMs)}
            sub="mean across workers"
            icon={<Clock className="h-3 w-3" />}
            warn={workers.meanHeartbeatAgeMs > 8_000}
            alert={workers.meanHeartbeatAgeMs > 15_000}
          />
        </div>
      </div>

      {/* Lease + DLQ */}
      <div>
        <div className="text-xs text-zinc-500 uppercase tracking-wide font-medium mb-2">Reliability</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard
            label="Active Leases"
            value={leases.active}
            icon={<Zap className="h-3 w-3" />}
          />
          <KpiCard
            label="Oldest Lease"
            value={formatMs(leases.oldestAgeMs)}
            sub="should renew < TTL"
            icon={<Clock className="h-3 w-3" />}
            warn={leases.oldestAgeMs > 25_000}
            alert={leases.oldestAgeMs > 30_000}
          />
          <KpiCard
            label="DLQ Volume"
            value={dlq.volume}
            sub="poison pills"
            icon={<AlertTriangle className="h-3 w-3" />}
            warn={dlq.volume > 0}
            alert={dlq.volume > 5}
          />
          <KpiCard
            label="Tokens Used"
            value={formatNumber(tokens.total)}
            sub={`${formatNumber(tokens.prompt)}p / ${formatNumber(tokens.completion)}c`}
            icon={<Activity className="h-3 w-3" />}
          />
        </div>
      </div>
    </div>
  );
}
