"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { CognitionGraph, CognitionNode, AgentRole } from "@/lib/cognition-api";
import { cn } from "@/lib/utils";

const ROLE_COLOR: Record<AgentRole, string> = {
  PLANNER: "from-sky-500/40 to-sky-500/10 border-sky-500/50",
  EXECUTOR: "from-emerald-500/40 to-emerald-500/10 border-emerald-500/50",
  VERIFIER: "from-amber-500/40 to-amber-500/10 border-amber-500/50",
  CRITIC: "from-fuchsia-500/40 to-fuchsia-500/10 border-fuchsia-500/50",
  MEMORY_MANAGER: "from-cyan-500/40 to-cyan-500/10 border-cyan-500/50"
};

const ROLE_GLYPH: Record<AgentRole, string> = {
  PLANNER: "◆",
  EXECUTOR: "▶",
  VERIFIER: "✓",
  CRITIC: "✦",
  MEMORY_MANAGER: "▣"
};

export interface CognitionGraphViewProps {
  graph: CognitionGraph;
  activeNodeId?: string;
  onNodeClick?: (node: CognitionNode) => void;
}

/**
 * Animated multi-agent cognition graph.
 *
 * Lays out nodes by sequence on a left-to-right rail, draws handoff edges
 * between roles, and pulses the currently-running node. Uses pure CSS
 * animation — no heavy graph library, deterministic layout.
 */
export function CognitionGraphView({ graph, activeNodeId, onNodeClick }: CognitionGraphViewProps) {
  const nodes = useMemo(() => [...graph.nodes].sort((a, b) => a.sequence - b.sequence), [graph.nodes]);
  const handoffEdges = useMemo(() => {
    const edges: Array<{ from: string; to: string; reason: string }> = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({ from: nodes[i].id, to: nodes[i + 1].id, reason: "next" });
    }
    for (const h of graph.handoffs) edges.push({ from: h.fromNodeId, to: "", reason: h.reason });
    return edges;
  }, [nodes, graph.handoffs]);

  return (
    <Card className="p-4 bg-zinc-950/60 border-zinc-800">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm font-medium text-zinc-200">Cognition Graph</div>
          <div className="text-xs text-zinc-500">{graph.id.slice(0, 12)}… · {graph.nodes.length} nodes</div>
        </div>
        <Badge variant="muted">{graph.phase}</Badge>
      </div>

      <div className="relative overflow-x-auto">
        <div className="flex items-stretch gap-3 min-w-max">
          {nodes.map((node, idx) => {
            const isActive = node.id === activeNodeId;
            const isRunning = node.status === "RUNNING";
            return (
              <div key={node.id} className="flex items-center">
                <button
                  onClick={() => onNodeClick?.(node)}
                  className={cn(
                    "relative w-44 rounded-lg border bg-gradient-to-br p-3 text-left transition-all",
                    ROLE_COLOR[node.role],
                    isActive && "ring-2 ring-amber-400 scale-[1.02]",
                    isRunning && "animate-pulse"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-zinc-100">
                      {ROLE_GLYPH[node.role]} {node.role}
                    </span>
                    <span className="text-[10px] text-zinc-300">#{node.sequence}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-300/90 uppercase tracking-wide">
                    {node.phase}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-400">
                    {node.status === "COMPLETED" ? "✓ done" : node.status.toLowerCase()}
                  </div>
                  {node.uncertainty && (
                    <div className="mt-2 h-1 bg-zinc-800 rounded overflow-hidden">
                      <div
                        className={cn(
                          "h-full transition-all",
                          node.uncertainty.overall < 0.3 ? "bg-emerald-500" :
                            node.uncertainty.overall < 0.55 ? "bg-amber-500" :
                            "bg-rose-500"
                        )}
                        style={{ width: `${Math.min(100, node.uncertainty.overall * 100)}%` }}
                      />
                    </div>
                  )}
                  {node.replayedFromNodeId && (
                    <div className="mt-1 text-[10px] text-fuchsia-300">replayed</div>
                  )}
                </button>
                {idx < nodes.length - 1 && (
                  <div className="w-6 h-[2px] bg-gradient-to-r from-zinc-600 to-zinc-700 mx-1 relative">
                    <div className="absolute -right-1 -top-1 w-2 h-2 rotate-45 border-r border-t border-zinc-500" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {graph.handoffs.length > 0 && (
        <div className="mt-3 text-xs text-zinc-500">
          {graph.handoffs.length} handoff{graph.handoffs.length === 1 ? "" : "s"}:
          <span className="text-zinc-400 ml-2">
            {graph.handoffs.map((h) => h.toRole).join(" → ")}
          </span>
        </div>
      )}
    </Card>
  );
}
