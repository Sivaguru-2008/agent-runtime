import { Radio, TriangleAlert } from "lucide-react";
import type { DomainEvent } from "@/types/observability";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTime } from "@/lib/utils";

export function LiveEventStream({ events, connected }: { events: DomainEvent[]; connected: boolean }) {
  return (
    <Card className="h-[420px]">
      <CardHeader>
        <CardTitle>Live Events</CardTitle>
        <Badge variant={connected ? "success" : "muted"}>
          <Radio className="mr-1 h-3 w-3" />
          {connected ? "streaming" : "paused"}
        </Badge>
      </CardHeader>
      <CardContent className="h-[365px] overflow-auto p-0">
        {events.length ? (
          <div className="divide-y divide-border">
            {events.map((event) => (
              <div key={`${event.id}-${event.sequence ?? event.timestamp}`} className="grid grid-cols-[86px_1fr] gap-3 px-4 py-3">
                <div className="font-mono text-[11px] text-muted-foreground">{formatTime(event.timestamp)}</div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-semibold">{event.type}</span>
                    {event.type.includes("FAILED") || event.type.includes("WARNING") ? (
                      <TriangleAlert className="h-3.5 w-3.5 text-warning" />
                    ) : null}
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{event.aggregateId}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Awaiting events</div>
        )}
      </CardContent>
    </Card>
  );
}
