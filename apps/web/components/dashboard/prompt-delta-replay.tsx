"use client";

import { useState } from "react";
import { ArrowLeftRight, Minus, Plus } from "lucide-react";
import type { PromptDelta } from "@/types/observability";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExplainedEmptyState } from "@/components/explain/empty-state";
import { formatTime } from "@/lib/utils";

export function PromptDeltaReplay({ deltas }: { deltas?: PromptDelta[] }) {
  const items = deltas ?? [];
  const [index, setIndex] = useState(0);
  const safeIndex = Math.min(index, Math.max(0, items.length - 1));
  const delta = items[safeIndex];

  return (
    <Card className="h-[420px]">
      <CardHeader>
        <CardTitle>Prompt Delta Replay</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="muted">{items.length} deltas</Badge>
          <Button variant="secondary" size="sm" onClick={() => setIndex(Math.max(0, safeIndex - 1))} disabled={!items.length}>
            prev
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setIndex(Math.min(items.length - 1, safeIndex + 1))} disabled={!items.length}>
            next
          </Button>
        </div>
      </CardHeader>
      <CardContent className="h-[365px] overflow-auto">
        {delta ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="muted">{delta.fromType.toLowerCase()}</Badge>
              <ArrowLeftRight className="h-3.5 w-3.5" />
              <Badge variant="muted">{delta.toType.toLowerCase()}</Badge>
              <span className="font-mono">{formatTime(delta.toTimestamp)}</span>
              <span className="ml-auto font-mono">similarity {(delta.similarity * 100).toFixed(1)}%</span>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <DiffBlock title="Removed" tone="critical" icon={Minus} tokens={delta.removed} />
              <DiffBlock title="Added" tone="success" icon={Plus} tokens={delta.added} />
            </div>

            {delta.changedKeys.length ? (
              <div>
                <div className="text-xs font-semibold text-muted-foreground">Changed keys</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {delta.changedKeys.map((key) => (
                    <Badge key={key} variant="warning">{key}</Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <ExplainedEmptyState
            className="h-full"
            title="No prompt mutations"
            body="The prompt didn't change across this execution's replays, so there are no deltas to compare here."
          />
        )}
      </CardContent>
    </Card>
  );
}

function DiffBlock({
  title,
  tone,
  icon: Icon,
  tokens
}: {
  title: string;
  tone: "success" | "critical";
  icon: typeof Plus;
  tokens: string[];
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon className={tone === "critical" ? "h-4 w-4 text-critical" : "h-4 w-4 text-emerald-300"} />
        <span className="text-xs font-semibold text-muted-foreground">{title}</span>
        <Badge variant={tone === "critical" ? "critical" : "success"} className="ml-auto">{tokens.length}</Badge>
      </div>
      <div className="max-h-48 overflow-auto p-3">
        {tokens.length ? (
          <div className="flex flex-wrap gap-1">
            {tokens.map((token) => (
              <span
                key={token}
                className={
                  tone === "critical"
                    ? "rounded-sm border border-critical/40 bg-critical/12 px-1.5 py-0.5 font-mono text-[11px] text-critical"
                    : "rounded-sm border border-emerald-400/40 bg-emerald-400/12 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300"
                }
              >
                {token}
              </span>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">no tokens</div>
        )}
      </div>
    </div>
  );
}
