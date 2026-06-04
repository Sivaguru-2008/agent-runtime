import { isLiveWorker } from "../../domain/cluster.js";
import type { ClusterOverview, ExecutionLease, RuntimeWorker } from "../../domain/cluster.js";
import type { CheckpointStore, LeaseStore, WorkerRegistry } from "../../domain/clusterPorts.js";
import type { ExecutionRepository } from "../../domain/ports.js";

export interface ClusterSnapshot {
  workers: RuntimeWorker[];
  leases: ExecutionLease[];
  overview: ClusterOverview;
  executionsByWorker: Array<{
    workerId: string;
    executionIds: string[];
  }>;
}

export class ClusterQueries {
  constructor(
    private readonly registry: WorkerRegistry,
    private readonly leases: LeaseStore,
    private readonly executions: ExecutionRepository,
    private readonly checkpoints: CheckpointStore
  ) {}

  async overview(): Promise<ClusterOverview> {
    const workers = await this.registry.list();
    const leases = await this.leases.listActive();
    const now = Date.now();
    // "Mean across live workers": only workers still in the fleet count toward
    // the heartbeat-age mean. LOST/STOPPED workers are excluded — otherwise a
    // single long-dead worker (e.g. a renamed embedded worker that lingered)
    // drags the mean to multi-day nonsense values.
    const ages = workers
      .filter((worker) => isLiveWorker(worker.status))
      .map((worker) => now - new Date(worker.lastHeartbeatAt).getTime());
    const mean = ages.length ? ages.reduce((sum, age) => sum + age, 0) / ages.length : 0;
    const eventsPerSecond = workers.reduce((sum, worker) => sum + worker.load.eventsPerSecond, 0);
    const queueDepth = workers.reduce((sum, worker) => sum + worker.load.queueDepth, 0);
    return {
      workers: {
        total: workers.length,
        ready: workers.filter((worker) => worker.status === "READY").length,
        busy: workers.filter((worker) => worker.status === "BUSY").length,
        lost: workers.filter((worker) => worker.status === "LOST").length,
        draining: workers.filter((worker) => worker.status === "DRAINING").length
      },
      leases: {
        active: leases.length,
        expired: 0,
        reclaimed: 0
      },
      throughput: {
        eventsPerSecond,
        runningExecutions: leases.length,
        queueDepth
      },
      meanHeartbeatAgeMs: Math.round(mean)
    };
  }

  async snapshot(): Promise<ClusterSnapshot> {
    const workers = await this.registry.list();
    const leases = await this.leases.listActive();
    const overview = await this.overview();
    const byWorker = new Map<string, string[]>();
    for (const lease of leases) {
      const bucket = byWorker.get(lease.workerId) ?? [];
      bucket.push(lease.executionId);
      byWorker.set(lease.workerId, bucket);
    }
    return {
      workers,
      leases,
      overview,
      executionsByWorker: [...byWorker.entries()].map(([workerId, executionIds]) => ({ workerId, executionIds }))
    };
  }

  async executionTimeline(executionId: string) {
    const lease = await this.leases.getByExecution(executionId);
    const checkpoints = await this.checkpoints.listByExecution(executionId);
    const execution = await this.executions.getById(executionId);
    return { execution, lease, checkpoints };
  }
}
