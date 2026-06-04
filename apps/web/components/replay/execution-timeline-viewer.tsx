"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  cognitionApi,
  CognitionApiError,
  type AnnotatedFrame,
  type FailureTimeline,
  type FailureSignal,
  type NamedCheckpoint,
} from "@/lib/cognition-api";
import { cn, formatTime } from "@/lib/utils";
import { ExplainedEmptyState } from "@/components/explain/empty-state";
import {
  AlertTriangle,
  Crosshair,
  GitBranch,
  ShieldCheck,
  Database,
  Save, 
  RotateCw, 
  CheckCircle, 
  ShieldAlert, 
  Cpu, 
  HelpCircle, 
  Activity, 
  Server, 
  Clock, 
  ArrowRight,
  Split,
  ChevronRight,
  TrendingDown
} from "lucide-react";

export interface ExecutionTimelineViewerProps {
  cognitionId: string;
  onSeekToFrame?: (frameIndex: number) => void;
  onBranchFromFrame?: (frameIndex: number) => void;
  activeFrameIndex?: number;
}

// Causal theme states following Phase 2 semantic guidelines
const CAUSAL_COLORS: Record<AnnotatedFrame["causalRole"], string> = {
  ROOT_CAUSE: "bg-rose-500 hover:bg-rose-400 border border-rose-600 shadow-[0_0_8px_rgba(244,63,94,0.15)]",
  PROPAGATION: "bg-amber-500 hover:bg-amber-400 border border-amber-600",
  TERMINAL: "bg-blue-500 hover:bg-blue-400 border border-blue-600 shadow-[0_0_8px_rgba(59,130,246,0.15)]",
  CLEAN: "bg-zinc-700/60 hover:bg-zinc-600/70 border border-zinc-800",
};

const CAUSAL_BADGE_COLORS: Record<AnnotatedFrame["causalRole"], string> = {
  ROOT_CAUSE: "bg-rose-950/40 text-rose-300 border-rose-800/60",
  PROPAGATION: "bg-amber-950/40 text-amber-300 border-amber-800/60",
  TERMINAL: "bg-blue-950/40 text-blue-300 border-blue-800/60",
  CLEAN: "bg-zinc-900 text-zinc-400 border-zinc-800",
};

const SEVERITY_DOT: Record<string, string> = {
  CRITICAL: "bg-rose-500",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-amber-500",
  LOW: "bg-zinc-500",
  INFO: "bg-blue-500",
};

// Phase/role coloring for CLEAN frames. A healthy run carries no failure roles,
// so without this every tile is the same grey ("looks the same for every id").
// Coloring clean frames by the agent phase that produced them surfaces each
// run's real PLAN → EXECUTE → VERIFY → CRITIQUE → MEMORY structure.
type PhaseKey = "PLANNER" | "EXECUTOR" | "VERIFIER" | "CRITIC" | "MEMORY" | "SYSTEM";

const PHASE_COLORS: Record<PhaseKey, string> = {
  PLANNER: "bg-sky-600/70 hover:bg-sky-500/80 border border-sky-700",
  EXECUTOR: "bg-emerald-600/70 hover:bg-emerald-500/80 border border-emerald-700",
  VERIFIER: "bg-amber-600/70 hover:bg-amber-500/80 border border-amber-700",
  CRITIC: "bg-fuchsia-600/70 hover:bg-fuchsia-500/80 border border-fuchsia-700",
  MEMORY: "bg-cyan-600/70 hover:bg-cyan-500/80 border border-cyan-700",
  SYSTEM: "bg-zinc-700/60 hover:bg-zinc-600/70 border border-zinc-800",
};

const PHASE_LABELS: Record<PhaseKey, string> = {
  PLANNER: "plan",
  EXECUTOR: "execute",
  VERIFIER: "verify",
  CRITIC: "critique",
  MEMORY: "memory",
  SYSTEM: "system",
};

function phaseKeyForFrame(frame: AnnotatedFrame): PhaseKey {
  const hay = `${frame.label ?? ""} ${frame.eventType ?? ""}`.toUpperCase();
  if (hay.includes("PLANNER")) return "PLANNER";
  if (hay.includes("EXECUTOR")) return "EXECUTOR";
  if (hay.includes("VERIFIER")) return "VERIFIER";
  if (hay.includes("CRITIC")) return "CRITIC";
  if (hay.includes("MEMORY")) return "MEMORY";
  return "SYSTEM";
}

