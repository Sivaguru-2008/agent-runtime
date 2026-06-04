import { Flame } from "lucide-react";
import type { DecisionHeatmap } from "@/types/observability";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatDuration } from "@/lib/utils";
import { ExplainLabel } from "@/components/explain/explain-label";
import { GraphGuide } from "@/components/explain/graph-guide";
import { ExplainedEmptyState } from "@/components/explain/empty-state";

export function DecisionHeatmapPanel({ heatmap }: { heatmap?: DecisionHeatmap }) {
  const nodes = heatmap?.nodes ?? [];

  return (
    <Card className="h-[360px]">
      <CardHeader>
        <CardTitle>
          <ExplainLabel concept="decision-heatmap" as="span">Decision Heatmap</ExplainLabel>
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="muted">{nodes.length} nodes</Badge>
          <Badge variant="muted">{heatmap?.totals.tokens ?? 0} tokens</Badge>
        </div>
      </CardHeader>
      <CardContent className="h-[305px] overflow-auto space-y-2">
        {nodes.length ? <GraphGuide concept="decision-heatmap" className="mb-1" /> : null}
        {nodes.length ? nodes.map((node) => {
          const intensity = node.reasoningIntensity;
          return (
            <div key={node.id} className="rounded-md border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Flame className={cn("h-4 w-4", intensityColor(intensity))} />
                  <span className="truncate text-xs font-semibold">{node.label}</span>
                </div>
                <Badge variant={intensity > 0.66 ? "critical" : intensity > 0.33 ? "warning" : "muted"}>
                  #{node.intensityRank}
                </Badge>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-muted">
                <div
                  className={cn("h-1.5 rounded-sm", intensityBg(intensity))}
                  style={{ width: `${Math.max(4, intensity * 100)}%` }}
                />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px] text-muted-foreground">
                <span>{formatDuration(node.durationMs)}</span>
                <span>{node.totalTokens} tok</span>
                <span>{Math.round(node.share * 100)}%</span>
              </div>
            </div>
          );
        }) : (
          <ExplainedEmptyState concept="decision-heatmap" className="h-full justify-center border-0 bg-transparent" />
        )}
      </CardContent>
    </Card>
  );
}

function intensityColor(value: number) {
  if (value > 0.66) return "text-critical";
  if (value > 0.33) return "text-warning";
  return "text-primary";
}

function intensityBg(value: number) {
  if (value > 0.66) return "bg-critical";
  if (value > 0.33) return "bg-warning";
  return "bg-primary";
}
