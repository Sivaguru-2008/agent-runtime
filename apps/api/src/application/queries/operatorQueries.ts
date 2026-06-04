/**
 * PHASE 4 — Operator Queries
 *
 * Assembles operational data from multiple stores into structures designed
 * for debugging, not for decoration. Every method answers a specific
 * operator question:
 *
 *   metricsSnapshot()      → "What is the system's health right now?"
 *   workerHealthDetail()   → "Which worker is struggling and why?"
 *   leaseOwnershipMap()    → "Who owns what execution and for how long?"
 *   dlqEntries()           → "What is stuck in the DLQ and why?"
 *   executionDiagnosis()   → "Why did this execution fail?"
 *   traceLineage()         → "Show me the full causal chain for this trace."
 *   replayScrubberData()   → "Step through this execution replay frame by frame."
 *
 * Operational visibility gained:
 *   Cross-store joins (worker ↔ lease ↔ execution ↔ events ↔ DLQ) that
 *   would take 5 separate API calls from the frontend are assembled here
 *   in a single fast query. The UI receives a complete operational picture
 *   with no N+1 round trips.
 *
 * Debugging improvements:
 *   executionDiagnosis() combines the checkpoint (phase progress), active
 *   lease (worker assignment), failure analysis warnings, and DLQ entry
 *   into one response. An operator can debug a stuck execution without
 *   knowing which API calls to make.
 *
 * Distributed tracing implications:
 *   traceLineage() pivots on metadata.traceId to reconstruct the full
 *   causal chain of an API request across event boundaries — the equivalent
 *   of a Jaeger trace but using the domain event log as the source of truth.
 *
 * Scaling implications:
 *   - traceLineage() scans the last N events (configurable). For deployments
 *     with high event throughput, add a Postgres index on
 *     events(metadata->>'traceId') and replace the scan with a WHERE clause.
 *   - metricsSnapshot() is O(workers + leases + executions) — acceptable for
 *     operator dashboards polled every 5s.
 *   - replayScrubberData() is per-execution and O(checkpoints) — cheap.
 */

import type { EventStore, ExecutionRepository } from "../../domain/ports.js";
import type { WorkerRegistry, LeaseStore, CheckpointStore, DeadLetterQueue } from "../../domain/clusterPorts.js";
import type { DomainEvent } from "../../domain/events.js";
import { isActiveLease, type RuntimeWorker, type ExecutionLease, type ExecutionCheckpoint } from "../../domain/cluster.js";
import type { DistributedScheduler } from "../cluster/distributedScheduler.js";
import { ObservabilityQueries } from "./observabilityQueries.js";

// ── Snapshot ───────────────────────────────────────────────────────────────

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
  dlq: {
    volume: number;
  };
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
}

// ── Worker Health ──────────────────────────────────────────────────────────

export interface WorkerHealthEntry {
  worker: RuntimeWorker;
  heartbeatAgeMs: number;
  activeLeases: ExecutionLease[];
  executionIds: string[];
  utilizationPct: number;
}

// ── Lease Map ─────────────────────────────────────────────────────────────

export interface LeaseMapEntry {
  lease: ExecutionLease;
  worker: RuntimeWorker | undefined;
  execution: { id: string; agentId: string; status: string } | undefined;
  ageMs: number;
  remainingMs: number;
  attemptCount: number;
}

// ── Execution Diagnosis ───────────────────────────────────────────────────

