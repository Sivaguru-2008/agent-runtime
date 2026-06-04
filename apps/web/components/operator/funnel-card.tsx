"use client";

/**
 * Activation Funnel card (admin-gated).
 *
 * Answers the growth question for the product: of everyone who signed up
 * self-serve, how many ran their first agent — and how is that moving, for whom,
 * and is the pipeline trustworthy? Reads the admin-gated /admin/funnel* endpoints
 * through the /api/runtime proxy (which injects the backend key server-side).
 *
 * Layout (top → bottom):
 *   1. Pipeline + alert strip  — freshness, data-quality, firing alerts (trust)
 *   2. Stat cards              — signups / activated / rate, with period delta
 *   3. Segmentation            — funnel sliced by source/plan/invite/campaign
 *   4. Trend                   — signups vs activations over a window
 *   5. Cohorts                 — activation triangle by signup week/month
 *
 * Access: every endpoint requires `tenant:read`. If the proxy's key lacks it the
 * backend answers 403 and we surface a muted "admin access required" note. The
 * Phase-2 extras fetch resiliently — a hiccup in one never blanks the card.
 */

import { useEffect, useState, useCallback } from "react";
import {
  operatorApi,
  type FunnelData,
  type FunnelHistory,
  type FunnelGranularity,
  type CohortGranularity,
  type CohortReport,
  type SegmentedFunnel,
  type SegmentDimension,
  type PeriodComparison,
  type FunnelHealth,
  type FunnelAlertsResult,
  type RetentionReport
} from "../../services/operator-api";
import { TrendingUp, UserPlus, Rocket, Lock, AlertTriangle, CheckCircle2, Activity, Download } from "lucide-react";
import { FunnelTrendChart } from "./funnel-trend-chart";
import { FunnelCohortTable } from "./funnel-cohort-table";

// Retention shares the cohort-triangle renderer: map its `active` counts onto
// the cohort table's `activated` field (numerically identical for display).
function retentionAsCohortReport(r: RetentionReport): CohortReport {
  return {
    cohortBy: r.cohortBy,
    periods: r.periods,
    cohorts: r.cohorts.map((c) => ({
      cohort: c.cohort,
      size: c.size,
      cells: c.cells.map((cell) => ({ period: cell.period, activated: cell.active, rate: cell.rate }))
    }))
  };
}

const RANGES: { label: string; days: number; granularity: FunnelGranularity }[] = [
  { label: "7d", days: 7, granularity: "day" },
  { label: "30d", days: 30, granularity: "day" },
  { label: "90d", days: 90, granularity: "week" }
];

const SEGMENTS: { value: SegmentDimension; label: string }[] = [
  { value: "source", label: "Source" },
  { value: "plan", label: "Plan" },
  { value: "invite", label: "Invite vs open" },
  { value: "campaign", label: "Campaign" }
];

