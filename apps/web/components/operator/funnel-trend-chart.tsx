"use client";

/**
 * Funnel trend chart — signups vs. activations over time.
 *
 * Pure-SVG, dependency-free on purpose: the web app's `next start` is known to
 * crash on Windows via an @xyflow vendor chunk, so we avoid pulling in a
 * charting library and the extra vendor bundle it would add. This renders two
 * cohort series (signups, activated) on a shared count axis from the
 * GET /admin/funnel/history payload, with hover tooltips carrying the per-bucket
 * activation rate.
 */

import { useState } from "react";
import type { FunnelHistoryBucket, FunnelGranularity } from "../../services/operator-api";

const VIEW_W = 640;
const VIEW_H = 200;
const PAD = { top: 16, right: 16, bottom: 28, left: 36 };
const INNER_W = VIEW_W - PAD.left - PAD.right;
const INNER_H = VIEW_H - PAD.top - PAD.bottom;

function fmtBucket(iso: string, granularity: FunnelGranularity): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (granularity === "month") {
    return d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`;
}

interface Props {
  buckets: FunnelHistoryBucket[];
  granularity: FunnelGranularity;
}

export function FunnelTrendChart({ buckets, granularity }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  if (buckets.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-6 text-center text-zinc-600 text-sm">
        No signups in this window yet.
      </div>
    );
  }

  // Shared count axis. Guard against an all-zero window (max 0 → flat baseline)
  // so we never divide by zero when projecting points.
  const maxCount = Math.max(1, ...buckets.map((b) => b.signups));
  const n = buckets.length;

  // x positions: spread across the inner width; a single bucket sits at the left
  // edge (its line is just a dot).
  const x = (i: number) => PAD.left + (n === 1 ? 0 : (i * INNER_W) / (n - 1));
  const y = (v: number) => PAD.top + INNER_H * (1 - v / maxCount);

  const line = (key: "signups" | "activated") =>
    buckets.map((b, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(b[key]).toFixed(1)}`).join(" ");

  // y-axis ticks: 0, mid, max.
  const ticks = [0, Math.round(maxCount / 2), maxCount].filter((v, i, a) => a.indexOf(v) === i);

  const active = hover != null ? buckets[hover] : null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-center gap-4 mb-2 text-xs">
        <span className="flex items-center gap-1.5 text-zinc-400">
          <span className="inline-block h-2 w-2 rounded-full bg-blue-500" /> Signups
        </span>
        <span className="flex items-center gap-1.5 text-zinc-400">
          <span className="inline-block h-2 w-2 rounded-full bg-green-500" /> Activated
        </span>
        <span className="ml-auto text-zinc-500 tabular-nums">
          {active
            ? `${fmtBucket(active.bucket, granularity)} · ${active.activated}/${active.signups} · ${pct(active.activationRate)}`
            : `${n} ${granularity}${n === 1 ? "" : "s"}`}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        width="100%"
        role="img"
        aria-label="Funnel trend: signups and activations over time"
        className="overflow-visible"
        preserveAspectRatio="none"
      >
        {/* y grid + labels */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={VIEW_W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="currentColor"
              className="text-zinc-800"
              strokeWidth={1}
            />
            <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" className="fill-zinc-600 text-[9px]">
              {t}
            </text>
          </g>
        ))}

        {/* x labels: first, middle, last to avoid crowding */}
        {[0, Math.floor((n - 1) / 2), n - 1]
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((i) => (
            <text
              key={i}
              x={x(i)}
              y={VIEW_H - 8}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              className="fill-zinc-600 text-[9px]"
            >
              {fmtBucket(buckets[i].bucket, granularity)}
            </text>
          ))}

        {/* series */}
        <path d={line("signups")} fill="none" stroke="#3b82f6" strokeWidth={2} />
        <path d={line("activated")} fill="none" stroke="#22c55e" strokeWidth={2} />

        {/* hover hit-targets + dots */}
        {buckets.map((b, i) => (
          <g key={b.bucket} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <rect
              x={x(i) - (n === 1 ? 12 : INNER_W / (2 * (n - 1)))}
              y={PAD.top}
              width={n === 1 ? 24 : INNER_W / (n - 1)}
              height={INNER_H}
              fill="transparent"
            />
            {hover === i && (
              <line
                x1={x(i)}
                x2={x(i)}
                y1={PAD.top}
                y2={PAD.top + INNER_H}
                stroke="currentColor"
                className="text-zinc-600"
                strokeWidth={1}
                strokeDasharray="2 2"
              />
            )}
            <circle cx={x(i)} cy={y(b.signups)} r={hover === i ? 3.5 : 2} fill="#3b82f6" />
            <circle cx={x(i)} cy={y(b.activated)} r={hover === i ? 3.5 : 2} fill="#22c55e" />
          </g>
        ))}
      </svg>
    </div>
  );
}
