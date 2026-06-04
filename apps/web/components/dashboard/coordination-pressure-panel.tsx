import { Gauge, Workflow } from "lucide-react";
import type { Topology } from "@/types/observability";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ExplainLabel } from "@/components/explain/explain-label";
import { GraphGuide } from "@/components/explain/graph-guide";
import { ExplainedEmptyState } from "@/components/explain/empty-state";

export function CoordinationPressurePanel({ topology }: { topology?: Topology }) {
  const summary = topology?.pressure;
  const nodes = summary?.nodes ?? [];
  const peak = Math.max(0.01, summary?.peakCongestion ?? 0);

  const agentLabel = (agentId: string) =>
    topology?.nodes.find((node) => node.id === agentId && node.type === "agent")?.label ?? agentId;

  return (
    <Card className="h-[360px]">
      <CardHeader>
        <CardTitle>
          <ExplainLabel concept="coordination-pressure" as="span">Coordination Pressure</ExplainLabel>
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="muted">mean {summary?.meanCongestion?.toFixed(1) ?? "0.0"}</Badge>
          <Badge variant="muted">peak {summary?.peakCongestion?.toFixed(1) ?? "0.0"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="h-[305px] overflow-auto space-y-2">
        {nodes.length ? <GraphGuide concept="coordination-pressure" value={Math.round(summary?.meanCongestion ?? 0)} className="mb-1" /> : null}
        {nodes.length ? nodes.map((node) => {
          const share = peak ? node.congestion / peak : 0;
          return (
            <div key={node.agentId} className="rounded-md border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Workflow className={cn("h-4 w-4", node.isBottleneck ? "text-critical" : "text-primary")} />
                  <span className="truncate text-xs font-semibold">{agentLabel(node.agentId)}</span>
                </div>
                {node.isBottleneck ? <Badge variant="critical">bottleneck</Badge> : <Badge variant="muted">healthy</Badge>}
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-muted">
                <div
                  className={cn("h-1.5 rounded-sm", node.isBottleneck ? "bg-critical" : "bg-primary")}
                  style={{ width: `${Math.max(6, share * 100)}%` }}
                />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Gauge className="h-3 w-3" />{node.congestion.toFixed(1)}</span>
                <span>in {node.inboundEdges}</span>
                <span>out {node.outboundEdges}</span>
              </div>
            </div>
          );
        }) : (
          <ExplainedEmptyState concept="coordination-pressure" className="h-full justify-center border-0 bg-transparent" />
        )}
      </CardContent>
    </Card>
  );
}
