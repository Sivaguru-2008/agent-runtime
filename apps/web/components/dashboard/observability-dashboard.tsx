"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, CirclePlay, DatabaseZap, Download, RefreshCcw, RotateCcw, ServerCrash } from "lucide-react";
import { api, eventStreamUrl } from "@/lib/api";
import type {
  Agent,
  DomainEvent,
  Execution,
  ExecutionDetails,
  FailureClusterReport,
  Overview,
  Topology
} from "@/types/observability";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Playground } from "@/components/playground/playground";
import { ClusterView } from "./cluster-view";
import { CoordinationPressurePanel } from "./coordination-pressure-panel";
import { DecisionHeatmapPanel } from "./decision-heatmap";
import { ExecutionGraph } from "./execution-graph";
import { FailureAnalysisPanel } from "./failure-analysis-panel";
import { FailureClusterPanel } from "./failure-cluster-panel";
import { LiveEventStream } from "./live-event-stream";
import { MemoryDriftTimeline } from "./memory-drift-timeline";
import { MemoryInspector } from "./memory-inspector";
import { MetricStrip } from "./metric-strip";
import { MultiAgentTopology } from "./multi-agent-topology";
import { PromptDeltaReplay } from "./prompt-delta-replay";
import { TimelineReplay } from "./timeline-replay";
import { CognitionWorkbench } from "@/components/cognition/cognition-workbench";
import { FrontendDiagnostics } from "./frontend-diagnostics";
import { ExecutionMetadataPanel } from "@/components/ui/execution-metadata-panel";
import { ExplainModeToggle } from "@/components/explain/explain-mode-toggle";
import { StatusPill } from "@/components/explain/status-pill";
import { ExplainedEmptyState } from "@/components/explain/empty-state";
import { OnboardingLaunchers } from "@/components/onboarding/onboarding-launchers";
import { TourAutoStart } from "@/components/onboarding/tour-auto-start";

