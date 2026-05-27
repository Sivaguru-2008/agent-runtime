"use client";

/**
 * PHASE 6 — Cognition Node Explorer
 *
 * Operator debugging value:
 *   Every node represents a reasoning step by a specific agent role.
 *   This component lets operators traverse the complete reasoning lineage:
 *   "Why did the VERIFIER reject this output?" → click VERIFIER → see its
 *   inputs (EXECUTOR's output) → trace back to PLANNER's plan.
 *   Diverged/replayed nodes are highlighted so operators can see which
 *   part of the execution changed between branch A and branch B.
 *
 * Replay UX improvement:
 *   Clicking "replay from this node" creates a branch starting from that
 *   node's input, with optional overrides. The operator can inject a
 *   corrected PLANNER output and see how the rest of the cognition unfolds.
 *
 * Scaling implications:
 *   Node list is sorted by sequence and paginated — only 50 nodes shown
 *   at once. Token streams are truncated to 300 tokens in the detail view.
 *   Memory influence cells are sorted by weight descending.
 *
 * Failure diagnosis improvements:
 *   The ancestry chain (ROOT → ... → TERMINAL) pinpoints exactly where
 *   bad state was introduced. The uncertainty bar on each node shows
 *   confidence degradation across the reasoning chain.
 */

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  cognitionApi,
  type CognitionNode,
  type CognitionGraphView,
  type AgentRole,
} from "@/lib/cognition-api";
import { cn, formatDuration, formatTime } from "@/lib/utils";
import { AlertTriangle, ChevronDown, ChevronRight, GitBranch } from "lucide-react";

export interface CognitionNodeExplorerProps {
  cognitionId: string;
  /** Called when operator wants to branch from a specific node */
  onBranchFromNode?: (nodeId: string, cognitionId: string) => void;
}

const ROLE_COLORS: Record<AgentRole, string> = {
  PLANNER: "border-sky-600/60 text-sky-300",
  EXECUTOR: "border-emerald-600/60 text-emerald-300",
  VERIFIER: "border-amber-600/60 text-amber-300",
  CRITIC: "border-fuchsia-600/60 text-fuchsia-300",
  MEMORY_MANAGER: "border-cyan-600/60 text-cyan-300",
};

const ROLE_BG: Record<AgentRole, string> = {
  PLANNER: "bg-sky-950/40",
  EXECUTOR: "bg-emerald-950/40",
  VERIFIER: "bg-amber-950/40",
  CRITIC: "bg-fuchsia-950/40",
  MEMORY_MANAGER: "bg-cyan-950/40",
};

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: "text-emerald-400",
  FAILED: "text-rose-400",
  RUNNING: "text-amber-400",
  STREAMING: "text-amber-300",
  PENDING: "text-zinc-500",
  SKIPPED: "text-zinc-600",
  REPLAYED: "text-fuchsia-400",
};

const PAGE_SIZE = 50;

