import { Activity, AlertTriangle, BrainCircuit, Gauge, Radio, Zap } from "lucide-react";
import type { Overview } from "@/types/observability";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ExplainLabel } from "@/components/explain/explain-label";

const metricIcons = [BrainCircuit, Radio, Activity, AlertTriangle, Zap, Gauge];

export function MetricStrip({ overview, connected }: { overview?: Overview; connected: boolean }) {
  // Each metric carries the registry concept id that explains it (hover for the
  // micro explanation, click for the full click-to-learn panel).
  const metrics = [
    { label: "Agents", concept: "agents-total", value: overview?.agents.total ?? 0, tone: "text-primary" },
    { label: "Active", concept: "agents-active", value: overview?.agents.active ?? 0, tone: "text-emerald-300" },
    { label: "Running", concept: "executions-running", value: overview?.executions.running ?? 0, tone: "text-warning" },
    { label: "Failures", concept: "executions-failed", value: overview?.executions.failed ?? 0, tone: "text-critical" },
    { label: "Tokens", concept: "tokens-total", value: overview?.tokens.total ?? 0, tone: "text-sky-300" },
    { label: "Stream", concept: "stream-status", value: connected ? "live" : "idle", tone: connected ? "text-emerald-300" : "text-muted-foreground" }
  ];

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      {metrics.map((metric, index) => {
        const Icon = metricIcons[index];
        return (
          <Card key={metric.label} className="flex h-20 items-center justify-between px-4">
            <div className="min-w-0">
              <ExplainLabel concept={metric.concept} className="text-xs text-muted-foreground">
                {metric.label}
              </ExplainLabel>
              <div className={cn("mt-1 font-mono text-2xl font-semibold", metric.tone)}>{metric.value}</div>
            </div>
            <Icon className="h-5 w-5 text-muted-foreground" />
          </Card>
        );
      })}
    </div>
  );
}
