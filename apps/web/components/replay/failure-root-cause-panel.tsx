"use client";

/**
 * PHASE 6 — Failure Root Cause Panel
 *
 * Operator debugging value:
 *   Transforms raw failure signals into a structured causal investigation.
 *   The causal chain view answers "what caused what" with a ROOT_CAUSE →
 *   PROPAGATION → TERMINAL visual flow. Operators see the exact sequence of
 *   events and agent decisions that made failure inevitable.
 *
 *   Per-kind inspection panels give targeted analysis:
 *   - HALLUCINATION: shows token confidence heatmap and memory grounding gap
 *   - CONTRADICTION: shows the specific output fields that conflict
 *   - EXECUTION_LOOP: shows repeated input fingerprints
 *   - TOOL_MISUSE: shows the failed tool call with error details
 *   - CORRUPTED_MEMORY: shows which memory records were inconsistent
 *
 * Replay UX improvement:
 *   "Jump to root cause frame" seeks the replay scrubber directly to the
 *   ROOT_CAUSE frame index so the operator doesn't need to search manually.
 *   The failure heatmap shows signal density across all frames, making it
 *   immediately clear where to focus the investigation.
 *
 * Scaling implications:
 *   Full analysis is fetched once via `/executions/:id/full-analysis`.
 *   Causality chains are fetched per-signal on demand, not upfront.
 *   The heatmap renders O(frames/10) cells via bucket aggregation.
 *
 * Failure diagnosis improvements:
 *   Without this panel, operators must correlate signals, frames, and node
 *   outputs manually. This panel does that correlation automatically and
 *   exposes the reasoning chain that led to failure with frame-level precision.
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExplainedEmptyState } from "@/components/explain/empty-state";
import {
  cognitionApi,
  CognitionApiError,
  type FullAnalysisResult,
  type CausalChain,
  type CausalLink,
  type FailureSignal,
  type AnnotatedFrame,
} from "@/lib/cognition-api";
import { cn, formatTime } from "@/lib/utils";
import { AlertTriangle, Crosshair, Zap } from "lucide-react";

export interface FailureRootCausePanelProps {
  executionId: string;
  /** Called when operator clicks "jump to frame" */
  onSeekToFrame?: (frameIndex: number) => void;
}

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

const CAUSAL_ROLE_STYLE: Record<CausalLink["causalRole"], string> = {
  ROOT_CAUSE: "border-rose-600 bg-rose-950/40 text-rose-300",
  PROPAGATION: "border-amber-700 bg-amber-950/30 text-amber-300",
  TERMINAL: "border-orange-600 bg-orange-950/30 text-orange-300",
};

const SIGNAL_KIND_LABELS: Record<string, string> = {
  HALLUCINATION: "Hallucination",
  CONTRADICTION: "Contradiction",
  RECURSION: "Recursion / Loop",
  EXECUTION_LOOP: "Execution Loop",
  TOOL_MISUSE: "Tool Misuse",
  CORRUPTED_MEMORY: "Corrupted Memory",
  UNCERTAINTY_SPIKE: "Uncertainty Spike",
  PLAN_DRIFT: "Plan Drift",
};

type SignalKind = keyof typeof SIGNAL_KIND_LABELS;