export function CognitionNodeExplorer({ cognitionId, onBranchFromNode }: CognitionNodeExplorerProps) {
  const [view, setView] = useState<CognitionGraphView | undefined>();
  const [selected, setSelected] = useState<CognitionNode | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [page, setPage] = useState(0);
  const [activeTab, setActiveTab] = useState<"nodes" | "lineage" | "branches">("nodes");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const v = await cognitionApi.get(cognitionId);
      setView(v);
      // Auto-select the first FAILED node if any, else first node
      const failedNode = v.graph.nodes.find((n) => n.status === "FAILED");
      setSelected(failedNode ?? v.graph.nodes[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cognition");
    } finally {
      setLoading(false);
    }
  }, [cognitionId]);

  useEffect(() => { void load(); }, [load]);

  // Deferred Deep Hydration on Selection
  useEffect(() => {
    if (!selected) return;
    if (!selected.input || Object.keys(selected.input).length === 0) {
      let active = true;
      void (async () => {
        try {
          const fullNode = await cognitionApi.getNodeDetails(cognitionId, selected.id);
          if (!active) return;
          setSelected(fullNode);
          setView((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              graph: {
                ...prev.graph,
                nodes: prev.graph.nodes.map((n) => (n.id === selected.id ? fullNode : n))
              }
            };
          });
        } catch (err) {
          console.error("Failed to load deep node payload", err);
        }
      })();
      return () => {
        active = false;
      };
    }
  }, [selected?.id, cognitionId]);

  if (loading) return <LoadingSkeleton />;
  if (error) return <ErrorBanner message={error} />;
  if (!view) return null;

  const sortedNodes = [...view.graph.nodes].sort((a, b) => a.sequence - b.sequence);
  const pageNodes = sortedNodes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(sortedNodes.length / PAGE_SIZE);

  return (
    <div className="space-y-3">
      {/* Graph header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-medium text-zinc-200">
            Cognition Node Explorer
          </div>
          <div className="text-xs text-zinc-500 font-mono mt-0.5">
            {cognitionId.slice(0, 16)}… · {view.graph.nodes.length} nodes · phase: {view.graph.phase}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="muted">{view.branches.length} branches</Badge>
          <Badge variant="muted">{view.failureSignals.length} signals</Badge>
          {view.uncertainty.overall > 0.5 && (
            <Badge variant="muted" className="border-rose-700 text-rose-300">
              uncertainty {(view.uncertainty.overall * 100).toFixed(0)}%
            </Badge>
          )}
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-0 border-b border-zinc-800">
        {(["nodes", "lineage", "branches"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2 text-xs font-medium border-b-2 transition-colors capitalize",
              activeTab === tab
                ? "border-blue-500 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            )}
          >
            {tab}
            {tab === "lineage" && view.lineage.length > 0 && (
              <span className="ml-1.5 text-zinc-600">({view.lineage.length})</span>
            )}
          </button>
        ))}
      </div>

      {activeTab === "nodes" && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
          {/* Node list */}
          <div className="lg:col-span-2 space-y-1.5">
            {pageNodes.map((node) => (
              <NodeListItem
                key={node.id}
                node={node}
                isSelected={selected?.id === node.id}
                onClick={() => setSelected(node)}
              />
            ))}
            {totalPages > 1 && (
              <div className="flex items-center gap-2 justify-center pt-1">
                <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                  ←
                </Button>
                <span className="text-xs text-zinc-500">{page + 1} / {totalPages}</span>
                <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}>
                  →
                </Button>
              </div>
            )}
          </div>

          {/* Node detail */}
          <div className="lg:col-span-3">
            {selected ? (
              <NodeDetail
                node={selected}
                allNodes={view.graph.nodes}
                onBranchFromNode={onBranchFromNode ? () => onBranchFromNode(selected.id, cognitionId) : undefined}
              />
            ) : (
              <div className="text-zinc-500 text-sm p-4 text-center border border-zinc-800 rounded">
                Select a node to inspect its reasoning state.
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "lineage" && (
        <LineageView lineage={view.lineage} nodes={view.graph.nodes} onSelectNode={setSelected} />
      )}

      {activeTab === "branches" && (
        <BranchesView
          cognitionId={cognitionId}
          branches={view.branches}
          onBranchFromNode={onBranchFromNode}
        />
      )}
    </div>
  );
}

// ── Node list item ────────────────────────────────────────────────────────────

function NodeListItem({
  node,
  isSelected,
  onClick,
}: {
  node: CognitionNode;
  isSelected: boolean;
  onClick: () => void;
}) {
  const uncertainty = node.uncertainty?.overall ?? 0;
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2 rounded border transition-all",
        ROLE_BG[node.role],
        isSelected ? "border-white/20 ring-1 ring-white/10" : "border-zinc-800 hover:border-zinc-700",
        node.status === "FAILED" && "border-rose-800/60"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className={cn("text-xs font-mono", ROLE_COLORS[node.role])}>{node.role}</span>
          <span className="text-zinc-600 text-xs">#{node.sequence}</span>
        </div>
        <span className={cn("text-[10px]", STATUS_COLORS[node.status] ?? "text-zinc-500")}>{node.status}</span>
      </div>
      {/* Uncertainty bar */}
      <div className="mt-1.5 h-1 bg-zinc-800 rounded overflow-hidden">
        <div
          className={cn(
            "h-full rounded",
            uncertainty > 0.65 ? "bg-rose-500" : uncertainty > 0.4 ? "bg-amber-500" : "bg-emerald-500"
          )}
          style={{ width: `${Math.min(100, uncertainty * 100)}%` }}
        />
      </div>
      {node.replayedFromNodeId && (
        <div className="text-[10px] text-fuchsia-400 mt-0.5">replayed</div>
      )}
    </button>
  );
}

// ── Node detail panel ─────────────────────────────────────────────────────────

