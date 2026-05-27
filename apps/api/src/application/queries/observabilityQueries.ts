import type { EventStore, AgentRepository, ExecutionRepository } from "../../domain/ports.js";
import type { DomainEvent } from "../../domain/events.js";
import type { Execution } from "../../domain/model.js";
import { FailureAnalysisEngine, type ObservabilityWarning } from "./failureAnalysisEngine.js";
import {
  coordinationPressure,
  decisionHeatmap,
  memoryDrift,
  promptDeltas,
  type CoordinationPressureReport,
  type DecisionHeatmap,
  type MemoryDriftReport,
  type PromptDelta
} from "./cognitiveAnalytics.js";
import { clusterFailures, type FailureClusterReport, type ExecutionWarningBundle } from "./failureClustering.js";

interface DetailsCacheEntry {
  signature: string;
  details: ExecutionDetailsResult;
}

export interface ExecutionDetailsResult {
  executionId: string;
  events: DomainEvent[];
  timeline: ReturnType<typeof eventToTimelineFrame>[];
  warnings: ObservabilityWarning[];
  memoryInfluence: ReturnType<typeof extractMemoryInfluence>;
  graph: {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
  heatmap: DecisionHeatmap;
  memoryDrift: MemoryDriftReport;
  promptDeltas: PromptDelta[];
}

export class ObservabilityQueries {
  private readonly detailsCache = new Map<string, DetailsCacheEntry>();

  constructor(
    private readonly agents: AgentRepository,
    private readonly executions: ExecutionRepository,
    private readonly events: EventStore,
    private readonly analysis = new FailureAnalysisEngine()
  ) {}

  async overview() {
    const agents = await this.agents.list();
    const executionsByAgent = await Promise.all(
      agents.map(async (agent) => [agent.id, await this.executions.listByAgent(agent.id)] as const)
    );
    const executions = executionsByAgent.flatMap(([, items]) => items);

    return {
      agents: {
        total: agents.length,
        active: agents.filter((agent) => agent.runtimeStatus === "BUSY" || agent.runtimeStatus === "READY").length,
        failed: agents.filter((agent) => agent.runtimeStatus === "ERROR").length
      },
      executions: {
        total: executions.length,
        running: executions.filter((execution) => execution.status === "RUNNING" || execution.status === "QUEUED").length,
        failed: executions.filter((execution) => execution.status === "FAILED").length,
        completed: executions.filter((execution) => execution.status === "COMPLETED").length
      },
      tokens: executions.reduce(
        (total, execution) => ({
          prompt: total.prompt + execution.tokenUsage.prompt,
          completion: total.completion + execution.tokenUsage.completion,
          total: total.total + execution.tokenUsage.total
        }),
        { prompt: 0, completion: 0, total: 0 }
      ),
      recentEvents: await this.events.listRecent(25)
    };
  }