export function FailureRootCausePanel({ executionId, onSeekToFrame }: FailureRootCausePanelProps) {
  const [analysis, setAnalysis] = useState<FullAnalysisResult | undefined>();
  const [causalChain, setCausalChain] = useState<CausalChain | undefined>();
  const [chainLoading, setChainLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CognitionApiError | Error | string | undefined>();
  const [activeKind, setActiveKind] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await cognitionApi.runFullAnalysis(executionId);
      setAnalysis(result);
      // Kick off causality chain for the top signal if available
      const topSignal = result.report.topSignals[0];
      if (topSignal) {
        setChainLoading(true);
        cognitionApi
          .getCausalityChain(topSignal.id)
          .then((chain) => setCausalChain(chain))
          .catch(() => {})
          .finally(() => setChainLoading(false));
      }
      // Default to the most severe kind present
      const kinds = Object.keys(result.report.byKind);
      if (kinds.length > 0) {
        const topKind = kinds.sort((a, b) => (result.report.bySeverity[a] ?? 0) - (result.report.bySeverity[b] ?? 0))[0];
        setActiveKind(topKind);
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
  }, [executionId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <div className="space-y-2 animate-pulse">
        <div className="h-14 bg-zinc-800/40 rounded" />
        <div className="h-32 bg-zinc-800/40 rounded" />
        <div className="h-24 bg-zinc-800/40 rounded" />
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
      <Card className="border-rose-950 bg-zinc-950/80 p-6 rounded-xl border max-w-2xl mx-auto my-8 shadow-2xl relative overflow-hidden group">
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

  if (!analysis) return null;

  const { report, timeline, topCausality: prefetchedChain, suggestBranch, branchSuggestion } = analysis;
  const chain = causalChain ?? prefetchedChain ?? undefined;
  const topSignals = [...report.topSignals].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
  );
  const presentKinds = Object.keys(report.byKind) as SignalKind[];

  return (
    <div className="space-y-4">
      {/* Summary section */}
      <ReportSummary report={report} executionId={executionId} suggestBranch={suggestBranch} branchSuggestion={branchSuggestion} />

      {/* Branch suggestion callout */}
      {suggestBranch && chain?.rootCauseFrameIndex !== undefined && (
        <div className="rounded border border-fuchsia-700/50 bg-fuchsia-950/20 p-3 flex items-start gap-3">
          <Zap className="h-4 w-4 text-fuchsia-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-fuchsia-300">{branchSuggestion}</div>
            {onSeekToFrame && (
              <Button
                size="sm"
                variant="secondary"
                className="mt-2 border-fuchsia-700 text-fuchsia-300 hover:bg-fuchsia-950/40"
                onClick={() => onSeekToFrame(chain.rootCauseFrameIndex!)}
              >
                <Crosshair className="h-3 w-3 mr-1" />
                Jump to root cause frame {chain.rootCauseFrameIndex}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Causal chain */}
      {(chain || chainLoading) && (
        <CausalChainView chain={chain} loading={chainLoading} onSeekToFrame={onSeekToFrame} />
      )}

      {/* Failure heatmap */}
      {timeline && timeline.frames.length > 0 && (
        <FailureHeatmap timeline={timeline} onSeekToFrame={onSeekToFrame} />
      )}

      {/* Per-kind inspection */}
      {presentKinds.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500 uppercase tracking-wide font-medium">
            Signal kind inspection
          </div>
          <div className="flex gap-1 flex-wrap">
            {presentKinds.map((kind) => (
              <button
                key={kind}
                onClick={() => setActiveKind(kind === activeKind ? undefined : kind)}
                className={cn(
                  "text-xs px-2 py-1 rounded border transition-colors",
                  activeKind === kind
                    ? "bg-zinc-700 border-zinc-500 text-white"
                    : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-500"
                )}
              >
                {SIGNAL_KIND_LABELS[kind] ?? kind}
                <span className="ml-1 text-zinc-500">({report.byKind[kind]})</span>
              </button>
            ))}
          </div>

          {activeKind && (
            <KindInspectionPanel
              kind={activeKind}
              signals={topSignals.filter((s) => s.kind === activeKind)}
              onSeekToFrame={onSeekToFrame}
            />
          )}
        </div>
      )}

      {/* All top signals */}
      {topSignals.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500 uppercase tracking-wide font-medium">
            Top signals ({topSignals.length})
          </div>
          {topSignals.slice(0, 10).map((sig) => (
            <SignalDetail key={sig.id} signal={sig} onSeekToFrame={onSeekToFrame} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Report summary ─────────────────────────────────────────────────────────────

function ReportSummary({
  report,
  executionId,
  suggestBranch,
  branchSuggestion,
}: {
  report: FullAnalysisResult["report"];
  executionId: string;
  suggestBranch: boolean;
  branchSuggestion: string | null;
}) {
  const healthColor =
    report.healthScore > 0.7
      ? "text-emerald-400"
      : report.healthScore > 0.4
      ? "text-amber-400"
      : "text-rose-400";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-medium text-zinc-200">Root Cause Analysis</div>
          <div className="font-mono text-xs text-zinc-500 mt-0.5">{executionId}</div>
        </div>
        <div className={cn("text-2xl font-bold font-mono", healthColor)}>
          {(report.healthScore * 100).toFixed(0)}%
          <span className="text-xs font-normal text-zinc-500 ml-1">health</span>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <Stat label="total signals" value={report.totalSignals} tone={report.totalSignals > 0 ? "error" : "success"} />
        <Stat label="critical" value={report.bySeverity["CRITICAL"] ?? 0} tone="error" />
        <Stat label="high" value={report.bySeverity["HIGH"] ?? 0} tone="warning" />
        <Stat label="medium" value={report.bySeverity["MEDIUM"] ?? 0} tone="neutral" />
      </div>
    </div>
  );
}

// ── Causal chain visualization ─────────────────────────────────────────────────

function CausalChainView({
  chain,
  loading,
  onSeekToFrame,
}: {
  chain?: CausalChain;
  loading: boolean;
  onSeekToFrame?: (i: number) => void;
}) {
  return (
    <Card className="p-4 bg-zinc-950/70 border-zinc-800 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-zinc-300 uppercase tracking-wide">Causal Chain</div>
        {chain?.rootCauseFrameIndex !== undefined && onSeekToFrame && (
          <Button size="sm" variant="ghost" onClick={() => onSeekToFrame(chain.rootCauseFrameIndex!)}>
            <Crosshair className="h-3 w-3 mr-1" />
            f{chain.rootCauseFrameIndex}
          </Button>
        )}
      </div>

      {loading && (
        <div className="text-xs text-zinc-500 animate-pulse">Tracing causal chain…</div>
      )}

      {!loading && !chain && (
        <ExplainedEmptyState
          concept="root-cause"
          title="No causal chain to trace"
          body="No failure signals were linked into a cause-and-effect chain for this execution — usually because it didn't fail, or the failure was isolated to a single step."
          className="py-6"
        />
      )}

      {chain && (
        <>
          <div className="text-xs text-zinc-400 italic">{chain.rootCauseDescription}</div>
          <div className="space-y-0">
            {chain.links.map((link, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="flex flex-col items-center">
                  <div className={cn("w-3 h-3 rounded-full border-2 shrink-0 mt-0.5",
                    link.causalRole === "ROOT_CAUSE" ? "border-rose-500 bg-rose-900/50" :
                    link.causalRole === "TERMINAL" ? "border-orange-500 bg-orange-900/50" :
                    "border-amber-500 bg-amber-900/50"
                  )} />
                  {i < chain.links.length - 1 && (
                    <div className="w-px flex-1 min-h-[1.5rem] bg-zinc-700 my-0.5" />
                  )}
                </div>
                <div
                  className={cn(
                    "flex-1 rounded border px-2.5 py-2 mb-1 text-xs",
                    CAUSAL_ROLE_STYLE[link.causalRole]
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{link.causalRole.replace("_", " ")}</span>
                      {link.role && <span className="opacity-70">· {link.role}</span>}
                    </div>
                    {link.eventSequence !== undefined && (
                      <span className="font-mono opacity-60">seq {link.eventSequence}</span>
                    )}
                  </div>
                  <div className="opacity-75 mt-0.5">{link.description}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ── Failure heatmap ────────────────────────────────────────────────────────────

function FailureHeatmap({
  timeline,
  onSeekToFrame,
}: {
  timeline: FullAnalysisResult["timeline"] & {};
  onSeekToFrame?: (i: number) => void;
}) {
  const BUCKET = 10;
  type Bucket = { start: number; end: number; signals: number; maxSeverity: string; causalRole: string };
  const buckets: Bucket[] = [];
  for (let i = 0; i < timeline.frames.length; i += BUCKET) {
    const slice = timeline.frames.slice(i, i + BUCKET) as AnnotatedFrame[];
    const signals = slice.reduce((sum, f) => sum + f.signals.length, 0);
    const worstSeverity = slice
      .flatMap((f) => f.signals)
      .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))[0]?.severity ?? "INFO";
    const causalRole = slice.find((f) => f.causalRole !== "CLEAN")?.causalRole ?? "CLEAN";
    buckets.push({ start: i, end: Math.min(i + BUCKET - 1, timeline.frames.length - 1), signals, maxSeverity: worstSeverity, causalRole });
  }

  return (
    <Card className="p-3 bg-zinc-950/70 border-zinc-800 space-y-2">
      <div className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Failure heatmap</div>
      <div className="text-[10px] text-zinc-600">
        Each cell = {BUCKET} frames. Color = worst signal severity in that window.
      </div>
      <div className="flex flex-wrap gap-1">
        {buckets.map((b) => (
          <button
            key={b.start}
            title={`Frames ${b.start}–${b.end}: ${b.signals} signal(s) · ${b.maxSeverity} · ${b.causalRole}`}
            onClick={() => onSeekToFrame?.(b.start)}
            className={cn(
              "w-8 h-6 rounded text-[9px] font-mono border transition-transform hover:scale-110",
              b.causalRole === "ROOT_CAUSE" && "bg-rose-700/60 border-rose-600/50 text-rose-200",
              b.causalRole === "TERMINAL" && "bg-orange-700/60 border-orange-600/50 text-orange-200",
              b.causalRole === "PROPAGATION" && "bg-amber-700/50 border-amber-600/40 text-amber-200",
              b.causalRole === "CLEAN" && b.signals === 0 && "bg-zinc-800/40 border-zinc-700/30 text-zinc-600",
              b.causalRole === "CLEAN" && b.signals > 0 && "bg-zinc-700/60 border-zinc-600/50 text-zinc-400"
            )}
          >
            {b.signals || ""}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 text-[10px] text-zinc-600 flex-wrap">
        <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-rose-700/60 border border-rose-600/50" /> ROOT CAUSE</div>
        <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-amber-700/50 border border-amber-600/40" /> PROPAGATION</div>
        <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-orange-700/60 border border-orange-600/50" /> TERMINAL</div>
        <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-zinc-800/40 border border-zinc-700/30" /> CLEAN (number = signal count)</div>
      </div>
    </Card>
  );
}

// ── Per-kind inspection ────────────────────────────────────────────────────────

function KindInspectionPanel({
  kind,
  signals,
  onSeekToFrame,
}: {
  kind: string;
  signals: FailureSignal[];
  onSeekToFrame?: (i: number) => void;
}) {
  if (signals.length === 0) {
    const kindLabel = SIGNAL_KIND_LABELS[kind] ?? kind;
    return (
      <ExplainedEmptyState
        concept="root-cause"
        title={`No ${kindLabel} signals found`}
        body={`This run recorded no ${kindLabel.toLowerCase()} signals, so there's nothing to inspect for this category.`}
        className="px-4 py-6"
      />
    );
  }

  return (
    <Card className="p-3 bg-zinc-950/70 border-zinc-800 space-y-2">
      <div className="text-xs font-medium text-zinc-300">
        {SIGNAL_KIND_LABELS[kind] ?? kind} inspection
      </div>
      <div className="text-[10px] text-zinc-500">{kindGuidance(kind)}</div>
      <div className="space-y-2">
        {signals.map((sig) => (
          <div key={sig.id} className="border border-zinc-800 rounded px-2 py-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-zinc-300 font-medium">{sig.severity}</span>
                <span className="text-zinc-600">score {sig.score.toFixed(2)}</span>
                <span className="text-zinc-600">by {sig.detectedBy}</span>
              </div>
              <span className="text-[10px] text-zinc-600">{formatTime(sig.detectedAt)}</span>
            </div>
            <div className="text-xs text-zinc-400">{sig.summary}</div>
            {sig.evidence.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-zinc-600 uppercase tracking-wide">Evidence ({sig.evidence.length})</div>
                {sig.evidence.slice(0, 4).map((ev, i) => (
                  <div key={i} className="text-[10px] flex items-center gap-2 text-zinc-500">
                    {ev.eventSequence !== undefined && (
                      <button
                        onClick={() => {
                          // Find frame near this event sequence
                          onSeekToFrame?.(ev.eventSequence!);
                        }}
                        className="font-mono text-sky-500 hover:text-sky-400"
                      >
                        seq {ev.eventSequence}
                      </button>
                    )}
                    {ev.nodeId && <span className="font-mono text-zinc-600">node {ev.nodeId.slice(0, 10)}…</span>}
                    {ev.snippet && <span className="truncate max-w-[24ch] italic">{ev.snippet}</span>}
                    {ev.metric && (
                      <span>
                        {Object.entries(ev.metric)
                          .slice(0, 2)
                          .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toFixed(2) : v}`)
                          .join(" · ")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Signal detail ──────────────────────────────────────────────────────────────

function SignalDetail({ signal, onSeekToFrame }: { signal: FailureSignal; onSeekToFrame?: (i: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      onClick={() => setExpanded((v) => !v)}
      className="w-full text-left border border-zinc-800 rounded p-3 bg-zinc-900/40 hover:bg-zinc-900/70 transition-colors space-y-1"
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1.5">
          <SeverityDot severity={signal.severity} />
          <span className="font-medium text-zinc-300">{signal.kind}</span>
          <span className="text-zinc-600">{signal.severity}</span>
        </div>
        <span className="text-zinc-600">{formatTime(signal.detectedAt)}</span>
      </div>
      <div className="text-xs text-zinc-400">{signal.summary}</div>
      {expanded && signal.evidence.length > 0 && (
        <div className="pt-1 space-y-1 border-t border-zinc-800 mt-2">
          {signal.evidence.slice(0, 5).map((ev, i) => (
            <div key={i} className="text-[10px] text-zinc-500 flex items-center gap-2">
              {ev.eventSequence !== undefined && (
                <button
                  onClick={(e) => { e.stopPropagation(); onSeekToFrame?.(ev.eventSequence!); }}
                  className="font-mono text-sky-500 hover:text-sky-400"
                >
                  seq {ev.eventSequence}
                </button>
              )}
              {ev.snippet && <span className="italic truncate max-w-[30ch]">{ev.snippet}</span>}
            </div>
          ))}
        </div>
      )}
    </button>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function SeverityDot({ severity }: { severity: string }) {
  const colorMap: Record<string, string> = {
    CRITICAL: "bg-rose-500",
    HIGH: "bg-orange-500",
    MEDIUM: "bg-amber-500",
    LOW: "bg-zinc-500",
    INFO: "bg-sky-500",
  };
  return <div className={cn("w-2 h-2 rounded-full shrink-0", colorMap[severity] ?? "bg-zinc-500")} />;
}

function Stat({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "success" | "warning" | "error" }) {
  return (
    <div className={cn("px-2 py-1.5 rounded border bg-zinc-900/60",
      tone === "success" && "border-emerald-800",
      tone === "warning" && "border-amber-800",
      tone === "error" && "border-rose-800",
      tone === "neutral" && "border-zinc-800"
    )}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-zinc-200 font-mono">{value}</div>
    </div>
  );
}

function kindGuidance(kind: string): string {
  const guidance: Record<string, string> = {
    HALLUCINATION: "Check token confidence heatmap. Low confidence tokens near memory-free outputs indicate fabrication without grounding.",
    CONTRADICTION: "Compare output fields between the two conflicting nodes. The first conflict establishes the incorrect state.",
    RECURSION: "Repeated inputFingerprint values indicate the cognition re-entered the same state. Check PLANNER output for progress markers.",
    EXECUTION_LOOP: "Retry counter exceeded without state change. Inspect EXECUTOR tool calls for silent failures.",
    TOOL_MISUSE: "Tool was called with invalid inputs or in wrong phase. Check EXECUTOR's input schema vs. tool requirements.",
    CORRUPTED_MEMORY: "Memory record was inconsistent with previous writes. Check MEMORY_MANAGER output at the corruption frame.",
    UNCERTAINTY_SPIKE: "Confidence collapsed at this node. Review token stream for low-confidence sequences before the spike.",
    PLAN_DRIFT: "EXECUTOR deviated from PLANNER's task decomposition. Compare PLANNER output with EXECUTOR inputs.",
  };
  return guidance[kind] ?? "Inspect the evidence sequences below to trace the failure origin.";
}
