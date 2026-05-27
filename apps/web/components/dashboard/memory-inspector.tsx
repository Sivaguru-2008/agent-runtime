import { Database, ShieldAlert } from "lucide-react";
import type { MemoryInfluence } from "@/types/observability";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export function MemoryInspector({ memories }: { memories: MemoryInfluence[] }) {
  return (
    <Card className="h-[360px]">
      <CardHeader>
        <CardTitle>Memory Influence</CardTitle>
        <Badge variant="muted">{memories.length} retrieved</Badge>
      </CardHeader>
      <CardContent className="h-[305px] overflow-auto space-y-3">
        {memories.length ? memories.map((memory) => (
          <div key={memory.id} className="rounded-md border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Database className="h-4 w-4 text-emerald-300" />
                <span className="truncate font-mono text-xs">{memory.id}</span>
              </div>
              <div className="flex items-center gap-1">
                {memory.corrupted ? <Badge variant="critical"><ShieldAlert className="mr-1 h-3 w-3" />corrupt</Badge> : null}
                {memory.conflicting ? <Badge variant="warning">conflict</Badge> : null}
              </div>
            </div>
            <Progress className="mt-3" value={memory.score * 100} />
            <p className="mt-3 line-clamp-4 text-xs leading-relaxed text-muted-foreground">{memory.content}</p>
          </div>
        )) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No memory influence recorded</div>
        )}
      </CardContent>
    </Card>
  );
}
