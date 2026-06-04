"use client";

/**
 * PHASE 4 — Event Trace Explorer
 *
 * Reconstructs the full causal chain of an API request using the domain
 * event log as the source of truth — a lightweight built-in trace viewer
 * that works without an external Jaeger/Tempo dependency.
 *
 * Operational purpose:
 *   Answers: "What happened during this request, from first event to last?"
 *   - causationId links child events back to the event that caused them
 *   - correlationId groups all events from one logical operation
 *   - Span tree view shows the parallelism or sequencing of operations
 *
 * Distributed tracing implications:
 *   The traceId in every domain event is the same traceId used in OTel spans.
 *   If you have Jaeger/Tempo configured, you can click "open in Jaeger" to
 *   jump from this view to the full span waterfall. If not, this view gives
 *   you the event-level equivalent.
 *
 * Debugging improvements:
 *   - The causation tree shows why each event was emitted, not just what
 *   - Events are colour-coded by aggregate type (AGENT / EXECUTION / SYSTEM)
 *   - Aggregate ID grouping exposes cross-aggregate interactions
 */

import { useCallback, useState } from "react";
import { operatorApi, type TraceLineageEntry } from "../../services/operator-api";
import {
  AlertTriangle, ChevronDown, ChevronRight, GitBranch, Search
} from "lucide-react";
import { ExplainedEmptyState } from "../explain/empty-state";

const AGGREGATE_COLOUR: Record<string, string> = {
  AGENT: "text-blue-400 border-blue-800",
  EXECUTION: "text-purple-400 border-purple-800",
  SYSTEM: "text-zinc-400 border-zinc-700",
  COGNITION: "text-cyan-400 border-cyan-800",
  REPLAY: "text-yellow-400 border-yellow-800"
};

function getColour(aggregateType: string): string {
  return AGGREGATE_COLOUR[aggregateType] ?? "text-zinc-400 border-zinc-700";
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3
  });
}

interface EventNodeProps {
  event: TraceLineageEntry;
  relativeMs: number;
}

