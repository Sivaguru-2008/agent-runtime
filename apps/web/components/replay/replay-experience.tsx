"use client";

/**
 * PHASE 6 — Replay Experience
 *
 * The primary operator product: a unified debugging workspace that composes
 * all Phase 6 components into a single, navigable surface.
 *
 * Six panels, each answering a different operational question:
 *
 *   Timeline  — "Where in the execution did failure begin?"
 *               ExecutionTimelineViewer with causality annotation
 *               and health degradation curve.
 *
 *   Scrubber  — "What was the execution state at frame X?"
 *               TimeTravelDebugger with step/play/pause controls
 *               and snapshot + branch actions.
 *
 *   Nodes     — "What did each agent decide and why?"
 *               CognitionNodeExplorer with lineage traversal,
 *               token stream, and memory influence view.
 *
 *   Root Cause — "What caused this failure?"
 *               FailureRootCausePanel with causal chain,
 *               heatmap, and per-kind signal inspection.
 *
 *   Console   — "How do I fix or replay this execution?"
 *               OperatorReplayConsole with pause/branch/inject/compare.
 *
 *   Determinism — "Can I trust this replay?"
 *               ReplayDeterminismPanel with fingerprint verification.
 *
 * Cross-panel coordination:
 *   - Seek-to-frame events propagate from Root Cause → Scrubber
 *   - Branch-from-node events propagate from Node Explorer → Console
 *   - Active replay frame propagates from Scrubber → Console inject targeting
 *   - All panels are keyed on cognitionId so they reload when the execution changes
 */

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  GitBranch,
  Network,
  AlertTriangle,
  Terminal,
  ShieldCheck,
  Search,
  Copy,
  Check,
} from "lucide-react";
import { cognitionApi, type CognitionListItem, type ReplaySession } from "@/lib/cognition-api";
import { ExecutionTimelineViewer } from "./execution-timeline-viewer";
import { TimeTravelDebugger } from "./time-travel-debugger";
import { CognitionNodeExplorer } from "./cognition-node-explorer";
import { FailureRootCausePanel } from "./failure-root-cause-panel";
import { OperatorReplayConsole } from "./operator-replay-console";
import { ReplayDeterminismPanel } from "./replay-determinism-panel";
import { ExecutionMetadataPanel } from "@/components/ui/execution-metadata-panel";
import type { ReplayFrame } from "@/lib/cognition-api";
import { ExplainLabel } from "@/components/explain/explain-label";
import { getConcept } from "@/lib/explain/registry";

type ReplayPanel = "timeline" | "scrubber" | "nodes" | "rootcause" | "console" | "determinism";

// `concept` ties each panel to its registry entry so first-time users get a
// plain-language explanation (hover) and the full click-to-learn panel (click).
const PANELS: { id: ReplayPanel; label: string; icon: React.ReactNode; description: string; concept: string }[] = [
  { id: "timeline", label: "Timeline", icon: <Activity className="h-4 w-4" />, description: "Causality-annotated frame timeline with health curve", concept: "timeline" },
  { id: "scrubber", label: "Scrubber", icon: <GitBranch className="h-4 w-4" />, description: "Step-by-step replay with snapshot and branch controls", concept: "scrubber" },
  { id: "nodes", label: "Nodes", icon: <Network className="h-4 w-4" />, description: "Agent node inspector with lineage traversal", concept: "nodes" },
  { id: "rootcause", label: "Root Cause", icon: <AlertTriangle className="h-4 w-4" />, description: "Failure heatmap, causal chain, and per-kind inspection", concept: "root-cause" },
  { id: "console", label: "Console", icon: <Terminal className="h-4 w-4" />, description: "Pause, branch, inject, and compare operator controls", concept: "inject" },
  { id: "determinism", label: "Determinism", icon: <ShieldCheck className="h-4 w-4" />, description: "Fingerprint verification and replay trust score", concept: "determinism" },
];

