import type { DomainEvent } from "../../domain/events.js";

export interface DecisionHeatNode {
  id: string;
  stepId?: string;
  type: string;
  label: string;
  timestamp: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningIntensity: number;
  intensityRank: number;
  share: number;
}

export interface DecisionHeatmap {
  nodes: DecisionHeatNode[];
  totals: {
    durationMs: number;
    tokens: number;
    nodes: number;
  };
  peak: {
    durationMs: number;
    tokens: number;
  };
}

export interface MemoryDriftPoint {
  recordId: string;
  agentId: string;
  executionId?: string;
  type: string;
  timestamp: string;
  signatureHash: number;
  driftFromPrevious: number;
  cumulativeDrift: number;
  preview: string;
}

export interface MemoryDriftReport {
  points: MemoryDriftPoint[];
  warnings: Array<{
    id: string;
    severity: "info" | "warning" | "critical";
    timestamp: string;
    title: string;
    description: string;
    driftScore: number;
  }>;
  meanDrift: number;
  peakDrift: number;
}

export interface PromptDelta {
  fromStepId: string;
  toStepId: string;
  fromTimestamp: string;
  toTimestamp: string;
  fromType: string;
  toType: string;
  added: string[];
  removed: string[];
  changedKeys: string[];
  similarity: number;
}

export interface CoordinationPressureNode {
  agentId: string;
  inboundEdges: number;
  outboundEdges: number;
  congestion: number;
  bottleneckScore: number;
  isBottleneck: boolean;
}

export interface CoordinationPressureReport {
  nodes: CoordinationPressureNode[];
  meanCongestion: number;
  peakCongestion: number;
}

export function decisionHeatmap(events: DomainEvent[]): DecisionHeatmap {
  const completedSteps = events.filter((event) => event.type === "EXECUTION_STEP_COMPLETED");
  const modelEvents = events.filter((event) => event.type === "MODEL_COMPLETED");

  const aggregatedTokens = modelEvents.reduce(
    (acc, event) => {
      const usage = readPath(event.payload, ["tokenUsage"]) as
        | { prompt?: number; completion?: number; total?: number }
        | undefined;
      acc.prompt += Number(usage?.prompt ?? 0);
      acc.completion += Number(usage?.completion ?? 0);
      acc.total += Number(usage?.total ?? 0);
      return acc;
    },
    { prompt: 0, completion: 0, total: 0 }
  );

  const candidates = completedSteps.map((event) => {
    const step = readPath(event.payload, ["step"]) as Record<string, unknown> | undefined;
    const stepId = String(step?.id ?? event.id);
    const stepType = String(step?.type ?? "UNKNOWN");
    const durationMs = Number(step?.durationMs ?? 0);
    const stepTokens = stepType === "MODEL_GENERATION"
      ? aggregatedTokens.total
      : Math.round(aggregatedTokens.total / Math.max(1, completedSteps.length));

    return {
      id: event.id,
      stepId,
      type: stepType,
      label: stepType.replaceAll("_", " ").toLowerCase(),
      timestamp: event.timestamp,
      durationMs,
      promptTokens: stepType === "MODEL_GENERATION" ? aggregatedTokens.prompt : 0,
      completionTokens: stepType === "MODEL_GENERATION" ? aggregatedTokens.completion : 0,
      totalTokens: stepTokens
    };
  });

  const totalDuration = candidates.reduce((sum, item) => sum + item.durationMs, 0);
  const totalTokens = candidates.reduce((sum, item) => sum + item.totalTokens, 0);
  const peakDuration = candidates.reduce((max, item) => Math.max(max, item.durationMs), 0);
  const peakTokens = candidates.reduce((max, item) => Math.max(max, item.totalTokens), 0);

  const scored = candidates
    .map((item) => {
      const normalizedDuration = peakDuration ? item.durationMs / peakDuration : 0;
      const normalizedTokens = peakTokens ? item.totalTokens / peakTokens : 0;
      const reasoningIntensity = Number((normalizedDuration * 0.55 + normalizedTokens * 0.45).toFixed(4));
      const share = totalDuration ? Number((item.durationMs / totalDuration).toFixed(4)) : 0;
      return { ...item, reasoningIntensity, share };
    })
    .sort((a, b) => b.reasoningIntensity - a.reasoningIntensity)
    .map((item, index) => ({ ...item, intensityRank: index + 1 }));

  return {
    nodes: scored,
    totals: { durationMs: totalDuration, tokens: totalTokens, nodes: scored.length },
    peak: { durationMs: peakDuration, tokens: peakTokens }
  };
}

