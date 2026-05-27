import { Activity, AlertTriangle, BrainCircuit, Gauge, Radio, Zap } from "lucide-react";
import type { Overview } from "@/types/observability";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const metricIcons = [BrainCircuit, Radio, Activity, AlertTriangle, Zap, Gauge];

export function MetricStrip({ overview, connected }: { overview?: Overview; connected: boolean }) {
  const metrics = [
    { label: "Agents", value: overview?.agents.total ?? 0, tone: "text-primary" },
    { label: "Active", value: overview?.agents.active ?? 0, tone: "text-emerald-300" },
    { label: "Running", value: overview?.executions.running ?? 0, tone: "text-warning" },
    { label: "Failures", value: overview?.executions.failed ?? 0, tone: "text-critical" },
    { label: "Tokens", value: overview?.tokens.total ?? 0, tone: "text-sky-300" },
    { label: "Stream", value: connected ? "live" : "idle", tone: connected ? "text-emerald-300" : "text-muted-foreground" }
  ];

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      {metrics.map((metric, index) => {
        const Icon = metricIcons[index];
        return (
          <Card key={metric.label} className="flex h-20 items-center justify-between px-4">
            <div>
              <div className="text-xs text-muted-foreground">{metric.label}</div>
              <div className={cn("mt-1 font-mono text-2xl font-semibold", metric.tone)}>{metric.value}</div>
            </div>
            <Icon className="h-5 w-5 text-muted-foreground" />
          </Card>
        );
      })}
    </div>
  );
}
