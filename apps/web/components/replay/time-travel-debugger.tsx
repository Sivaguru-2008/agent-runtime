"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useReplaySession } from "@/hooks/use-replay-session";
import { useCognitionGraph } from "@/hooks/use-cognition-graph";
import { cognitionApi, type CognitionNode } from "@/lib/cognition-api";
import { ReplayTimelineScrubber } from "./replay-timeline-scrubber";
import { BranchDivergence } from "./branch-divergence";
import { cn, formatDuration } from "@/lib/utils";

export interface TimeTravelDebuggerProps {
  cognitionId: string;
}

/**
 * Time-Travel Debugger — composes the timeline scrubber, the cognition graph
 * at the cursor, and branch divergence panels. The whole panel re-renders as
 * the scrubber moves.
 */
export function TimeTravelDebugger({ cognitionId }: TimeTravelDebuggerProps) {
  const [sessionId, setSessionId] = useState<string | undefined>();
  const replay = useReplaySession(sessionId);
  const cognition = useCognitionGraph(cognitionId);

  useEffect(() => {
    let cancelled = false;
    cognitionApi
      .createReplaySession(cognitionId)
      .then((session) => {
        if (!cancelled) setSessionId(session.id);
      })
      .catch((err) => {
        console.warn("Failed to create replay session for cognition", cognitionId, err);
      });
    return () => {
      cancelled = true;
    };
  }, [cognitionId]);

  const onSnapshot = useCallback(
    async (frameIndex: number) => {
      if (!sessionId) return;
      try {
        await cognitionApi.snapshotAtFrame(sessionId, frameIndex);
        await replay.refresh();
      } catch (err) {
        console.warn("Failed to create snapshot at frame", frameIndex, err);
      }
    },
    [sessionId, replay]
  );

  const onBranch = useCallback(
    async (frameIndex: number) => {
      if (!sessionId || !cognition.view) return;
      const node = cognition.view.graph.nodes[Math.min(frameIndex, cognition.view.graph.nodes.length - 1)];
      if (!node) return;
      try {
        await cognitionApi.branchFromNode({
          sourceCognitionId: cognitionId,
          sourceNodeId: node.id,
          reason: `manual branch @ frame ${frameIndex}`,
          overrides: { seed: `branch-${Date.now()}` }
        });
        await cognition.refresh();
      } catch (err) {
        console.warn("Failed to branch from node", node.id, err);
      }
    },
    [sessionId, cognition, cognitionId]
  );

  const currentNode = pickNodeAtCursor(cognition.view?.graph.nodes ?? [], replay.session?.cursor.frameIndex ?? 0);

  return (
    <div className="space-y-3">
      <ReplayTimelineScrubber
        session={replay.session}
        onSeek={replay.seek}
        onPlay={replay.play}
        onPause={replay.pause}
        onStep={replay.step}
        onSnapshot={onSnapshot}
        onBranch={onBranch}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card className="p-4 lg:col-span-2 bg-zinc-950/60 border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-zinc-200">Cognition State @ cursor</div>
            <Badge variant="muted">{cognition.view?.graph.phase ?? "—"}</Badge>
          </div>
          {currentNode ? (
            <NodeInspector node={currentNode} />
          ) : (
            <div className="text-xs text-zinc-500">No node at this cursor yet.</div>
          )}
        </Card>

        <BranchDivergence
          sourceCognitionId={cognitionId}
          branches={cognition.view?.branches ?? []}
        />
      </div>
    </div>
  );
}

function pickNodeAtCursor(nodes: CognitionNode[], frameIndex: number): CognitionNode | undefined {
  // Heuristic — pick the most recent node whose sequence ≤ frame cursor.
  let pick: CognitionNode | undefined;
  for (const node of nodes) {
    if (node.sequence <= frameIndex + 1) pick = node;
  }
  return pick ?? nodes[Math.min(frameIndex, nodes.length - 1)];
}

function NodeInspector({ node }: { node: CognitionNode }) {
  const uncertainty = node.uncertainty?.overall ?? 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <KV label="role" value={node.role} />
        <KV label="seq" value={`#${node.sequence}`} />
        <KV label="status" value={node.status} />
        <KV label="duration" value={formatDuration(node.durationMs)} />
        <KV label="uncertainty" value={uncertainty.toFixed(2)} tone={uncertainty > 0.5 ? "error" : "success"} />
        <KV label="influence" value={String(node.memoryInfluence?.length ?? 0)} />
        <KV label="streamed" value={String(node.tokenStream?.length ?? 0)} />
        <KV label="phase" value={node.phase} />
      </div>
      {node.tokenStream && node.tokenStream.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">Token stream</div>
          <div className="flex flex-wrap gap-[2px] text-[10px] font-mono">
            {node.tokenStream.slice(0, 200).map((chunk) => {
              const conf = chunk.confidence;
              return (
                <span
                  key={chunk.sequence}
                  title={`#${chunk.sequence} conf=${conf.toFixed(2)}`}
                  className="px-1 rounded"
                  style={{
                    background:
                      conf > 0.85
                        ? "rgba(16,185,129,0.25)"
                        : conf > 0.6
                        ? "rgba(245,158,11,0.25)"
                        : "rgba(244,63,94,0.35)",
                    color: "#e4e4e7"
                  }}
                >
                  {chunk.text}
                </span>
              );
            })}
          </div>
        </div>
      )}
      {node.memoryInfluence && node.memoryInfluence.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">Memory influence</div>
          <div className="space-y-1">
            {node.memoryInfluence.map((m) => (
              <div key={m.memoryId} className="flex items-center gap-2 text-xs">
                <div className="font-mono text-zinc-400">{m.memoryId.slice(0, 10)}…</div>
                <div className="flex-1 h-1.5 bg-zinc-800 rounded">
                  <div
                    className="h-1.5 bg-fuchsia-500/80 rounded"
                    style={{ width: `${Math.min(100, m.weight * 100)}%` }}
                  />
                </div>
                <div className="text-zinc-500">{(m.weight * 100).toFixed(0)}%</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function KV({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "success" | "warning" | "error" }) {
  return (
    <div className={cn(
      "px-2 py-1 rounded border bg-zinc-900/60",
      tone === "success" && "border-emerald-700",
      tone === "warning" && "border-amber-700",
      tone === "error" && "border-rose-700",
      tone === "neutral" && "border-zinc-800"
    )}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-zinc-200">{value}</div>
    </div>
  );
}
