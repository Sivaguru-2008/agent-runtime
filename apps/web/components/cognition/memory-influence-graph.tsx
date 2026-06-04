"use client";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { MemoryInfluenceHeatmap } from "@/lib/cognition-api";
import { cn } from "@/lib/utils";
import { ExplainLabel } from "@/components/explain/explain-label";
import { ExplainedEmptyState } from "@/components/explain/empty-state";

export interface MemoryInfluenceGraphProps {
  influence: MemoryInfluenceHeatmap;
}

/**
 * Memory Influence Graph + Heatmap.
 *
 * Left column = memory records (sorted by aggregate weight). Center grid =
 * (memory × node) heatmap. Right side = anchor indicators & previews.
 */
export function MemoryInfluenceGraph({ influence }: MemoryInfluenceGraphProps) {
  const { memories, nodes, cells } = influence;
  const cellByKey = new Map(cells.map((c) => [`${c.memoryId}__${c.nodeId}`, c]));

  if (memories.length === 0) {
    return (
      <Card className="p-4 bg-zinc-950/60 border-zinc-800 space-y-2">
        <ExplainLabel concept="memory-influence" as="span" className="text-sm font-medium text-zinc-200">
          Memory Influence
        </ExplainLabel>
        <ExplainedEmptyState concept="memory-influence" className="border-0 bg-transparent py-4" />
      </Card>
    );
  }

  return (
    <Card className="p-4 bg-zinc-950/60 border-zinc-800 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <ExplainLabel concept="memory-influence" as="span" className="text-sm font-medium text-zinc-200">
            Memory Influence
          </ExplainLabel>
          <div className="text-xs text-zinc-500">
            {memories.length} memories · {nodes.length} nodes
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="text-xs w-full">
          <thead>
            <tr className="text-zinc-500">
              <th className="text-left font-normal pr-2">Memory</th>
              <th className="text-left font-normal pr-2">Total</th>
              {nodes.map((n) => (
                <th key={n.nodeId} className="text-center font-normal px-1 font-mono text-[10px]">
                  {n.role.slice(0, 3)}·{n.sequence}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {memories.map((mem) => (
              <tr key={mem.memoryId} className="border-t border-zinc-800/60">
                <td className="py-1 pr-2 font-mono text-zinc-400">
                  {mem.memoryId.slice(0, 10)}…
                  {mem.isAnchor && <Badge variant="muted" className="ml-1 text-[9px] py-0">anchor</Badge>}
                </td>
                <td className="py-1 pr-2">
                  <div className="flex items-center gap-1">
                    <div className="w-16 h-1.5 bg-zinc-800 rounded">
                      <div
                        className="h-1.5 bg-fuchsia-500/80 rounded"
                        style={{ width: `${Math.min(100, mem.aggregateWeight * 50)}%` }}
                      />
                    </div>
                    <span className="text-zinc-400 w-10">{mem.aggregateWeight.toFixed(2)}</span>
                  </div>
                </td>
                {nodes.map((n) => {
                  const cell = cellByKey.get(`${mem.memoryId}__${n.nodeId}`);
                  const w = cell?.weight ?? 0;
                  return (
                    <td key={n.nodeId} className="text-center align-middle px-1">
                      <div
                        className={cn(
                          "w-5 h-5 rounded mx-auto",
                          w === 0 && "bg-zinc-900",
                          w > 0 && w < 0.2 && "bg-fuchsia-900/60",
                          w >= 0.2 && w < 0.4 && "bg-fuchsia-700/70",
                          w >= 0.4 && w < 0.6 && "bg-fuchsia-500/70",
                          w >= 0.6 && "bg-fuchsia-400/90"
                        )}
                        title={`weight ${w.toFixed(2)}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-1">
        {memories.slice(0, 3).map((m) => (
          <div key={m.memoryId} className="text-[11px] text-zinc-500 truncate">
            <span className="font-mono text-zinc-400 mr-2">{m.memoryId.slice(0, 8)}…</span>
            {m.contentPreview ?? "(no preview)"}
          </div>
        ))}
      </div>
    </Card>
  );
}
