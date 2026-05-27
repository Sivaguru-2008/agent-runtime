"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cognitionApi, type CognitionListItem } from "@/lib/cognition-api";
import { useCognitionGraph } from "@/hooks/use-cognition-graph";
import { CognitionGraphView } from "./cognition-graph";
import { UncertaintyHeatmap } from "./uncertainty-heatmap";
import { MemoryInfluenceGraph } from "./memory-influence-graph";
import { FailureIntelligencePanel } from "./failure-intelligence-panel";
import { TokenStreamOverlay } from "./token-stream-overlay";
import { TimeTravelDebugger } from "@/components/replay/time-travel-debugger";
import { cn, formatTime } from "@/lib/utils";

export interface CognitionWorkbenchProps {
  agents: Array<{ id: string; name: string; goal: string }>;
}

/**
 * Cognition Workbench — single-pane workbench combining:
 *  - cognition list
 *  - cognition graph (animated)
 *  - token stream overlay
 *  - uncertainty heatmap
 *  - memory influence graph
 *  - failure intelligence
 *  - time-travel replay debugger
 */
export function CognitionWorkbench({ agents }: CognitionWorkbenchProps) {
  const [cognitions, setCognitions] = useState<CognitionListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [isStarting, setIsStarting] = useState(false);
  const { view, failureReport, influence, refresh } = useCognitionGraph(selectedId);

  useEffect(() => {
    void loadList();
    const interval = setInterval(() => void loadList(), 5000);
    return () => clearInterval(interval);
  }, []);

  const loadList = async () => {
    try {
      const list = await cognitionApi.list(20);
      setCognitions(list);
      if (!selectedId && list[0]) setSelectedId(list[0].id);
    } catch {
      // silently retry next tick
    }
  };

  const startCognition = async () => {
    const agent = agents[0];
    if (!agent) return;
    setIsStarting(true);
    try {
      const graph = await cognitionApi.startCognition({
        agentId: agent.id,
        goal: agent.goal || "Run an observability cognition cycle",
        task: { prompt: "Investigate recent runtime anomalies and propose a plan" }
      });
      await loadList();
      setSelectedId(graph.id);
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[280px_1fr] gap-3 min-h-[60vh]">
      <Card className="p-3 bg-zinc-950/60 border-zinc-800 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-zinc-200">Durable Runloops</div>
          <Button size="sm" onClick={startCognition} disabled={isStarting || agents.length === 0}>
            {isStarting ? "starting…" : "+ run"}
          </Button>
        </div>
        <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
          {cognitions.length === 0 && (
            <div className="text-xs text-zinc-500 py-2">No runloops yet — click <span className="text-zinc-300">+ run</span>.</div>
          )}
          {cognitions.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={cn(
                "w-full text-left rounded border bg-zinc-900/40 p-2 hover:bg-zinc-900",
                selectedId === c.id ? "border-amber-500/60" : "border-zinc-800"
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] text-zinc-300">{c.id.slice(0, 12)}…</span>
                <Badge variant="muted" className="text-[9px]">{c.phase}</Badge>
              </div>
              <div className="text-[10px] text-zinc-500 mt-1 flex items-center justify-between">
                <span>{c.nodeCount} nodes</span>
                <span suppressHydrationWarning>{formatTime(c.startedAt)}</span>
              </div>
              {c.hasFailureSignals && (
                <div className="text-[10px] text-rose-400 mt-0.5">⚠ failures</div>
              )}
              {c.parentCognitionId && (
                <div className="text-[10px] text-fuchsia-400 mt-0.5">↳ branch</div>
              )}
            </button>
          ))}
        </div>
      </Card>

      <div className="space-y-3">
        {!view && (
          <Card className="p-6 bg-zinc-950/60 border-zinc-800 text-sm text-zinc-400">
            Select a runloop or click <span className="text-zinc-200">+ run</span> to start one.
          </Card>
        )}
        {view && (
          <Tabs defaultValue="graph">
            <TabsList>
              <TabsTrigger value="graph">Durable Execution Graph</TabsTrigger>
              <TabsTrigger value="timetravel">Time-Travel Replay</TabsTrigger>
              <TabsTrigger value="memory">Cognitive Memory Influence</TabsTrigger>
              <TabsTrigger value="failure">Self-Healing Diagnostics</TabsTrigger>
            </TabsList>

            <TabsContent value="graph" className="space-y-3">
              <CognitionGraphView graph={view.graph} onNodeClick={() => undefined} />
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <UncertaintyHeatmap graph={view.graph} />
                <TokenStreamOverlay cognitionId={view.graph.id} />
              </div>
            </TabsContent>

            <TabsContent value="timetravel">
              <TimeTravelDebugger cognitionId={view.graph.id} />
            </TabsContent>

            <TabsContent value="memory">
              {influence ? (
                <MemoryInfluenceGraph influence={influence} />
              ) : (
                <Card className="p-4 bg-zinc-950/60 border-zinc-800 text-sm text-zinc-500">
                  No memory influence recorded.
                </Card>
              )}
            </TabsContent>

            <TabsContent value="failure" className="space-y-3">
              <FailureIntelligencePanel report={failureReport} />
              <Card className="p-4 bg-zinc-950/60 border-zinc-800 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-zinc-200">Raw signals</div>
                  <Badge variant="muted">{view.failureSignals.length}</Badge>
                </div>
                <div className="space-y-1 max-h-72 overflow-y-auto">
                  {view.failureSignals.map((s) => (
                    <div key={s.id} className="text-xs text-zinc-400 border-t border-zinc-800/60 pt-1">
                      <span className="font-mono text-zinc-500 mr-2">{s.kind}</span>
                      <span>{s.summary}</span>
                    </div>
                  ))}
                  {view.failureSignals.length === 0 && (
                    <div className="text-xs text-zinc-600">No failure signals raised.</div>
                  )}
                </div>
              </Card>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
