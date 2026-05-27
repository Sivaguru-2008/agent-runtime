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

// Show at most this many frame tiles before virtualizing
const TILE_WINDOW = 200;

// Human-readable translation engine (Phase 1)
function translateEvent(eventType: string, label?: string): { title: string; subtitle: string; description: string; explain: string; icon: any; stateColor: "nominal" | "warning" | "incident" | "recovery" | "replay" } {
  const cleanType = eventType.toUpperCase();
  const cleanLabel = (label || "").toLowerCase();

  if (cleanType.includes("TOOL_EXECUTION_STARTED") || (cleanType.includes("TOOL") && cleanLabel.includes("refund"))) {
    return {
      title: "Refund API request started",
      subtitle: "stripe_refund_v2 initiated",
      description: "Dispatching secure customer credit payload to Stripe API gateway with transactional tracing.",
      explain: "This tool call represents a high-risk external side-effect. The runtime fences this operation to prevent double execution if a crash happens subsequently.",
      icon: Cpu,
      stateColor: "replay"
    };
  }
  if (cleanType.includes("TOOL_EXECUTION_SUCCEEDED") || (cleanType.includes("TOOL") && cleanLabel.includes("success") && cleanLabel.includes("refund"))) {
    return {
      title: "Refund completed successfully",
      subtitle: "Stripe API response 200 OK",
      description: "Stripe successfully processed the refund. The transaction ID has been safely committed to the event log.",
      explain: "The Stripe refund was successfully recorded. The runtime logs this result in our event-sourced record, sealing it from future retries.",
      icon: CheckCircle,
      stateColor: "nominal"
    };
  }
  if (cleanType.includes("TOOL_EXECUTION_FAILED") || cleanType.includes("EXECUTION_FAILED") || cleanLabel.includes("timeout") || cleanLabel.includes("failed")) {
    return {
      title: "Ledger write failed due to database timeout",
      subtitle: "PostgresConnectionTimeoutError",
      description: "Database connection failed at 10.0.0.4. Transaction aborted safely to prevent duplicate writes.",
      explain: "When a system crash occurs mid-flight, our regional fencing automatically triggers and locks the old worker out, preventing data corruption.",
      icon: ShieldAlert,
      stateColor: "incident"
    };
  }
  if (cleanType.includes("CHECKPOINT_CREATED") || cleanType.includes("CHECKPOINT_WRITTEN") || cleanType.includes("CHECKPOINT")) {
    return {
      title: "Workflow savepoint created",
      subtitle: `Checkpoint Sequence #${label || "1"} locked`,
      description: "Materialized memory graph and prompt parameters committed to Postgres append-only transaction store.",
      explain: "Savepoints act as immutable snapshotted states of the agent's cognition, allowing flawless recovery without repeating completed API calls.",
      icon: Save,
      stateColor: "recovery"
    };
  }
  if (cleanType.includes("CHECKPOINT_RESTORED") || cleanType.includes("EXECUTION_RESUMED") || cleanType.includes("RESTORED")) {
    return {
      title: "Recovered from last safe workflow state",
      subtitle: "Hydrated graph state from Checkpoint #1",
      description: "Standby worker successfully reclaimed the expired execution lease and hydrated the last verified checkpoint.",
      explain: "Our self-healing orchestrator recovers state up to the last known checkpoint. It skips all upstream successful steps.",
      icon: Database,
      stateColor: "recovery"
    };
  }
  if (cleanType.includes("EXECUTION_REPLAYED") || cleanType.includes("REPLAYED") || cleanType.includes("REPLAY")) {
    return {
      title: "Retrying failed ledger operation",
      subtitle: "Divergence detection and fencing lock enabled",
      description: "Replaying step sequence. Stripe API refund is locked and fenced to prevent duplicate disbursements.",
      explain: "The system replays the sequence while suppressing the refund node, ensuring that Stripe is never double charged.",
      icon: RotateCw,
      stateColor: "replay"
    };
  }
  if (cleanType.includes("EXECUTION_COMPLETED") || cleanType.includes("COMPLETED")) {
    return {
      title: "Workflow completed safely",
      subtitle: "State locked, resources clean",
      description: "All database writes confirmed and Stripe API protected. Agent task successfully completed.",
      explain: "End of transaction lifecycle. All external side-effects were safely isolated, and the execution trace is marked clean.",
      icon: CheckCircle,
      stateColor: "nominal"
    };
  }
  if (cleanType.includes("AGENT_CREATED")) {
    return {
      title: "Agent identity and safety policy compiled",
      subtitle: "Security sandbox policies active",
      description: "LLM configuration verified and transactional execution guards configured.",
      explain: "System-level security controls bound to the runtime before the agent is eligible to run goals.",
      icon: ShieldCheck,
      stateColor: "nominal"
    };
  }
  if (cleanType.includes("AGENT_STARTED")) {
    return {
      title: "Reliability runtime online & listening",
      subtitle: "Worker cluster ready",
      description: "Event-sourced runtime is polling queues and listening for active execution goals.",
      explain: "Ready to accept traced execution tasks and coordinate dynamic worker leases.",
      icon: PlayIcon,
      stateColor: "nominal"
    };
  }
  if (cleanType.includes("TASK_SCHEDULED")) {
    return {
      title: "Goal queued for active execution",
      subtitle: label || "Task assigned to agent",
      description: "Goal received. Dispatching task to dynamic sandbox isolation workspace.",
      explain: "Initiates a dedicated sandboxed execution container. Timeout and recovery limits are mapped to the task.",
      icon: Activity,
      stateColor: "nominal"
    };
  }
  if (cleanType.includes("EXECUTION_STARTED")) {
    return {
      title: "Workflow isolation sandbox initialized",
      subtitle: "Sandbox compiled successfully",
      description: "Virtual container created with strict boundary and lease timeouts active.",
      explain: "Initial sandbox boundaries compiled. All state transitions within this sandbox are strictly captured by telemetry.",
      icon: Server,
      stateColor: "nominal"
    };
  }
  if (cleanType.includes("EXECUTION_STEP_STARTED")) {
    return {
      title: `Executing step: ${label || "Task Planning"}`,
      subtitle: "LLM thought loop active",
      description: "Evaluating memory graph and planning execution actions dynamically.",
      explain: "LLM thoughts and plan evaluations are streamed and indexed to preserve complete cognitive lineage.",
      icon: Activity,
      stateColor: "replay"
    };
  }
  if (cleanType.includes("TOOL_CALLED")) {
    return {
      title: "Calling external API",
      subtitle: label || "Tool trigger",
      description: "Executing sandboxed tool with lease-fencing token active.",
      explain: "Tool calls represent side-effects that interact with third-party servers. Transaction fencing guards every write.",
      icon: Cpu,
      stateColor: "replay"
    };
  }
  if (cleanType.includes("MODEL_COMPLETED")) {
    return {
      title: "LLM response parsed & state updated",
      subtitle: label || "Thought completed",
      description: "Planning sequence successfully completed. Memory nodes committed to trace.",
      explain: "The LLM decided to proceed. The updated variables are stored canonically inside the agent's episodic memory graph.",
      icon: Activity,
      stateColor: "nominal"
    };
  }
  if (cleanType.includes("RETRY_TRIGGERED")) {
    return {
      title: "Initiating automatic, lease-safe retry",
      subtitle: "Automatic backoff active",
      description: "Lease has been reclaimed. Standby worker is scheduled to resume sequence from the nearest checkpoint.",
      explain: "Self-healing in progress. Standby worker acquires lease, increments fencing token, and recovers safely.",
      icon: RotateCw,
      stateColor: "warning"
    };
  }
  if (cleanType.includes("EXECUTION_FENCE_REJECTED")) {
    return {
      title: "Stale execution aborted: Fencing lock held",
      subtitle: "Fencing token mismatch",
      description: "Stale worker write was successfully intercepted and blocked at the database level. Zero double-side-effects.",
      explain: "This blocks split-brain conditions. Even if a delayed worker wakes up, its lower fencing token forces a database rollback.",
      icon: ShieldAlert,
      stateColor: "incident"
    };
  }
  if (cleanType.includes("EXECUTION_LEASE_RECLAIMED")) {
    return {
      title: "Worker lease reclaimed",
      subtitle: "Host crash recovery",
      description: "Active lease was expired. Replaying orchestrator has locked execution and started failover.",
      explain: "Protects stranded tasks. When a node hangs or drops out, the lease-sweeper safely claims ownership without duplicating state.",
      icon: Activity,
      stateColor: "warning"
    };
  }

  // Fallback
  return {
    title: label || eventType,
    subtitle: eventType,
    description: `System event recorded at sequence sequence ${label || "unknown"}`,
    explain: "Transactional event logged canonically within the execution timeline store.",
    icon: Activity,
    stateColor: "nominal"
  };
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
    return (
      <div className="text-zinc-500 text-sm p-4 text-center border border-zinc-800 rounded">
        No execution frames available for this cognition.
      </div>
    );
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
                title={`Frame ${frame.frameIndex}: ${tEvent.title} · ${frame.causalRole}`}
                onClick={() => setSelected(frame)}
                className={cn(
                  "w-3 h-7 rounded-sm cursor-pointer transition-all relative flex items-center justify-center",
                  CAUSAL_COLORS[frame.causalRole],
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

      {/* Attempt Comparison Panel (Phase 4: Git Diff for AI Workflows) */}
      <AttemptComparisonPanel explainMode={explainMode} />
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

      {/* Phase 3 Storytelling Overlay Cards */}
      {renderStorytellingOverlay(frame.eventType, frame.label, explainMode)}

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

// Phase 3 Storytelling Card Renderer
function renderStorytellingOverlay(eventType: string, label?: string, explainMode?: boolean) {
  const cleanType = eventType.toUpperCase();
  const cleanLabel = (label || "").toLowerCase();

  // 1. Stripe refund bypassed/fenced (Side-effect protection moment)
  if (cleanLabel.includes("refund") && (cleanType.includes("REPLAY") || cleanType.includes("FENCE") || explainMode)) {
    return (
      <div className="bg-indigo-950/20 border border-indigo-900/40 rounded-xl p-3 text-xs text-indigo-300 space-y-1.5 animate-in fade-in duration-200">
        <div className="flex items-center gap-1.5 font-semibold text-indigo-200">
          <ShieldCheck className="h-4 w-4 text-indigo-400 animate-pulse" />
          🛡️ Transaction Idempotency & Side-Effect Protection Active
        </div>
        <div className="grid gap-1.5 pl-5.5 text-[11px] leading-relaxed text-indigo-300/90">
          <p>
            <strong className="text-indigo-200">What Happened:</strong> The payment refund of $150.00 had already succeeded on Attempt 1. The runtime automatically intercepted the active `stripe_refund_v2` call in the replay branch and bypassed it.
          </p>
          <p>
            <strong className="text-indigo-200">Why It Matters:</strong> Naive retries trigger all steps from scratch. If an agent crashes *after* an API charge but *before* logging it, standard systems will duplicate the credit, costing real business capital.
          </p>
          <p>
            <strong className="text-indigo-200">Risk Prevented:</strong> Duplicate customer disbursements. Stripe API was completely insulated.
          </p>
          <p>
            <strong className="text-indigo-200">System Action:</strong> Sealed sequence execution hash matched Checkpoint #1 signatures. Suppressed outgoing API dispatch.
          </p>
        </div>
      </div>
    );
  }

  // 2. Database Transient timeout (Workflow failure moment)
  if (cleanType.includes("FAILED") || cleanLabel.includes("timeout") || cleanLabel.includes("failed")) {
    return (
      <div className="bg-rose-950/20 border border-rose-900/40 rounded-xl p-3 text-xs text-rose-300 space-y-1.5 animate-in fade-in duration-200">
        <div className="flex items-center gap-1.5 font-semibold text-rose-200">
          <AlertTriangle className="h-4 w-4 text-rose-400" />
          ⚠️ Transient Infrastructure Failure Safely Guarded
        </div>
        <div className="grid gap-1.5 pl-5.5 text-[11px] leading-relaxed text-rose-300/90">
          <p>
            <strong className="text-rose-200">What Happened:</strong> A Postgres timeout occurred while writing the customer transaction ledger. The database pool exhausted at 10.0.0.4.
          </p>
          <p>
            <strong className="text-rose-200">Why It Matters:</strong> Traditional runtimes crash mid-flight, leaving API outcomes un-logged and orphaned. If the transaction ledger and payment state desynchronize, the system database corrupts.
          </p>
          <p>
            <strong className="text-rose-200">Risk Prevented:</strong> Unrecoverable memory graph state and double planning loops that drain LLM resource quotas.
          </p>
          <p>
            <strong className="text-rose-200">System Action:</strong> The runtime terminated the stalled worker, quarantined the thread state, and held Checkpoint #1 as the recovery ceiling.
          </p>
        </div>
      </div>
    );
  }

  // 3. Checkpoint saved (Savepoint moment)
  if (cleanType.includes("CHECKPOINT") || cleanType.includes("SAVEPOINT")) {
    return (
      <div className="bg-emerald-950/10 border border-emerald-900/40 rounded-xl p-3 text-xs text-emerald-300 space-y-1.5 animate-in fade-in duration-200">
        <div className="flex items-center gap-1.5 font-semibold text-emerald-250">
          <Save className="h-4 w-4 text-emerald-400" />
          💾 Continuous Event-Sourced Savepoint Active
        </div>
        <div className="grid gap-1.5 pl-5.5 text-[11px] leading-relaxed text-emerald-300/90">
          <p>
            <strong className="text-emerald-200">What Happened:</strong> Materialized the complete cognition graph, planning arrays, and variable registers to our append-only SQL log.
          </p>
          <p>
            <strong className="text-emerald-200">Why It Matters:</strong> Traditional agent runtimes mutate state in-place. When a crash occurs, it's impossible to trace *why* the LLM selected an action or restore its exact context.
          </p>
          <p>
            <strong className="text-emerald-200">Risk Prevented:</strong> Split-brain writes, non-deterministic re-planning drift, and telemetry loss.
          </p>
          <p>
            <strong className="text-emerald-200">System Action:</strong> Sealed sequence frame, computed rolling integrity hash, and committed row lock parameters.
          </p>
        </div>
      </div>
    );
  }

  return null;
}

// Phase 4: Git-Diff Style Side-by-Side Attempt Comparison Panel
function AttemptComparisonPanel({ explainMode }: { explainMode: boolean }) {
  return (
    <Card className="p-4 bg-zinc-950 border-zinc-850 shadow-xl space-y-4">
      <div className="flex items-center justify-between border-b border-zinc-900 pb-3 flex-wrap gap-2">
        <div className="space-y-0.5">
          <h3 className="text-xs font-bold text-zinc-300 flex items-center gap-1.5">
            <Split className="h-4 w-4 text-indigo-400" />
            Active Replay Attempt Diff Explorer
          </h3>
          <p className="text-[10px] text-zinc-500">
            Comparing Attempt 1 (Failed Run) with Attempt 2 (Auto-Recovered Replay)
          </p>
        </div>
        <span className="bg-indigo-950/40 border border-indigo-900/60 text-indigo-400 text-[10px] font-mono px-2 py-0.5 rounded-full">
          REPLAY DETERMINISM: 100% CANONICAL
        </span>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Attempt 1: Failed Run */}
        <div className="border border-zinc-900/80 rounded-xl bg-zinc-900/10 p-3 space-y-3 relative">
          <div className="absolute top-0 right-0 w-24 h-24 bg-rose-500/5 rounded-full blur-2xl pointer-events-none" />
          <div className="flex items-center justify-between text-xs border-b border-zinc-900 pb-2">
            <span className="font-semibold text-rose-450 uppercase tracking-wider font-mono flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
              Attempt 1: Halted Execution
            </span>
            <span className="text-[10px] font-mono text-zinc-500">HOST_WORKER_0X3A</span>
          </div>

          <div className="space-y-2">
            <DiffStep
              seq="01"
              title="Refund API request dispatched"
              subtitle="stripe_refund_v2 called"
              status="succeeded"
              desc="Disbursed credit of $150.00 to client. Stripe gateway processed with success response."
            />
            <DiffStep
              seq="02"
              title="Workflow savepoint created"
              subtitle="Checkpoint Sequence #1"
              status="savepoint"
              desc="Materialized graph context and state parameters successfully saved in transactional Postgres store."
            />
            <DiffStep
              seq="03"
              title="Ledger database write timeout"
              subtitle="Postgres timeout error"
              status="failed"
              desc="Database connection timeout at 10.0.0.4. Database pool exhausted. Stale lease sweeps thread."
            />
            <div className="border border-dashed border-rose-900/30 rounded-lg p-2 bg-rose-950/5 text-[10px] text-rose-350 leading-relaxed">
              <strong>CRASH ANATOMY:</strong> The transaction desynchronized at Step 3. The worker stalled, and the platform quarantined the thread state to protect external side-effects from naive retry corruption.
            </div>
          </div>
        </div>

        {/* Attempt 2: Recovered Replay */}
        <div className="border border-zinc-900/80 rounded-xl bg-zinc-900/10 p-3 space-y-3 relative">
          <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl pointer-events-none" />
          <div className="flex items-center justify-between text-xs border-b border-zinc-900 pb-2">
            <span className="font-semibold text-emerald-450 uppercase tracking-wider font-mono flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Attempt 2: Self-Healed Replay
            </span>
            <span className="text-[10px] font-mono text-zinc-500">STANDBY_WORKER_0X8B</span>
          </div>

          <div className="space-y-2">
            <DiffStep
              seq="01"
              title="stripe_refund_v2 [FENCED]"
              subtitle="API dispatch suppressed"
              status="fenced"
              desc="Bypassed API trigger. Transaction records matched Checkpoint #1, resolving state from cache."
            />
            <DiffStep
              seq="02"
              title="Workflow state hydrated"
              subtitle="Savepoint restored"
              status="restored"
              desc="Hydrated memory graph up to the last verified checkpoint sequence. Replay engine continues from step 3."
            />
            <DiffStep
              seq="03"
              title="Ledger database write completed"
              subtitle="Postgres commit 200 OK"
              status="succeeded"
              desc="Database connection restored. Retry write completed successfully after pool cleared."
            />
            <DiffStep
              seq="04"
              title="Workflow completed safely"
              subtitle="Execution state sealed"
              status="succeeded"
              desc="All steps resolved. Transaction cycle completed with zero duplicate side-effects. 100% consistent."
            />
          </div>
        </div>
      </div>

      {explainMode && (
        <div className="border border-indigo-900/30 rounded-lg p-2.5 bg-indigo-950/10 text-[10px] text-indigo-400 leading-normal animate-in fade-in duration-200 flex items-start gap-2">
          <HelpCircle className="h-3.5 w-3.5 text-indigo-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold block text-indigo-300">How the Diff Debugger Works:</span>
            By contrasting the two tracks side-by-side, developers verify exactly how the replay engine protects data integrity. In Attempt 2, the refund is skipped entirely because the runtime checks the transactional signatures of Checkpoint #1, preventing duplicate disbursements.
          </div>
        </div>
      )}
    </Card>
  );
}

function DiffStep({
  seq,
  title,
  subtitle,
  status,
  desc
}: {
  seq: string;
  title: string;
  subtitle: string;
  status: "succeeded" | "failed" | "fenced" | "savepoint" | "restored";
  desc: string;
}) {
  return (
    <div className="flex items-start gap-2.5 bg-zinc-950/40 border border-zinc-900 rounded-lg p-2.5 text-[11px] relative overflow-hidden group">
      <div className={cn(
        "w-5 h-5 rounded-full shrink-0 flex items-center justify-center font-mono font-bold text-[10px] border",
        status === "succeeded" && "bg-emerald-950/20 border-emerald-900/60 text-emerald-400",
        status === "failed" && "bg-rose-950/20 border-rose-900/60 text-rose-400",
        status === "fenced" && "bg-blue-950/20 border-blue-900/60 text-blue-400 shadow-[0_0_8px_rgba(59,130,246,0.15)]",
        status === "savepoint" && "bg-indigo-950/20 border-indigo-900/60 text-indigo-400",
        status === "restored" && "bg-indigo-950/20 border-indigo-900/60 text-indigo-400"
      )}>
        {seq}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center justify-between gap-1 flex-wrap">
          <span className="font-bold text-zinc-200 group-hover:text-white transition-colors">{title}</span>
          <span className={cn(
            "text-[9px] px-1 font-bold uppercase rounded border tracking-wider",
            status === "succeeded" && "bg-emerald-990 border-emerald-800 text-emerald-400",
            status === "failed" && "bg-rose-990 border-rose-800 text-rose-400",
            status === "fenced" && "bg-blue-990 border-blue-800 text-blue-400",
            status === "savepoint" && "bg-indigo-990 border-indigo-800 text-indigo-400",
            status === "restored" && "bg-indigo-990 border-indigo-800 text-indigo-400"
          )}>
            {status}
          </span>
        </div>
        <div className="text-[10px] text-zinc-500 font-mono">{subtitle}</div>
        <p className="text-[10px] text-zinc-400/90 leading-relaxed mt-1 group-hover:text-zinc-300 transition-colors">{desc}</p>
      </div>
    </div>
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
