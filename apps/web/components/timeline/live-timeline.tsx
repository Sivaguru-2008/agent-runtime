"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, History, ShieldCheck, HelpCircle, Activity, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExplainedEmptyState } from "@/components/explain/empty-state";
import { formatDuration, formatTime } from "@/lib/utils";
import type { LiveEvent } from "@/events/live-events";
import type { LiveExecutionView } from "@/stores/execution-store";
import { cn } from "@/lib/utils";

interface Props {
  view?: LiveExecutionView;
}

export function LiveTimeline({ view }: Props) {
  const frames = useMemo(() => buildFrames(view), [view]);
  const [override, setOverride] = useState<number | null>(null);
  const [explainMode, setExplainMode] = useState(false);

  const index = override ?? Math.max(0, frames.length - 1);
  const frame = frames[index];

  const playhead = frames.length <= 1 ? 0 : (index / (frames.length - 1)) * 100;
  const buildSnapshot = (i: number) => frames.slice(0, i + 1).filter((f) => f.type === "TOKEN_STREAM").map((f) => f.token ?? "").join("");
  const snapshotText = frame ? (frame.type === "TOKEN_STREAM" || frame.type === "MODEL_COMPLETE" ? buildSnapshot(index) : (view?.prompt ?? "")) : "";

  return (
    <Card className="h-[460px] bg-zinc-950 border-zinc-800 shadow-2xl relative overflow-hidden text-zinc-100">
      {/* Decorative gradient overlay for premium infrastructure feel */}
      <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/5 rounded-full blur-3xl pointer-events-none" />
      
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 border-b border-zinc-900">
        <div className="space-y-0.5">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-white">
            <History className="h-4 w-4 text-blue-400" />
            Live Reliability Timeline
          </CardTitle>
          <p className="text-[11px] text-zinc-500">
            Real-time transaction & execution safety stream
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Explain Reliability Mode Toggle */}
          <button
            onClick={() => setExplainMode(!explainMode)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium border rounded-md transition-all active:scale-95 duration-150",
              explainMode
                ? "bg-indigo-950/40 border-indigo-700/60 text-indigo-300 shadow-[0_0_12px_rgba(99,102,241,0.15)]"
                : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-300 hover:border-zinc-700"
            )}
          >
            <ShieldCheck className={cn("h-3.5 w-3.5", explainMode ? "text-indigo-400 animate-pulse" : "text-zinc-500")} />
            Explain Reliability
          </button>

          <div className="flex items-center gap-1.5">
            <Button
              size="icon"
              variant="secondary"
              className="h-7 w-7 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-400"
              onClick={() => setOverride(Math.max(0, index - 1))}
              disabled={frames.length === 0}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              className="h-7 w-7 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-400"
              onClick={() => setOverride(Math.min(frames.length - 1, index + 1))}
              disabled={frames.length === 0}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button 
              size="sm" 
              variant="ghost" 
              className="h-7 text-xs text-zinc-400 hover:text-zinc-200"
              onClick={() => setOverride(null)}
            >
              Live
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        {/* Scrubber slider track */}
        <div className="space-y-1.5">
          <input
            aria-label="Timeline scrubber"
            type="range"
            min={0}
            max={Math.max(0, frames.length - 1)}
            value={index}
            onChange={(event) => setOverride(Number(event.target.value))}
            className="w-full accent-blue-500 bg-zinc-800 h-1 rounded-lg cursor-pointer appearance-none"
          />
          <div className="flex justify-between text-[9px] font-mono text-zinc-600">
            <span>SEQUENCE START</span>
            <span>{override === null ? "LIVE STREAMING" : `PAUSED @ FRAME ${index + 1}`}</span>
            <span>COMPLETE</span>
          </div>
        </div>

        {explainMode && (
          <div className="bg-indigo-950/20 border border-indigo-900/40 rounded-lg p-2.5 text-xs text-indigo-300 flex items-start gap-2 animate-in fade-in slide-in-from-top-2 duration-200">
            <HelpCircle className="h-4 w-4 shrink-0 text-indigo-400 mt-0.5" />
            <div className="space-y-1">
              <span className="font-semibold block text-indigo-200">Reliability Mode Active</span>
              <p className="text-[11px] text-indigo-300/90 leading-normal">
                Every event in this stream is validated by our event-sourced transaction layer. If an infrastructure step crashes, the sandbox bypasses completed API operations and restores memory deterministically.
              </p>
            </div>
          </div>
        )}

        {frame ? (
          <div className="grid gap-4 md:grid-cols-[200px_1fr]">
            <div className="space-y-2 bg-zinc-900/40 border border-zinc-900 rounded-lg p-3 relative">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono font-semibold text-zinc-500">FRAME #{index + 1}</span>
                <span className={cn(
                  "text-[9px] px-1.5 py-0.5 font-bold uppercase rounded border tracking-wider",
                  frame.stateColor === "nominal" && "bg-emerald-950/30 border-emerald-900/60 text-emerald-400",
                  frame.stateColor === "warning" && "bg-amber-950/30 border-amber-900/60 text-amber-400",
                  frame.stateColor === "incident" && "bg-rose-950/30 border-rose-900/60 text-rose-400",
                  frame.stateColor === "recovery" && "bg-indigo-950/30 border-indigo-900/60 text-indigo-400",
                  frame.stateColor === "replay" && "bg-blue-950/30 border-blue-900/60 text-blue-400"
                )}>
                  {frame.stateColor}
                </span>
              </div>
              <div className="space-y-1">
                <h4 className="text-xs font-semibold text-zinc-200 leading-snug">{frame.title}</h4>
                <p className="text-[11px] text-zinc-500 leading-normal">{frame.description}</p>
              </div>

              <div className="pt-2 border-t border-zinc-900 space-y-1 text-[10px] font-mono text-zinc-500">
                <div className="flex justify-between">
                  <span>Timestamp:</span>
                  <span className="text-zinc-400">{formatTime(frame.timestamp)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Compute:</span>
                  <span className="text-zinc-400">{frame.latencyMs > 0 ? formatDuration(frame.latencyMs) : "0ms"}</span>
                </div>
                <div className="flex justify-between">
                  <span>Tokens:</span>
                  <span className="text-zinc-400">{frame.tokens || "—"}</span>
                </div>
              </div>

              {explainMode && frame.explanation && (
                <div className="mt-2.5 pt-2 border-t border-indigo-950 text-[10px] text-indigo-400 leading-normal animate-in fade-in duration-200">
                  <span className="font-semibold block text-indigo-300 mb-0.5">Transactional Guarantee:</span>
                  {frame.explanation}
                </div>
              )}
            </div>

            <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/30 flex flex-col h-[280px]">
              <div className="border-b border-zinc-900 bg-zinc-950 px-3.5 py-2.5 flex items-center justify-between text-[11px] font-mono font-semibold text-zinc-500">
                <span>{frame.type === "PROMPT_RECEIVED" || frame.type === "MODEL_START" ? "INPUT GOAL CONFIG" : "ACTIVE WORKSPACE LOG"}</span>
                <span className="flex items-center gap-1"><Activity className="h-3 w-3 text-blue-400 animate-pulse" /> Sandbox Mode</span>
              </div>
              <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[11px] text-zinc-300 leading-relaxed bg-zinc-950/40">
                {frame.type === "PROMPT_RECEIVED" || frame.type === "MODEL_START"
                  ? view?.prompt ?? ""
                  : snapshotText}
              </pre>
            </div>
          </div>
        ) : (
          <ExplainedEmptyState
            concept="timeline"
            icon={<Sparkles className="h-5 w-5 animate-pulse" />}
            title="No active sandbox processes running"
            body="Submit a goal from the agent explorer to boot the timeline."
            className="h-64"
          />
        )}
      </CardContent>
    </Card>
  );
}

