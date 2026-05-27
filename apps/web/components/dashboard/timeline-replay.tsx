"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import type { ExecutionDetails } from "@/types/observability";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDuration, formatTime } from "@/lib/utils";

export function TimelineReplay({
  details,
  onReplay
}: {
  details?: ExecutionDetails;
  onReplay(): void;
}) {
  const frames = details?.timeline ?? [];
  const [index, setIndex] = useState(0);
  const safeIndex = Math.min(index, Math.max(0, frames.length - 1));
  const frame = frames[safeIndex];
  const progress = useMemo(() => (frames.length <= 1 ? 0 : (safeIndex / (frames.length - 1)) * 100), [frames.length, safeIndex]);

  return (
    <Card className="h-[420px]">
      <CardHeader>
        <CardTitle>Timeline Replay</CardTitle>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setIndex(Math.max(0, safeIndex - 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setIndex(Math.min(frames.length - 1, safeIndex + 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={onReplay}>
            <RotateCcw className="h-4 w-4" />
            Replay
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <input
            aria-label="Timeline scrubber"
            className="w-full accent-primary"
            min={0}
            max={Math.max(0, frames.length - 1)}
            value={safeIndex}
            type="range"
            onChange={(event) => setIndex(Number(event.target.value))}
          />
          <div className="mt-2 h-1 rounded-sm bg-muted">
            <div className="h-1 rounded-sm bg-primary" style={{ width: `${progress}%` }} />
          </div>
        </div>

        {frame ? (
          <div className="grid gap-3 lg:grid-cols-[220px_1fr]">
            <div className="space-y-3">
              <Badge variant="muted">{safeIndex + 1} / {frames.length}</Badge>
              <div className="text-sm font-semibold">{frame.title}</div>
              <div className="font-mono text-xs text-muted-foreground">{formatTime(frame.timestamp)}</div>
              <div className="font-mono text-xs text-muted-foreground">{formatDuration(frame.durationMs)}</div>
              <div className="grid grid-cols-3 gap-2 text-center font-mono text-xs">
                <Token label="prompt" value={frame.tokenUsage?.prompt} />
                <Token label="out" value={frame.tokenUsage?.completion} />
                <Token label="total" value={frame.tokenUsage?.total} />
              </div>
            </div>
            <div className="grid min-h-56 gap-3 md:grid-cols-2">
              <FrameBlock title="Prompt" value={frame.prompt ?? frame.payload} />
              <FrameBlock title="Output" value={frame.output ?? frame.payload} />
            </div>
          </div>
        ) : (
          <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">No execution selected</div>
        )}
      </CardContent>
    </Card>
  );
}

function Token({ label, value }: { label: string; value?: number }) {
  return (
    <div className="rounded-sm border border-border bg-muted px-2 py-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-foreground">{value ?? 0}</div>
    </div>
  );
}

function FrameBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold text-muted-foreground">{title}</div>
      <pre className="h-48 overflow-auto p-3 font-mono text-xs leading-relaxed text-foreground">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
