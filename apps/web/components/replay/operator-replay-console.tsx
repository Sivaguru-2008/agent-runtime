"use client";

/**
 * PHASE 6 — Operator Replay Console
 *
 * Operator debugging value:
 *   The central operator control surface for intervening in live executions
 *   and replay sessions. Combines four distinct operational workflows:
 *
 *   1. PAUSE / RESUME — suspend a running execution at its next checkpoint
 *      boundary so the operator can inspect state without race conditions.
 *
 *   2. BRANCH — fork execution state from any cognition node with optional
 *      overrides (seed, model, corrected input). Tests "what would have
 *      happened if the PLANNER had said X instead?"
 *
 *   3. INJECT — queue a corrected input payload at a specific replay frame.
 *      The execution engine picks it up at the next checkpoint and applies
 *      it, effectively giving the agent corrected context without a full restart.
 *
 *   4. COMPARE — select two branch IDs and render a side-by-side diff showing
 *      which frames diverged and which remained identical.
 *
 * Replay UX improvement:
 *   All controls are co-located so the operator doesn't need to navigate
 *   between tabs while debugging. Worker ownership and lease TTL are shown
 *   alongside execution controls so the operator knows whether the execution
 *   is actually running before issuing a pause.
 *
 * Scaling implications:
 *   Pause/resume are O(1) checkpoint writes. Branch is idempotent (deterministic
 *   branch ID). Compare fetches two cognition frames on demand, not upfront.
 *
 * Failure diagnosis improvements:
 *   The operator can close the loop: detect failure (root cause panel) →
 *   pause execution → inject corrected input or branch → compare outcomes.
 *   All within one console without switching screens.
 */

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { operatorApi } from "@/services/operator-api";
import { cognitionApi, type BranchPointer, type ReplayDiff, type CognitionGraphView } from "@/lib/cognition-api";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  GitBranch,
  Pause,
  Play,
  Syringe,
  ArrowLeftRight,
  RefreshCw,
  Server,
} from "lucide-react";

export interface OperatorReplayConsoleProps {
  executionId: string;
  cognitionId?: string;
  /** Active replay frame index for inject targeting */
  activeFrameIndex?: number;
}

type ConsoleTab = "controls" | "branch" | "inject" | "compare";

