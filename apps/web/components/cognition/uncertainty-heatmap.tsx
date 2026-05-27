"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import type { CognitionGraph } from "@/lib/cognition-api";
import { cn } from "@/lib/utils";

export interface UncertaintyHeatmapProps {
  graph: CognitionGraph;
}

/**
 * Per-token uncertainty heatmap across all completed nodes in the cognition.
 * Each row = a node, each cell = a streamed token coloured by confidence.
 */
export function UncertaintyHeatmap({ graph }: UncertaintyHeatmapProps) {
  const rows = useMemo(() => {
    return graph.nodes
      .filter((n) => n.tokenStream && n.tokenStream.length > 0)
      .sort((a, b) => a.sequence - b.sequence);
  }, [graph.nodes]);

  if (rows.length === 0) {
    return (
      <Card className="p-4 bg-zinc-950/60 border-zinc-800">
        <div className="text-sm font-medium text-zinc-200">Uncertainty Heatmap</div>
        <div className="text-xs text-zinc-500 mt-2">No token streams captured yet.</div>
      </Card>
    );
  }

  return (
    <Card className="p-4 bg-zinc-950/60 border-zinc-800 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-zinc-200">Uncertainty Heatmap</div>
          <div className="text-xs text-zinc-500">
            {rows.length} node{rows.length === 1 ? "" : "s"} · {rows.reduce((acc, n) => acc + (n.tokenStream?.length ?? 0), 0)} tokens
          </div>
        </div>
        <Legend />
      </div>

      <div className="space-y-1">
        {rows.map((node) => (
          <div key={node.id} className="flex items-center gap-2">
            <div className="w-28 text-[10px] text-zinc-400 truncate font-mono">
              {node.role}·#{node.sequence}
            </div>
            <div className="flex-1 flex flex-wrap gap-[2px]">
              {node.tokenStream!.slice(0, 200).map((chunk) => (
                <div
                  key={chunk.sequence}
                  className={cn(
                    "w-2 h-3 rounded-sm",
                    chunk.confidence > 0.85
                      ? "bg-emerald-500/80"
                      : chunk.confidence > 0.7
                      ? "bg-emerald-400/60"
                      : chunk.confidence > 0.55
                      ? "bg-amber-500/70"
                      : chunk.confidence > 0.4
                      ? "bg-orange-500/70"
                      : "bg-rose-500/80"
                  )}
                  title={`conf=${chunk.confidence.toFixed(2)}`}
                />
              ))}
            </div>
            <div className="text-[10px] text-zinc-400 w-12 text-right font-mono">
              {(node.uncertainty?.overall ?? 0).toFixed(2)}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-1 text-[10px] text-zinc-500">
      <span>high conf</span>
      <div className="w-2 h-3 bg-emerald-500/80 rounded-sm" />
      <div className="w-2 h-3 bg-amber-500/70 rounded-sm" />
      <div className="w-2 h-3 bg-rose-500/80 rounded-sm" />
      <span>low conf</span>
    </div>
  );
}