interface Frame {
  id: string;
  type: LiveEvent["type"];
  title: string;
  description: string;
  explanation?: string;
  timestamp: string;
  latencyMs: number;
  tokens: number;
  token?: string;
  stateColor: "nominal" | "warning" | "incident" | "recovery" | "replay";
}

function buildFrames(view?: LiveExecutionView): Frame[] {
  if (!view) return [];
  return view.events.map((event, index) => {
    void index;
    
    // Human readable translation engine for Live Events
    let title = event.type as string;
    let description = "Processing state transition inside the workflow container.";
    let stateColor: Frame["stateColor"] = "nominal";
    let explanation = "";

    switch (event.type) {
      case "PROMPT_RECEIVED":
        title = "Prompt received";
        description = "Prompt submitted to the runtime; preparing the model call.";
        stateColor = "nominal";
        explanation = "The run starts from this prompt — every following frame is derived from it.";
        break;
      case "MODEL_START":
        title = "Model generation started";
        description = `Calling model: ${event.model}.`;
        stateColor = "replay";
        explanation = "Token streaming begins; each token is captured for replay.";
        break;
      case "TOKEN_STREAM":
        title = "Streaming tokens";
        description = `Received ${event.tokensSoFar} token(s) so far.`;
        stateColor = "replay";
        explanation = "Streamed output is captured incrementally so the trace survives a stalled connection.";
        break;
      case "MODEL_COMPLETE":
        title = "Model generation completed";
        description = `Completed. Total usage: ${event.totalTokens} tokens.`;
        stateColor = "nominal";
        explanation = "The model finished generating; final token usage is recorded.";
        break;
      case "MODEL_ERROR":
        title = "Model error";
        description = `Generation failed${event.code ? ` (code: ${event.code})` : ""}${event.message ? `: ${event.message}` : ""}.`;
        stateColor = "incident";
        explanation = "The model provider returned an error for this run. The exact code/message is shown above.";
        break;
      case "EXECUTION_STATE":
        if (event.state === "FAILED") {
          title = "Execution failed";
          description = "The run ended in a FAILED state. See the response/error for the originating reason.";
          stateColor = "incident";
          explanation = "A terminal failure state was recorded for this execution.";
        } else if ((event.state as string) === "REPLAYING" || (event.state as string) === "RECOVERING") {
          title = `Execution ${String(event.state).toLowerCase()}`;
          description = "The runtime is re-deriving state from a durable checkpoint.";
          stateColor = "recovery";
          explanation = "Recovery resumes work without repeating already-committed steps.";
        } else if (event.state === "COMPLETED") {
          title = "Execution completed";
          description = "The run completed successfully; state is sealed in the event log.";
          stateColor = "nominal";
          explanation = "End of the run — the trace is marked complete.";
        } else {
          title = `Status: ${event.state}`;
          description = "Execution state transition.";
          stateColor = "nominal";
        }
        break;
    }

    const base: Frame = {
      id: `${event.executionId}-${event.sequence}`,
      type: event.type,
      title,
      description,
      explanation,
      timestamp: event.timestamp,
      latencyMs: 0,
      tokens: 0,
      stateColor
    };

    if (event.type === "TOKEN_STREAM") {
      base.tokens = event.tokensSoFar;
      base.latencyMs = event.latencyMs;
      base.token = event.token;
    } else if (event.type === "MODEL_COMPLETE") {
      base.tokens = event.totalTokens;
      base.latencyMs = event.latencyMs;
    } else if (event.type === "MODEL_ERROR") {
      base.latencyMs = event.latencyMs;
    }
    return base;
  });
}
