"use client";

import { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react";
import { AlertOctagon, CheckCircle2, MessageSquare, Play, Radio, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn, formatTime } from "@/lib/utils";
import type { LiveExecutionView } from "@/stores/execution-store";
import "@xyflow/react/dist/style.css";

interface NodeData extends Record<string, unknown> {
  label: string;
  kind: "PROMPT" | "MODEL_START" | "STREAM" | "COMPLETE" | "ERROR";
  timestamp: string;
  detail: string;
}

const nodeTypes = { live: LiveNode };

export function LiveExecutionGraph({ view }: { view?: LiveExecutionView }) {
  const { nodes, edges } = useMemo(() => buildGraph(view), [view]);

  return (
    <Card className="h-[420px] overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-primary" />
          Live Execution Graph
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="muted">{nodes.length} nodes</Badge>
          <Badge variant="muted">{edges.length} edges</Badge>
        </div>
      </CardHeader>
      <CardContent className="h-[365px] p-0">
        {nodes.length > 0 ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.5}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} size={1} />
            <MiniMap pannable zoomable nodeStrokeWidth={3} />
            <Controls position="bottom-right" />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Run a prompt to build the live execution graph.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function buildGraph(view?: LiveExecutionView): { nodes: Node<NodeData>[]; edges: Edge[] } {
  if (!view) return { nodes: [], edges: [] };

  const out: Node<NodeData>[] = [];
  const edges: Edge[] = [];
  const baseY = 60;
  const stepX = 240;
  const push = (id: string, kind: NodeData["kind"], label: string, detail: string, timestamp: string) => {
    out.push({
      id,
      type: "live",
      position: { x: stepX * out.length, y: baseY },
      data: { label, kind, timestamp, detail },
      sourcePosition: Position.Right,
      targetPosition: Position.Left
    });
  };

  let promptEvent = view.events.find((e) => e.type === "PROMPT_RECEIVED");
  if (!promptEvent && view.prompt) {
    promptEvent = {
      type: "PROMPT_RECEIVED",
      executionId: view.id,
      timestamp: view.startedAt,
      sequence: 0,
      prompt: view.prompt,
      model: view.model
    };
  }
  if (promptEvent && promptEvent.type === "PROMPT_RECEIVED") {
    push("prompt", "PROMPT", "Prompt Received", truncate(promptEvent.prompt, 80), promptEvent.timestamp);
  }

  const startEvent = view.events.find((e) => e.type === "MODEL_START");
  if (startEvent && startEvent.type === "MODEL_START") {
    push("model-start", "MODEL_START", "Model Start", startEvent.model, startEvent.timestamp);
  }

  const tokenCount = view.events.filter((e) => e.type === "TOKEN_STREAM").length;
  if (tokenCount > 0) {
    push(
      "stream",
      "STREAM",
      "Token Stream",
      `${tokenCount} tokens · ${view.tokensPerSecond.toFixed(1)} tok/s`,
      view.firstTokenAt ?? view.startedAt
    );
  }

  const completeEvent = view.events.find((e) => e.type === "MODEL_COMPLETE");
  if (completeEvent && completeEvent.type === "MODEL_COMPLETE") {
    push(
      "complete",
      "COMPLETE",
      "Completion",
      `${completeEvent.totalTokens} tok · ${completeEvent.latencyMs} ms`,
      completeEvent.timestamp
    );
  }

  const errorEvent = view.events.find((e) => e.type === "MODEL_ERROR");
  if (errorEvent && errorEvent.type === "MODEL_ERROR") {
    push("error", "ERROR", "Model Error", errorEvent.message, errorEvent.timestamp);
  }

  for (let i = 1; i < out.length; i += 1) {
    edges.push({
      id: `edge-${i}`,
      source: out[i - 1]!.id,
      target: out[i]!.id,
      animated: true,
      style: { stroke: "rgba(148,163,184,0.7)" }
    });
  }

  return { nodes: out, edges };
}

function LiveNode({ data }: NodeProps<Node<NodeData>>) {
  const Icon = iconFor(data.kind);
  const border = borderFor(data.kind);
  const color = colorFor(data.kind);
  return (
    <div className={cn("w-56 rounded-md border bg-card shadow-panel", border)}>
      <Handle type="target" position={Position.Left} className="!border-border !bg-primary" />
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon className={cn("h-4 w-4", color)} />
        <div className="min-w-0 flex-1 truncate text-xs font-semibold">{data.label}</div>
      </div>
      <div className="space-y-2 px-3 py-2">
        <div className="font-mono text-[11px] text-muted-foreground">{formatTime(data.timestamp)}</div>
        <div className="line-clamp-3 break-words text-xs text-muted-foreground">{data.detail}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!border-border !bg-primary" />
    </div>
  );
}

function iconFor(kind: NodeData["kind"]) {
  switch (kind) {
    case "PROMPT": return MessageSquare;
    case "MODEL_START": return Play;
    case "STREAM": return Zap;
    case "COMPLETE": return CheckCircle2;
    case "ERROR": return AlertOctagon;
  }
}

function borderFor(kind: NodeData["kind"]) {
  switch (kind) {
    case "PROMPT": return "border-sky-400/40";
    case "MODEL_START": return "border-primary/40";
    case "STREAM": return "border-warning/40";
    case "COMPLETE": return "border-emerald-400/40";
    case "ERROR": return "border-critical/40";
  }
}

function colorFor(kind: NodeData["kind"]) {
  switch (kind) {
    case "PROMPT": return "text-sky-300";
    case "MODEL_START": return "text-primary";
    case "STREAM": return "text-warning";
    case "COMPLETE": return "text-emerald-300";
    case "ERROR": return "text-critical";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