function NodeDetail({
  node,
  allNodes,
  onBranchFromNode,
}: {
  node: CognitionNode;
  allNodes: CognitionNode[];
  onBranchFromNode?: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["meta"]));
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const uncertainty = node.uncertainty?.overall ?? 0;
  const parent = node.parentNodeId ? allNodes.find((n) => n.id === node.parentNodeId) : undefined;

  return (
    <Card className={cn("p-4 bg-zinc-950/70 space-y-3", ROLE_COLORS[node.role], "border")}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={cn("text-sm font-medium", ROLE_COLORS[node.role])}>{node.role}</span>
            <span className="text-zinc-500 text-xs">seq #{node.sequence}</span>
            <span className={cn("text-xs font-mono", STATUS_COLORS[node.status] ?? "text-zinc-500")}>{node.status}</span>
          </div>
          <div className="font-mono text-xs text-zinc-500 mt-0.5">{node.id.slice(0, 20)}…</div>
        </div>
        {onBranchFromNode && (
          <Button size="sm" variant="secondary" onClick={onBranchFromNode}>
            <GitBranch className="h-3 w-3 mr-1" />
            Branch here
          </Button>
        )}
      </div>

      {/* Ancestry trail */}
      {parent && (
        <div className="flex items-center gap-1 text-xs text-zinc-500">
          <span>parent:</span>
          <span className={cn("font-mono", ROLE_COLORS[parent.role])}>{parent.role}</span>
          <span className="text-zinc-600">#{parent.sequence}</span>
        </div>
      )}

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <KV label="duration" value={formatDuration(node.durationMs)} />
        <KV label="uncertainty" value={`${(uncertainty * 100).toFixed(0)}%`} tone={uncertainty > 0.5 ? "error" : "success"} />
        <KV label="mem influence" value={String(node.memoryInfluence?.length ?? 0)} />
      </div>

      {/* Expandable sections */}
      <ExpandSection title="Input" sectionKey="input" expanded={expanded} toggle={toggle}>
        <JsonViewer data={node.input} />
      </ExpandSection>

      {node.output && (
        <ExpandSection title="Output" sectionKey="output" expanded={expanded} toggle={toggle}>
          <JsonViewer data={node.output} />
        </ExpandSection>
      )}

      {node.tokenStream && node.tokenStream.length > 0 && (
        <ExpandSection
          title={`Token stream (${node.tokenStream.length} chunks)`}
          sectionKey="tokens"
          expanded={expanded}
          toggle={toggle}
        >
          <div className="flex flex-wrap gap-[2px] text-[10px] font-mono max-h-28 overflow-y-auto">
            {node.tokenStream.slice(0, 300).map((chunk) => (
              <span
                key={chunk.sequence}
                title={`conf ${chunk.confidence.toFixed(2)}`}
                className="px-0.5 rounded"
                style={{
                  background:
                    chunk.confidence > 0.85
                      ? "rgba(16,185,129,0.2)"
                      : chunk.confidence > 0.6
                      ? "rgba(245,158,11,0.2)"
                      : "rgba(244,63,94,0.3)",
                  color: "#d4d4d8",
                }}
              >
                {chunk.text}
              </span>
            ))}
            {node.tokenStream.length > 300 && (
              <span className="text-zinc-600 px-1">+{node.tokenStream.length - 300} more</span>
            )}
          </div>
        </ExpandSection>
      )}

      {node.memoryInfluence && node.memoryInfluence.length > 0 && (
        <ExpandSection title="Memory influence" sectionKey="memory" expanded={expanded} toggle={toggle}>
          <div className="space-y-1">
            {[...node.memoryInfluence]
              .sort((a, b) => b.weight - a.weight)
              .map((m) => (
                <div key={m.memoryId} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-zinc-500 w-20 truncate">{m.memoryId.slice(0, 10)}…</span>
                  <div className="flex-1 h-1.5 bg-zinc-800 rounded overflow-hidden">
                    <div
                      className="h-1.5 bg-fuchsia-500/80 rounded"
                      style={{ width: `${Math.min(100, m.weight * 100)}%` }}
                    />
                  </div>
                  <span className="text-zinc-500 w-8 text-right">{(m.weight * 100).toFixed(0)}%</span>
                  {m.reason && <span className="text-zinc-600 text-[10px] truncate max-w-[12ch]">{m.reason}</span>}
                </div>
              ))}
          </div>
        </ExpandSection>
      )}

      {node.replayedFromNodeId && (
        <div className="text-xs text-fuchsia-400 bg-fuchsia-950/30 border border-fuchsia-800/40 rounded px-2 py-1">
          Replayed from node {node.replayedFromNodeId.slice(0, 12)}…
        </div>
      )}
    </Card>
  );
}

