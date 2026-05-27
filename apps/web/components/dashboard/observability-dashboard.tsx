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
import { statusVariant } from "./status";
import { TimelineReplay } from "./timeline-replay";
import { CognitionWorkbench } from "@/components/cognition/cognition-workbench";
import { FrontendDiagnostics } from "./frontend-diagnostics";

const demoPrompt = "Investigate an autonomous agent incident, inspect memory influence, flag uncertainty, and produce traceable reasoning.";

export function ObservabilityDashboard() {
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
  const [failureClusters, setFailureClusters] = useState<FailureClusterReport>();

  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedAgentId), [agents, selectedAgentId]);

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

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 4500);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!selectedExecutionId) return;
    api.execution(selectedExecutionId)
      .then(setDetails)
      .catch((detailsError: unknown) => setError(detailsError instanceof Error ? detailsError.message : "Unable to load execution"));
  }, [selectedExecutionId, events]);

  useEffect(() => {
    const source = new EventSource(eventStreamUrl());
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as DomainEvent;
      setEvents((current) => mergeEvents([event, ...current], []));
      if (event.aggregateType === "EXECUTION") setSelectedExecutionId(event.aggregateId);
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
        const event = JSON.parse((message as MessageEvent).data) as DomainEvent;
        setEvents((current) => mergeEvents([event, ...current], []));
        if (event.aggregateType === "EXECUTION") setSelectedExecutionId(event.aggregateId);
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
    setBusy(true);
    setError(undefined);
    try {
      const agentId = await ensureAgent();
      const execution = await api.runTask(agentId, demoPrompt);
      setSelectedExecutionId(execution.id);
      await refresh();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Unable to run trace");
    } finally {
      setBusy(false);
    }
  }, [ensureAgent, refresh]);

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
            <Button onClick={runTrace} disabled={busy}>
              <CirclePlay className="h-4 w-4" />
              Run Trace
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1800px] space-y-4 px-4 py-4">
        {error ? (
          <div className="flex items-center gap-2 rounded-md border border-critical/40 bg-critical/10 px-4 py-3 text-sm text-critical">
            <ServerCrash className="h-4 w-4" />
            {error}
          </div>
        ) : null}

        <MetricStrip overview={overview} connected={connected} />

        <Tabs defaultValue="workbench" className="space-y-4">
          <TabsList>
            <TabsTrigger value="workbench">Durable Run Studio</TabsTrigger>
            <TabsTrigger value="playground">Playground</TabsTrigger>
            <TabsTrigger value="cognition">Legacy Engine Traces</TabsTrigger>
            <TabsTrigger value="cluster">Cluster Topology</TabsTrigger>
          </TabsList>
          <TabsContent value="workbench">
            <CognitionWorkbench agents={agents.map((a) => ({ id: a.id, name: a.name, goal: a.goal }))} />
          </TabsContent>
          <TabsContent value="playground">
            <Playground />
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
                  <Badge variant={statusVariant(agent.runtimeStatus)}>{agent.runtimeStatus}</Badge>
                </div>
                <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{agent.goal}</p>
                <div className="mt-2 font-mono text-[11px] text-muted-foreground">{agent.model.provider}/{agent.model.model}</div>
              </button>
            ))}
            {!agents.length ? <div className="py-16 text-center text-sm text-muted-foreground">No agents yet</div> : null}
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
                  <Badge variant={statusVariant(execution.status)}>{execution.status}</Badge>
                </div>
                <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-muted-foreground">
                  <span>{execution.tokenUsage.total} tokens</span>
                  {execution.parentExecutionId ? <span className="inline-flex items-center gap-1"><RotateCcw className="h-3 w-3" /> replay</span> : null}
                </div>
              </button>
            ))}
            {!executions.length ? <div className="py-16 text-center text-sm text-muted-foreground">No runs yet</div> : null}
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
