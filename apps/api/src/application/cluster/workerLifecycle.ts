import type { Clock } from "../../shared/clock.js";
import { toIso } from "../../shared/clock.js";
import type { RuntimeWorker, RuntimeWorkerLoad, WorkerStatus } from "../../domain/cluster.js";
import type { LeaseStore, WorkerRegistry } from "../../domain/clusterPorts.js";
import type { EventFactory, EventContext } from "../../infrastructure/events/eventFactory.js";
import type { PersistedEventPublisher } from "../../infrastructure/events/persistedEventPublisher.js";
import type pino from "pino";
import { acquireFencingToken, assertCanWrite } from "../../infrastructure/reliability/splitBrainGuard.js";

export interface WorkerLifecycleConfig {
  heartbeatTtlMs: number;
  sweepIntervalMs: number;
  /**
   * Retention window for terminal (LOST/STOPPED) workers. Once a worker has
   * been terminal for longer than this, the sweep permanently removes it from
   * the registry. Defaults to 24h — long enough that recently-dead workers
   * stay visible for diagnostics, short enough that abandoned rows (e.g. a
   * renamed embedded worker) do not linger forever. Tunable via
   * WORKER_REAP_AFTER_MS.
   */
  reapAfterMs?: number;
}

/** Default terminal-worker retention before reaping: 24 hours. */
const DEFAULT_REAP_AFTER_MS = 24 * 60 * 60 * 1000;

export interface RegisterWorkerInput {
  id: string;
  host: string;
  region?: string;
  version: string;
  capacity?: number;
  metadata?: Record<string, unknown>;
}

const ZERO_LOAD: RuntimeWorkerLoad = {
  cpu: 0,
  memory: 0,
  inFlight: 0,
  queueDepth: 0,
  eventsPerSecond: 0
};

export class WorkerLifecycleService {
  private sweepTimer?: NodeJS.Timeout;
  private readonly lastPublishedHeartbeat = new Map<string, { timestamp: number; status: WorkerStatus; load: RuntimeWorkerLoad }>();

  constructor(
    private readonly registry: WorkerRegistry,
    private readonly leases: LeaseStore,
    private readonly publisher: PersistedEventPublisher,
    private readonly eventFactory: EventFactory,
    private readonly clock: Clock,
    private readonly config: WorkerLifecycleConfig,
    private readonly logger?: pino.Logger
  ) {}

  async register(input: RegisterWorkerInput): Promise<RuntimeWorker> {
    const previousWorker = await this.registry.getById(input.id);
    const previousStatus = previousWorker?.status;

    const now = this.clock.now();
    const worker: RuntimeWorker = {
      id: input.id,
      host: input.host,
      region: input.region,
      version: input.version,
      capacity: input.capacity ?? 4,
      status: "READY",
      load: { ...ZERO_LOAD },
      startedAt: toIso(now),
      lastHeartbeatAt: toIso(now),
      metadata: input.metadata
    };
    const stored = await this.registry.register(worker);
    await this.publisher.publish(
      this.eventFactory.create({
        type: "WORKER_REGISTERED",
        aggregateId: worker.id,
        aggregateType: "SYSTEM",
        payload: { worker: stored }
      })
    );

    // Publish WORKER_STATUS_CHANGED if registering worker status changes (e.g. from LOST/STOPPED to READY)
    if (previousStatus && previousStatus !== "READY") {
      await this.publisher.publish(
        this.eventFactory.create({
          type: "WORKER_STATUS_CHANGED",
          aggregateId: worker.id,
          aggregateType: "SYSTEM",
          payload: {
            workerId: worker.id,
            previousStatus,
            newStatus: "READY",
            worker: stored
          }
        })
      );
    }

    return stored;
  }

  async heartbeat(workerId: string, load: RuntimeWorkerLoad): Promise<RuntimeWorker | undefined> {
    const updated = await this.registry.heartbeat(workerId, load);
    if (!updated) return undefined;

    const last = this.lastPublishedHeartbeat.get(workerId);
    const now = Date.now();

    // Sample heartbeats to reduce event spam on the bus:
    // 1. Status change is a critical transition — always publish immediately.
    // 2. Significant load changes (CPU or memory shift > 20%, or inFlight count shift) are published.
    // 3. Otherwise, we emit a heartbeat log once every 30 seconds.
    const statusChanged = last ? last.status !== updated.status : true;
    const timeSinceLastPublish = last ? now - last.timestamp : Infinity;

    const loadChangedSignificantly = last
      ? Math.abs(last.load.cpu - load.cpu) > 0.2 ||
        Math.abs(last.load.memory - load.memory) > 0.2 ||
        last.load.inFlight !== load.inFlight
      : true;

    if (statusChanged || loadChangedSignificantly || timeSinceLastPublish >= 30_000) {
      await this.publisher.publish(
        this.eventFactory.create({
          type: "WORKER_HEARTBEAT",
          aggregateId: workerId,
          aggregateType: "SYSTEM",
          payload: { worker: updated }
        })
      );
      this.lastPublishedHeartbeat.set(workerId, { timestamp: now, status: updated.status, load });
    }

    return updated;
  }