// Color a tile by failure role when it carries signals; otherwise by phase.
function tileColor(frame: AnnotatedFrame): string {
  return frame.causalRole === "CLEAN"
    ? PHASE_COLORS[phaseKeyForFrame(frame)]
    : CAUSAL_COLORS[frame.causalRole];
}

// Show at most this many frame tiles before virtualizing
const TILE_WINDOW = 200;

// Honest, data-driven event description. Maps the REAL runtime event type
// (and the frame's own label) to accurate text — no fabricated business
// narrative. Every field is derived from the actual frame, so the description
// differs per cognition instead of repeating a fixed story.
function translateEvent(eventType: string, label?: string): { title: string; subtitle: string; description: string; explain: string; icon: any; stateColor: "nominal" | "warning" | "incident" | "recovery" | "replay" } {
  const t = (eventType || "").toUpperCase();
  const human = humanizeEventType(t);
  const detail = label && label.trim().length > 0 ? label.trim() : undefined;

  // Failure / abort family.
  if (t.includes("FAILED") || t.includes("FENCE_REJECTED") || t.includes("ABORTED")) {
    return {
      title: detail ? `${human} — ${detail}` : human,
      subtitle: eventType,
      description: `A failure was recorded at this frame${detail ? ` (${detail})` : ""}. Inspect the failure-intelligence signals below for the originating cause.`,
      explain: "This frame carries a terminal or fenced state. The runtime records it in the event log so the exact failure point is replayable.",
      icon: ShieldAlert,
      stateColor: "incident"
    };
  }
  // Recovery / retry / replay family.
  if (t.includes("RECOVERY") || t.includes("RETRY") || t.includes("REPLAY") || t.includes("RESUMED") || t.includes("RECLAIMED") || t.includes("RESTORED")) {
    return {
      title: detail ? `${human} — ${detail}` : human,
      subtitle: eventType,
      description: "A recovery/replay transition was recorded — the runtime re-derived state from a durable checkpoint or re-ran a step under a fresh lease.",
      explain: "Recovery frames mark where the self-healing orchestrator resumed work without repeating already-committed side-effects.",
      icon: RotateCw,
      stateColor: "recovery"
    };
  }
  // Completion family.
  if (t.includes("COMPLETED") || t.includes("SUCCEEDED")) {
    return {
      title: detail ? `${human} — ${detail}` : human,
      subtitle: eventType,
      description: `Step completed successfully${detail ? `: ${detail}` : ""}. State committed to the event log.`,
      explain: "Completed frames are sealed in the event-sourced record and skipped on replay.",
      icon: CheckCircle,
      stateColor: "nominal"
    };
  }
  // Checkpoint family.
  if (t.includes("CHECKPOINT") || t.includes("SNAPSHOT") || t.includes("SAVEPOINT")) {
    return {
      title: detail ? `${human} — ${detail}` : human,
      subtitle: eventType,
      description: "A durable savepoint of the cognition state was written, enabling resume-from-here on recovery.",
      explain: "Checkpoints capture the materialized graph + cursor so replay can hydrate exact state without re-running prior steps.",
      icon: Save,
      stateColor: "recovery"
    };
  }
  // Tool / model family.
  if (t.includes("TOOL")) {
    return {
      title: detail ? `Tool: ${detail}` : human,
      subtitle: eventType,
      description: `An external tool call was recorded${detail ? ` (${detail})` : ""}.`,
      explain: "Tool calls are side-effects; the runtime fences them so a replay cannot double-execute.",
      icon: Cpu,
      stateColor: "replay"
    };
  }
  if (t.includes("MODEL")) {
    return {
      title: human,
      subtitle: eventType,
      description: "A model generation step was recorded at this frame.",
      explain: "Model frames capture the generated tokens and usage for this step.",
      icon: Activity,
      stateColor: "nominal"
    };
  }

  // Default: honest, derived from the real type + label.
  return {
    title: detail ? `${human} — ${detail}` : human,
    subtitle: eventType,
    description: detail
      ? `${human}: ${detail}.`
      : `${human} recorded in the execution timeline.`,
    explain: "Event recorded canonically in the event-sourced execution log.",
    icon: iconForEventType(t),
    stateColor: t.includes("STARTED") || t.includes("SCHEDULED") ? "replay" : "nominal"
  };
}

