import { AlertOctagon, Info, ShieldAlert, TriangleAlert } from "lucide-react";
import type { ObservabilityWarning } from "@/types/observability";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTime } from "@/lib/utils";
import { ExplainLabel } from "@/components/explain/explain-label";
import { ExplainedEmptyState } from "@/components/explain/empty-state";

export function FailureAnalysisPanel({ warnings }: { warnings: ObservabilityWarning[] }) {
  return (
    <Card className="h-[360px]">
      <CardHeader>
        <CardTitle>
          <ExplainLabel concept="self-healing-diagnostics" as="span">Failure Analysis</ExplainLabel>
        </CardTitle>
        <Badge variant={warnings.some((warning) => warning.severity === "critical") ? "critical" : warnings.length ? "warning" : "success"}>
          {warnings.length} warnings
        </Badge>
      </CardHeader>
      <CardContent className="h-[305px] overflow-auto space-y-3">
        {warnings.length ? warnings.map((warning) => {
          const Icon = warning.severity === "critical" ? AlertOctagon : warning.severity === "warning" ? TriangleAlert : Info;
          return (
            <div key={warning.id} className="rounded-md border border-border bg-background p-3">
              <div className="flex items-start gap-3">
                <Icon className={warning.severity === "critical" ? "mt-0.5 h-4 w-4 text-critical" : "mt-0.5 h-4 w-4 text-warning"} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-sm font-semibold">{warning.title}</div>
                    <Badge variant={warning.severity === "critical" ? "critical" : warning.severity === "warning" ? "warning" : "muted"}>
                      {warning.kind}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{warning.description}</p>
                  <div className="mt-2 font-mono text-[11px] text-muted-foreground">{formatTime(warning.timestamp)}</div>
                </div>
              </div>
            </div>
          );
        }) : (
          <ExplainedEmptyState
            concept="self-healing-diagnostics"
            icon={<ShieldAlert className="h-5 w-5 text-emerald-300" />}
            title="No analysis warnings"
            body="The platform's health checks didn't flag anything about this run — no anomalies, drift, or risks were detected. This is the healthy state."
            className="h-full justify-center border-0 bg-transparent"
          />
        )}
      </CardContent>
    </Card>
  );
}
