"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cognitionApi, type BranchPointer, type ReplayDiff } from "@/lib/cognition-api";
import { cn } from "@/lib/utils";

export interface BranchDivergenceProps {
  sourceCognitionId: string;
  branches: BranchPointer[];
}

/**
 * Branch Divergence Visualization — shows all child branches forked from a
 * cognition and the frame at which each branch diverged.
 */
export function BranchDivergence({ sourceCognitionId, branches }: BranchDivergenceProps) {
  const [selected, setSelected] = useState<BranchPointer | undefined>(branches[0]);
  const [diff, setDiff] = useState<ReplayDiff | undefined>();

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    cognitionApi
      .diff(selected.sourceCognitionId, selected.branchCognitionId)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch(() => {
        if (!cancelled) setDiff(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.branchCognitionId]);

  if (branches.length === 0) {
    return (
      <Card className="p-4 bg-zinc-950/60 border-zinc-800">
        <div className="text-sm text-zinc-400">
          No branches yet. Use <span className="text-zinc-200">⑂ branch</span> on the scrubber to fork from any frame.
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-3 bg-zinc-950/60 border-zinc-800">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-zinc-200">Branch Divergence</div>
          <div className="text-xs text-zinc-500">Source · {sourceCognitionId.slice(0, 10)}…</div>
        </div>
        <Badge variant="muted">{branches.length} branches</Badge>
      </div>

      <div className="grid gap-2">
        {branches.map((b) => (
          <button
            key={b.branchCognitionId}
            onClick={() => setSelected(b)}
            className={cn(
              "text-left p-2 rounded border bg-zinc-900/40 hover:bg-zinc-900",
              selected?.branchCognitionId === b.branchCognitionId
                ? "border-fuchsia-500/60"
                : "border-zinc-800"
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-mono text-xs text-zinc-300">{b.branchCognitionId.slice(0, 14)}…</div>
              <Badge variant="muted" className="text-[10px]">frame {b.branchPointFrameIndex}</Badge>
            </div>
            <div className="text-[11px] text-zinc-500 mt-1">
              forked from node {b.sourceNodeId.slice(0, 10)}…
            </div>
          </button>
        ))}
      </div>

      {selected && diff && <DiffRow diff={diff} />}
    </Card>
  );
}

function DiffRow({ diff }: { diff: ReplayDiff }) {
  return (
    <div className="border-t border-zinc-800 pt-3 space-y-2">
      <div className="text-xs font-medium text-zinc-300">Replay Diff</div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
        <Stat label="compared" value={diff.summary.framesCompared} />
        <Stat label="identical" value={diff.summary.framesIdentical} tone="success" />
        <Stat label="diverged" value={diff.summary.framesDiverged} tone="warning" />
        <Stat label="branch-only" value={diff.summary.branchOnlyFrames} tone="info" />
        <Stat
          label="divergence@"
          value={diff.divergenceFrameIndex === null ? "—" : `f${diff.divergenceFrameIndex}`}
          tone="error"
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {diff.deltas.slice(0, 64).map((d) => (
          <div
            key={d.frameIndex}
            title={`${d.frameIndex} ${d.kind}`}
            className={cn(
              "w-3 h-3 rounded-sm",
              d.kind === "IDENTICAL" && "bg-emerald-600/60",
              d.kind === "DIVERGED" && "bg-rose-500/80",
              d.kind === "BRANCH_ONLY" && "bg-fuchsia-500/80",
              d.kind === "SOURCE_ONLY" && "bg-zinc-500/70"
            )}
          />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = "neutral" }: { label: string; value: number | string; tone?: "neutral" | "success" | "warning" | "error" | "info" }) {
  return (
    <div className={cn(
      "px-2 py-1 rounded border bg-zinc-900/40",
      tone === "success" && "border-emerald-700",
      tone === "warning" && "border-amber-700",
      tone === "error" && "border-rose-700",
      tone === "info" && "border-fuchsia-700",
      tone === "neutral" && "border-zinc-800"
    )}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-zinc-200 font-mono">{value}</div>
    </div>
  );
}