export function ReplayExperience() {
  const [activePanel, setActivePanel] = useState<ReplayPanel>("timeline");
  const [cognitionId, setCognitionId] = useState<string | undefined>();
  const [executionId, setExecutionId] = useState<string | undefined>();
  const [traceId, setTraceId] = useState<string | undefined>();
  const [runtimeId, setRuntimeId] = useState<string | undefined>();
  const [mode, setMode] = useState<string | undefined>();
  const [cognitions, setCognitions] = useState<CognitionListItem[]>([]);
  const [inputId, setInputId] = useState("");
  const [replaySession] = useState<ReplaySession | undefined>();
  const [frames, setFrames] = useState<ReplayFrame[]>([]);
  const [seekTarget, setSeekTarget] = useState<number | undefined>();

  // Load recent cognitions for the picker
  useEffect(() => {
    cognitionApi.list(20).then(setCognitions).catch(() => {});
  }, []);

  // Auto-derive executionId from cognitionId so the operator does not have to
  // re-enter it for the Root Cause and Console panels — and load the real
  // replay frames that feed the Determinism panel (previously this panel was
  // never wired to data, so it always showed "No replay frames").
  useEffect(() => {
    if (!cognitionId) {
      setExecutionId(undefined);
      setTraceId(undefined);
      setRuntimeId(undefined);
      setMode(undefined);
      setFrames([]);
      return;
    }
    let cancelled = false;
    cognitionApi
      .get(cognitionId)
      .then((view) => {
        if (cancelled) return;
        setExecutionId(view.graph.executionId);
        setTraceId(view.traceId ?? view.graph.traceId);
        setRuntimeId(view.runtimeId);
        setMode(
          view.graph.nodes?.some((n) => (n.output as Record<string, unknown> | undefined)?.modelBacked)
            ? "MODEL-BACKED"
            : "DETERMINISTIC"
        );
      })
      .catch(() => {});
    cognitionApi
      .listFrames(cognitionId)
      .then((f) => { if (!cancelled) setFrames(f); })
      .catch(() => { if (!cancelled) setFrames([]); });
    return () => { cancelled = true; };
  }, [cognitionId]);

  const handleSelect = (cid: string) => {
    setCognitionId(cid);
    setSeekTarget(undefined);
  };

  const handleSeekToFrame = useCallback((frameIndex: number) => {
    setSeekTarget(frameIndex);
    setActivePanel("scrubber");
  }, []);

  const handleBranchFromNode = useCallback((nodeId: string, cid: string) => {
    setCognitionId(cid);
    setActivePanel("console");
  }, []);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-white">Replay Experience</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Replayable · Inspectable · Debuggable · Repairable
          </p>
        </div>
        {cognitionId && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-zinc-500 font-medium">Cognition ID:</span>
            <div className="font-mono text-xs text-zinc-300 bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 select-all hover:text-white transition-colors">
              {cognitionId}
            </div>
            <CopyButton text={cognitionId} />
          </div>
        )}
      </div>

      {/* Cognition selector */}
      <CognitionSelector
        cognitions={cognitions}
        selected={cognitionId}
        inputId={inputId}
        onInputChange={setInputId}
        onSelect={handleSelect}
      />

      {!cognitionId && (
        <div className="text-zinc-500 text-sm p-8 text-center border border-zinc-800 rounded-lg">
          Select a cognition above to begin the replay investigation.
          <div className="mt-2 text-xs text-zinc-600">
            Recent executions are listed automatically. Paste any cognition ID to load it directly.
          </div>
        </div>
      )}

      {cognitionId && (
        <>
          {/* Execution identity — copyable IDs shared across all replay panels */}
          <ExecutionMetadataPanel
            cognitionId={cognitionId}
            executionId={executionId}
            runId={executionId}
            traceId={traceId}
            runtimeId={runtimeId}
            mode={mode}
            title="Replay Target"
          />

          {/* Panel tabs */}
          <div className="border-b border-zinc-800">
            <nav className="flex gap-0 overflow-x-auto">
              {PANELS.map(({ id, label, icon, description }) => (
                <button
                  key={id}
                  onClick={() => setActivePanel(id)}
                  title={description}
                  className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
                    activePanel === id
                      ? "border-blue-500 text-white"
                      : "border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
                  }`}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </nav>
          </div>

          {/* Plain-language explanation of the active panel */}
          <ReplayPanelHeader panel={activePanel} />

          {/* Active panel content */}
          <div className="min-h-[400px]">
            {activePanel === "timeline" && (
              <ExecutionTimelineViewer
                cognitionId={cognitionId}
                onSeekToFrame={handleSeekToFrame}
                onBranchFromFrame={(frameIndex) => {
                  setSeekTarget(frameIndex);
                  setActivePanel("console");
                }}
                activeFrameIndex={replaySession?.cursor.frameIndex}
              />
            )}

            {activePanel === "scrubber" && (
              <div className="space-y-2">
                {seekTarget !== undefined && (
                  <div className="text-xs text-amber-400 bg-amber-950/20 border border-amber-800/40 rounded px-2 py-1">
                    Seeking to frame {seekTarget} — scrubber will jump when session loads.
                  </div>
                )}
                <TimeTravelDebugger cognitionId={cognitionId} />
              </div>
            )}

            {activePanel === "nodes" && (
              <CognitionNodeExplorer
                cognitionId={cognitionId}
                onBranchFromNode={handleBranchFromNode}
              />
            )}

            {activePanel === "rootcause" && executionId && (
              <FailureRootCausePanel
                executionId={executionId}
                onSeekToFrame={handleSeekToFrame}
              />
            )}

            {activePanel === "rootcause" && !executionId && (
              <ExecutionIdInput
                label="Root Cause Analysis requires an execution ID"
                onSubmit={(eid) => { setExecutionId(eid); }}
              />
            )}

            {activePanel === "console" && executionId && (
              <OperatorReplayConsole
                executionId={executionId}
                cognitionId={cognitionId}
                activeFrameIndex={replaySession?.cursor.frameIndex}
              />
            )}

            {activePanel === "console" && !executionId && (
              <ExecutionIdInput
                label="Console requires an execution ID to inspect lease and worker state"
                onSubmit={(eid) => { setExecutionId(eid); }}
              />
            )}

            {activePanel === "determinism" && (
              <ReplayDeterminismPanel
                frames={frames}
                onSeekToFrame={handleSeekToFrame}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Per-panel explanation header ─────────────────────────────────────────────

function ReplayPanelHeader({ panel }: { panel: ReplayPanel }) {
  const meta = PANELS.find((p) => p.id === panel);
  if (!meta) return null;
  const concept = getConcept(meta.concept);
  if (!concept) return null;
  return (
    <div className="my-3 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <ExplainLabel concept={meta.concept} as="span" className="text-sm font-semibold text-zinc-200">
          {concept.label}
        </ExplainLabel>
        <span className="text-xs text-zinc-500">— {concept.short}</span>
      </div>
      {/* The Console hosts the operator actions the user listed individually. */}
      {panel === "console" ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
          <span className="text-zinc-500">Actions:</span>
          <ExplainLabel concept="branch">Branch</ExplainLabel>
          <ExplainLabel concept="inject">Inject</ExplainLabel>
          <ExplainLabel concept="compare">Compare</ExplainLabel>
        </div>
      ) : null}
    </div>
  );
}

// ── Cognition selector ─────────────────────────────────────────────────────────

function CognitionSelector({
  cognitions,
  selected,
  inputId,
  onInputChange,
  onSelect,
}: {
  cognitions: CognitionListItem[];
  selected?: string;
  inputId: string;
  onInputChange: (v: string) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          value={inputId}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder="Paste cognition ID…"
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-blue-500"
        />
        <button
          onClick={() => { if (inputId.trim()) onSelect(inputId.trim()); }}
          disabled={!inputId.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded font-medium transition-colors flex items-center gap-1.5"
        >
          <Search className="h-4 w-4" />
          Load
        </button>
      </div>

      {cognitions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {cognitions.slice(0, 12).map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`text-xs px-2.5 py-1 rounded border transition-colors font-mono ${
                selected === c.id
                  ? "border-blue-500 bg-blue-950/30 text-blue-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500"
              }`}
            >
              {c.id.slice(0, 10)}…
              {c.hasFailureSignals && <span className="ml-1 text-rose-500">●</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Execution ID input fallback ────────────────────────────────────────────────

function ExecutionIdInput({ label, onSubmit }: { label: string; onSubmit: (id: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="space-y-3 p-4 border border-zinc-800 rounded">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste execution ID…"
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-blue-500"
        />
        <button
          onClick={() => { if (value.trim()) onSubmit(value.trim()); }}
          disabled={!value.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded font-medium transition-colors"
        >
          Load
        </button>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      className="p-1 text-zinc-500 hover:text-zinc-300 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded transition-colors active:scale-95 flex items-center justify-center h-7 w-7"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400 animate-in fade-in zoom-in-50 duration-150" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
