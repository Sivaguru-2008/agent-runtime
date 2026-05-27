/**
 * PHASE 4 — Operator API Client
 *
 * Typed client for all Phase 4 operator endpoints.
 * Each function maps 1:1 to a backend operator route so the UI layer
 * never constructs raw URLs.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
    next: { revalidate: 0 }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Types (mirrored from backend operatorQueries.ts) ──────────────────────

export interface MetricsSnapshot {
  ts: string;
  executions: {
    running: number;
    queued: number;
    completed: number;
    failed: number;
    total: number;
  };
  workers: {
    total: number;
    ready: number;
    busy: number;
    lost: number;
    draining: number;
    meanHeartbeatAgeMs: number;
  };
  leases: {
    active: number;
    oldestAgeMs: number;
  };
  scheduler: {
    queueDepth: number;
    inFlightCount: number;
  };
  dlq: { volume: number };
  tokens: { prompt: number; completion: number; total: number };
}

export interface WorkerLoad {
  cpu: number;
  memory: number;
  inFlight: number;
  queueDepth: number;
  eventsPerSecond: number;
}

export interface RuntimeWorker {
  id: string;
  host: string;
  region?: string;
  version: string;
  capacity: number;
  status: "REGISTERED" | "READY" | "BUSY" | "DRAINING" | "LOST" | "STOPPED";
  load: WorkerLoad;
  startedAt: string;
  lastHeartbeatAt: string;
}

export interface ExecutionLease {
  executionId: string;
  workerId: string;
  acquiredAt: string;
  expiresAt: string;
  renewedAt: string;
  status: "ACTIVE" | "RELEASED" | "EXPIRED" | "RECLAIMED";
  attempt: number;
}

export interface WorkerHealthEntry {
  worker: RuntimeWorker;
  heartbeatAgeMs: number;
  activeLeases: ExecutionLease[];
  executionIds: string[];
  utilizationPct: number;
}

export interface LeaseMapEntry {
  lease: ExecutionLease;
  worker: RuntimeWorker | undefined;
  execution: { id: string; agentId: string; status: string } | undefined;
  ageMs: number;
  remainingMs: number;
  attemptCount: number;
}

export interface DeadLetterEntry {
  id: string;
  executionId: string;
  agentId: string;
  workerId: string;
  failureCount: number;
  lastError: string;
  firstFailedAt: string;
  movedAt: string;
  taskSnapshot?: Record<string, unknown>;
}

export interface ExecutionDiagnosis {
  executionId: string;
  execution: { id: string; agentId: string; status: string; createdAt?: string; completedAt?: string } | undefined;
  checkpoint: {
    id: string;
    phase: string;
    sequence: number;
    createdAt: string;
  } | undefined;
  lease: ExecutionLease | undefined;
  dlqEntry: DeadLetterEntry | undefined;
  eventCount: number;
  timeline: Array<{
    sequence: number;
    type: string;
    timestamp: string;
    traceId: string | undefined;
    phase?: string;
    durationMs?: number;
    toolName?: string;
    payload: unknown;
  }>;
  warnings: Array<{
    kind: string;
    severity: string;
    title: string;
    description: string;
    timestamp: string;
  }>;
  summary: {
    totalDurationMs: number | undefined;
    stepCount: number;
    toolCallCount: number;
    modelCallCount: number;
    retryCount: number;
    failureCount: number;
  };
  heartbeatFreshnessMs?: number;
  leaseToken?: number;
  cancellationStatus?: { isCancelled: boolean; reason?: string; latencyMs?: number };
  recoveryStatus?: { isRecovered: boolean; recoveryCount: number };
}

export interface TraceLineageEntry {
  sequence: number;
  eventId: string;
  type: string;
  timestamp: string;
  aggregateType: string;
  aggregateId: string;
  traceId: string;
  correlationId?: string;
  causationId?: string;
  payload: unknown;
}

export interface ReplayScrubberData {
  executionId: string;
  checkpoints: Array<{ id: string; phase: string; sequence: number; createdAt: string }>;
  frames: Array<{
    frameIndex: number;
    sequence: number;
    eventType: string;
    timestamp: string;
    phase: string;
    payload: unknown;
  }>;
  branches: Array<{ branchExecutionId: string; createdAt: string }>;
}

// ── Phase 6: Operator control types ──────────────────────────────────────

export interface OperatorPauseResult {
  status: "PAUSE_REQUESTED" | "ALREADY_PAUSED";
  executionId: string;
  checkpointId: string;
  requestedAt: string;
}

export interface OperatorResumeResult {
  status: "RESUME_REQUESTED" | "NOT_PAUSED";
  executionId: string;
  requestedAt: string;
}

export interface OperatorInjectResult {
  status: "INJECT_QUEUED";
  executionId: string;
  injectionId: string;
  frameIndex: number;
  requestedAt: string;
}

// ── API functions ─────────────────────────────────────────────────────────

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    next: { revalidate: 0 }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface MemoryTrustData {
  cognitionId: string;
  scoredMemories: Array<{
    memory: {
      id: string;
      agentId: string;
      executionId?: string;
      type: string;
      content: string;
      metadata: Record<string, any>;
      createdAt: string;
    };
    trustScore: {
      recency: number;
      frequency: number;
      sourceReliability: number;
      contradictionLikelihood: number;
      semanticRelevance: number;
      executionSuccessCorrelation: number;
      overall: number;
    };
    freshnessScore: number;
    isStale: boolean;
    isSuppressed: boolean;
    contaminationAlerts: Array<{
      id: string;
      memoryId: string;
      type: "SEMANTIC_CONFLICT" | "OUTDATED_INSTRUCTION" | "RECURSIVE_CONTAMINATION_LOOP";
      severity: "LOW" | "HIGH" | "CRITICAL";
      message: string;
      conflictingMemoryIds?: string[];
    }>;
    lineage: {
      dependencies: string[];
      derivedFromExecutionId?: string;
    };
  }>;
}

export const operatorApi = {
  snapshot: () => get<MetricsSnapshot>("/operator/snapshot"),
  workers: () => get<WorkerHealthEntry[]>("/operator/workers"),
  leases: () => get<LeaseMapEntry[]>("/operator/leases"),
  dlq: () => get<DeadLetterEntry[]>("/operator/dlq"),
  diagnose: (executionId: string) =>
    get<ExecutionDiagnosis>(`/operator/diagnose/${executionId}`),
  trace: (traceId: string) =>
    get<{ traceId: string; eventCount: number; events: TraceLineageEntry[] }>(
      `/operator/trace/${traceId}`
    ),
  replay: (executionId: string) =>
    get<ReplayScrubberData>(`/operator/replay/${executionId}`),
  memoryTrust: (cognitionId: string) =>
    get<MemoryTrustData>(`/cognition/${cognitionId}/memory-trust`),

  // Phase 6: Operator control commands
  pauseExecution: (executionId: string) =>
    post<OperatorPauseResult>(`/operator/executions/${executionId}/pause`),

  resumeExecution: (executionId: string) =>
    post<OperatorResumeResult>(`/operator/executions/${executionId}/resume`),

  injectInput: (executionId: string, frameIndex: number, input: Record<string, unknown>, reason: string) =>
    post<OperatorInjectResult>(`/operator/executions/${executionId}/inject`, { frameIndex, input, reason })
};
