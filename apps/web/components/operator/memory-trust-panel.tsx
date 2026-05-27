"use client";

import { useState, useEffect, useCallback } from "react";
import { operatorApi, type MemoryTrustData } from "../../services/operator-api";
import {
  Brain,
  ShieldCheck,
  ShieldAlert,
  Clock,
  Zap,
  Layers,
  Search,
  Link as LinkIcon,
  AlertTriangle,
  RefreshCw,
  EyeOff
} from "lucide-react";

interface MemoryTrustPanelProps {
  cognitionId: string;
}

export function MemoryTrustPanel({ cognitionId }: MemoryTrustPanelProps) {
  const [data, setData] = useState<MemoryTrustData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [filterStale, setFilterStale] = useState<boolean>(false);
  const [filterSuppressed, setFilterSuppressed] = useState<boolean>(false);
  const [activeMemoryId, setActiveMemoryId] = useState<string | null>(null);

  const fetchTrustData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await operatorApi.memoryTrust(cognitionId);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load memory trust insights");
    } finally {
      setLoading(false);
    }
  }, [cognitionId]);

  useEffect(() => {
    void fetchTrustData();
  }, [fetchTrustData]);

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-4 border border-zinc-800 bg-zinc-900/30 rounded-lg">
        <RefreshCw className="h-8 w-8 text-blue-400 animate-spin" />
        <span className="text-sm text-zinc-400">Analyzing memory corpus and scoring trust...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-950/10 p-5 space-y-3">
        <div className="flex items-center gap-2 text-red-400">
          <AlertTriangle className="h-5 w-5" />
          <h3 className="font-semibold">Memory Trust Error</h3>
        </div>
        <p className="text-sm text-red-300/80">{error}</p>
        <button
          onClick={fetchTrustData}
          className="text-xs px-3 py-1.5 bg-red-900/30 hover:bg-red-900/50 border border-red-700/50 rounded text-red-200 transition-colors"
        >
          Retry Analysis
        </button>
      </div>
    );
  }

  if (!data || !data.scoredMemories || data.scoredMemories.length === 0) {
    return (
      <div className="text-center py-16 border border-dashed border-zinc-800 rounded-lg bg-zinc-950/50 space-y-3">
        <Brain className="h-10 w-10 text-zinc-600 mx-auto" />
        <h3 className="text-white font-medium">No Memories Retrieved</h3>
        <p className="text-sm text-zinc-500 max-w-sm mx-auto">
          This execution did not trigger episodic or historical memory queries.
        </p>
      </div>
    );
  }

  // Aggregate stats
  const totalMemories = data.scoredMemories.length;
  const suppressedCount = data.scoredMemories.filter(m => m.isSuppressed).length;
  const staleCount = data.scoredMemories.filter(m => m.isStale).length;
  const allAlerts = data.scoredMemories.flatMap(m => m.contaminationAlerts);
  const criticalAlerts = allAlerts.filter(a => a.severity === "CRITICAL");
  const highAlerts = allAlerts.filter(a => a.severity === "HIGH");

  const averageTrustScore =
    data.scoredMemories.reduce((acc, m) => acc + m.trustScore.overall, 0) / totalMemories;

  // Filter memories
  const filteredMemories = data.scoredMemories.filter(item => {
    const matchesSearch =
      item.memory.content.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.memory.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStale = !filterStale || item.isStale;
    const matchesSuppressed = !filterSuppressed || item.isSuppressed;
    return matchesSearch && matchesStale && matchesSuppressed;
  });

  const activeMemory = data.scoredMemories.find(m => m.memory.id === activeMemoryId);

  return (
    <div className="space-y-6">
      {/* Overview Metric Row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Metric 1: Avg Trust */}
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur-md p-4 space-y-2 relative overflow-hidden">
          <div className="flex justify-between items-center text-zinc-500 text-xs font-medium uppercase tracking-wider">
            <span>Average Trust Score</span>
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white">
              {(averageTrustScore * 100).toFixed(0)}%
            </span>
            <span className="text-xs text-emerald-400">stable retrieval</span>
          </div>
          <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                averageTrustScore > 0.7
                  ? "bg-emerald-500"
                  : averageTrustScore > 0.4
                  ? "bg-amber-500"
                  : "bg-red-500"
              }`}
              style={{ width: `${averageTrustScore * 100}%` }}
            />
          </div>
        </div>

        {/* Metric 2: Contamination Alerts */}
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur-md p-4 space-y-2">
          <div className="flex justify-between items-center text-zinc-500 text-xs font-medium uppercase tracking-wider">
            <span>Contamination Alerts</span>
            <ShieldAlert className="h-4 w-4 text-red-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white">
              {allAlerts.length}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded border ${
              criticalAlerts.length > 0
                ? "border-red-900 bg-red-950/30 text-red-400"
                : highAlerts.length > 0
                ? "border-amber-900 bg-amber-950/30 text-amber-400"
                : "border-zinc-800 bg-zinc-900 text-zinc-500"
            }`}>
              {criticalAlerts.length} critical
            </span>
          </div>
          <p className="text-xs text-zinc-500">Negated contradictions and loops</p>
        </div>

        {/* Metric 3: Stale Memories */}
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur-md p-4 space-y-2">
          <div className="flex justify-between items-center text-zinc-500 text-xs font-medium uppercase tracking-wider">
            <span>Stale Memories</span>
            <Clock className="h-4 w-4 text-amber-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white">
              {staleCount}
            </span>
            <span className="text-xs text-zinc-500">out of {totalMemories}</span>
          </div>
          <p className="text-xs text-zinc-500">Exponential decay active</p>
        </div>

        {/* Metric 4: Suppressed Context */}
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur-md p-4 space-y-2">
          <div className="flex justify-between items-center text-zinc-500 text-xs font-medium uppercase tracking-wider">
            <span>Suppressed Noise</span>
            <EyeOff className="h-4 w-4 text-zinc-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white">
              {suppressedCount}
            </span>
            <span className="text-xs text-zinc-400 font-medium border border-zinc-800 rounded px-1.5 py-0.5 bg-zinc-900/60">
              {((suppressedCount / totalMemories) * 100).toFixed(0)}% cut
            </span>
          </div>
          <p className="text-xs text-zinc-500">Low-trust retrieval chains hidden</p>
        </div>
      </div>

      {/* Contamination Alerts Section */}
      {allAlerts.length > 0 && (
        <div className="rounded-xl border border-red-900/30 bg-red-950/5 p-5 space-y-4">
          <div className="flex items-center gap-2 text-red-400">
            <ShieldAlert className="h-5 w-5" />
            <h3 className="font-semibold text-white">Active Contamination & Negation Alerts</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {allAlerts.map((alert) => (
              <div
                key={alert.id}
                className={`rounded-lg border p-4 space-y-2 transition-all ${
                  alert.severity === "CRITICAL"
                    ? "border-red-800/50 bg-red-950/20 hover:bg-red-950/30"
                    : "border-amber-800/50 bg-amber-950/10 hover:bg-amber-950/25"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-[10px] font-extrabold uppercase px-2 py-0.5 border rounded-full ${
                    alert.severity === "CRITICAL"
                      ? "border-red-700 bg-red-900/50 text-red-300"
                      : "border-amber-700 bg-amber-900/50 text-amber-300"
                  }`}>
                    {alert.type}
                  </span>
                  <span className="text-zinc-600 text-xs font-mono truncate max-w-[150px]">
                    {alert.memoryId.slice(0, 10)}...
                  </span>
                </div>
                <p className="text-xs text-zinc-300 leading-relaxed font-medium">
                  {alert.message}
                </p>
                {alert.conflictingMemoryIds && alert.conflictingMemoryIds.length > 0 && (
                  <div className="text-[10px] text-zinc-500 border-t border-zinc-800/80 pt-2 flex flex-wrap gap-1.5 items-center">
                    <span>Conflicting/Superceded IDs:</span>
                    {alert.conflictingMemoryIds.map((cId) => (
                      <button
                        key={cId}
                        onClick={() => setActiveMemoryId(cId)}
                        className="font-mono text-blue-400 hover:text-blue-300 hover:underline px-1 border border-zinc-800 rounded bg-zinc-950"
                      >
                        {cId.slice(0, 8)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Split Layout: Filter & Memory List / Scored Memory Details */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Memory Browser Deck */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
            <h3 className="font-semibold text-white flex items-center gap-2 self-start">
              <Layers className="h-4 w-4 text-blue-400" />
              Memory Retrieval Corpus
            </h3>

            {/* Filter controls */}
            <div className="flex flex-wrap gap-2 items-center w-full sm:w-auto">
              <div className="relative flex-1 sm:w-64 min-w-[200px]">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Filter content or ID..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 border border-zinc-800 bg-zinc-900/60 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-700 transition-colors"
                />
              </div>

              <button
                onClick={() => setFilterStale(!filterStale)}
                className={`text-xs px-2.5 py-1.5 rounded-lg border transition-all ${
                  filterStale
                    ? "border-amber-600 bg-amber-950/20 text-amber-400"
                    : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:text-zinc-300"
                }`}
              >
                Stale
              </button>

              <button
                onClick={() => setFilterSuppressed(!filterSuppressed)}
                className={`text-xs px-2.5 py-1.5 rounded-lg border transition-all ${
                  filterSuppressed
                    ? "border-red-600 bg-red-950/20 text-red-400"
                    : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:text-zinc-300"
                }`}
              >
                Suppressed
              </button>
            </div>
          </div>

          {/* Cards List */}
          <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
            {filteredMemories.map((item) => {
              const isSelected = item.memory.id === activeMemoryId;
              const hasCritical = item.contaminationAlerts.some(a => a.severity === "CRITICAL");
              return (
                <div
                  key={item.memory.id}
                  onClick={() => setActiveMemoryId(item.memory.id)}
                  className={`cursor-pointer rounded-xl border p-4 transition-all relative overflow-hidden flex flex-col justify-between ${
                    isSelected
                      ? "border-blue-500/80 bg-blue-950/10 shadow-lg shadow-blue-950/20"
                      : "border-zinc-800/80 bg-zinc-900/30 hover:bg-zinc-900/60"
                  }`}
                >
                  {/* Suppressed / stale overlay tag */}
                  <div className="flex items-center justify-between gap-3 border-b border-zinc-800/60 pb-2 mb-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-mono text-zinc-400 border border-zinc-800 rounded px-1.5 py-0.5 bg-zinc-950">
                        {item.memory.type}
                      </span>
                      {item.isStale && (
                        <span className="text-[9px] font-semibold text-amber-400 border border-amber-800/50 rounded-full px-1.5 bg-amber-950/20">
                          STALE
                        </span>
                      )}
                      {item.isSuppressed && (
                        <span className="text-[9px] font-semibold text-red-400 border border-red-800/50 rounded-full px-1.5 bg-red-950/20">
                          SUPPRESSED
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-zinc-500 font-mono">
                        {new Date(item.memory.createdAt).toLocaleDateString()}
                      </span>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-zinc-400 font-semibold">Trust:</span>
                        <span className={`text-xs font-bold ${
                          item.trustScore.overall > 0.7
                            ? "text-emerald-400"
                            : item.trustScore.overall > 0.4
                            ? "text-amber-400"
                            : "text-red-400"
                        }`}>
                          {(item.trustScore.overall * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Main Content preview */}
                  <p className="text-sm text-zinc-300 line-clamp-2 leading-relaxed mb-3">
                    {item.memory.content}
                  </p>

                  {/* Alert summary pill */}
                  {item.contaminationAlerts.length > 0 && (
                    <div className="flex items-center gap-1 text-[10px] text-red-400 font-semibold bg-red-950/10 border border-red-900/40 rounded px-2 py-1 w-fit">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      <span>{item.contaminationAlerts.length} contamination risk(s)</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right 1 Col: Score Details Panel */}
        <div className="lg:col-span-1">
          {activeMemory ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 backdrop-blur-md p-5 space-y-6 animate-fadeIn">
              <div className="border-b border-zinc-800 pb-3">
                <div className="flex justify-between items-start">
                  <h4 className="font-semibold text-white text-base">Memory Metrics</h4>
                  <span className="font-mono text-[9px] text-zinc-500 bg-zinc-950 px-2 py-0.5 border border-zinc-800 rounded">
                    {activeMemory.memory.id.slice(0, 12)}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-1">
                  Comprehensive scoring trace and dependency lineage
                </p>
              </div>

              {/* Dynamic HSL trust ring / bar charts */}
              <div className="space-y-4">
                <h5 className="text-xs text-zinc-400 font-semibold flex items-center gap-1.5 uppercase tracking-wider">
                  <ShieldCheck className="h-3.5 w-3.5 text-blue-400" />
                  Scoring Breakdown
                </h5>

                {/* Score bar components */}
                <div className="space-y-3 text-xs">
                  {/* Semantic Relevance */}
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Semantic Relevance</span>
                      <span className="font-mono text-zinc-300">{(activeMemory.trustScore.semanticRelevance * 100).toFixed(0)}%</span>
                    </div>
                    <div className="w-full bg-zinc-800/80 h-1 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-400 rounded-full" style={{ width: `${activeMemory.trustScore.semanticRelevance * 100}%` }} />
                    </div>
                  </div>

                  {/* Recency / Freshness */}
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Freshness (Decay)</span>
                      <span className="font-mono text-zinc-300">{(activeMemory.trustScore.recency * 100).toFixed(0)}%</span>
                    </div>
                    <div className="w-full bg-zinc-800/80 h-1 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-400 rounded-full" style={{ width: `${activeMemory.trustScore.recency * 100}%` }} />
                    </div>
                  </div>

                  {/* Source Reliability */}
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Source Reliability</span>
                      <span className="font-mono text-zinc-300">{(activeMemory.trustScore.sourceReliability * 100).toFixed(0)}%</span>
                    </div>
                    <div className="w-full bg-zinc-800/80 h-1 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${activeMemory.trustScore.sourceReliability * 100}%` }} />
                    </div>
                  </div>

                  {/* Success correlation */}
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Success Correlation</span>
                      <span className="font-mono text-zinc-300">{(activeMemory.trustScore.executionSuccessCorrelation * 100).toFixed(0)}%</span>
                    </div>
                    <div className="w-full bg-zinc-800/80 h-1 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-400 rounded-full" style={{ width: `${activeMemory.trustScore.executionSuccessCorrelation * 100}%` }} />
                    </div>
                  </div>

                  {/* Retrieval Frequency */}
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Retrieval Frequency</span>
                      <span className="font-mono text-zinc-300">{(activeMemory.trustScore.frequency * 100).toFixed(0)}%</span>
                    </div>
                    <div className="w-full bg-zinc-800/80 h-1 rounded-full overflow-hidden">
                      <div className="h-full bg-purple-400 rounded-full" style={{ width: `${activeMemory.trustScore.frequency * 100}%` }} />
                    </div>
                  </div>

                  {/* Contradiction penalty */}
                  {activeMemory.trustScore.contradictionLikelihood > 0 && (
                    <div className="space-y-1 border border-red-900/30 bg-red-950/5 rounded p-2 text-[10px]">
                      <div className="flex justify-between text-red-400 font-semibold mb-0.5">
                        <span>Contradiction Penalty</span>
                        <span>-{(activeMemory.trustScore.contradictionLikelihood * 100).toFixed(0)}%</span>
                      </div>
                      <p className="text-[9px] text-zinc-400">
                        High structural similarity but negation overrides detected.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Lineage & Dependency edges */}
              <div className="space-y-3 pt-3 border-t border-zinc-800/80">
                <h5 className="text-xs text-zinc-400 font-semibold flex items-center gap-1.5 uppercase tracking-wider">
                  <LinkIcon className="h-3.5 w-3.5 text-zinc-400" />
                  Lineage & Dependency
                </h5>

                <div className="text-xs space-y-2">
                  <div className="flex items-center justify-between text-zinc-500">
                    <span>Derived From Execution:</span>
                    {activeMemory.memory.executionId ? (
                      <span className="font-mono text-zinc-300">{activeMemory.memory.executionId.slice(0, 12)}...</span>
                    ) : (
                      <span className="text-zinc-600">Manual / Reference Seed</span>
                    )}
                  </div>

                  <div className="space-y-1">
                    <span className="text-zinc-500 block mb-1">Depends On (Retrieved Ancestors):</span>
                    {activeMemory.lineage.dependencies && activeMemory.lineage.dependencies.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {activeMemory.lineage.dependencies.map(dId => (
                          <button
                            key={dId}
                            onClick={() => setActiveMemoryId(dId)}
                            className="font-mono text-[9px] text-blue-400 hover:text-blue-300 hover:underline border border-zinc-800 rounded px-1.5 py-0.5 bg-zinc-950 transition-colors"
                          >
                            {dId.slice(0, 8)}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-zinc-600 italic text-[11px]">No dependencies (Root source).</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Complete content display */}
              <div className="space-y-2 pt-3 border-t border-zinc-800/80">
                <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">Content Preview</span>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 max-h-40 overflow-y-auto">
                  <pre className="text-xs text-zinc-300 font-mono whitespace-pre-wrap break-all leading-relaxed">
                    {activeMemory.memory.content}
                  </pre>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/10 p-6 text-center space-y-2 text-zinc-500 text-xs">
              <Brain className="h-6 w-6 mx-auto text-zinc-600 opacity-60" />
              <span>Select any memory card to examine its trust score vectors and graph dependencies.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function MemoryTrustWithInput() {
  const [inputId, setInputId] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          value={inputId}
          onChange={(e) => setInputId(e.target.value)}
          placeholder="Paste cognition ID…"
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-blue-500"
        />
        <button
          onClick={() => setActiveId(inputId.trim() || null)}
          disabled={!inputId.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded font-medium transition-colors"
        >
          Load Trust Insights
        </button>
      </div>
      {activeId && <MemoryTrustPanel cognitionId={activeId} />}
    </div>
  );
}
