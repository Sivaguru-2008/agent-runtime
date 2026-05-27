"use client";

import { useMemo } from "react";
import { Background, Controls, Handle, ReactFlow, type Edge, type Node, type NodeProps, Position } from "@xyflow/react";
import { Boxes, GitFork } from "lucide-react";
import type { Topology } from "@/types/observability";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { statusVariant } from "./status";

const nodeTypes = {
  topology: TopologyNode
};

export function MultiAgentTopology({ topology }: { topology?: Topology }) {
  const { nodes, edges } = useMemo(() => toFlow(topology), [topology]);

  return (
    <Card className="h-[420px] overflow-hidden">
      <CardHeader>
        <CardTitle>Coordination View</CardTitle>
        <Badge variant="muted">{edges.length} links</Badge>
      </CardHeader>
      <CardContent className="h-[365px] p-0">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView proOptions={{ hideAttribution: true }}>
          <Background gap={22} size={1} />
          <Controls position="bottom-right" />
        </ReactFlow>
      </CardContent>
    </Card>
  );
}

function TopologyNode({ data }: NodeProps<Node<{ label: string; type: string; status?: string; congestion?: number; isBottleneck?: boolean }>>) {
  const Icon = data.type === "agent" ? Boxes : GitFork;
  const bottleneck = data.isBottleneck;
  return (
    <div className={cn(
      "w-48 rounded-md border border-border bg-card px-3 py-2 shadow-panel",
      data.type === "agent" ? "border-primary/40" : "",
      bottleneck ? "border-critical/60" : ""
    )}>
      <Handle type="target" position={Position.Left} className="!border-border !bg-primary" />
      <div className="flex items-center gap-2">
        <Icon className={data.type === "agent" ? "h-4 w-4 text-primary" : "h-4 w-4 text-sky-300"} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{data.label}</span>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="font-mono text-[11px] text-muted-foreground">{data.type}</span>
        <Badge variant={statusVariant(data.status)}>{data.status ?? "unknown"}</Badge>
      </div>
      {data.congestion !== undefined ? (
        <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
          <span>load {data.congestion.toFixed(1)}</span>
          {bottleneck ? <Badge variant="critical">bottleneck</Badge> : null}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} className="!border-border !bg-primary" />
    </div>
  );
}

function toFlow(topology?: Topology): { nodes: Node[]; edges: Edge[] } {
  if (!topology) return { nodes: [], edges: [] };

  const nodes = topology.nodes.map((node, index) => ({
    id: node.id,
    type: "topology",
    position: {
      x: node.type === "agent" ? 0 : 260 + (index % 3) * 230,
      y: node.type === "agent" ? index * 110 : Math.floor(index / 3) * 120
    },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      label: node.label,
      type: node.type,
      status: node.status,
      congestion: node.pressure?.congestion,
      isBottleneck: node.pressure?.isBottleneck
    }
  }));

  const edges = topology.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    animated: edge.label === "replay branch",
    style: { stroke: edge.label === "replay branch" ? "hsl(var(--primary))" : "rgba(148, 163, 184, 0.65)" }
  }));

  return { nodes, edges };
}