  async setStatus(workerId: string, status: WorkerStatus): Promise<RuntimeWorker | undefined> {
    const previousWorker = await this.registry.getById(workerId);
    const previousStatus = previousWorker?.status;

    const updated = await this.registry.markStatus(workerId, status);
    if (!updated) return undefined;

    if (previousStatus && previousStatus !== status) {
      await this.publisher.publish(
        this.eventFactory.create({
          type: "WORKER_STATUS_CHANGED",
          aggregateId: workerId,
          aggregateType: "SYSTEM",
          payload: {
            workerId,
            previousStatus,
            newStatus: status,
            worker: updated
          }
        })
      );
    }

    if (status === "STOPPED") {
      await this.publisher.publish(
        this.eventFactory.create({
          type: "WORKER_STOPPED",
          aggregateId: workerId,
          aggregateType: "SYSTEM",
          payload: { worker: updated }
        })
      );
    }
    return updated;
  }

  async sweep(): Promise<{ expired: RuntimeWorker[]; reclaimedLeases: number; reaped: RuntimeWorker[] }> {
    // TASK D1: Split-brain sweep fencing: only the active region sweeps stale workers.
    const held = acquireFencingToken();
    const now = this.clock.now();
    const expired = await this.registry.expireStale(now, this.config.heartbeatTtlMs);
    const reclaimedSet = new Set<string>();

    assertCanWrite(held);

    for (const worker of expired) {
      assertCanWrite(held);

      // Emit WORKER_STATUS_CHANGED since they transitioned to LOST
      await this.publisher.publish(
        this.eventFactory.create({
          type: "WORKER_STATUS_CHANGED",
          aggregateId: worker.id,
          aggregateType: "SYSTEM",
          payload: {
            workerId: worker.id,
            previousStatus: "READY", // safe fallback since markStale only targets active status
            newStatus: "LOST",
            worker
          }
        })
      );

      // Emit WORKER_LOST
      const workerLostEvent = this.eventFactory.create({
        type: "WORKER_LOST",
        aggregateId: worker.id,
        aggregateType: "SYSTEM",
        payload: { worker, reason: "heartbeat-timeout" }
      });
      await this.publisher.publish(workerLostEvent);

      const reclaimed = await this.leases.reclaimByWorker(worker.id, now);
      for (const lease of reclaimed) {
        assertCanWrite(held);
        reclaimedSet.add(lease.executionId);

        // TASK B1+B2: recovery context propagation & causation chaining from lastEvent to WORKER_LOST
        const lastEvent = await this.publisher.eventStore.lastForExecution(lease.executionId);
        const context: EventContext = lastEvent
          ? {
              traceId: lastEvent.metadata.traceId,
              correlationId: lastEvent.metadata.correlationId,
              causationId: workerLostEvent.id, // Causation chains to the WORKER_LOST event
              tenantId: (lastEvent.metadata as any)?.tenantId
            }
          : {
              traceId: lease.executionId,
              correlationId: lease.executionId,
              causationId: workerLostEvent.id
            };

        await this.publisher.publish(
          this.eventFactory.create({
            type: "EXECUTION_LEASE_RECLAIMED",
            aggregateId: lease.executionId,
            aggregateType: "EXECUTION",
            payload: { lease, reason: `worker:${worker.id}:lost` },
            context
          })
        );
      }
    }

    const expiredLeases = await this.leases.reclaimExpired(now);
    for (const lease of expiredLeases) {
      assertCanWrite(held);
      reclaimedSet.add(lease.executionId);

      // TASK B1+B2: recovery context & causation chaining to the last event of the execution itself
      const lastEvent = await this.publisher.eventStore.lastForExecution(lease.executionId);
      const context: EventContext = lastEvent
        ? {
            traceId: lastEvent.metadata.traceId,
            correlationId: lastEvent.metadata.correlationId,
            causationId: lastEvent.id,
            tenantId: (lastEvent.metadata as any)?.tenantId
          }
        : {
            traceId: lease.executionId,
            correlationId: lease.executionId
          };

      await this.publisher.publish(
        this.eventFactory.create({
          type: "EXECUTION_LEASE_RECLAIMED",
          aggregateId: lease.executionId,
          aggregateType: "EXECUTION",
          payload: { lease, reason: "lease-expired" },
          context
        })
      );
    }
    // Purge workers that have been terminal (LOST/STOPPED) beyond the retention
    // window. Long-dead rows otherwise linger forever in the topology view and
    // skew live-fleet aggregates. Recently-lost workers stay (within retention)
    // for operator diagnostics.
    assertCanWrite(held);
    const reaped = await this.registry.reapTerminated(
      now,
      this.config.reapAfterMs ?? DEFAULT_REAP_AFTER_MS
    );
    for (const worker of reaped) {
      this.logger?.info(
        { workerId: worker.id, status: worker.status, lastHeartbeatAt: worker.lastHeartbeatAt },
        "reaped terminated worker"
      );
    }

    return { expired, reclaimedLeases: reclaimedSet.size, reaped };
  }

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err) => {
        // Sweep errors are no longer silently discarded. Log at error severity
        // and emit a SYSTEM_ERROR_RAISED event so the failure is visible in the
        // event log. The interval continues — a single sweep failure should not
        // permanently stop worker expiry detection.
        this.logger?.error({ err }, "worker lifecycle sweep failed");
        void this.publisher
          .publish(
            this.eventFactory.create({
              type: "SYSTEM_ERROR_RAISED",
              aggregateId: "lifecycle",
              aggregateType: "SYSTEM",
              payload: {
                subsystem: "worker-lifecycle-sweep",
                message: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined
              }
            })
          )
          .catch(() => undefined); // best-effort — never mask the original error
      });
    }, this.config.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}
