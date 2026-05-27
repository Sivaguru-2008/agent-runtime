import { Waves } from "lucide-react";
import type { MemoryDriftReport } from "@/types/observability";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatTime } from "@/lib/utils";

export function MemoryDriftTimeline({ drift }: { drift?: MemoryDriftReport }) {
  const points = drift?.points ?? [];
  const maxDrift = Math.max(0.0001, ...points.map((point) => point.driftFromPrevious));

  return (
    <Card className="h-[360px]">
      <CardHeader>
        <CardTitle>Memory Drift</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="muted">peak {Math.round((drift?.peakDrift ?? 0) * 100)}%</Badge>
          <Badge variant={drift?.warnings?.length ? "warning" : "muted"}>{drift?.warnings?.length ?? 0} warnings</Badge>
        </div>
      </CardHeader>
      <CardContent className="h-[305px] overflow-auto space-y-3">
        {points.length ? (
          <>
            <div className="flex h-20 items-end gap-1 rounded-md border border-border bg-background p-2">
              {points.map((point) => {
                const height = Math.max(6, (point.driftFromPrevious / maxDrift) * 100);
                return (
                  <div
                    key={point.recordId}
                    className={cn("flex-1 rounded-sm", driftColor(point.driftFromPrevious))}
                    style={{ height: `${height}%` }}
                    title={`drift ${(point.driftFromPrevious * 100).toFixed(1)}%`}
                  />
                );
              })}
            </div>
            <div className="space-y-2">
              {points.slice(-6).reverse().map((point) => (
                <div key={point.recordId} className="rounded-md border border-border bg-background p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Waves className={cn("h-4 w-4", driftIconColor(point.driftFromPrevious))} />
                      <span className="truncate font-mono text-[11px] text-muted-foreground">{point.recordId}</span>
                    </div>
                    <Badge variant={point.driftFromPrevious > 0.85 ? "critical" : point.driftFromPrevious > 0.45 ? "warning" : "muted"}>
                      {Math.round(point.driftFromPrevious * 100)}%
                    </Badge>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">{formatTime(point.timestamp)}</div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{point.preview}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No memory mutations recorded</div>
        )}
      </CardContent>
    </Card>
  );
}

function driftColor(value: number) {
  if (value > 0.85) return "bg-critical";
  if (value > 0.45) return "bg-warning";
  return "bg-primary/70";
}

function driftIconColor(value: number) {
  if (value > 0.85) return "text-critical";
  if (value > 0.45) return "text-warning";
  return "text-primary";
}