// ── Lineage view ──────────────────────────────────────────────────────────────

function LineageView({
  lineage,
  nodes,
  onSelectNode,
}: {
  lineage: CognitionGraphView["lineage"];
  nodes: CognitionNode[];
  onSelectNode: (n: CognitionNode) => void;
}) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  if (lineage.length === 0) {
    return (
      <div className="text-zinc-500 text-sm p-4 text-center border border-zinc-800 rounded">
        No lineage data available for this cognition.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {lineage.map((entry) => {
        const node = nodeMap.get(entry.nodeId);
        return (
          <Card key={entry.nodeId} className="p-3 bg-zinc-950/70 border-zinc-800 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {node && (
                  <span className={cn("text-xs font-mono", ROLE_COLORS[node.role])}>{node.role}</span>
                )}
                <span className="font-mono text-xs text-zinc-400">{entry.nodeId.slice(0, 14)}…</span>
              </div>
              {node && (
                <Button size="sm" variant="ghost" onClick={() => onSelectNode(node)} className="h-6 text-xs">
                  inspect
                </Button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 text-[10px]">
              <div>
                <div className="text-zinc-600 uppercase tracking-wide">ancestors</div>
                <div className="text-zinc-400">{entry.ancestors.length}</div>
              </div>
              <div>
                <div className="text-zinc-600 uppercase tracking-wide">descendants</div>
                <div className="text-zinc-400">{entry.descendants.length}</div>
              </div>
              <div>
                <div className="text-zinc-600 uppercase tracking-wide">siblings</div>
                <div className="text-zinc-400">{entry.siblings.length}</div>
              </div>
            </div>
            {entry.ancestors.length > 0 && (
              <div className="text-[10px] text-zinc-600">
                ← {entry.ancestors.slice(0, 3).map((id) => id.slice(0, 8)).join(" ← ")}
                {entry.ancestors.length > 3 && ` + ${entry.ancestors.length - 3} more`}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ── Branches view ─────────────────────────────────────────────────────────────

function BranchesView({
  cognitionId,
  branches,
  onBranchFromNode,
}: {
  cognitionId: string;
  branches: CognitionGraphView["branches"];
  onBranchFromNode?: (nodeId: string, cognitionId: string) => void;
}) {
  if (branches.length === 0) {
    return (
      <div className="text-zinc-500 text-sm p-4 text-center border border-zinc-800 rounded">
        No branches forked from this cognition yet.
        <div className="mt-1 text-xs text-zinc-600">
          Use "Branch here" on any node to fork a new replay branch.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {branches.map((b) => (
        <Card key={b.branchCognitionId} className="p-3 bg-zinc-950/70 border-zinc-800 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-mono text-xs text-zinc-300">{b.branchCognitionId.slice(0, 18)}…</div>
              <div className="text-[11px] text-zinc-500">
                forked @ frame {b.branchPointFrameIndex} · node {b.sourceNodeId.slice(0, 10)}…
              </div>
            </div>
            <div className="text-[10px] text-zinc-600">{formatTime(b.createdAt)}</div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function ExpandSection({
  title,
  sectionKey,
  expanded,
  toggle,
  children,
}: {
  title: string;
  sectionKey: string;
  expanded: Set<string>;
  toggle: (k: string) => void;
  children: React.ReactNode;
}) {
  const open = expanded.has(sectionKey);
  return (
    <div className="border border-zinc-800 rounded">
      <button
        onClick={() => toggle(sectionKey)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
      >
        {title}
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function JsonViewer({ data }: { data: Record<string, unknown> }) {
  return (
    <pre className="text-[10px] text-zinc-400 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function KV({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "error";
}) {
  return (
    <div
      className={cn(
        "px-2 py-1 rounded border bg-zinc-900/50",
        tone === "success" && "border-emerald-800",
        tone === "error" && "border-rose-800",
        tone === "neutral" && "border-zinc-800"
      )}
    >
      <div className="text-[10px] uppercase tracking-wide text-zinc-600">{label}</div>
      <div className="text-zinc-300">{value}</div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="h-10 bg-zinc-800/40 rounded" />
      <div className="grid grid-cols-5 gap-2">
        <div className="col-span-2 h-48 bg-zinc-800/40 rounded" />
        <div className="col-span-3 h-48 bg-zinc-800/40 rounded" />
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded border border-rose-700/50 bg-rose-950/20 p-3 text-rose-400 text-sm flex items-center gap-2">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      {message}
    </div>
  );
}