export function OperatorReplayConsole({ executionId, cognitionId, activeFrameIndex }: OperatorReplayConsoleProps) {
  const [activeTab, setActiveTab] = useState<ConsoleTab>("controls");
  const [diagnosis, setDiagnosis] = useState<Awaited<ReturnType<typeof operatorApi.diagnose>> | undefined>();
  const [cognitionView, setCognitionView] = useState<CognitionGraphView | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const d = await operatorApi.diagnose(executionId);
      setDiagnosis(d);
      if (cognitionId) {
        cognitionApi.get(cognitionId).then(setCognitionView).catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load execution state");
    } finally {
      setLoading(false);
    }
  }, [executionId, cognitionId]);

  useEffect(() => { void load(); }, [load]);

  const TABS: { id: ConsoleTab; label: string; icon: React.ReactNode }[] = [
    { id: "controls", label: "Controls", icon: <Pause className="h-3.5 w-3.5" /> },
    { id: "branch", label: "Branch", icon: <GitBranch className="h-3.5 w-3.5" /> },
    { id: "inject", label: "Inject", icon: <Syringe className="h-3.5 w-3.5" /> },
    { id: "compare", label: "Compare", icon: <ArrowLeftRight className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="space-y-3">
      {/* Header with execution state */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-medium text-zinc-200">Operator Replay Console</div>
          <div className="font-mono text-xs text-zinc-500 mt-0.5">{executionId}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded border border-rose-700/40 bg-rose-950/20 p-2 text-rose-400 text-xs flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      {/* Execution state overview */}
      {diagnosis && <ExecutionStateBar diagnosis={diagnosis} />}

      {/* Tab nav */}
      <div className="flex gap-0 border-b border-zinc-800">
        {TABS.map(({ id, label, icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors",
              activeTab === id
                ? "border-blue-500 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            )}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === "controls" && (
          <PauseResumePanel
            executionId={executionId}
            currentPhase={diagnosis?.checkpoint?.phase}
            onAction={load}
          />
        )}
        {activeTab === "branch" && cognitionId && cognitionView && (
          <BranchPanel
            sourceCognitionId={cognitionId}
            nodes={cognitionView.graph.nodes}
            existingBranches={cognitionView.branches}
            onBranched={load}
          />
        )}
        {activeTab === "branch" && !cognitionId && (
          <div className="text-zinc-500 text-sm p-4 text-center border border-zinc-800 rounded">
            Branch operations require a cognition ID. Use the Cognition Node Explorer to select a node.
          </div>
        )}
        {activeTab === "inject" && (
          <InjectPanel
            executionId={executionId}
            activeFrameIndex={activeFrameIndex}
            onInjected={load}
          />
        )}
        {activeTab === "compare" && cognitionId && (
          <ComparePanel sourceCognitionId={cognitionId} />
        )}
        {activeTab === "compare" && !cognitionId && (
          <div className="text-zinc-500 text-sm p-4 text-center border border-zinc-800 rounded">
            Compare requires a cognition ID to list available branches.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Execution state bar ────────────────────────────────────────────────────────

function ExecutionStateBar({
  diagnosis,
}: {
  diagnosis: Awaited<ReturnType<typeof operatorApi.diagnose>>;
}) {
  const exec = diagnosis.execution;
  const lease = diagnosis.lease;
  const checkpoint = diagnosis.checkpoint;

  const leaseRemainingMs = lease
    ? Math.max(0, new Date(lease.expiresAt).getTime() - Date.now())
    : undefined;
  const leaseExpired = leaseRemainingMs !== undefined && leaseRemainingMs <= 0;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
      <StateCell
        label="status"
        value={exec?.status ?? "unknown"}
        tone={
          exec?.status === "COMPLETED" ? "success" :
          exec?.status === "FAILED" ? "error" :
          exec?.status === "RUNNING" ? "info" :
          "neutral"
        }
      />
      <StateCell
        label="checkpoint phase"
        value={checkpoint?.phase ?? "—"}
        tone={
          checkpoint?.phase === "OPERATOR_PAUSED" ? "warning" :
          checkpoint?.phase === "OPERATOR_INJECTED" ? "info" :
          "neutral"
        }
      />
      <StateCell
        label="worker"
        value={lease?.workerId ? `${lease.workerId.slice(0, 12)}…` : "unowned"}
        tone={lease ? "info" : "neutral"}
        icon={<Server className="h-2.5 w-2.5" />}
      />
      <StateCell
        label="lease TTL"
        value={leaseRemainingMs !== undefined ? `${(leaseRemainingMs / 1000).toFixed(0)}s` : "—"}
        tone={leaseExpired ? "error" : leaseRemainingMs !== undefined && leaseRemainingMs < 5000 ? "warning" : "success"}
      />
    </div>
  );
}

// ── Pause / Resume ─────────────────────────────────────────────────────────────

function PauseResumePanel({
  executionId,
  currentPhase,
  onAction,
}: {
  executionId: string;
  currentPhase?: string;
  onAction: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | undefined>();
  const isPaused = currentPhase === "OPERATOR_PAUSED";

  const handlePause = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      const r = await operatorApi.pauseExecution(executionId);
      setResult(`${r.status} — checkpoint ${r.checkpointId.slice(0, 10)}…`);
      onAction();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Pause failed");
    } finally {
      setBusy(false);
    }
  };

  const handleResume = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      const r = await operatorApi.resumeExecution(executionId);
      setResult(r.status);
      onAction();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Resume failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4 bg-zinc-950/70 border-zinc-800 space-y-4">
      <div className="text-xs text-zinc-400 space-y-1">
        <div className="font-medium text-zinc-300">Execution suspension</div>
        <div className="text-zinc-500">
          Pause writes an <span className="font-mono text-zinc-400">OPERATOR_PAUSED</span> checkpoint.
          The execution engine suspends at its next checkpoint boundary.
          Resume writes <span className="font-mono text-zinc-400">OPERATOR_RESUMED</span> to cancel it.
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          disabled={busy || isPaused}
          onClick={handlePause}
          className="flex items-center gap-2"
        >
          <Pause className="h-4 w-4" />
          {isPaused ? "Already paused" : "Pause execution"}
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !isPaused}
          onClick={handleResume}
          className="flex items-center gap-2"
        >
          <Play className="h-4 w-4" />
          Resume execution
        </Button>
      </div>

      {result && (
        <div className="text-xs text-zinc-400 bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1.5 font-mono">
          {result}
        </div>
      )}

      <div className="border-t border-zinc-800 pt-3 space-y-1 text-xs text-zinc-500">
        <div className="font-medium text-zinc-400">Important</div>
        <ul className="space-y-0.5 list-disc list-inside">
          <li>The execution will complete its current step before suspending.</li>
          <li>Leases are not released on pause — the worker retains ownership.</li>
          <li>Resume does not re-schedule; the worker polls and self-resumes.</li>
          <li>DLQ'd executions cannot be resumed — use Branch instead.</li>
        </ul>
      </div>
    </Card>
  );
}

// ── Branch panel ───────────────────────────────────────────────────────────────

function BranchPanel({
  sourceCognitionId,
  nodes,
  existingBranches,
  onBranched,
}: {
  sourceCognitionId: string;
  nodes: CognitionGraphView["graph"]["nodes"];
  existingBranches: BranchPointer[];
  onBranched: () => void;
}) {
  const [sourceNodeId, setSourceNodeId] = useState(nodes[0]?.id ?? "");
  const [seed, setSeed] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [inputOverride, setInputOverride] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BranchPointer | undefined>();
  const [error, setError] = useState<string | undefined>();

  const handleBranch = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    let parsedInput: Record<string, unknown> | undefined;
    if (inputOverride.trim()) {
      try {
        parsedInput = JSON.parse(inputOverride);
      } catch {
        setError("Input override must be valid JSON");
        setBusy(false);
        return;
      }
    }
    try {
      const pointer = await cognitionApi.branchFromNode({
        sourceCognitionId,
        sourceNodeId,
        reason: reason || `operator branch @ ${new Date().toISOString()}`,
        overrides: {
          ...(seed ? { seed } : {}),
          ...(modelOverride ? { model: modelOverride } : {}),
          ...(parsedInput ? { input: parsedInput } : {}),
        },
      });
      setResult(pointer);
      onBranched();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Branch failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4 bg-zinc-950/70 border-zinc-800 space-y-3">
      <div>
        <div className="text-sm font-medium text-zinc-300 mb-1">Branch from node</div>
        <div className="text-xs text-zinc-500">
          Creates a new cognition forked from the selected node's ancestry. Overrides
          apply to the new branch only — the source cognition is unchanged.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <div>
          <label className="text-xs text-zinc-400 block mb-1">Source node</label>
          <select
            value={sourceNodeId}
            onChange={(e) => setSourceNodeId(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300"
          >
            {nodes.sort((a, b) => a.sequence - b.sequence).map((node) => (
              <option key={node.id} value={node.id}>
                #{node.sequence} {node.role} ({node.status})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-zinc-400 block mb-1">Reason</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why are you branching? (e.g. test corrected planner output)"
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:border-blue-600 outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Seed override</label>
            <input
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="optional seed string"
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:border-blue-600 outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Model override</label>
            <input
              value={modelOverride}
              onChange={(e) => setModelOverride(e.target.value)}
              placeholder="e.g. claude-opus-4-7"
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:border-blue-600 outline-none"
            />
          </div>
        </div>

        <div>
          <label className="text-xs text-zinc-400 block mb-1">Input override (JSON)</label>
          <textarea
            value={inputOverride}
            onChange={(e) => setInputOverride(e.target.value)}
            placeholder='{"task": "corrected task description", ...}'
            rows={3}
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-400 font-mono placeholder-zinc-600 focus:border-blue-600 outline-none resize-y"
          />
        </div>
      </div>

      {error && <div className="text-xs text-rose-400 bg-rose-950/20 border border-rose-800/40 rounded px-2 py-1">{error}</div>}

      <Button onClick={handleBranch} disabled={busy || !sourceNodeId} className="w-full">
        <GitBranch className="h-4 w-4 mr-2" />
        {busy ? "Creating branch…" : "Create branch"}
      </Button>

      {result && (
        <div className="bg-emerald-950/20 border border-emerald-800/40 rounded px-3 py-2 text-xs space-y-1">
          <div className="text-emerald-400 font-medium">Branch created</div>
          <div className="font-mono text-zinc-400">{result.branchCognitionId}</div>
          <div className="text-zinc-500">forked @ frame {result.branchPointFrameIndex}</div>
        </div>
      )}

      {existingBranches.length > 0 && (
        <div className="border-t border-zinc-800 pt-2 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-zinc-600">
            Existing branches ({existingBranches.length})
          </div>
          {existingBranches.slice(0, 5).map((b) => (
            <div key={b.branchCognitionId} className="text-[10px] text-zinc-500 flex items-center gap-2">
              <GitBranch className="h-2.5 w-2.5 text-fuchsia-500" />
              <span className="font-mono">{b.branchCognitionId.slice(0, 16)}…</span>
              <span>@ f{b.branchPointFrameIndex}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Inject panel ───────────────────────────────────────────────────────────────

function InjectPanel({
  executionId,
  activeFrameIndex,
  onInjected,
}: {
  executionId: string;
  activeFrameIndex?: number;
  onInjected: () => void;
}) {
  const [frameIndex, setFrameIndex] = useState(activeFrameIndex ?? 0);
  const [inputJson, setInputJson] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (activeFrameIndex !== undefined) setFrameIndex(activeFrameIndex);
  }, [activeFrameIndex]);

  const handleInject = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(inputJson || "{}");
    } catch {
      setError("Input must be valid JSON");
      setBusy(false);
      return;
    }
    try {
      const r = await operatorApi.injectInput(executionId, frameIndex, parsed, reason || "operator injection");
      setResult(`INJECT_QUEUED · id: ${r.injectionId.slice(0, 14)}…`);
      onInjected();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Inject failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4 bg-zinc-950/70 border-zinc-800 space-y-3">
      <div>
        <div className="text-sm font-medium text-zinc-300 mb-1">Inject corrected input</div>
        <div className="text-xs text-zinc-500">
          Queues a corrected input at the specified replay frame. The execution engine
          applies it at the next checkpoint, giving the agent new context without a
          full restart.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <div>
          <label className="text-xs text-zinc-400 block mb-1">
            Target frame index
            {activeFrameIndex !== undefined && (
              <span className="text-zinc-600 ml-2">(active replay frame: {activeFrameIndex})</span>
            )}
          </label>
          <input
            type="number"
            value={frameIndex}
            onChange={(e) => setFrameIndex(Number(e.target.value))}
            min={0}
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300 focus:border-blue-600 outline-none"
          />
        </div>

        <div>
          <label className="text-xs text-zinc-400 block mb-1">Reason</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why are you injecting? (audit trail)"
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:border-blue-600 outline-none"
          />
        </div>

        <div>
          <label className="text-xs text-zinc-400 block mb-1">Corrected input (JSON)</label>
          <textarea
            value={inputJson}
            onChange={(e) => setInputJson(e.target.value)}
            placeholder='{"goal": "corrected task goal", "context": {...}}'
            rows={4}
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-400 font-mono placeholder-zinc-600 focus:border-blue-600 outline-none resize-y"
          />
        </div>
      </div>

      {error && <div className="text-xs text-rose-400 bg-rose-950/20 border border-rose-800/40 rounded px-2 py-1">{error}</div>}

      <Button onClick={handleInject} disabled={busy} className="w-full">
        <Syringe className="h-4 w-4 mr-2" />
        {busy ? "Injecting…" : "Queue injection"}
      </Button>

      {result && (
        <div className="bg-emerald-950/20 border border-emerald-800/40 rounded px-3 py-2 text-xs text-emerald-400 font-mono">
          {result}
        </div>
      )}
    </Card>
  );
}

// ── Compare panel ──────────────────────────────────────────────────────────────

function ComparePanel({ sourceCognitionId }: { sourceCognitionId: string }) {
  const [branches, setBranches] = useState<BranchPointer[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState("");
  const [diff, setDiff] = useState<ReplayDiff | undefined>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    cognitionApi.get(sourceCognitionId)
      .then((v) => {
        setBranches(v.branches);
        if (v.branches[0]) setSelectedBranchId(v.branches[0].branchCognitionId);
      })
      .catch(() => {});
  }, [sourceCognitionId]);

  const handleCompare = async () => {
    if (!selectedBranchId) return;
    setDiffLoading(true);
    setDiff(undefined);
    setError(undefined);
    try {
      const d = await cognitionApi.diff(sourceCognitionId, selectedBranchId);
      setDiff(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Diff failed");
    } finally {
      setDiffLoading(false);
    }
  };

  return (
    <Card className="p-4 bg-zinc-950/70 border-zinc-800 space-y-3">
      <div>
        <div className="text-sm font-medium text-zinc-300 mb-1">Branch comparison</div>
        <div className="text-xs text-zinc-500">
          Compare frame-by-frame divergence between the source cognition and a branch.
          Identical frames confirm deterministic replay; diverged frames show where the
          branch changed behavior.
        </div>
      </div>

      {branches.length === 0 ? (
        <div className="text-zinc-500 text-xs p-3 text-center border border-zinc-800 rounded">
          No branches exist yet. Use the Branch tab to create one.
        </div>
      ) : (
        <>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="text-xs text-zinc-400 block mb-1">Branch to compare</label>
              <select
                value={selectedBranchId}
                onChange={(e) => setSelectedBranchId(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300"
              >
                {branches.map((b) => (
                  <option key={b.branchCognitionId} value={b.branchCognitionId}>
                    {b.branchCognitionId.slice(0, 18)}… @ f{b.branchPointFrameIndex}
                  </option>
                ))}
              </select>
            </div>
            <Button onClick={handleCompare} disabled={diffLoading || !selectedBranchId} size="sm">
              {diffLoading ? "Comparing…" : "Compare"}
            </Button>
          </div>

          {error && <div className="text-xs text-rose-400">{error}</div>}

          {diff && <DiffResults diff={diff} />}
        </>
      )}
    </Card>
  );
}

function DiffResults({ diff }: { diff: ReplayDiff }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        <StatCell label="compared" value={diff.summary.framesCompared} />
        <StatCell label="identical" value={diff.summary.framesIdentical} tone="success" />
        <StatCell label="diverged" value={diff.summary.framesDiverged} tone="error" />
        <StatCell label="branch-only" value={diff.summary.branchOnlyFrames} tone="info" />
        <StatCell
          label="divergence@"
          value={diff.divergenceFrameIndex !== null ? `f${diff.divergenceFrameIndex}` : "none"}
          tone={diff.divergenceFrameIndex !== null ? "warning" : "success"}
        />
      </div>

      {/* Frame grid diff visualization */}
      <div className="flex flex-wrap gap-[2px]">
        {diff.deltas.slice(0, 128).map((d) => (
          <div
            key={d.frameIndex}
            title={`f${d.frameIndex}: ${d.kind}${d.note ? ` — ${d.note}` : ""}`}
            className={cn(
              "w-2.5 h-2.5 rounded-sm cursor-default",
              d.kind === "IDENTICAL" && "bg-emerald-600/60",
              d.kind === "DIVERGED" && "bg-rose-500/80",
              d.kind === "BRANCH_ONLY" && "bg-fuchsia-500/80",
              d.kind === "SOURCE_ONLY" && "bg-zinc-500/70"
            )}
          />
        ))}
        {diff.deltas.length > 128 && (
          <span className="text-[10px] text-zinc-600 self-center ml-1">+{diff.deltas.length - 128} more</span>
        )}
      </div>

      <div className="flex items-center gap-3 text-[10px] text-zinc-500 flex-wrap">
        <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-sm bg-emerald-600/60" /> identical</div>
        <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-sm bg-rose-500/80" /> diverged</div>
        <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-sm bg-fuchsia-500/80" /> branch-only</div>
        <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-sm bg-zinc-500/70" /> source-only</div>
      </div>

      {/* Diverged frame details */}
      {diff.deltas.filter((d) => d.kind === "DIVERGED").length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Divergence details</div>
          {diff.deltas
            .filter((d) => d.kind === "DIVERGED")
            .slice(0, 8)
            .map((d) => (
              <div key={d.frameIndex} className="text-[10px] text-zinc-400 flex items-center gap-2">
                <span className="font-mono text-rose-400">f{d.frameIndex}</span>
                {d.field && <span className="text-zinc-500">field: {d.field}</span>}
                {d.note && <span className="text-zinc-600 italic">{d.note}</span>}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function StateCell({
  label,
  value,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning" | "error" | "info";
  icon?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "px-2 py-1.5 rounded border bg-zinc-900/60",
        tone === "success" && "border-emerald-800",
        tone === "warning" && "border-amber-800",
        tone === "error" && "border-rose-800",
        tone === "info" && "border-sky-800",
        tone === "neutral" && "border-zinc-800"
      )}
    >
      <div className="text-[10px] uppercase tracking-wide text-zinc-600 flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="text-zinc-300 font-mono text-xs truncate">{value}</div>
    </div>
  );
}

function StatCell({ label, value, tone = "neutral" }: { label: string; value: number | string; tone?: "neutral" | "success" | "warning" | "error" | "info" }) {
  return (
    <div className={cn("px-2 py-1 rounded border bg-zinc-900/60",
      tone === "success" && "border-emerald-800",
      tone === "warning" && "border-amber-800",
      tone === "error" && "border-rose-800",
      tone === "info" && "border-fuchsia-800",
      tone === "neutral" && "border-zinc-800"
    )}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-600">{label}</div>
      <div className="text-zinc-300 font-mono">{value}</div>
    </div>
  );
}
