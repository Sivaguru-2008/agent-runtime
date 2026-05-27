"use client";

import { Activity, AlertOctagon, CheckCircle2, MessageSquare, Play, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatTime } from "@/lib/utils";
import type { LiveEvent } from "@/events/live-events";

export function LiveEventFeed({ events, connected }: { events: LiveEvent[]; connected: boolean }) {
  return (
    <Card className="h-[420px]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          Live Event Feed
        </CardTitle>
        <Badge variant={connected ? "success" : "muted"}>{connected ? "stream live" : "idle"}</Badge>
      </CardHeader>
      <CardContent className="h-[360px] overflow-auto p-0">
        {events.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Waiting for events…
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {events.slice(0, 200).map((event, index) => {
              const Icon = iconFor(event);
              // Sprint Stabilization — key on executionId+sequence ONLY.
              // The previous `${sequence}-${index}` was unstable: when a
              // new event was prepended every existing row's index bumped
              // by one, forcing React to discard and re-mount every <li>.
              // executionId+sequence is globally unique (after server-side
              // and client-side dedup) and survives reorder + filter.
              void index;
              const stableKey = `${event.executionId}-${event.sequence}`;
              return (
                <li key={stableKey} className="flex items-start gap-3 px-3 py-2">
                  <Icon className={cn("mt-0.5 h-3.5 w-3.5", toneFor(event))} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px]">{event.type}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{formatTime(event.timestamp)}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 break-words text-[11px] text-muted-foreground">
                      {summarize(event)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function iconFor(event: LiveEvent) {
  switch (event.type) {
    case "PROMPT_RECEIVED": return MessageSquare;
    case "MODEL_START": return Play;
    case "TOKEN_STREAM": return Zap;
    case "MODEL_COMPLETE": return CheckCircle2;
    case "MODEL_ERROR": return AlertOctagon;
    case "EXECUTION_STATE": return Activity;
  }
}

function toneFor(event: LiveEvent) {
  switch (event.type) {
    case "PROMPT_RECEIVED": return "text-sky-300";
    case "MODEL_START": return "text-primary";
    case "TOKEN_STREAM": return "text-warning";
    case "MODEL_COMPLETE": return "text-emerald-300";
    case "MODEL_ERROR": return "text-critical";
    case "EXECUTION_STATE": return "text-muted-foreground";
  }
}

function summarize(event: LiveEvent): string {
  switch (event.type) {
    case "PROMPT_RECEIVED": return `${event.model} · ${truncate(event.prompt, 80)}`;
    case "MODEL_START": return `Starting ${event.model}`;
    case "TOKEN_STREAM": return `#${event.tokensSoFar} ${JSON.stringify(event.token)}`;
    case "MODEL_COMPLETE": return `${event.totalTokens} tok · ${event.latencyMs} ms · ${event.tokensPerSecond.toFixed(1)} tok/s`;
    case "MODEL_ERROR": return `${event.code}: ${event.message}`;
    case "EXECUTION_STATE": return `state → ${event.state}`;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
