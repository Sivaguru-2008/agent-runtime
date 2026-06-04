"use client";

/**
 * PHASE 4 — Lease Ownership Panel
 *
 * Shows the active lease map: for every execution currently under a lease,
 * which worker holds it, how long it has been held, and how much time
 * remains before it expires.
 *
 * Operational purpose:
 *   Answers: "Who owns what, and is anything about to expire?"
 *   - Remaining < 5s → worker is not renewing; executor may have stalled
 *   - attempt > 1 → execution has been reclaimed at least once (instability)
 *   - execution status FAILED while lease is ACTIVE → stuck state
 *
 * Distributed tracing implications:
 *   Each row links to the execution so operators can drill into the diagnosis
 *   view with one click.
 */

import { useEffect, useState, useCallback } from "react";
import { operatorApi, type LeaseMapEntry } from "../../services/operator-api";
import { AlertTriangle, Clock, Shield, User } from "lucide-react";
import { ExplainLabel } from "../explain/explain-label";
import { StatusPill } from "../explain/status-pill";
import { ExplainedEmptyState } from "../explain/empty-state";
import { WhyChip } from "../explain/why-chip";

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function LeaseAgeBar({ remainingMs, totalTtlMs = 30_000 }: { remainingMs: number; totalTtlMs?: number }) {
  const pct = Math.min(100, Math.max(0, (remainingMs / totalTtlMs) * 100));
  const colour = pct < 20 ? "bg-red-500" : pct < 50 ? "bg-yellow-500" : "bg-emerald-500";
  return (
    <div className="w-full h-1 rounded-full bg-zinc-700 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-300 ${colour}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

interface LeaseRowProps {
  entry: LeaseMapEntry;
  onDrilldown: (executionId: string) => void;
}

function LeaseRow({ entry, onDrilldown }: LeaseRowProps) {
  const { lease, worker, execution, ageMs, remainingMs, attemptCount } = entry;
  const isExpiring = remainingMs < 5_000;
  const isRetried = attemptCount > 1;

  return (
    <div
      className={`rounded-lg border p-3 space-y-2 ${
        isExpiring ? "border-red-500/50 bg-red-950/10" : "border-zinc-700/50 bg-zinc-900"
      }`}
    >
      {/* Execution ID + status */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            onClick={() => onDrilldown(lease.executionId)}
            className="font-mono text-xs text-blue-400 hover:text-blue-300 truncate block text-left"
          >
            {lease.executionId}
          </button>
          {execution && (
            <div className="text-xs text-zinc-500 mt-0.5">
              agent: <span className="text-zinc-400 font-mono">{execution.agentId}</span>
              {" · "}
              <StatusPill status={execution.status} dot={false} className="px-1.5 py-0 align-middle" />
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isRetried && (
            <WhyChip
              label={`attempt #${attemptCount}`}
              question={`Why is this on attempt #${attemptCount}?`}
              answer="This task's lease was reclaimed at least once: the worker holding it stopped renewing (it crashed, stalled, or was network-split), so the recovery loop handed the task to another worker. Repeated attempts signal instability worth investigating."
            />
          )}
          {isExpiring && (
            <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
          )}
        </div>
      </div>

      {/* TTL bar */}
      <LeaseAgeBar remainingMs={remainingMs} />

      {/* Metadata row */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="flex items-center gap-1 text-zinc-500">
          <Clock className="h-3 w-3" />
          <span>age: <span className="text-zinc-300">{formatMs(ageMs)}</span></span>
        </div>
        <div className="flex items-center gap-1 text-zinc-500">
          <Shield className="h-3 w-3" />
          <ExplainLabel concept="lease-ttl">remaining</ExplainLabel>
          <span>: <span className={isExpiring ? "text-red-400 font-medium" : "text-zinc-300"}>{formatMs(remainingMs)}</span></span>
        </div>
        <div className="flex items-center gap-1 text-zinc-500">
          <User className="h-3 w-3" />
          <span className="truncate text-zinc-400 font-mono">
            {worker?.host ?? lease.workerId}
          </span>
        </div>
      </div>
    </div>
  );
}

interface Props {
  onDrilldown?: (executionId: string) => void;
}

export function LeaseOwnershipPanel({ onDrilldown }: Props) {
  const [entries, setEntries] = useState<LeaseMapEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await operatorApi.leases();
      setEntries(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch leases");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 4_000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleDrilldown = (executionId: string) => {
    onDrilldown?.(executionId);
  };

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
        <div className="flex items-center gap-2">
          <ExplainLabel concept="leases" as="span" className="text-base font-semibold text-white">
            Lease Ownership
          </ExplainLabel>
          <WhyChip concept="lease" />
        </div>
        <span className="text-xs text-zinc-500">{entries.length} active</span>
      </div>

      {entries.length === 0 ? (
        <ExplainedEmptyState concept="leases" />
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <LeaseRow
              key={entry.lease.executionId}
              entry={entry}
              onDrilldown={handleDrilldown}
            />
          ))}
        </div>
      )}
    </div>
  );
}