export function memoryDrift(events: DomainEvent[]): MemoryDriftReport {
  const memoryEvents = events
    .filter((event) => event.type === "MEMORY_RETRIEVED")
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const points: MemoryDriftPoint[] = [];
  let lastSignature: number | undefined;
  let cumulative = 0;

  for (const event of memoryEvents) {
    const records = (readPath(event.payload, ["records"]) ?? []) as Array<{
      id: string;
      agentId: string;
      executionId?: string;
      type: string;
      content: string;
      createdAt?: string;
    }>;

    for (const record of records) {
      const signatureHash = computeSignature(record.content);
      const driftFromPrevious = lastSignature === undefined
        ? 0
        : Number((Math.abs(signatureHash - lastSignature) / Math.max(1, Math.abs(lastSignature))).toFixed(4));
      cumulative = Number((cumulative + driftFromPrevious).toFixed(4));

      points.push({
        recordId: record.id,
        agentId: record.agentId,
        executionId: record.executionId,
        type: record.type,
        timestamp: record.createdAt ?? event.timestamp,
        signatureHash,
        driftFromPrevious,
        cumulativeDrift: cumulative,
        preview: record.content.slice(0, 160)
      });

      lastSignature = signatureHash;
    }
  }

  const drifts = points.map((point) => point.driftFromPrevious);
  const meanDrift = drifts.length ? Number((drifts.reduce((s, v) => s + v, 0) / drifts.length).toFixed(4)) : 0;
  const peakDrift = drifts.length ? Math.max(...drifts) : 0;

  const warnings = points
    .filter((point) => point.driftFromPrevious > 0.45)
    .map((point) => ({
      id: `warning-memory-drift-${point.recordId}`,
      severity: (point.driftFromPrevious > 0.85 ? "critical" : "warning") as "warning" | "critical",
      timestamp: point.timestamp,
      title: "Memory embedding drift detected",
      description: `Memory signature diverged ${(point.driftFromPrevious * 100).toFixed(1)}% from the previous sample.`,
      driftScore: point.driftFromPrevious
    }));

  return { points, warnings, meanDrift, peakDrift };
}

export function promptDeltas(events: DomainEvent[]): PromptDelta[] {
  const stepStarts = events
    .filter((event) => event.type === "EXECUTION_STEP_STARTED")
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const deltas: PromptDelta[] = [];

  for (let index = 1; index < stepStarts.length; index += 1) {
    const previous = stepStarts[index - 1];
    const current = stepStarts[index];
    const prevStep = readPath(previous.payload, ["step"]) as Record<string, unknown> | undefined;
    const currStep = readPath(current.payload, ["step"]) as Record<string, unknown> | undefined;
    if (!prevStep || !currStep) continue;

    const prevInput = prevStep.input as Record<string, unknown> | undefined;
    const currInput = currStep.input as Record<string, unknown> | undefined;
    const prevTokens = tokenize(prevInput);
    const currTokens = tokenize(currInput);
    const added = diffSet(currTokens, prevTokens);
    const removed = diffSet(prevTokens, currTokens);
    const changedKeys = Object.keys({ ...(prevInput ?? {}), ...(currInput ?? {}) })
      .filter((key) => JSON.stringify((prevInput ?? {})[key]) !== JSON.stringify((currInput ?? {})[key]));
    const similarity = jaccard(prevTokens, currTokens);

    deltas.push({
      fromStepId: String(prevStep.id ?? previous.id),
      toStepId: String(currStep.id ?? current.id),
      fromTimestamp: previous.timestamp,
      toTimestamp: current.timestamp,
      fromType: String(prevStep.type ?? "UNKNOWN"),
      toType: String(currStep.type ?? "UNKNOWN"),
      added: added.slice(0, 40),
      removed: removed.slice(0, 40),
      changedKeys,
      similarity: Number(similarity.toFixed(4))
    });
  }

  return deltas;
}

export function coordinationPressure(input: {
  agents: Array<{ id: string }>;
  executions: Array<{ id: string; agentId: string; parentExecutionId?: string }>;
}): CoordinationPressureReport {
  const executionToAgent = new Map(input.executions.map((execution) => [execution.id, execution.agentId]));

  const stats = new Map<string, { inbound: number; outbound: number }>();
  for (const agent of input.agents) {
    stats.set(agent.id, { inbound: 0, outbound: 0 });
  }

  for (const execution of input.executions) {
    const slot = stats.get(execution.agentId) ?? { inbound: 0, outbound: 0 };
    slot.inbound += 1;
    if (execution.parentExecutionId) {
      const parentAgentId = executionToAgent.get(execution.parentExecutionId);
      if (parentAgentId) {
        const parentSlot = stats.get(parentAgentId) ?? { inbound: 0, outbound: 0 };
        parentSlot.outbound += 1;
        stats.set(parentAgentId, parentSlot);
      }
    }
    stats.set(execution.agentId, slot);
  }

  const nodes: CoordinationPressureNode[] = [...stats.entries()].map(([agentId, slot]) => {
    const congestion = slot.inbound + slot.outbound * 1.5;
    const bottleneckScore = slot.inbound >= 3 ? Math.min(1, slot.inbound / 6) : 0;
    return {
      agentId,
      inboundEdges: slot.inbound,
      outboundEdges: slot.outbound,
      congestion: Number(congestion.toFixed(2)),
      bottleneckScore: Number(bottleneckScore.toFixed(2)),
      isBottleneck: bottleneckScore >= 0.5
    };
  });

  const congestionValues = nodes.map((node) => node.congestion);
  const meanCongestion = congestionValues.length
    ? Number((congestionValues.reduce((s, v) => s + v, 0) / congestionValues.length).toFixed(2))
    : 0;
  const peakCongestion = congestionValues.length ? Math.max(...congestionValues) : 0;

  return { nodes, meanCongestion, peakCongestion };
}

function computeSignature(content: string): number {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) - hash + content.charCodeAt(index)) | 0;
  }
  return hash;
}

function tokenize(input?: Record<string, unknown>): string[] {
  if (!input) return [];
  return JSON.stringify(input)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function diffSet(source: string[], other: string[]): string[] {
  const seen = new Set(other);
  const unique = new Set<string>();
  for (const token of source) {
    if (!seen.has(token)) unique.add(token);
  }
  return [...unique];
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union ? intersection / union : 0;
}

function readPath(source: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}