export function ObservabilityDashboard() {
  const [backendReady, setBackendReady] = useState(false);
  const [checkingReadiness, setCheckingReadiness] = useState(true);
  const [overview, setOverview] = useState<Overview>();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [topology, setTopology] = useState<Topology>();
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [selectedExecutionId, setSelectedExecutionId] = useState<string>();
  const [details, setDetails] = useState<ExecutionDetails>();
  const [events, setEvents] = useState<DomainEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Single shared prompt for the whole console. Entered once in the Playground
  // and reused by Run Studio and Run Trace — there is no second prompt box.
  const [sharedPrompt, setSharedPrompt] = useState("Explain what a vector database is in 4 sentences.");
  const [failureClusters, setFailureClusters] = useState<FailureClusterReport>();

  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedAgentId), [agents, selectedAgentId]);

  // Derive the run's trace id from its event stream (events carry
  // metadata.traceId; the execution row itself does not). First non-empty wins.
  const derivedTraceId = useMemo(
    () => details?.events?.find((e) => e.metadata?.traceId)?.metadata?.traceId,
    [details]
  );
  // Cognition id, when this execution was driven by a cognition run, is stamped
  // into COGNITION_* event payloads.
  const derivedCognitionId = useMemo(() => {
    const evt = details?.events?.find(
      (e) => typeof (e.payload as Record<string, unknown> | undefined)?.cognitionId === "string"
    );
    return (evt?.payload as Record<string, unknown> | undefined)?.cognitionId as string | undefined;
  }, [details]);

  const refresh = useCallback(async () => {
    try {
      const [overviewResult, agentsResult, topologyResult, clustersResult] = await Promise.all([
        api.overview(),
        api.agents(),
        api.topology(),
        api.failureClusters().catch(() => undefined)
      ]);
      setOverview(overviewResult);
      setAgents(agentsResult);
      setTopology(topologyResult);
      if (clustersResult) setFailureClusters(clustersResult);
      setEvents((current) => mergeEvents(current, overviewResult.recentEvents));

      // Successfully reached the API: clear the prior failure state
      setError(undefined);

      const nextAgentId = selectedAgentId ?? agentsResult[0]?.id;
      setSelectedAgentId(nextAgentId);

      if (nextAgentId && !selectedExecutionId) {
        const agentDetails = await api.agent(nextAgentId);
        const latestExecution = agentDetails.executions[0];
        if (latestExecution) setSelectedExecutionId(latestExecution.id);
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Unable to reach API");
    }
  }, [selectedAgentId, selectedExecutionId]);

  // Startup readiness checks and API health polling with exponential backoff
  useEffect(() => {
    let active = true;
    let delay = 1000; // Start with 1s
    const maxDelay = 8000; // Cap at 8s
    let timeoutId: NodeJS.Timeout;

    const checkReadiness = async () => {
      try {
        const res = await fetch("/api/runtime/health");
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.ok && active) {
            setBackendReady(true);
            setCheckingReadiness(false);
            return true;
          }
        }
      } catch {
        // silent fetch failure
      }
      if (active) {
        setBackendReady(false);
        setCheckingReadiness(false);
        const nextDelay = Math.min(delay * 1.8, maxDelay);
        delay = nextDelay;
        timeoutId = setTimeout(checkReadiness, nextDelay);
      }
      return false;
    };

    void checkReadiness();

    return () => {
      active = false;
      clearTimeout(timeoutId);
    };
  }, [backendReady]);

  useEffect(() => {
    if (!backendReady) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 4500);
    return () => window.clearInterval(interval);
  }, [refresh, backendReady]);

  useEffect(() => {
    if (!selectedExecutionId) return;
    api.execution(selectedExecutionId)
      .then(setDetails)
      .catch((detailsError: unknown) => {
        // A single execution failing to load (e.g. an id observed on the event
        // stream a beat before its row is durably readable) must NOT blow away
        // the whole console with a global error banner — that read as a
        // platform-wide "API failure". Degrade gracefully: clear the stale
        // detail view and let the next poll/SSE tick recover. Genuine,
        // sustained failures still surface via the per-execution metadata panel.
        const message = detailsError instanceof Error ? detailsError.message : String(detailsError);
        const transient = /\b404\b|not[_\s-]?found/i.test(message);
        if (!transient) {
          setError(message);
        }
        setDetails(undefined);
      });
  }, [selectedExecutionId, events]);

  useEffect(() => {
    const source = new EventSource(eventStreamUrl());
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    // Only a real execution *lifecycle* transition should auto-focus a run.
    // Previously ANY event with aggregateType === "EXECUTION" flipped the
    // selection — including replay-session / cognition-trace events whose
    // aggregateId is not always a resolvable execution. That produced phantom
    // selections and downstream GET /executions/:id 404s. Restrict auto-focus
    // to the lifecycle event types below.
    const LIFECYCLE_SELECT = new Set([
      "EXECUTION_STARTED",
      "EXECUTION_COMPLETED",
      "EXECUTION_FAILED",
      "EXECUTION_REPLAY_REQUESTED"
    ]);

    const ingest = (event: DomainEvent) => {
      setEvents((current) => mergeEvents([event, ...current], []));
      if (event.aggregateType === "EXECUTION" && LIFECYCLE_SELECT.has(event.type)) {
        setSelectedExecutionId(event.aggregateId);
      }
    };

    source.onmessage = (message) => {
      try {
        ingest(JSON.parse(message.data) as DomainEvent);
      } catch {
        /* ignore malformed frame */
      }
    };

    const eventTypes = [
      "AGENT_CREATED",
      "TASK_SCHEDULED",
      "EXECUTION_STARTED",
      "EXECUTION_STEP_STARTED",
      "EXECUTION_STEP_COMPLETED",
      "MEMORY_RETRIEVED",
      "TOOL_CALLED",
      "MODEL_COMPLETED",
      "EXECUTION_FAILED",
      "EXECUTION_COMPLETED",
      "EXECUTION_REPLAY_REQUESTED"
    ];
    eventTypes.forEach((type) => {
      source.addEventListener(type, (message) => {
        try {
          ingest(JSON.parse((message as MessageEvent).data) as DomainEvent);
        } catch {
          /* ignore malformed frame */
        }
      });
    });

    return () => source.close();
  }, []);

  const ensureAgent = useCallback(async () => {
    if (selectedAgentId) return selectedAgentId;
    const agent = await api.createAgent();
    setAgents((current) => [agent, ...current]);
    setSelectedAgentId(agent.id);
    return agent.id;
  }, [selectedAgentId]);

  const runTrace = useCallback(async () => {
    const prompt = sharedPrompt.trim();
    if (!prompt) {
      setError("Enter a prompt in the Playground first.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const agentId = await ensureAgent();
      const execution = await api.runTask(agentId, prompt);
      setSelectedExecutionId(execution.id);
      await refresh();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Unable to run trace");
    } finally {
      setBusy(false);
    }
  }, [ensureAgent, refresh, sharedPrompt]);

  const seedMemory = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const agentId = await ensureAgent();
      await api.addMemory(agentId, "Previous incident memory: deployment scanner reported a conflict with stale policy state and a possibly corrupted tool result.");
      await api.addMemory(agentId, "Healthy baseline: runtime.inspect can verify execution metadata before model generation.");
      await refresh();
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : "Unable to seed memory");
    } finally {
      setBusy(false);
    }
  }, [ensureAgent, refresh]);

  const replay = useCallback(async () => {
    if (!selectedExecutionId) return;
    setBusy(true);
    try {
      const execution = await api.replay(selectedExecutionId);
      setSelectedExecutionId(execution.id);
      await refresh();
    } catch (replayError) {
      setError(replayError instanceof Error ? replayError.message : "Unable to replay execution");
    } finally {
      setBusy(false);
    }
  }, [refresh, selectedExecutionId]);

  const exportSnapshot = useCallback(async () => {
    if (!selectedExecutionId) return;
    setBusy(true);
    setError(undefined);
    try {
      const bundle = await api.snapshot(selectedExecutionId);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `execution-${selectedExecutionId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Unable to export snapshot");
    } finally {
      setBusy(false);
    }
  }, [selectedExecutionId]);

  if (!backendReady && checkingReadiness) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 font-sans">
        <div className="text-center space-y-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <div className="text-zinc-400 text-sm font-medium">Loading Runloop Console...</div>
        </div>
      </div>
    );
  }

  if (!backendReady) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-4 font-sans selection:bg-primary/20">
        {/* Soft background glow */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-primary/10 rounded-full blur-[120px] pointer-events-none" />
        
        <div className="relative w-full max-w-md p-8 rounded-2xl border border-zinc-800/80 bg-zinc-900/60 backdrop-blur-xl shadow-2xl text-center space-y-6">
          <div className="flex justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 animate-pulse">
              <Bot className="h-7 w-7 text-primary" />
            </div>
          </div>
          
          <div className="space-y-2">
            <h2 className="text-xl font-bold tracking-tight text-zinc-100">Backend Starting Up</h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              The Runloop API service is currently booting up or temporarily unavailable on port 4000. 
              We are establishing a stable connection to the persistence loop.
            </p>
          </div>

          <div className="rounded-lg bg-zinc-950/80 border border-zinc-800/50 p-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-500 font-medium flex items-center gap-1.5">
                <ServerCrash className="h-3.5 w-3.5 text-zinc-500" /> API Status:
              </span>
              <span className="text-amber-400 font-mono flex items-center gap-1">
                <RefreshCcw className="h-3 w-3 animate-spin" /> connecting...
              </span>
            </div>
            
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-900">
              <div className="h-1.5 w-1/2 animate-pulse rounded-full bg-primary/80" />
            </div>
          </div>

          <div className="flex flex-col gap-2 pt-2">
            <Button 
              variant="secondary" 
              className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-zinc-700"
              onClick={() => {
                setCheckingReadiness(true);
                fetch("/api/runtime/health")
                  .then(res => {
                    if (res.ok) {
                      return res.json().catch(() => ({}));
                    }
                    throw new Error();
                  })
                  .then(data => {
                    if (data.ok) {
                      setBackendReady(true);
                    }
                  })
                  .catch(() => {})
                  .finally(() => setCheckingReadiness(false));
              }}
            >
              Retry Connection Now
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-[1800px] flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-primary/35 bg-primary/10">
              <Bot className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-normal">Runloop Console</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Self-Healing Traces</span>
                <span className="h-1 w-1 rounded-full bg-muted-foreground" />
                <span>Time-Travel Replay</span>
                <span className="h-1 w-1 rounded-full bg-muted-foreground" />
                <span>Worker Fencing (Lease Guard)</span>
                <span className="h-1 w-1 rounded-full bg-muted-foreground" />
                <span>Automated DLQ Remediation</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span data-tour="explain-toggle" className="inline-flex">
              <ExplainModeToggle />
            </span>
            <OnboardingLaunchers surface="dashboard" />
            <FrontendDiagnostics />
            <Button variant="secondary" onClick={refresh} disabled={busy}>
              <RefreshCcw className="h-4 w-4" />
              Refresh
            </Button>
            <Button variant="secondary" onClick={seedMemory} disabled={busy}>
              <DatabaseZap className="h-4 w-4" />
              Seed Memory
            </Button>
            <Button variant="secondary" onClick={exportSnapshot} disabled={busy || !selectedExecutionId}>
              <Download className="h-4 w-4" />
              Export Snapshot
            </Button>
            <Button
              onClick={runTrace}
              disabled={busy || !sharedPrompt.trim()}
              title={sharedPrompt.trim() ? "Run the Playground prompt as a durable trace" : "Enter a prompt in the Playground first"}
            >
              <CirclePlay className="h-4 w-4" />
              Run Trace
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1800px] space-y-4 px-4 py-4">
        {/* First-run guided tour (auto-starts once; replay via "Take the tour"). */}
        <TourAutoStart surface="dashboard" />
        {error ? (
          <div className="flex items-center gap-2 rounded-md border border-critical/40 bg-critical/10 px-4 py-3 text-sm text-critical">
            <ServerCrash className="h-4 w-4" />
            {error}
          </div>
        ) : null}

        <MetricStrip overview={overview} connected={connected} />

        <Tabs defaultValue="workbench" className="space-y-4">
          <TabsList>
            <TabsTrigger value="workbench" data-tour="dash-tab-workbench">Durable Run Studio</TabsTrigger>
            <TabsTrigger value="playground" data-tour="dash-tab-playground">Playground</TabsTrigger>
            <TabsTrigger value="cognition" data-tour="dash-tab-cognition">Legacy Engine Traces</TabsTrigger>
            <TabsTrigger value="cluster" data-tour="dash-tab-cluster">Cluster Topology</TabsTrigger>
          </TabsList>
          <TabsContent value="workbench">
            <CognitionWorkbench
              agents={agents.map((a) => ({ id: a.id, name: a.name, goal: a.goal }))}
              prompt={sharedPrompt}
            />
          </TabsContent>
          <TabsContent value="playground">
            <Playground prompt={sharedPrompt} onPromptChange={setSharedPrompt} />
          </TabsContent>
          <TabsContent value="cluster">
            <ClusterView />
          </TabsContent>
          <TabsContent value="cognition" className="space-y-4">
        <div className="grid gap-4 xl:grid-cols-[280px_1fr_380px]">
          <AgentRail
            agents={agents}
            selectedAgentId={selectedAgentId}
            selectedExecutionId={selectedExecutionId}
            onSelectAgent={setSelectedAgentId}
            onSelectExecution={setSelectedExecutionId}
          />

          <div className="space-y-4">
            <ExecutionMetadataPanel
              executionId={details?.execution.id ?? selectedExecutionId}
              runId={details?.execution.parentExecutionId}
              traceId={details?.traceId ?? details?.execution.traceId ?? derivedTraceId}
              runtimeId={details?.runtimeId}
              cognitionId={derivedCognitionId}
              status={details?.execution.status}
              failure={details?.execution.failure}
            />
            <ExecutionGraph details={details} />
            <TimelineReplay details={details} onReplay={replay} />
          </div>

          <div className="space-y-4">
            <LiveEventStream events={events} connected={connected} />
            <FailureAnalysisPanel warnings={details?.warnings ?? []} />
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[420px_1fr]">
          <MemoryInspector memories={details?.memoryInfluence ?? []} />
          <MultiAgentTopology topology={topology} />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <DecisionHeatmapPanel heatmap={details?.heatmap} />
          <MemoryDriftTimeline drift={details?.memoryDrift} />
          <CoordinationPressurePanel topology={topology} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
          <PromptDeltaReplay deltas={details?.promptDeltas} />
          <FailureClusterPanel report={failureClusters} />
        </div>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

function AgentRail({
  agents,
  selectedAgentId,
  selectedExecutionId,
  onSelectAgent,
  onSelectExecution
}: {
  agents: Agent[];
  selectedAgentId?: string;
  selectedExecutionId?: string;
  onSelectAgent(agentId: string): void;
  onSelectExecution(executionId: string): void;
}) {
  const [executions, setExecutions] = useState<Execution[]>([]);

  useEffect(() => {
    if (!selectedAgentId) {
      setExecutions([]);
      return;
    }
    api.agent(selectedAgentId).then((details) => setExecutions(details.executions)).catch(() => setExecutions([]));
  }, [selectedAgentId]);

  return (
    <Card className="h-[996px] overflow-hidden">
      <CardHeader>
        <CardTitle>Runtime State</CardTitle>
        <Badge variant="muted">{agents.length} agents</Badge>
      </CardHeader>
      <CardContent className="h-[940px] overflow-auto p-0">
        <Tabs defaultValue="agents" className="p-3">
          <TabsList className="w-full">
            <TabsTrigger value="agents" className="flex-1">Agents</TabsTrigger>
            <TabsTrigger value="executions" className="flex-1">Runs</TabsTrigger>
          </TabsList>
          <TabsContent value="agents" className="space-y-2">
            {agents.map((agent) => (
              <button
                key={agent.id}
                className={`w-full rounded-md border px-3 py-3 text-left transition-colors ${
                  selectedAgentId === agent.id ? "border-primary bg-primary/10" : "border-border bg-background hover:bg-muted"
                }`}
                onClick={() => onSelectAgent(agent.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-sm font-semibold">{agent.name}</div>
                  <StatusPill status={agent.runtimeStatus} />
                </div>
                <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{agent.goal}</p>
                <div className="mt-2 font-mono text-[11px] text-muted-foreground">{agent.model.provider}/{agent.model.model}</div>
              </button>
            ))}
            {!agents.length ? <ExplainedEmptyState concept="agents-total" title="No agents yet" body="An agent is a configured AI worker. Run a prompt in the Playground (or click Run Trace) and one is created automatically." className="mt-4" /> : null}
          </TabsContent>
          <TabsContent value="executions" className="space-y-2">
            {executions.map((execution) => (
              <button
                key={execution.id}
                className={`w-full rounded-md border px-3 py-3 text-left transition-colors ${
                  selectedExecutionId === execution.id ? "border-primary bg-primary/10" : "border-border bg-background hover:bg-muted"
                }`}
                onClick={() => onSelectExecution(execution.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate font-mono text-xs">{execution.id}</div>
                  <StatusPill status={execution.status} />
                </div>
                <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-muted-foreground">
                  <span>{execution.tokenUsage.total} tokens</span>
                  {execution.parentExecutionId ? <span className="inline-flex items-center gap-1"><RotateCcw className="h-3 w-3" /> replay</span> : null}
                </div>
                {execution.failure ? (
                  <div className="mt-1.5 rounded border border-critical/30 bg-critical/10 px-2 py-1 text-[11px] leading-snug text-critical">
                    <span className="font-medium">{execution.failure.code ?? "FAILURE"}:</span>{" "}
                    <span className="break-words">{execution.failure.message}</span>
                  </div>
                ) : null}
              </button>
            ))}
            {!executions.length ? <ExplainedEmptyState concept="execution" title="No runs yet" body="A run is one attempt at one task. Select an agent and start a run to see it here." className="mt-4" /> : null}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function mergeEvents(primary: DomainEvent[], secondary: DomainEvent[]) {
  const seen = new Set<string>();
  return [...primary, ...secondary]
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 80);
}