function EventNode({ event, relativeMs }: EventNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const colour = getColour(event.aggregateType);

  return (
    <div className="relative pl-5">
      {/* Vertical connector line */}
      <div className="absolute left-1.5 top-0 bottom-0 w-px bg-zinc-800" />

      {/* Dot */}
      <div className={`absolute left-0.5 top-2 h-2 w-2 rounded-full border ${colour} bg-zinc-950`} />

      <div className="pb-2">
        {/* Event header */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-start gap-2 text-left"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs font-mono font-medium ${colour.split(" ")[0]}`}>
                {event.type}
              </span>
              <span className="text-xs text-zinc-600 tabular-nums">
                +{relativeMs}ms
              </span>
              <span className="text-xs text-zinc-700">
                {event.aggregateType}
              </span>
            </div>
            <div className="text-xs text-zinc-600 font-mono mt-0.5 truncate">
              {event.aggregateId}
            </div>
          </div>
          <div className="shrink-0 mt-0.5">
            {expanded
              ? <ChevronDown className="h-3 w-3 text-zinc-600" />
              : <ChevronRight className="h-3 w-3 text-zinc-600" />
            }
          </div>
        </button>

        {/* Expanded detail */}
        {expanded && (
          <div className="mt-2 space-y-1.5 bg-zinc-900/60 border border-zinc-800 rounded p-2.5">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <div><span className="text-zinc-600">eventId</span></div>
              <div className="font-mono text-zinc-400 truncate">{event.eventId}</div>
              <div><span className="text-zinc-600">sequence</span></div>
              <div className="font-mono text-zinc-400">{event.sequence}</div>
              <div><span className="text-zinc-600">timestamp</span></div>
              <div className="text-zinc-400">{formatTimestamp(event.timestamp)}</div>
              {event.correlationId && (
                <>
                  <div><span className="text-zinc-600">correlationId</span></div>
                  <div className="font-mono text-zinc-400 truncate">{event.correlationId}</div>
                </>
              )}
              {event.causationId && (
                <>
                  <div><span className="text-zinc-600">causationId</span></div>
                  <div className="font-mono text-zinc-400 truncate">{event.causationId}</div>
                </>
              )}
            </div>
            {!!event.payload && (
              <div className="border-t border-zinc-800 pt-1.5">
                <pre className="text-xs text-zinc-600 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-40 overflow-y-auto">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function EventTraceExplorer() {
  const [traceId, setTraceId] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [result, setResult] = useState<{
    traceId: string;
    eventCount: number;
    events: TraceLineageEntry[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");

  const search = useCallback(async (id: string) => {
    if (!id.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await operatorApi.trace(id.trim());
      setResult(data);
      setTraceId(id.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load trace");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const filteredEvents = result?.events.filter(
    (e) =>
      !filterText ||
      e.type.toLowerCase().includes(filterText.toLowerCase()) ||
      e.aggregateType.toLowerCase().includes(filterText.toLowerCase()) ||
      e.aggregateId.toLowerCase().includes(filterText.toLowerCase())
  ) ?? [];

  // Compute relative timestamps from first event
  const firstTs = result?.events[0]
    ? new Date(result.events[0].timestamp).getTime()
    : 0;

  // Group by aggregateId for the aggregate view
  const aggregates = new Map<string, TraceLineageEntry[]>();
  for (const ev of filteredEvents) {
    const bucket = aggregates.get(ev.aggregateId) ?? [];
    bucket.push(ev);
    aggregates.set(ev.aggregateId, bucket);
  }

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="space-y-2">
        <h2 className="text-base font-semibold text-white">Event Trace Explorer</h2>
        <div className="flex gap-2">
          <input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search(inputValue)}
            placeholder="Enter traceId…"
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 outline-none focus:border-blue-500 font-mono"
          />
          <button
            onClick={() => search(inputValue)}
            disabled={loading || !inputValue.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded font-medium transition-colors flex items-center gap-1.5"
          >
            <Search className="h-3.5 w-3.5" />
            Trace
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-950/20 p-4 text-red-400 text-sm">
          <AlertTriangle className="inline mr-2 h-4 w-4" />
          {error}
        </div>
      )}

      {loading && (
        <div className="text-zinc-500 text-sm animate-pulse">Tracing {traceId}…</div>
      )}

      {result && !loading && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <GitBranch className="h-4 w-4 text-zinc-500" />
              <span className="text-sm text-zinc-400">
                <span className="text-white font-medium">{result.eventCount}</span> events across{" "}
                <span className="text-white font-medium">{aggregates.size}</span> aggregates
              </span>
            </div>
            <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-700 rounded px-2 py-1">
              <Search className="h-3 w-3 text-zinc-500" />
              <input
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="filter events…"
                className="bg-transparent text-xs text-zinc-300 placeholder-zinc-600 outline-none w-32"
              />
            </div>
          </div>

          {/* Aggregate sections */}
          <div className="space-y-4">
            {Array.from(aggregates.entries()).map(([aggregateId, events]) => {
              const aggregateType = events[0]?.aggregateType ?? "UNKNOWN";
              const colour = getColour(aggregateType);

              return (
                <div key={aggregateId} className="space-y-0">
                  <div className={`flex items-center gap-2 text-xs font-medium border-b pb-1.5 mb-2 ${colour}`}>
                    <span className="uppercase tracking-wide">{aggregateType}</span>
                    <span className="opacity-60 font-mono truncate">{aggregateId}</span>
                    <span className="opacity-50 ml-auto">{events.length} events</span>
                  </div>

                  <div className="ml-2">
                    {events.map((ev) => (
                      <EventNode
                        key={ev.eventId}
                        event={ev}
                        relativeMs={Math.max(
                          0,
                          Math.round(new Date(ev.timestamp).getTime() - firstTs)
                        )}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {result && result.eventCount === 0 && (
        <ExplainedEmptyState
          concept="trace"
          title="No events for this trace"
          body={`Nothing was recorded under trace "${traceId}". Either the ID is wrong, or the request didn't generate any events. Paste a trace ID from a recent run to follow it across the system.`}
        />
      )}
    </div>
  );
}
