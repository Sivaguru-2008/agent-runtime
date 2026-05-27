"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { FailureReport, FailureSignal } from "@/lib/cognition-api";
import { cn } from "@/lib/utils";

const SEVERITY_TONE: Record<FailureSignal["severity"], string> = {
  INFO: "border-zinc-700 text-zinc-300",
  LOW: "border-sky-700/60 text-sky-300",
  MEDIUM: "border-amber-700/60 text-amber-300",
  HIGH: "border-rose-700/60 text-rose-300",
  CRITICAL: "border-red-700 text-red-300 ring-1 ring-red-700/60"
};

const KIND_ICON: Record<FailureSignal["kind"], string> = {
  HALLUCINATION: "👻",
  CONTRADICTION: "⚡",
  RECURSION: "↻",
  TOOL_MISUSE: "🛠",
  CORRUPTED_MEMORY: "☣",
  UNCERTAINTY_SPIKE: "△",
  PLAN_DRIFT: "↗"
};

export interface FailureIntelligencePanelProps {
  report: FailureReport | undefined;
}

/**
 * Failure Intelligence Panel — surfaces the cognition's failure report,
 * top signals, and the runtime healthScore (0..100).
 */
export function FailureIntelligencePanel({ report }: FailureIntelligencePanelProps) {
  if (!report) {
    return (
      <Card className="p-4 bg-zinc-950/60 border-zinc-800">
        <div className="text-sm font-medium text-zinc-200">Failure Intelligence</div>
        <div className="text-xs text-zinc-500 mt-2">No analysis available.</div>
      </Card>
    );
  }

  const healthTone =
    report.healthScore >= 80 ? "text-emerald-400" :
    report.healthScore >= 60 ? "text-amber-400" :
    "text-rose-400";

  const bySeverity = useMemo(() => Object.entries(report.bySeverity), [report.bySeverity]);
  const byKind = useMemo(() => Object.entries(report.byKind).filter(([, count]) => Number(count) > 0), [report.byKind]);

  return (
    <Card className="p-4 bg-zinc-950/60 border-zinc-800 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-zinc-200">Failure Intelligence</div>
          <div className="text-xs text-zinc-500">{report.totalSignals} signal{report.totalSignals === 1 ? "" : "s"}</div>
        </div>
        <div className="text-right">
          <div className={cn("text-3xl font-bold", healthTone)}>{report.healthScore}</div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">health</div>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-1 text-[10px]">
        {bySeverity.map(([sev, count]) => (
          <div key={sev} className={cn("px-2 py-1 rounded border text-center", SEVERITY_TONE[sev as FailureSignal["severity"]])}>
            <div className="opacity-70">{sev}</div>
            <div className="text-zinc-100 font-mono text-sm">{String(count)}</div>
          </div>
        ))}
      </div>

      {byKind.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {byKind.map(([kind, count]) => (
            <Badge key={kind} variant="muted" className="text-[10px]">
              {KIND_ICON[kind as FailureSignal["kind"]]} {kind} · {String(count)}
            </Badge>
          ))}
        </div>
      )}

      {report.topSignals.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">Top signals</div>
          {report.topSignals.map((s) => (
            <div key={s.id} className={cn("rounded border bg-zinc-900/50 px-2 py-1 text-xs", SEVERITY_TONE[s.severity])}>
              <div className="flex items-center justify-between">
                <span className="font-medium">{KIND_ICON[s.kind]} {s.kind}</span>
                <span className="opacity-60">score {s.score.toFixed(2)}</span>
              </div>
              <div className="text-zinc-300/90 mt-0.5">{s.summary}</div>
              {s.evidence[0]?.snippet && (
                <div className="text-[10px] text-zinc-500 mt-0.5 font-mono truncate">
                  {s.evidence[0].snippet}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
