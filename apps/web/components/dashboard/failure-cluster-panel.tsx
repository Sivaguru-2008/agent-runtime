import { Fingerprint, ShieldCheck } from "lucide-react";
import type { FailureClusterReport } from "@/types/observability";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTime } from "@/lib/utils";
import { ExplainLabel } from "@/components/explain/explain-label";
import { ExplainedEmptyState } from "@/components/explain/empty-state";

export function FailureClusterPanel({ report }: { report?: FailureClusterReport }) {
  const clusters = report?.clusters ?? [];

  return (
    <Card className="h-[360px]">
      <CardHeader>
        <CardTitle>
          <ExplainLabel concept="failure-clusters" as="span">Failure Clusters</ExplainLabel>
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="muted">{clusters.length} clusters</Badge>
          <Badge variant="muted">{report?.totals.warnings ?? 0} warnings</Badge>
        </div>
      </CardHeader>
      <CardContent className="h-[305px] overflow-auto space-y-2">
        {clusters.length ? clusters.map((cluster) => (
          <div key={cluster.id} className="rounded-md border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Fingerprint className="h-4 w-4 text-primary" />
                <span className="truncate text-xs font-semibold">{cluster.signature}</span>
              </div>
              <Badge variant={cluster.severity === "critical" ? "critical" : cluster.severity === "warning" ? "warning" : "muted"}>
                ×{cluster.occurrences}
              </Badge>
            </div>
            <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{cluster.description}</p>
            <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11px] text-muted-foreground">
              <span>kind {cluster.kind.toLowerCase()}</span>
              <span>{cluster.executionIds.length} execs</span>
              <span className="truncate">first {formatTime(cluster.firstSeen)}</span>
              <span className="truncate">last {formatTime(cluster.lastSeen)}</span>
            </div>
            <div className="mt-2 truncate font-mono text-[10px] text-muted-foreground">fp: {cluster.fingerprint}</div>
          </div>
        )) : (
          <ExplainedEmptyState
            concept="failure-clusters"
            icon={<ShieldCheck className="h-5 w-5 text-emerald-300" />}
            className="h-full justify-center border-0 bg-transparent"
          />
        )}
      </CardContent>
    </Card>
  );
}
