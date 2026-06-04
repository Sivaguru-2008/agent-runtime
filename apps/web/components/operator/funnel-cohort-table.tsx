"use client";

/**
 * Cohort activation triangle. Rows = signup cohort (week/month), columns =
 * periods since signup, cell = cumulative activation rate for that cohort by
 * that period. Colour intensity scales with the rate so the diagonal "warm-up"
 * pattern is visible at a glance. Dependency-free (CSS grid + inline styles).
 */

import type { CohortReport, CohortGranularity } from "../../services/operator-api";

function fmtCohort(iso: string, granularity: CohortGranularity): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (granularity === "month") {
    return d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

// Blue with alpha proportional to rate — empty cells stay near-transparent.
function cellStyle(rate: number): React.CSSProperties {
  const alpha = Math.max(0.05, Math.min(1, rate));
  return { backgroundColor: `rgba(59, 130, 246, ${alpha})` };
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function FunnelCohortTable({ report }: { report: CohortReport }) {
  if (report.cohorts.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-6 text-center text-zinc-600 text-sm">
        No cohorts in range yet.
      </div>
    );
  }

  const periodLabel = report.cohortBy === "month" ? "M" : "W";
  const cols = report.periods + 1; // offsets 0..periods

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <table className="border-separate border-spacing-1 text-xs">
        <thead>
          <tr>
            <th className="text-left font-medium text-zinc-400 pr-3">Cohort</th>
            <th className="text-right font-medium text-zinc-500 pr-3">Size</th>
            {Array.from({ length: cols }, (_, p) => (
              <th key={p} className="text-center font-medium text-zinc-500 w-12">
                {periodLabel}
                {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.cohorts.map((c) => (
            <tr key={c.cohort}>
              <td className="text-left text-zinc-300 pr-3 whitespace-nowrap">
                {fmtCohort(c.cohort, report.cohortBy)}
              </td>
              <td className="text-right text-zinc-500 tabular-nums pr-3">{c.size}</td>
              {c.cells.map((cell) => (
                <td
                  key={cell.period}
                  title={`${pct(cell.rate)} (${cell.activated}/${c.size})`}
                  className="text-center tabular-nums rounded text-[11px] text-white/90 px-1 py-1"
                  style={cellStyle(cell.rate)}
                >
                  {c.size > 0 ? pct(cell.rate) : "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
