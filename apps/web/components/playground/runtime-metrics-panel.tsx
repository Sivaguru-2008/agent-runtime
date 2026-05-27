"use client";

import { useEffect, useState } from "react";
import { Activity, AlertOctagon, BarChart3, Gauge, Timer, Zap } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { playgroundApi, type RuntimeMetrics } from "@/services/playground-api";
import type { LiveExecutionView } from "@/stores/execution-store";

const REFRESH_MS = 1500;

interface Props {
  current?: LiveExecutionView;
  connected: boolean;
}

export function RuntimeMetricsPanel({ current, connected }: Props) {
  const [metrics, setMetrics] = useState<RuntimeMetrics>();

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      playgroundApi
        .metrics()
        .then((data) => {
          if (!cancelled) setMetrics(data);
        })
        .catch(() => undefined);
    };
    tick();
    const interval = window.setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const tiles = [
    {
      label: "Total tokens",
      value: formatNumber(metrics?.tokens.total),
      icon: BarChart3,
      tone: "text-sky-300"
    },
    {
      label: "Tokens/sec",
      value: current ? current.tokensPerSecond.toFixed(1) : (metrics?.tokensPerSecond ?? 0).toFixed(1),
      icon: Zap,
      tone: "text-primary"
    },
    {
      label: "Latency",
      value: current ? `${current.latencyMs} ms` : `${Math.round(metrics?.latency.averageMs ?? 0)} ms`,
      icon: Timer,
      tone: "text-emerald-300"
    },
    {
      label: "Stream time",
      value: current ? `${current.streamDurationMs} ms` : `${Math.round(metrics?.stream.averageMs ?? 0)} ms`,
      icon: Gauge,
      tone: "text-warning"
    },
    {
      label: "Active",
      value: String(metrics?.executions.active ?? 0),
      icon: Activity,
      tone: connected ? "text-emerald-300" : "text-muted-foreground"
    },
    {
      label: "Failures",
      value: String(metrics?.executions.failed ?? 0),
      icon: AlertOctagon,
      tone: "text-critical"
    }
  ];

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      {tiles.map((tile) => {
        const Icon = tile.icon;
        return (
          <Card key={tile.label} className="flex h-20 items-center justify-between px-4">
            <div>
              <div className="text-xs text-muted-foreground">{tile.label}</div>
              <div className={cn("mt-1 font-mono text-2xl font-semibold", tile.tone)}>{tile.value}</div>
            </div>
            <Icon className="h-5 w-5 text-muted-foreground" />
          </Card>
        );
      })}
    </div>
  );
}

function formatNumber(value?: number): string {
  if (value === undefined) return "0";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}m`;
}