export interface ExecutionDiagnosis {
  executionId: string;
  /** Distributed trace id for this execution, resolved from its event log. */
  traceId: string | undefined;
  execution: { id: string; agentId: string; status: string; createdAt?: string; completedAt?: string } | undefined;
  checkpoint: ExecutionCheckpoint | undefined;
  lease: ExecutionLease | undefined;
  dlqEntry: import("../../domain/cluster.js").DeadLetterEntry | undefined;
  eventCount: number;
  timeline: Array<{
    sequence: number;
    type: string;
    timestamp: string;
    traceId: string | undefined;
    spanId?: string;
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
  // ENRICHED Telemetry Fields
  workerId: string | undefined;
  leaseToken: number | undefined;
  retryCount: number;
  heartbeatFreshnessMs: number | undefined;
  cancellationStatus: {
    isCancelled: boolean;
    cancelledAt?: string;
    reason?: string;
    latencyMs?: number;
  } | undefined;
  recoveryStatus: {
    isRecovered: boolean;
    recoveredAt?: string;
    recoveryCount: number;
  } | undefined;
  executionDurationMs: number | undefined;
}

// ── Trace Lineage ─────────────────────────────────────────────────────────

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

// ── Replay Scrubber ───────────────────────────────────────────────────────

export interface ReplayScrubberData {
  executionId: string;
  checkpoints: ExecutionCheckpoint[];
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

// ── Query Class ───────────────────────────────────────────────────────────

export class OperatorQueries {
  constructor(
    private readonly eventStore: EventStore,
    private readonly executions: ExecutionRepository,
    private readonly workers: WorkerRegistry,
    private readonly leases: LeaseStore,
    private readonly checkpoints: CheckpointStore,
    private readonly dlq: DeadLetterQueue,
    private readonly scheduler: DistributedScheduler,
    private readonly observability: ObservabilityQueries,
    /** Max events to scan for traceLineage (add DB index for production). */
    private readonly traceLinageScanLimit = 5_000
  ) {}

  // ── Metrics Snapshot ────────────────────────────────────────────────────

  async metricsSnapshot(): Promise<MetricsSnapshot> {
    const [workers, leases, dlqList] = await Promise.all([
      this.workers.list(),
      this.leases.listActive(),
      this.dlq.list()
    ]);

    const overview = await this.observability.overview();
    const now = Date.now();

    const heartbeatAges = workers
      .filter((w) => w.status !== "STOPPED")
      .map((w) => now - new Date(w.lastHeartbeatAt).getTime());

    const meanHeartbeatAgeMs = heartbeatAges.length
      ? Math.round(heartbeatAges.reduce((s, a) => s + a, 0) / heartbeatAges.length)
      : 0;

    const leaseAges = leases.map((l) => now - new Date(l.acquiredAt).getTime());
    const oldestAgeMs = leaseAges.length ? Math.max(...leaseAges) : 0;

    return {
      ts: new Date().toISOString(),
      executions: {
        running: overview.executions.running,
        queued: overview.executions.running, // scheduler.queueDepth() below is more accurate
        completed: overview.executions.completed,
        failed: overview.executions.failed,
        total: overview.executions.total
      },
      workers: {
        total: workers.length,
        ready: workers.filter((w) => w.status === "READY").length,
        busy: workers.filter((w) => w.status === "BUSY").length,
        lost: workers.filter((w) => w.status === "LOST").length,
        draining: workers.filter((w) => w.status === "DRAINING").length,
        meanHeartbeatAgeMs
      },
      leases: {
        active: leases.length,
        oldestAgeMs
      },
      scheduler: {
        queueDepth: this.scheduler.queueDepth(),
        inFlightCount: this.scheduler.inFlightCount()
      },
      dlq: {
        volume: dlqList.length
      },
      tokens: overview.tokens
    };
  }

  // ── Worker Health Detail ─────────────────────────────────────────────────

  async workerHealthDetail(): Promise<WorkerHealthEntry[]> {
    const [workers, leases] = await Promise.all([
      this.workers.list(),
      this.leases.listActive()
    ]);

    const now = Date.now();
    const leasesByWorker = new Map<string, ExecutionLease[]>();
    for (const lease of leases) {
      const bucket = leasesByWorker.get(lease.workerId) ?? [];
      bucket.push(lease);
      leasesByWorker.set(lease.workerId, bucket);
    }

    return workers.map((worker) => {
      const workerLeases = leasesByWorker.get(worker.id) ?? [];
      const heartbeatAgeMs = now - new Date(worker.lastHeartbeatAt).getTime();
      // Utilisation = in-flight / capacity, clamped to 0–100%.
      const utilizationPct = Math.min(
        100,
        worker.capacity > 0
          ? Math.round((worker.load.inFlight / worker.capacity) * 100)
          : 0
      );

      return {
        worker,
        heartbeatAgeMs,
        activeLeases: workerLeases,
        executionIds: workerLeases.map((l) => l.executionId),
        utilizationPct
      };
    });
  }

  // ── Lease Ownership Map ──────────────────────────────────────────────────

