"use client";

import { useMemo } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  Handle,
  type Edge,
  type Node,
  type NodeProps,
  Position
} from "@xyflow/react";
import { AlertTriangle, Brain, GitBranch, Hammer, History, Layers, MessageSquareWarning, Network, Search } from "lucide-react";
import type { ExecutionDetails, GraphNode } from "@/types/observability";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatTime } from "@/lib/utils";
import { statusVariant } from "./status";

const nodeTypes = {
  cognition: CognitionNode
};

export function ExecutionGraph({ details }: { details?: ExecutionDetails }) {
  const { nodes, edges } = useMemo(() => toFlow(details), [details]);

  return (
    <Card className="h-[560px] overflow-hidden">
      <CardHeader>
        <CardTitle>Execution DAG</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="muted">{nodes.length} nodes</Badge>
          <Badge variant="muted">{edges.length} edges</Badge>
        </div>
      </CardHeader>
      <CardContent className="h-[505px] p-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.35}
          maxZoom={1.4}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} size={1} />
          <MiniMap pannable zoomable nodeStrokeWidth={3} />
          <Controls position="bottom-right" />
        </ReactFlow>
      </CardContent>
    </Card>
  );
}

function CognitionNode({ data }: NodeProps<Node<CognitionNodeData>>) {
  const Icon = iconFor(data.kind);
  const intensity = Math.max(0, Math.min(1, data.reasoningIntensity ?? 0));
  return (
    <div className={cn("w-56 rounded-md border bg-card shadow-panel", borderFor(data.kind, data.severity, intensity))}>
      <Handle type="target" position={Position.Left} className="!border-border !bg-primary" />
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon className={cn("h-4 w-4", colorFor(data.kind, data.severity, intensity))} />
        <div className="min-w-0 flex-1 truncate text-xs font-semibold">{data.label}</div>
        {data.severity ? <Badge variant={statusVariant(data.severity)}>{data.severity}</Badge> : null}
      </div>
      <div className="space-y-2 px-3 py-2">
        <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground">
          <span>{formatTime(data.timestamp)}</span>
          {data.reasoningIntensity !== undefined ? (
            <span>{Math.round(intensity * 100)}% heat</span>
          ) : null}
        </div>
        {data.reasoningIntensity !== undefined ? (
          <div className="h-1 overflow-hidden rounded-sm bg-muted">
            <div
              className={cn("h-1 rounded-sm", intensity > 0.66 ? "bg-critical" : intensity > 0.33 ? "bg-warning" : "bg-primary")}
              style={{ width: `${Math.max(4, intensity * 100)}%` }}
            />
          </div>
        ) : null}
        {data.totalTokens || data.durationMs ? (
          <div className="grid grid-cols-2 gap-2 font-mono text-[10px] text-muted-foreground">
            <span>{data.totalTokens ?? 0} tok</span>
            <span>{data.durationMs ?? 0} ms</span>
          </div>
        ) : null}
        <div className="line-clamp-3 text-xs text-muted-foreground">{data.summary}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!border-border !bg-primary" />
    </div>
  );
}

interface CognitionNodeData extends Record<string, unknown> {
  kind: string;
  label: string;
  timestamp?: string;
  severity?: "info" | "warning" | "critical";
  summary: string;
  reasoningIntensity?: number;
  durationMs?: number;
  totalTokens?: number;
}

function toFlow(details?: ExecutionDetails): { nodes: Node<CognitionNodeData>[]; edges: Edge[] } {
  if (!details) return { nodes: [], edges: [] };

  const nodes = details.graph.nodes.map((node, index) => ({
    id: node.id,
    type: "cognition",
    position: {
      x: (index % 4) * 300,
      y: Math.floor(index / 4) * 180 + (node.type === "OBSERVABILITY_WARNING" ? 70 : 0)
    },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      kind: node.type,
      label: node.label,
      timestamp: node.timestamp,
      severity: node.severity,
      summary: summarizeNode(node),
      reasoningIntensity: node.metadata?.reasoningIntensity,
      durationMs: node.metadata?.durationMs,
      totalTokens: node.metadata?.totalTokens
    }
  }));

  const edges = details.graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    animated: edge.label === "warns",
    style: {
      stroke: edge.label === "warns" ? "hsl(var(--warning))" : "rgba(148, 163, 184, 0.7)"
    }
  }));

  return { nodes, edges };
}

function summarizeNode(node: GraphNode) {
  if (node.type === "OBSERVABILITY_WARNING") {
    const data = node.data as { description?: string } | undefined;
    return data?.description ?? "Structured warning emitted by analysis engine.";
  }
  const raw = JSON.stringify(node.data ?? {});
  return raw.length > 180 ? `${raw.slice(0, 180)}...` : raw;
}

function iconFor(kind: string) {
  const normalized = kind.toLowerCase();
  if (normalized.includes("planning")) return Brain;
  if (normalized.includes("memory")) return Search;
  if (normalized.includes("tool")) return Hammer;
  if (normalized.includes("retry")) return History;
  if (normalized.includes("warning") || normalized.includes("hallucination")) return MessageSquareWarning;
  if (normalized.includes("subagent")) return GitBranch;
  if (normalized.includes("model")) return Layers;
  if (normalized.includes("execution")) return Network;
  return AlertTriangle;
}

function colorFor(kind: string, severity?: string, intensity = 0) {
  if (severity === "critical") return "text-critical";
  if (severity === "warning") return "text-warning";
  if (intensity > 0.66) return "text-critical";
  if (intensity > 0.33) return "text-warning";
  if (kind.toLowerCase().includes("memory")) return "text-emerald-300";
  if (kind.toLowerCase().includes("tool")) return "text-sky-300";
  return "text-primary";
}

function borderFor(kind: string, severity?: string, intensity = 0) {
  if (severity === "critical") return "border-critical/50";
  if (severity === "warning") return "border-warning/50";
  if (intensity > 0.66) return "border-critical/45";
  if (intensity > 0.33) return "border-warning/45";
  if (kind.toLowerCase().includes("memory")) return "border-emerald-400/40";
  if (kind.toLowerCase().includes("tool")) return "border-sky-400/40";
  return "border-border";
}