  async executionDetails(executionId: string): Promise<ExecutionDetailsResult> {
    const events = await this.events.listByExecution(executionId);
    const signature = `${events.length}:${events.at(-1)?.id ?? "empty"}`;
    const cached = this.detailsCache.get(executionId);
    if (cached && cached.signature === signature) {
      return cached.details;
    }

    const warnings = this.analysis.analyze(events);
    const heatmap = decisionHeatmap(events);
    const drift = memoryDrift(events);
    const deltas = promptDeltas(events);
    const intensityByEventId = new Map(heatmap.nodes.map((node) => [node.id, node]));

    const flowEvents = events.filter(
      (event) =>
        event.type === "EXECUTION_STEP_STARTED" ||
        event.type === "TOOL_CALLED" ||
        event.type === "MEMORY_RETRIEVED"
    );
    const nodes = flowEvents.map((event) => eventToGraphNode(event, intensityByEventId));

    const driftWarnings: ObservabilityWarning[] = drift.warnings.map((warning) => ({
      id: warning.id,
      kind: "MEMORY_DRIFT",
      severity: warning.severity,
      title: warning.title,
      description: warning.description,
      evidence: { driftScore: warning.driftScore },
      timestamp: warning.timestamp
    }));
    const allWarnings = [...warnings, ...driftWarnings];

    const warningNodes = allWarnings.map((warning) => ({
      id: warning.id,
      type: "OBSERVABILITY_WARNING",
      label: warning.title,
      timestamp: warning.timestamp,
      severity: warning.severity,
      data: warning,
      metadata: {
        aggregateId: executionId,
        traceId: events[0]?.metadata.traceId
      }
    }));

    const graphNodes = [...nodes, ...warningNodes];
    const flowEdges = nodes.slice(1).map((node, index) => ({
      id: `${nodes[index].id}->${node.id}`,
      source: nodes[index].id,
      target: node.id,
      label: "next"
    }));
    const warningEdges = warningNodes.map((node) => ({
      id: `${nodes.at(-1)?.id ?? executionId}->${node.id}`,
      source: nodes.at(-1)?.id ?? executionId,
      target: node.id,
      label: "warns"
    }));

    const details: ExecutionDetailsResult = {
      executionId,
      events,
      timeline: events.map(eventToTimelineFrame),
      warnings: allWarnings,
      memoryInfluence: extractMemoryInfluence(events),
      graph: {
        nodes: graphNodes,
        edges: [...flowEdges, ...warningEdges]
      },
      heatmap,
      memoryDrift: drift,
      promptDeltas: deltas
    };

    this.detailsCache.set(executionId, { signature, details });
    if (this.detailsCache.size > 256) {
      const oldestKey = this.detailsCache.keys().next().value;
      if (oldestKey) this.detailsCache.delete(oldestKey);
    }

    return details;
  }

  async failureAnalysis(executionId: string) {
    const details = await this.executionDetails(executionId);
    return {
      executionId,
      warnings: details.warnings
    };
  }

  async topology() {
    const agents = await this.agents.list();
    const executionsByAgent = await Promise.all(
      agents.map(async (agent) => [agent.id, await this.executions.listByAgent(agent.id)] as const)
    );
    const executions = executionsByAgent.flatMap(([, items]) => items);
    const pressure = coordinationPressure({ agents, executions });
    const pressureByAgent = new Map(pressure.nodes.map((node) => [node.agentId, node]));

    return {
      nodes: [
        ...agents.map((agent) => {
          const slot = pressureByAgent.get(agent.id);
          return {
            id: agent.id,
            type: "agent",
            label: agent.name,
            status: agent.runtimeStatus,
            data: agent,
            pressure: slot
              ? {
                  congestion: slot.congestion,
                  inbound: slot.inboundEdges,
                  outbound: slot.outboundEdges,
                  bottleneckScore: slot.bottleneckScore,
                  isBottleneck: slot.isBottleneck
                }
              : undefined
          };
        }),
        ...executions.map((execution) => ({
          id: execution.id,
          type: "execution",
          label: execution.status.toLowerCase(),
          status: execution.status,
          data: execution
        }))
      ],
      edges: [
        ...executions.map((execution) => ({
          id: `${execution.agentId}->${execution.id}`,
          source: execution.agentId,
          target: execution.id,
          label: "runs"
        })),
        ...executions
          .filter((execution) => execution.parentExecutionId)
          .map((execution) => ({
            id: `${execution.parentExecutionId}->${execution.id}`,
            source: execution.parentExecutionId!,
            target: execution.id,
            label: "replay branch"
          }))
      ],
      pressure: {
        meanCongestion: pressure.meanCongestion,
        peakCongestion: pressure.peakCongestion,
        nodes: pressure.nodes
      }
    };
  }

