export type AgentState = "CREATED" | "IDLE" | "RUNNING" | "STOPPING" | "STOPPED" | "FAILED" | "DEGRADED";
export type RuntimeStatus = "OFFLINE" | "READY" | "BUSY" | "STOPPING" | "ERROR";
export type ExecutionStatus = "QUEUED" | "RUNNING" | "FAILED" | "COMPLETED" | "CANCELLED";

export interface Agent {
  id: string;
  name: string;
  goal: string;
  state: AgentState;
  runtimeStatus: RuntimeStatus;
  model: {
    provider: string;
    model: string;
    temperature?: number;
  };
  tools: Array<{ name: string; description?: string; enabled: boolean }>;
  memoryPolicy: {
    episodicEnabled: boolean;
    semanticEnabled: boolean;
    maxRetrievedItems: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface Execution {
  id: string;
  agentId: string;
  parentExecutionId?: string;
  status: ExecutionStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  failure?: {
    message: string;
    code?: string;
    recoverable: boolean;
  };
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
  };
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
}

export interface DomainEvent {
  id: string;
  type: string;
  aggregateId: string;
  aggregateType: string;
  timestamp: string;
  payload: Record<string, unknown>;
  metadata: {
    traceId: string;
    correlationId: string;
    causationId?: string;
    source: string;
    schemaVersion: number;
  };
  sequence?: number;
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  timestamp?: string;
  severity?: "info" | "warning" | "critical";
  data?: Record<string, unknown>;
  metadata?: {
    aggregateId?: string;
    traceId?: string;
    reasoningIntensity?: number;
    intensityRank?: number;
    durationMs?: number;
    totalTokens?: number;
    [key: string]: unknown;
  };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface TimelineFrame {
  id: string;
  type: string;
  timestamp: string;
  title: string;
  prompt?: unknown;
  output?: unknown;
  tokenUsage?: { prompt?: number; completion?: number; total?: number };
  durationMs?: number;
  payload: Record<string, unknown>;
}

export interface MemoryInfluence {
  id: string;
  content: string;
  score: number;
  corrupted: boolean;
  conflicting: boolean;
  createdAt?: string;
  metadata: Record<string, unknown>;
}

export interface ObservabilityWarning {
  id: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  timestamp: string;
}

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
  totals: { durationMs: number; tokens: number; nodes: number };
  peak: { durationMs: number; tokens: number };
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

export interface FailureCluster {
  id: string;
  fingerprint: string;
  kind: string;
  signature: string;
  description: string;
  occurrences: number;
  severity: "info" | "warning" | "critical";
  firstSeen: string;
  lastSeen: string;
  executionIds: string[];
  sampleWarningIds: string[];
}

export interface FailureClusterReport {
  clusters: FailureCluster[];
  totals: { warnings: number; executions: number };
}

export interface CoordinationPressureNodeSummary {
  agentId: string;
  inboundEdges: number;
  outboundEdges: number;
  congestion: number;
  bottleneckScore: number;
  isBottleneck: boolean;
}

export interface ExecutionDetails {
  execution: Execution;
  executionId: string;
  events: DomainEvent[];
  timeline: TimelineFrame[];
  warnings: ObservabilityWarning[];
  memoryInfluence: MemoryInfluence[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  heatmap?: DecisionHeatmap;
  memoryDrift?: MemoryDriftReport;
  promptDeltas?: PromptDelta[];
}

export interface Overview {
  agents: { total: number; active: number; failed: number };
  executions: { total: number; running: number; failed: number; completed: number };
  tokens: { prompt: number; completion: number; total: number };
  recentEvents: DomainEvent[];
}

export interface AgentDetails {
  agent: Agent;
  executions: Execution[];
  memory: MemoryInfluence[];
}

export type WorkerStatus = "REGISTERED" | "READY" | "BUSY" | "DRAINING" | "LOST" | "STOPPED";

export interface RuntimeWorker {
  id: string;
  host: string;
  region?: string;
  version: string;
  capacity: number;
  status: WorkerStatus;
  load: {
    cpu: number;
    memory: number;
    inFlight: number;
    queueDepth: number;
    eventsPerSecond: number;
  };
  startedAt: string;
  lastHeartbeatAt: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionLease {
  executionId: string;
  workerId: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  status: "ACTIVE" | "RELEASED" | "EXPIRED" | "RECLAIMED";
  attempt: number;
}

export interface ClusterOverview {
  workers: { total: number; ready: number; busy: number; lost: number; draining: number };
  leases: { active: number; expired: number; reclaimed: number };
  throughput: { eventsPerSecond: number; runningExecutions: number; queueDepth: number };
  meanHeartbeatAgeMs: number;
}

export interface ClusterSnapshot {
  workers: RuntimeWorker[];
  leases: ExecutionLease[];
  overview: ClusterOverview;
  executionsByWorker: Array<{ workerId: string; executionIds: string[] }>;
}

export interface Topology {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    status?: string;
    data: Record<string, unknown>;
    pressure?: {
      congestion: number;
      inbound: number;
      outbound: number;
      bottleneckScore: number;
      isBottleneck: boolean;
    };
  }>;
  edges: GraphEdge[];
  pressure?: {
    meanCongestion: number;
    peakCongestion: number;
    nodes: CoordinationPressureNodeSummary[];
  };
}