  async leaseOwnershipMap(): Promise<LeaseMapEntry[]> {
    const [leases, workers] = await Promise.all([
      this.leases.listActive(),
      this.workers.list()
    ]);

    const workerMap = new Map<string, RuntimeWorker>(workers.map((w) => [w.id, w]));
    const now = Date.now();

    const entries = await Promise.all(
      leases.map(async (lease): Promise<LeaseMapEntry> => {
        const execution = await this.executions.getById(lease.executionId).catch(() => undefined);
        const ageMs = now - new Date(lease.acquiredAt).getTime();
        const remainingMs = Math.max(0, new Date(lease.expiresAt).getTime() - now);

        return {
          lease,
          worker: workerMap.get(lease.workerId),
          execution: execution
            ? { id: execution.id, agentId: execution.agentId, status: execution.status }
            : undefined,
          ageMs,
          remainingMs,
          attemptCount: lease.attempt
        };
      })
    );

    // Sort by oldest-first so expiring leases float to the top.
    return entries.sort((a, b) => b.ageMs - a.ageMs);
  }

  // ── DLQ Entries ──────────────────────────────────────────────────────────

  async dlqEntries() {
    return this.dlq.list();
  }

  // ── Execution Diagnosis ──────────────────────────────────────────────────

  async executionDiagnosis(executionId: string): Promise<ExecutionDiagnosis> {
    const [execution, events, checkpoint, lease, dlqEntry] = await Promise.all([
      this.executions.getById(executionId).catch(() => undefined),
      this.eventStore.listByExecution(executionId).catch(() => [] as DomainEvent[]),
      this.checkpoints.latest(executionId).catch(() => undefined),
      this.leases.getByExecution(executionId).catch(() => undefined),
      this.dlq.getByExecution(executionId).catch(() => undefined)
    ]);

    // Lightweight observability analysis — reuses existing warning engine.
    let warnings: ExecutionDiagnosis["warnings"] = [];
    try {
      const analysis = await this.observability.failureAnalysis(executionId);
      warnings = analysis.warnings.map((w) => ({
        kind: w.kind,
        severity: w.severity,
        title: w.title,
        description: w.description,
        timestamp: w.timestamp
      }));
    } catch {
      // Non-fatal: diagnosis is still valuable without warnings.
    }

    // Build structured timeline from raw events.
    const timeline = events.map((event) => ({
      sequence: event.sequence ?? 0,
      type: event.type as string,
      timestamp: event.timestamp,
      traceId: event.metadata.traceId as string | undefined,
      correlationId: event.metadata.correlationId,
      causationId: event.metadata.causationId,
      phase: extractField(event.payload, "step", "type") as string | undefined,
      durationMs: extractField(event.payload, "step", "durationMs") as number | undefined,
      toolName: extractField(event.payload, "toolCall", "toolName") as string | undefined,
      payload: event.payload
    }));

    // Aggregate summary statistics for quick triage.
    const stepEvents = events.filter((e) => e.type === "EXECUTION_STEP_COMPLETED");
    const toolCalls = events.filter((e) => e.type === "TOOL_CALLED");
    const modelCalls = events.filter((e) => e.type === "MODEL_COMPLETED" || e.type === "EXECUTION_STEP_COMPLETED");
    const retries = events.filter((e) => e.type === "RETRY_TRIGGERED");
    const failures = events.filter(
      (e) =>
        e.type === "EXECUTION_FAILED" ||
        e.type === "HALLUCINATION_DETECTED" ||
        e.type === "CONTRADICTION_DETECTED" ||
        e.type === "FAILURE_SIGNAL_RAISED"
    );

    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    const totalDurationMs =
      firstEvent && lastEvent
        ? new Date(lastEvent.timestamp).getTime() - new Date(firstEvent.timestamp).getTime()
        : undefined;

    // Resolve workerId from lease or checkpoints or events
    const workerId = lease?.workerId ?? checkpoint?.workerId ?? ((events.find(e => e.payload && (e.payload as any).workerId)?.payload as any)?.workerId as string | undefined);

    // Heartbeat freshness calculations
    const heartbeatFreshnessMs = lease && isActiveLease(lease.status)
      ? Math.max(0, new Date(lease.expiresAt).getTime() - Date.now())
      : undefined;

    // Cancellation status calculations
    const abortEvent = events.find(e => e.type === "EXECUTION_ABORTED");
    const cancellationStatus = {
      isCancelled: !!abortEvent || execution?.status === "CANCELLED",
      cancelledAt: abortEvent?.timestamp,
      reason: abortEvent ? (abortEvent.payload as any).reason : undefined,
      latencyMs: abortEvent && lastEvent 
        ? Math.max(0, new Date(lastEvent.timestamp).getTime() - new Date(abortEvent.timestamp).getTime())
        : undefined
    };

    // Recovery status calculations
    const resumeEvents = events.filter(e => e.type === "EXECUTION_RESUMED" || e.type === "EXECUTION_LEASE_RECLAIMED");
    const recoveryStatus = {
      isRecovered: resumeEvents.length > 0,
      recoveredAt: resumeEvents.find(e => e.type === "EXECUTION_RESUMED")?.timestamp,
      recoveryCount: resumeEvents.filter(e => e.type === "EXECUTION_RESUMED").length
    };

    const traceId =
      execution?.traceId ?? timeline.find((t) => t.traceId)?.traceId ?? undefined;

    return {
      executionId,
      traceId,
      execution: execution
        ? {
            id: execution.id,
            agentId: execution.agentId,
            status: execution.status,
            createdAt: execution.startedAt,
            completedAt: execution.completedAt
          }
        : undefined,
      checkpoint,
      lease,
      dlqEntry,
      eventCount: events.length,
      timeline,
      warnings,
      summary: {
        totalDurationMs,
        stepCount: stepEvents.length,
        toolCallCount: toolCalls.length,
        modelCallCount: modelCalls.length,
        retryCount: retries.length,
        failureCount: failures.length
      },
      workerId,
      leaseToken: lease?.attempt,
      retryCount: retries.length,
      heartbeatFreshnessMs,
      cancellationStatus,
      recoveryStatus,
      executionDurationMs: totalDurationMs
    };
  }