  async failureClusters(): Promise<FailureClusterReport> {
    const agents = await this.agents.list();
    const executionsByAgent = await Promise.all(
      agents.map(async (agent) => this.executions.listByAgent(agent.id))
    );
    const executions = executionsByAgent.flat();
    const bundles: ExecutionWarningBundle[] = [];

    for (const execution of executions) {
      const details = await this.executionDetails(execution.id);
      bundles.push({
        executionId: execution.id,
        warnings: details.warnings,
        events: details.events,
        failure: execution.failure,
        toolChain: extractToolChain(details.events)
      });
    }

    return clusterFailures(bundles);
  }

  async snapshot(executionId: string) {
    const execution = await this.executions.getById(executionId);
    const details = await this.executionDetails(executionId);
    const agent = execution ? await this.agents.getById(execution.agentId) : undefined;

    return {
      bundleVersion: 1 as const,
      exportedAt: new Date().toISOString(),
      executionId,
      execution,
      agent,
      events: details.events,
      timeline: details.timeline,
      warnings: details.warnings,
      memoryInfluence: details.memoryInfluence,
      graph: details.graph,
      heatmap: details.heatmap,
      memoryDrift: details.memoryDrift,
      promptDeltas: details.promptDeltas
    };
  }
}

function eventToGraphNode(
  event: DomainEvent,
  intensity: Map<string, { reasoningIntensity: number; intensityRank: number; durationMs: number; totalTokens: number }>
) {
  const stepType = readPath(event.payload, ["step", "type"]);
  const toolName = readPath(event.payload, ["toolCall", "toolName"]);
  const intensityNode = intensity.get(event.id);
  return {
    id: event.id,
    type: String(stepType ?? toolName ?? event.type),
    label: String(stepType ?? toolName ?? event.type).replaceAll("_", " ").toLowerCase(),
    timestamp: event.timestamp,
    data: event.payload,
    metadata: {
      aggregateId: event.aggregateId,
      traceId: event.metadata.traceId,
      reasoningIntensity: intensityNode?.reasoningIntensity ?? 0,
      intensityRank: intensityNode?.intensityRank,
      durationMs: intensityNode?.durationMs,
      totalTokens: intensityNode?.totalTokens
    }
  };
}

function eventToTimelineFrame(event: DomainEvent) {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    title: event.type.replaceAll("_", " ").toLowerCase(),
    prompt: readPath(event.payload, ["step", "input", "prompt"]),
    output: readPath(event.payload, ["step", "output"]) ?? readPath(event.payload, ["output"]),
    tokenUsage: readPath(event.payload, ["tokenUsage"]) ?? readPath(event.payload, ["execution", "tokenUsage"]),
    durationMs: readPath(event.payload, ["step", "durationMs"]),
    payload: event.payload
  };
}

function extractMemoryInfluence(events: DomainEvent[]) {
  return events
    .filter((event) => event.type === "MEMORY_RETRIEVED")
    .flatMap((event) => {
      const records = (readPath(event.payload, ["records"]) ?? []) as Array<{
        id: string;
        content: string;
        metadata?: Record<string, unknown>;
        createdAt?: string;
      }>;
      return records.map((record, index) => ({
        id: record.id,
        content: record.content,
        score: Number(record.metadata?.retrievalScore ?? Math.max(0.2, 1 - index * 0.15)),
        corrupted: /corrupt|invalid|poisoned/i.test(record.content),
        conflicting: /conflict|contradict/i.test(record.content),
        createdAt: record.createdAt,
        metadata: record.metadata ?? {}
      }));
    });
}

function extractToolChain(events: DomainEvent[]): string[] {
  return events
    .filter((event) => event.type === "TOOL_CALLED")
    .map((event) => String(readPath(event.payload, ["toolCall", "toolName"]) ?? "unknown"));
}

function readPath(source: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

// Re-export to ease downstream imports without touching consumers.
export type { ObservabilityWarning } from "./failureAnalysisEngine.js";
export type { FailureClusterReport } from "./failureClustering.js";
export type { Execution };
