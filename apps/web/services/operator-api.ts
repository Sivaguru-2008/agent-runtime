/**
 * PHASE 4 — Operator API Client
 *
 * Typed client for all Phase 4 operator endpoints.
 * Each function maps 1:1 to a backend operator route so the UI layer
 * never constructs raw URLs.
 */

// Single backend URL source: route through the Next proxy at /api/runtime like
// every other client (lib/api.ts, lib/cognition-api.ts, services/playground-api.ts,
// hooks/use-backend-health.ts). Talking to http://localhost:4000 directly from
// the browser bypassed the proxy's circuit breaker, IPv4/IPv6 normalisation and
// structured error envelopes, and broke the moment the backend host/port moved.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/runtime";

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 0 }
    });
  } catch (err) {
    throw new Error(
      `Backend is unavailable — ensure the API server is running on port 4000. ` +
        `(${err instanceof Error ? err.message : String(err)})`
    );
  }
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
  /** Distributed trace id, resolved server-side from the execution's events. */
  traceId?: string;
  /** Runtime correlation id of the request that produced this diagnosis. */
  runtimeId?: string;
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
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      next: { revalidate: 0 }
    });
  } catch (err) {
    throw new Error(
      `Backend is unavailable — ensure the API server is running on port 4000. ` +
        `(${err instanceof Error ? err.message : String(err)})`
    );
  }
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

// ── Activation funnel (admin-gated) ──────────────────────────────────────
// Mirrors GET /admin/funnel: how many self-serve signups went on to run their
// first agent. The single founder-facing growth number.

export interface FunnelSource {
  source: string;
  signups: number;
  activated: number;
  activationRate: number;
}

export interface FunnelData {
  total: number;
  activated: number;
  activationRate: number;
  bySource: FunnelSource[];
}

// ── Historical funnel (admin-gated) ──────────────────────────────────────
// Mirrors GET /admin/funnel/history: signup→activation conversion bucketed by
// signup time over a window. Buckets are cohort-based (a bucket's `activated`
// = tenants who signed up in it and have since activated).

export type FunnelGranularity = "day" | "week" | "month";

export interface FunnelHistoryBucket {
  /** Bucket start, ISO-8601 UTC. */
  bucket: string;
  signups: number;
  activated: number;
  activationRate: number;
}

export interface FunnelHistory {
  from: string;
  to: string;
  granularity: FunnelGranularity;
  buckets: FunnelHistoryBucket[];
  totals: { signups: number; activated: number; activationRate: number };
}

// ── Phase 2: cohorts, segmentation, period comparison, health, alerts ───────

export type CohortGranularity = "week" | "month";

export interface CohortCell {
  period: number;
  activated: number;
  rate: number;
}
export interface Cohort {
  cohort: string;
  size: number;
  cells: CohortCell[];
}
export interface CohortReport {
  cohortBy: CohortGranularity;
  periods: number;
  cohorts: Cohort[];
}

export interface RetentionCell {
  period: number;
  active: number;
  rate: number;
}
export interface RetentionCohort {
  cohort: string;
  size: number;
  cells: RetentionCell[];
}
export interface RetentionReport {
  cohortBy: CohortGranularity;
  periods: number;
  cohorts: RetentionCohort[];
}

export type SegmentDimension = "source" | "plan" | "invite" | "campaign";
export interface FunnelSegment {
  key: string;
  signups: number;
  activated: number;
  activationRate: number;
}
export interface SegmentedFunnel {
  segmentBy: SegmentDimension;
  segments: FunnelSegment[];
  totals: { signups: number; activated: number; activationRate: number };
}

export interface PeriodCounts {
  from: string;
  to: string;
  signups: number;
  activated: number;
  activationRate: number;
}
export interface PeriodComparison {
  granularity: CohortGranularity;
  current: PeriodCounts;
  previous: PeriodCounts;
  delta: { signupsPct: number | null; activationRatePoints: number };
}

export type HealthStatus = "ok" | "warn" | "error" | "empty";
export interface DataQualityCheck {
  id: string;
  description: string;
  count: number;
  severity: "warn" | "error";
  ok: boolean;
}
export interface FunnelHealth {
  generatedAt: string;
  pipeline: {
    status: HealthStatus;
    totalEvents: number;
    signupEvents: number;
    activationEvents: number;
    lastEventAt: string | null;
    freshnessMs: number | null;
  };
  dataQuality: { status: HealthStatus; checks: DataQualityCheck[] };
}

export interface FunnelAlertEvaluation {
  ruleId: string;
  title: string;
  status: "ok" | "firing";
  value: number | null;
  threshold: number | null;
  reason: string;
  firedAt: string | null;
  changed: boolean;
}
export interface FunnelAlertsResult {
  enabled: boolean;
  evaluatedAt: string;
  alerts: FunnelAlertEvaluation[];
}

export const operatorApi = {
  snapshot: () => get<MetricsSnapshot>("/operator/snapshot"),
  funnel: () => get<FunnelData>("/admin/funnel"),
  funnelHistory: (params?: { granularity?: FunnelGranularity; from?: string; to?: string; source?: "events" | "rollup" }) => {
    const qs = new URLSearchParams();
    if (params?.granularity) qs.set("granularity", params.granularity);
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    if (params?.source) qs.set("source", params.source);
    const suffix = qs.toString();
    return get<FunnelHistory>(`/admin/funnel/history${suffix ? `?${suffix}` : ""}`);
  },
  funnelCohorts: (params?: { cohortBy?: CohortGranularity; periods?: number }) => {
    const qs = new URLSearchParams();
    if (params?.cohortBy) qs.set("cohortBy", params.cohortBy);
    if (params?.periods != null) qs.set("periods", String(params.periods));
    const suffix = qs.toString();
    return get<CohortReport>(`/admin/funnel/cohorts${suffix ? `?${suffix}` : ""}`);
  },
  funnelSegments: (segmentBy: SegmentDimension) =>
    get<SegmentedFunnel>(`/admin/funnel/segments?segmentBy=${encodeURIComponent(segmentBy)}`),
  funnelCompare: (granularity: CohortGranularity = "week") =>
    get<PeriodComparison>(`/admin/funnel/compare?granularity=${granularity}`),
  funnelHealth: () => get<FunnelHealth>("/admin/funnel/health"),
  funnelAlerts: () => get<FunnelAlertsResult>("/admin/funnel/alerts"),
  funnelRetention: (params?: { cohortBy?: CohortGranularity; periods?: number }) => {
    const qs = new URLSearchParams();
    if (params?.cohortBy) qs.set("cohortBy", params.cohortBy);
    if (params?.periods != null) qs.set("periods", String(params.periods));
    const suffix = qs.toString();
    return get<RetentionReport>(`/admin/funnel/retention${suffix ? `?${suffix}` : ""}`);
  },
  /** Download URL for the CSV export (proxied; the proxy injects the key). */
  funnelExportUrl: () => `${API_BASE}/admin/funnel/export`,
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