function pct(rate: number): string {
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`;
}

function freshness(ms: number | null): string {
  if (ms == null) return "no events";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function DeltaBadge({ value, unit, label }: { value: number | null; unit: "pct" | "pp"; label: string }) {
  if (value == null) return <span className="text-zinc-600">· {label}</span>;
  const up = value >= 0;
  const magnitude = Math.round(value * 100);
  const text = unit === "pp" ? `${up ? "+" : ""}${magnitude}pp` : `${up ? "+" : ""}${magnitude}%`;
  return (
    <span className={up ? "text-green-400" : "text-red-400"}>
      {up ? "▲" : "▼"} {text} <span className="text-zinc-600">{label}</span>
    </span>
  );
}

function Stat({
  label,
  value,
  sub,
  icon
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-700/50 bg-zinc-900 p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-zinc-400 text-xs font-medium uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-bold text-white tabular-nums">{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

const QUALITY_TONE: Record<string, string> = {
  ok: "text-green-400 border-green-500/30 bg-green-500/10",
  warn: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  error: "text-red-400 border-red-500/30 bg-red-500/10",
  empty: "text-zinc-500 border-zinc-700 bg-zinc-800/40"
};

function PipelineStrip({ health, alerts }: { health: FunnelHealth | null; alerts: FunnelAlertsResult | null }) {
  const firing = alerts?.alerts.filter((a) => a.status === "firing") ?? [];
  const tone = QUALITY_TONE[health?.dataQuality.status ?? "empty"];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="flex items-center gap-1.5 text-zinc-500">
          <Activity className="h-3.5 w-3.5" />
          {health ? `${health.pipeline.totalEvents} events · fresh ${freshness(health.pipeline.freshnessMs)}` : "pipeline…"}
        </span>
        {health && (
          <span className={`flex items-center gap-1 px-2 py-0.5 rounded border ${tone}`}>
            {health.dataQuality.status === "ok" || health.dataQuality.status === "empty" ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <AlertTriangle className="h-3 w-3" />
            )}
            quality {health.dataQuality.status}
          </span>
        )}
      </div>

      {firing.length > 0 && (
        <div className="space-y-1">
          {firing.map((a) => (
            <div
              key={a.ruleId}
              className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-950/30 px-3 py-2 text-xs text-red-300"
            >
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                <span className="font-semibold">{a.title}:</span> {a.reason}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SegmentBars({ segmented }: { segmented: SegmentedFunnel }) {
  if (segmented.segments.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 text-zinc-600 text-sm">
        No signups yet. Once self-serve signup is enabled, attribution shows up here.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {segmented.segments.map((s) => (
        <div key={s.key} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 flex items-center gap-3">
          <div className="font-mono text-xs text-zinc-300 w-28 shrink-0 truncate">{s.key}</div>
          <div className="flex-1 min-w-0">
            <div className="h-2 rounded bg-zinc-800 overflow-hidden">
              <div className="h-full bg-blue-500/70" style={{ width: `${Math.round(s.activationRate * 100)}%` }} />
            </div>
          </div>
          <div className="text-xs text-zinc-400 tabular-nums w-32 shrink-0 text-right">
            {s.activated}/{s.signups} · <span className="text-zinc-200">{pct(s.activationRate)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function FunnelCard() {
  const [data, setData] = useState<FunnelData | null>(null);
  const [history, setHistory] = useState<FunnelHistory | null>(null);
  const [compare, setCompare] = useState<PeriodComparison | null>(null);
  const [segmented, setSegmented] = useState<SegmentedFunnel | null>(null);
  const [health, setHealth] = useState<FunnelHealth | null>(null);
  const [alerts, setAlerts] = useState<FunnelAlertsResult | null>(null);
  const [cohorts, setCohorts] = useState<CohortReport | null>(null);
  const [retention, setRetention] = useState<RetentionReport | null>(null);

  const [rangeIdx, setRangeIdx] = useState(1); // default 30d
  const [segmentBy, setSegmentBy] = useState<SegmentDimension>("source");
  const [cohortBy, setCohortBy] = useState<CohortGranularity>("week");

  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const range = RANGES[rangeIdx];

  const refresh = useCallback(async () => {
    const to = new Date();
    const from = new Date(to.getTime() - range.days * 24 * 60 * 60 * 1000);
    try {
      // The core funnel + history drive auth (a 403 here flips `forbidden`). The
      // Phase-2 extras fetch resiliently — each catches independently so one
      // failing endpoint never blanks the whole card.
      const [d, h, cmp, seg, hl, al, ch, ret] = await Promise.all([
        operatorApi.funnel(),
        operatorApi.funnelHistory({ granularity: range.granularity, from: from.toISOString(), to: to.toISOString() }),
        operatorApi.funnelCompare(cohortBy).catch(() => null),
        operatorApi.funnelSegments(segmentBy).catch(() => null),
        operatorApi.funnelHealth().catch(() => null),
        operatorApi.funnelAlerts().catch(() => null),
        operatorApi.funnelCohorts({ cohortBy, periods: 8 }).catch(() => null),
        operatorApi.funnelRetention({ cohortBy, periods: 8 }).catch(() => null)
      ]);
      setData(d);
      setHistory(h);
      setCompare(cmp);
      setSegmented(seg);
      setHealth(hl);
      setAlerts(al);
      setCohorts(ch);
      setRetention(ret);
      setError(null);
      setForbidden(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch funnel";
      if (msg.includes("(403)") || msg.includes("(401)")) {
        setForbidden(true);
        setError(null);
      } else {
        setError(msg);
      }
    }
  }, [range.days, range.granularity, segmentBy, cohortBy]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (forbidden) {
    return (
      <div className="rounded-lg border border-zinc-700/50 bg-zinc-900 p-4 text-zinc-500 text-sm flex items-center gap-2">
        <Lock className="h-4 w-4" />
        Activation funnel requires admin access (tenant:read).
      </div>
    );
  }

  if (error) {
    return <div className="rounded-lg border border-red-500/40 bg-red-950/20 p-4 text-red-400 text-sm">{error}</div>;
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-zinc-700/50 bg-zinc-900 p-4 text-zinc-500 text-sm">
        Loading activation funnel…
      </div>
    );
  }

  const notActivated = Math.max(0, data.total - data.activated);
  const periodLabel = cohortBy === "month" ? "vs last month" : "vs last week";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-white">Activation Funnel</h3>
          <p className="mt-0.5 text-xs text-zinc-500">Self-serve signups → ran their first agent.</p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={operatorApi.funnelExportUrl()}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1 border border-zinc-700 rounded"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </a>
          <button
            onClick={refresh}
            className="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1 border border-zinc-700 rounded"
          >
            Refresh
          </button>
        </div>
      </div>

      <PipelineStrip health={health} alerts={alerts} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Stat
          label="Signups"
          value={String(data.total)}
          icon={<UserPlus className="h-4 w-4" />}
          sub={
            <DeltaBadge value={compare?.delta.signupsPct ?? null} unit="pct" label={periodLabel} />
          }
        />
        <Stat
          label="Activated"
          value={String(data.activated)}
          icon={<Rocket className="h-4 w-4" />}
          sub={notActivated > 0 ? `${notActivated} not yet activated` : "all activated"}
        />
        <Stat
          label="Activation Rate"
          value={pct(data.activationRate)}
          icon={<TrendingUp className="h-4 w-4" />}
          sub={
            compare ? (
              <DeltaBadge value={compare.delta.activationRatePoints} unit="pp" label={periodLabel} />
            ) : (
              `${data.activated} / ${data.total}`
            )
          }
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">Segmentation</div>
          <select
            value={segmentBy}
            onChange={(e) => setSegmentBy(e.target.value as SegmentDimension)}
            className="text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-300 focus:border-blue-500 focus:outline-none"
          >
            {SEGMENTS.map((s) => (
              <option key={s.value} value={s.value}>
                By {s.label.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        {segmented ? (
          <SegmentBars segmented={segmented} />
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 text-zinc-600 text-sm">Loading…</div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">Trend</div>
          <div className="flex items-center gap-1">
            {RANGES.map((r, i) => (
              <button
                key={r.label}
                onClick={() => setRangeIdx(i)}
                className={`text-xs px-2 py-0.5 rounded border tabular-nums transition-colors ${
                  i === rangeIdx
                    ? "border-blue-500 text-blue-300 bg-blue-500/10"
                    : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {history ? (
          <FunnelTrendChart buckets={history.buckets} granularity={history.granularity} />
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-6 text-center text-zinc-600 text-sm">
            Loading trend…
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">Cohorts</div>
          <div className="flex items-center gap-1">
            {(["week", "month"] as CohortGranularity[]).map((g) => (
              <button
                key={g}
                onClick={() => setCohortBy(g)}
                className={`text-xs px-2 py-0.5 rounded border capitalize transition-colors ${
                  g === cohortBy
                    ? "border-blue-500 text-blue-300 bg-blue-500/10"
                    : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {g}ly
              </button>
            ))}
          </div>
        </div>
        {cohorts ? (
          <FunnelCohortTable report={cohorts} />
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-6 text-center text-zinc-600 text-sm">
            Loading cohorts…
          </div>
        )}
      </div>

      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-400 mb-2">
          Retention <span className="text-zinc-600 normal-case">— % of each cohort still active per {cohortBy}</span>
        </div>
        {retention ? (
          <FunnelCohortTable report={retentionAsCohortReport(retention)} />
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-6 text-center text-zinc-600 text-sm">
            Loading retention…
          </div>
        )}
      </div>
    </div>
  );
}