  // ── Trace Lineage ─────────────────────────────────────────────────────────

  async traceLineage(traceId: string): Promise<TraceLineageEntry[]> {
    // Scan recent events for the traceId. For high-throughput deployments,
    // replace this with a Postgres query:
    //   SELECT * FROM events WHERE metadata->>'traceId' = $1 ORDER BY sequence
    const events = await this.eventStore.listAfterSequence(0, this.traceLinageScanLimit);

    return events
      .filter((e) => e.metadata.traceId === traceId)
      .map((e) => ({
        sequence: e.sequence ?? 0,
        eventId: e.id,
        type: e.type,
        timestamp: e.timestamp,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        traceId: e.metadata.traceId ?? traceId,
        correlationId: e.metadata.correlationId,
        causationId: e.metadata.causationId,
        payload: e.payload
      }));
  }

  // ── Replay Scrubber Data ──────────────────────────────────────────────────

  async replayScrubberData(executionId: string): Promise<ReplayScrubberData> {
    const [checkpointList, events] = await Promise.all([
      this.checkpoints.listByExecution(executionId),
      this.eventStore.listByExecution(executionId)
    ]);

    // Frame = one execution step event, mapped to the checkpoint phase it
    // corresponds to for scrubber positioning.
    const frames = events
      .filter(
        (e) =>
          e.type === "EXECUTION_STEP_STARTED" ||
          e.type === "EXECUTION_STEP_COMPLETED" ||
          e.type === "TOOL_CALLED" ||
          e.type === "MODEL_COMPLETED"
      )
      .map((e, i) => ({
        frameIndex: i,
        sequence: e.sequence ?? 0,
        eventType: e.type,
        timestamp: e.timestamp,
        phase: (extractField(e.payload, "step", "type") as string) ?? e.type,
        payload: e.payload
      }));

    // Find replay branch executions (child executions of this one).
    // These are executions whose parentExecutionId === executionId.
    // We detect them from REPLAY_BRANCH_CREATED events.
    const branchEvents = events.filter((e) => e.type === "REPLAY_BRANCH_CREATED");
    const branches = branchEvents.map((e) => ({
      branchExecutionId:
        (extractField(e.payload, "branch", "executionId") as string) ??
        (extractField(e.payload, "executionId") as string) ?? "",
      createdAt: e.timestamp
    }));

    return { executionId, checkpoints: checkpointList, frames, branches };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function extractField(source: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((cur, key) => {
    if (!cur || typeof cur !== "object") return undefined;
    return (cur as Record<string, unknown>)[key];
  }, source);
}