// Turn a SCREAMING_SNAKE event type into a readable phrase.
function humanizeEventType(t: string): string {
  if (!t) return "Event";
  return t
    .toLowerCase()
    .split("_")
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function iconForEventType(t: string): any {
  if (t.includes("HANDOFF") || t.includes("PHASE")) return ArrowRight;
  if (t.includes("NODE") || t.includes("STEP")) return Activity;
  if (t.includes("STARTED") || t.includes("SCHEDULED")) return Server;
  if (t.includes("MEMORY")) return Database;
  return Activity;
}

function PlayIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

export function ExecutionTimelineViewer({
  cognitionId,
  onSeekToFrame,
  onBranchFromFrame,
  activeFrameIndex,
}: ExecutionTimelineViewerProps) {
  const [timeline, setTimeline] = useState<FailureTimeline | undefined>();
  const [checkpoints, setCheckpoints] = useState<NamedCheckpoint[]>([]);
  const [selected, setSelected] = useState<AnnotatedFrame | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CognitionApiError | Error | string | undefined>();
  const [windowStart, setWindowStart] = useState(0);
  const [explainMode, setExplainMode] = useState(false);
  const rootCauseRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [tl, cps] = await Promise.all([
        cognitionApi.getFailureTimeline(cognitionId),
        cognitionApi.listCheckpoints(cognitionId).catch(() => [] as NamedCheckpoint[]),
      ]);
      setTimeline(tl);
      setCheckpoints(cps);
      // Auto-select the ROOT_CAUSE frame so the operator sees the critical moment first
      const rootFrame = tl.frames.find((f) => f.causalRole === "ROOT_CAUSE");
      if (rootFrame) {
        setSelected(rootFrame);
        const rootIdx = rootFrame.frameIndex;
        setWindowStart(Math.max(0, rootIdx - Math.floor(TILE_WINDOW / 2)));
      }
    } catch (err) {
      if (err instanceof CognitionApiError) {
        setError(err);
      } else if (err instanceof Error) {
        setError(err);
      } else {
        setError(String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [cognitionId]);

  useEffect(() => { void load(); }, [load]);

  // Scroll root cause frame into view
  useEffect(() => {
    if (rootCauseRef.current) {
      rootCauseRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [timeline]);

  if (loading) {
    return (
      <div className="space-y-2 animate-pulse">
        <div className="h-16 bg-zinc-900 border border-zinc-800 rounded-lg" />
        <div className="h-32 bg-zinc-900 border border-zinc-800 rounded-lg" />
      </div>
    );
  }
  if (error) {
    const isCognitionError = error instanceof CognitionApiError;
    const status = isCognitionError ? error.status : undefined;
    const degradedState = isCognitionError ? error.degradedState : undefined;
    const runtimeId = isCognitionError ? error.runtimeId : undefined;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType = status === 500 ? "INTERNAL_ERROR" : `API_ERROR_${status ?? "UNKNOWN"}`;

    return (
      <Card className="border-rose-950 bg-zinc-950 p-6 rounded-xl border max-w-2xl mx-auto my-8 shadow-2xl relative overflow-hidden group">
        <div className="absolute -right-16 -top-16 w-32 h-32 rounded-full bg-rose-500/10 blur-2xl group-hover:bg-rose-500/15 transition-all duration-500" />
        <CardContent className="p-0 space-y-4">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-400">
              <AlertTriangle className="h-6 w-6 animate-pulse" />
            </div>
            <div className="space-y-1 min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-rose-400 uppercase tracking-wider font-mono">
                  {errorType}
                </h3>
                {status && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-rose-950/40 text-rose-300 border border-rose-800/40">
                    STATUS {status}
                  </span>
                )}
                {degradedState && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-amber-950/40 text-amber-300 border border-amber-800/40 animate-pulse">
                    {degradedState}
                  </span>
                )}
              </div>
              <p className="text-zinc-200 text-sm font-medium leading-relaxed mt-2 select-text">
                {errorMessage}
              </p>
              {runtimeId && (
                <div className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500 font-mono">
                  <span className="text-zinc-600">Runtime ID:</span>
                  <span className="bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 select-all">{runtimeId}</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 pt-2 border-t border-zinc-900">
            <Button
              size="sm"
              variant="secondary"
              className="border-zinc-800 hover:border-zinc-700 bg-zinc-900/50 text-zinc-400 hover:text-zinc-200 text-xs font-medium"
              onClick={() => setError(undefined)}
            >
              Dismiss
            </Button>
            <Button
              size="sm"
              className="bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold px-4 py-2 shadow-lg shadow-rose-950/50 hover:shadow-rose-900/60 transition-all active:scale-95 duration-150"
              onClick={load}
            >
              Retry Action
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }
  if (!timeline || timeline.frames.length === 0) {
    return <ExplainedEmptyState concept="timeline" />;
  }

  const totalFrames = timeline.frames.length;
  const visibleFrames = timeline.frames.slice(windowStart, windowStart + TILE_WINDOW);
  const checkpointFrameSet = new Set(checkpoints.map((cp) => cp.frameIndex));

  return (
    <div className="space-y-4">
      {/* Visual Header with Explain Reliability Toggle */}
      <div className="flex items-center justify-between gap-3 border-b border-zinc-900 pb-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
            <Activity className="h-4 w-4 text-blue-400" />
            Interactive Reliability Scrubber
          </h2>
          <p className="text-[11px] text-zinc-500">
            Causally annotated step traces and deterministic attempt comparison logs
          </p>
        </div>
        <button
          onClick={() => setExplainMode(!explainMode)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg transition-all active:scale-95 duration-150",
            explainMode
              ? "bg-indigo-950/40 border-indigo-700/60 text-indigo-300 shadow-[0_0_12px_rgba(99,102,241,0.15)]"
              : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-300 hover:border-zinc-700"
          )}
        >
          <ShieldCheck className={cn("h-4 w-4", explainMode ? "text-indigo-400 animate-pulse" : "text-zinc-500")} />
          Explain Reliability
        </button>
      </div>

      {explainMode && (
        <div className="bg-indigo-950/15 border border-indigo-900/40 rounded-xl p-3 text-xs text-indigo-300 flex items-start gap-2.5 animate-in fade-in slide-in-from-top-2 duration-200">
          <HelpCircle className="h-5 w-5 shrink-0 text-indigo-400" />
          <div className="space-y-1">
            <span className="font-semibold block text-indigo-200 text-sm">Explaining Reliability Architecture</span>
            <p className="text-[11px] text-indigo-300/80 leading-relaxed">
              Timelines are divided into causal roles: <span className="text-rose-400 font-semibold">ROOT_CAUSE</span> identifies the initial infrastructure timeout frame; <span className="text-amber-400 font-semibold font-mono">PROPAGATION</span> highlights retry/recovery operations; and checkpoints are denoted by <span className="text-indigo-400 font-semibold font-mono">PURPLE DOTS</span>. Replay boundaries are active below. Hover or click frames to examine transactional parameters.
            </p>
          </div>
        </div>
      )}

      {/* Summary metrics bar */}
      <SummaryBar timeline={timeline} totalFrames={totalFrames} checkpointCount={checkpoints.length} />

      {/* Health degradation curve */}
      {timeline.healthCurve.length > 0 && (
        <HealthCurve curve={timeline.healthCurve} firstFailure={timeline.firstFailureFrameIndex} />
      )}

      {/* Frame tile track (Obsidian Surface) */}
      <Card className="p-4 bg-zinc-950 border-zinc-850 space-y-3 shadow-xl">
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span className="font-medium text-zinc-400">Sequence Frame Track</span>
          {totalFrames > TILE_WINDOW && (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-2 text-[10px]"
                onClick={() => setWindowStart((w) => Math.max(0, w - 50))}
                disabled={windowStart === 0}
              >
                ←
              </Button>
              <span className="font-mono text-zinc-400">{windowStart + 1}–{Math.min(windowStart + TILE_WINDOW, totalFrames)}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-2 text-[10px]"
                onClick={() => setWindowStart((w) => Math.min(totalFrames - TILE_WINDOW, w + 50))}
                disabled={windowStart + TILE_WINDOW >= totalFrames}
              >
                →
              </Button>
            </div>
          )}
        </div>

        <div className="flex gap-[3px] flex-wrap py-2 px-1 rounded-md bg-zinc-900/30 border border-zinc-900/50" role="list" aria-label="Execution frame timeline">
          {visibleFrames.map((frame) => {
            const isActive = frame.frameIndex === activeFrameIndex;
            const isSelected = frame.frameIndex === selected?.frameIndex;
            const isRoot = frame.causalRole === "ROOT_CAUSE";
            const hasCheckpoint = checkpointFrameSet.has(frame.frameIndex);
            const isFirstFailure = frame.frameIndex === timeline.firstFailureFrameIndex;
            const isHotspot = frame.frameIndex === timeline.hotspotFrameIndex;

            const tEvent = translateEvent(frame.eventType, frame.label);

            return (
              <div
                key={frame.frameIndex}
                ref={isRoot ? rootCauseRef : undefined}
                role="listitem"
                title={`Frame ${frame.frameIndex}: ${tEvent.title} · ${frame.causalRole === "CLEAN" ? PHASE_LABELS[phaseKeyForFrame(frame)] : frame.causalRole}`}
                onClick={() => setSelected(frame)}
                className={cn(
                  "w-3 h-7 rounded-sm cursor-pointer transition-all relative flex items-center justify-center",
                  tileColor(frame),
                  isActive && "ring-2 ring-amber-300 scale-y-110 shadow-[0_0_12px_rgba(252,211,77,0.4)]",
                  isSelected && "ring-2 ring-white scale-y-110 shadow-[0_0_12px_rgba(255,255,255,0.4)]",
                  isFirstFailure && "ring-1 ring-rose-400 animate-pulse",
                  isHotspot && "scale-y-125"
                )}
              >
                {hasCheckpoint && (
                  <div className="absolute -top-1 w-1.5 h-1.5 rounded-full bg-indigo-400 ring-2 ring-zinc-950" />
                )}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 text-[10px] text-zinc-500 flex-wrap pt-2 border-t border-zinc-900">
          {(["ROOT_CAUSE", "PROPAGATION", "TERMINAL", "CLEAN"] as const).map((role) => (
            <div key={role} className="flex items-center gap-1.5">
              <div className={cn("w-3 h-3 rounded border", CAUSAL_COLORS[role].split(" ")[0], CAUSAL_COLORS[role].split(" ")[2])} />
              <span className="font-medium text-zinc-400">{role === "ROOT_CAUSE" ? "Root Cause (Failure)" : role.replace("_", " ").toLowerCase()}</span>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded border border-zinc-800 bg-zinc-900/60 relative flex items-center justify-center">
              <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
            </div>
            <span className="font-medium text-zinc-400">checkpoint</span>
          </div>
        </div>

        {/* Phase legend — how CLEAN frames are tinted by the producing agent role */}
        <div className="flex items-center gap-3 text-[10px] text-zinc-600 flex-wrap pt-1">
          <span className="text-zinc-500">clean frames by phase:</span>
          {(["PLANNER", "EXECUTOR", "VERIFIER", "CRITIC", "MEMORY"] as const).map((p) => (
            <div key={p} className="flex items-center gap-1.5">
              <div className={cn("w-3 h-3 rounded border", PHASE_COLORS[p].split(" ")[0], PHASE_COLORS[p].split(" ").slice(-1)[0])} />
              <span className="text-zinc-400">{PHASE_LABELS[p]}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Selected frame detail (Observability Translation Layer + Overlays) */}
      {selected && (
        <FrameDetailPanel
          frame={selected}
          onSeekToFrame={onSeekToFrame}
          onBranchFromFrame={onBranchFromFrame}
          explainMode={explainMode}
        />
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryBar({
  timeline,
  totalFrames,
  checkpointCount,
}: {
  timeline: FailureTimeline;
  totalFrames: number;
  checkpointCount: number;
}) {
  const frames = timeline?.frames ?? [];
  const rootCauseCount = frames.filter((f) => f.causalRole === "ROOT_CAUSE").length;
  const terminalCount = frames.filter((f) => f.causalRole === "TERMINAL").length;
  const propagationCount = frames.filter((f) => f.causalRole === "PROPAGATION").length;
  const cleanCount = frames.filter((f) => f.causalRole === "CLEAN").length;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5 text-xs">
      <Stat label="total frames" value={totalFrames} />
      <Stat label="signals" value={timeline?.totalSignals ?? 0} tone={(timeline?.totalSignals ?? 0) > 0 ? "error" : "success"} />
      <Stat label="root cause" value={rootCauseCount} tone="error" />
      <Stat label="propagation" value={propagationCount} tone="warning" />
      <Stat label="terminal" value={terminalCount} tone="warning" />
      <Stat label="clean" value={cleanCount} tone="success" />
      <Stat label="checkpoints" value={checkpointCount} tone="info" />
    </div>
  );
}

function HealthCurve({
  curve,
  firstFailure,
}: {
  curve: Array<{ bucketStart: number; healthScore: number }>;
  firstFailure: number | null;
}) {
  const max = 100;
  const curveList = curve ?? [];
  const curveLength = curveList.length;

  return (
    <Card className="p-3 bg-zinc-950 border-zinc-900 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 mb-2 flex items-center justify-between">
        <span>Health degradation curve</span>
        {firstFailure !== null && <span className="text-rose-400 flex items-center gap-0.5"><TrendingDown className="h-3 w-3" /> Degradation starts at Frame {firstFailure}</span>}
      </div>
      <div className="relative h-10 flex items-end gap-px">
        {curveList.map((bucket, i) => {
          const heightPct = ((bucket?.healthScore ?? 0) / max) * 100;
          const isFailZone = (bucket?.healthScore ?? 0) < 60;
          const isCritical = (bucket?.healthScore ?? 0) < 30;
          return (
            <div
              key={`${bucket?.bucketStart ?? 0}-${i}`}
              title={`Frames ${bucket?.bucketStart ?? 0}–${(bucket?.bucketStart ?? 0) + 9}: health ${bucket?.healthScore ?? 0}%`}
              className="flex-1 rounded-t-sm transition-all"
              style={{
                height: `${Math.max(4, heightPct)}%`,
                background: isCritical
                  ? "rgba(244,63,94,0.6)"
                  : isFailZone
                  ? "rgba(245,158,11,0.5)"
                  : "rgba(16,185,129,0.4)",
              }}
            />
          );
        })}
        {/* First failure marker */}
        {firstFailure !== null && curveLength > 0 && (
          <div
            className="absolute bottom-0 top-0 w-px bg-rose-500/50"
            style={{ left: `${(firstFailure / ((curveList[curveLength - 1]?.bucketStart ?? 0) + 10)) * 100}%` }}
          />
        )}
      </div>
      <div className="flex justify-between text-[9px] font-mono text-zinc-650 mt-1">
        <span>NOMINAL OPERATING POINT</span>
        <span>REPLAY BOUNDARY</span>
      </div>
    </Card>
  );
}

function FrameDetailPanel({
  frame,
  onSeekToFrame,
  onBranchFromFrame,
  explainMode,
}: {
  frame: AnnotatedFrame;
  onSeekToFrame?: (i: number) => void;
  onBranchFromFrame?: (i: number) => void;
  explainMode?: boolean;
}) {
  const signals = frame?.signals ?? [];
  
  // Translate raw values (Phase 1)
  const translated = translateEvent(frame.eventType, frame.label);
  const IconComponent = translated.icon;

  return (
    <Card className="p-4 bg-zinc-950 border-zinc-850 space-y-4 shadow-xl text-zinc-100 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-32 h-32 bg-zinc-900/20 rounded-full blur-2xl pointer-events-none" />

      <div className="flex items-start justify-between gap-3 flex-wrap border-b border-zinc-900 pb-3">
        <div className="flex items-start gap-3">
          <div className={cn(
            "p-2 rounded-lg border",
            translated.stateColor === "nominal" && "bg-emerald-950/20 border-emerald-900/40 text-emerald-400",
            translated.stateColor === "warning" && "bg-amber-950/20 border-amber-900/40 text-amber-400",
            translated.stateColor === "incident" && "bg-rose-950/20 border-rose-900/40 text-rose-400",
            translated.stateColor === "recovery" && "bg-indigo-950/20 border-indigo-900/40 text-indigo-400",
            translated.stateColor === "replay" && "bg-blue-950/20 border-blue-900/40 text-blue-400"
          )}>
            <IconComponent className="h-5 w-5" />
          </div>
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-200">Frame {frame.frameIndex}</span>
              <span className={cn("text-[9px] font-mono px-1.5 py-0.2 rounded border tracking-wider", CAUSAL_BADGE_COLORS[frame.causalRole])}>
                {frame.causalRole.replace("_", " ")}
              </span>
            </div>
            <h3 className="text-sm font-semibold text-white leading-snug">{translated.title}</h3>
            <div className="text-[11px] text-zinc-400 font-mono flex items-center gap-1.5">
              <span>{translated.subtitle}</span>
              <span className="text-zinc-700">•</span>
              <span className="text-zinc-500">seq {frame.eventSequence}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onSeekToFrame && (
            <Button size="sm" variant="secondary" className="bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 text-xs h-8" onClick={() => onSeekToFrame(frame.frameIndex)}>
              <Crosshair className="h-3.5 w-3.5 mr-1 text-zinc-400" />
              Seek to Scrubber
            </Button>
          )}
          {onBranchFromFrame && (
            <Button size="sm" variant="secondary" className="bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 text-xs h-8" onClick={() => onBranchFromFrame(frame.frameIndex)}>
              <GitBranch className="h-3.5 w-3.5 mr-1 text-zinc-400" />
              Fork Replay
            </Button>
          )}
        </div>
      </div>

      <div className="text-xs text-zinc-400 leading-relaxed bg-zinc-900/20 rounded-lg p-3 border border-zinc-900">
        <span className="font-semibold block text-zinc-200 mb-1">Operational Description:</span>
        {translated.description}
      </div>

      {explainMode && (
        <div className="text-[11px] text-zinc-400 leading-relaxed bg-zinc-900/20 rounded-lg p-3 border border-zinc-900">
          <span className="font-semibold block text-zinc-300 mb-1">Why this frame matters</span>
          {translated.explain}
        </div>
      )}

      {signals.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] uppercase font-bold tracking-wide text-zinc-500">
            Failure intelligence diagnostics ({signals.length})
          </div>
          <div className="grid gap-2">
            {signals.map((sig, index) => (
              <SignalRow key={`${frame.frameIndex}-${sig?.id ?? index}-${index}`} signal={sig} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function SignalRow({ signal }: { signal: FailureSignal }) {
  return (
    <div className="flex items-start gap-2 bg-zinc-900/60 border border-zinc-900 rounded-lg px-2.5 py-2 text-xs">
      <div className={cn("mt-1 w-2.5 h-2.5 rounded-full shrink-0 border border-zinc-950", SEVERITY_DOT[signal?.severity ?? "INFO"] ?? "bg-zinc-500")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-zinc-300 font-semibold">{signal?.kind ?? "UNKNOWN"}</span>
          <span className="text-[10px] px-1 bg-zinc-950 rounded font-mono text-zinc-500 border border-zinc-900">{signal?.severity ?? "INFO"}</span>
          <span className="text-[10px] font-mono text-zinc-500">score {(signal?.score ?? 0).toFixed(2)}</span>
        </div>
        <div className="text-zinc-450 leading-relaxed mt-0.5">{signal?.summary ?? ""}</div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "warning" | "error" | "info";
}) {
  return (
    <div
      className={cn(
        "px-2.5 py-2 rounded-lg border bg-zinc-900/40 shadow-sm relative overflow-hidden",
        tone === "success" && "border-emerald-900/60 bg-emerald-950/5 text-emerald-450",
        tone === "warning" && "border-amber-900/60 bg-amber-950/5 text-amber-450",
        tone === "error" && "border-rose-900/60 bg-rose-950/5 text-rose-450",
        tone === "info" && "border-indigo-900/60 bg-indigo-950/5 text-indigo-450",
        tone === "neutral" && "border-zinc-850"
      )}
    >
      <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-zinc-200 font-mono text-base font-bold mt-0.5">{value}</div>
    </div>
  );
}
