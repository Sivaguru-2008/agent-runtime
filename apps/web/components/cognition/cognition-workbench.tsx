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
import { ExecutionMetadataPanel } from "@/components/ui/execution-metadata-panel";
import type { CognitionNode } from "@/lib/cognition-api";
import { cn, formatTime } from "@/lib/utils";
import { ExplainLabel } from "@/components/explain/explain-label";
import { ExplainedEmptyState } from "@/components/explain/empty-state";
import { RunNarration } from "@/components/explain/run-narration";

/** Map a cognition graph's overall phase to a plain-language run outcome. */
function cognitionOutcome(phase?: string): "running" | "completed" | "failed" | "unknown" {
  if (phase === "COMPLETE") return "completed";
  if (phase === "FAILED") return "failed";
  if (phase === "INIT" || phase === "PLAN" || phase === "EXECUTE" || phase === "VERIFY" || phase === "CRITIQUE" || phase === "MEMORY_COMMIT") {
    return "running";
  }
  return "unknown";
}

/** Collect narration signals from a cognition graph's node roles + phases. */
function cognitionSignals(nodes: CognitionNode[]): string[] {
  const signals: string[] = [];
  for (const node of nodes) {
    if (node.role) signals.push(node.role);
    if (node.phase) signals.push(node.phase);
  }
  return signals;
}

/** A run is real-LLM if any node was produced by a model-backed role. */
function cognitionMode(nodes: CognitionNode[]): string {
  return nodes?.some((n) => (n.output as Record<string, unknown> | undefined)?.modelBacked)
    ? "MODEL-BACKED"
    : "DETERMINISTIC";
}

export interface CognitionWorkbenchProps {
  agents: Array<{ id: string; name: string; goal: string }>;
  /** Shared console prompt entered in the Playground. Run Studio runs this same
   *  prompt — it has no prompt box of its own. */
  prompt?: string;
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
export function CognitionWorkbench({ agents, prompt = "" }: CognitionWorkbenchProps) {
  const [cognitions, setCognitions] = useState<CognitionListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { view, failureReport, influence, refresh } = useCognitionGraph(selectedId);

  // Read-only refresh of the runloop list. Critically this does NOT create or
  // auto-start anything — runs only ever begin when the operator submits a
  // prompt below. It also no longer auto-selects the first item, so opening the
  // tab never makes it look like a run was created on your behalf.
  useEffect(() => {
    void loadList();
    const interval = setInterval(() => void loadList(), 5000);
    return () => clearInterval(interval);
  }, []);

  const loadList = async () => {
    try {
      const list = await cognitionApi.list(20);
      setCognitions(list);
    } catch {
      // silently retry next tick
    }
  };

  // A run is created ONLY here, on explicit prompt submission. The prompt the
  // operator types becomes the cognition goal + task — nothing is hardcoded and
  // nothing runs until there is a prompt and a target agent.
  const startCognition = async () => {
    const trimmed = prompt.trim();
    const agent = agents[0];
    if (!trimmed) {
      setError("Enter a prompt in the Playground first.");
      return;
    }
    if (!agent) {
      setError("No agent available — run a Playground prompt (or Run Trace) once to provision an agent.");
      return;
    }
    setError(undefined);
    setIsStarting(true);
    try {
      const graph = await cognitionApi.startCognition({
        agentId: agent.id,
        goal: trimmed,
        task: { prompt: trimmed }
      });
      await loadList();
      setSelectedId(graph.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run.");
    } finally {
      setIsStarting(false);
    }
  };

  const trimmedPrompt = prompt.trim();
  const canRun = trimmedPrompt.length > 0 && agents.length > 0 && !isStarting;

  return (
    <div className="space-y-3">
      {/* No prompt box here — Run Studio reuses the prompt entered in the
          Playground. It only shows that active prompt and runs it on demand. */}
      <Card className="p-3 bg-zinc-950/60 border-zinc-800 space-y-2">
        <div className="flex items-center justify-between">
          <ExplainLabel concept="durable-run-studio" as="span" className="text-sm font-medium text-zinc-200">
            Run Studio — active prompt
          </ExplainLabel>
          <span className="text-[11px] text-zinc-500">
            {agents.length > 0 ? `agent: ${agents[0].name}` : "no agent available"}
          </span>
        </div>
        <div className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm min-h-[40px]">
          {trimmedPrompt ? (
            <span className="text-zinc-200">{trimmedPrompt}</span>
          ) : (
            <ExplainedEmptyState concept="playground" className="border-0 bg-transparent px-2 py-3" />
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-zinc-600">
            Plans → executes → verifies the Playground prompt as a durable runloop.
          </span>
          <Button size="sm" onClick={startCognition} disabled={!canRun}>
            {isStarting ? "running…" : "Run"}
          </Button>
        </div>
        {error && (
          <div className="rounded border border-rose-800/50 bg-rose-950/20 px-2 py-1.5 text-[11px] text-rose-300">
            {error}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-[280px_1fr] gap-3 min-h-[60vh]">
      <Card className="p-3 bg-zinc-950/60 border-zinc-800 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-zinc-200">Durable Runloops</div>
          <span className="text-[10px] text-zinc-500">{cognitions.length}</span>
        </div>
        <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
          {cognitions.length === 0 && (
            <ExplainedEmptyState
              concept="durable-run-studio"
              title="No runloops yet"
              body="Submit a prompt above to start one. Each durable runloop appears here, ready to inspect, replay, and debug."
              className="px-3 py-5"
            />
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
          <ExecutionMetadataPanel
            cognitionId={view.graph.id}
            executionId={view.graph.executionId}
            runId={view.graph.executionId}
            traceId={view.traceId ?? view.graph.traceId}
            runtimeId={view.runtimeId}
            status={view.graph.phase}
            mode={cognitionMode(view.graph.nodes)}
            title="Run Studio — Active Runloop"
          />
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
              {/* Layer 4 — the run told as a plain-language story before the
                  technical graph. Signals come from the cognition node roles
                  and phases; outcome from the graph's overall phase. */}
              <RunNarration
                signals={cognitionSignals(view.graph.nodes)}
                outcome={cognitionOutcome(view.graph.phase)}
              />
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
                <ExplainedEmptyState concept="memory-influence" />
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
                    <ExplainedEmptyState concept="self-healing-diagnostics" />
                  )}
                </div>
              </Card>
            </TabsContent>
          </Tabs>
        )}
      </div>
      </div>
    </div>
  );
}
