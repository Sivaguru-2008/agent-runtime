import type { ExecutionCheckpoint, ExecutionLease, RuntimeWorker, WorkerStatus } from "../../domain/cluster.js";
import type {
  AcquireLeaseInput,
  CheckpointStore,
  FencedWriteOutcome,
  FencingToken,
  LeaseStore,
  WorkerRegistry
} from "../../domain/clusterPorts.js";
import { toIso } from "../../shared/clock.js";

export class InMemoryWorkerRegistry implements WorkerRegistry {
  private readonly workers = new Map<string, RuntimeWorker>();

  async register(worker: RuntimeWorker): Promise<RuntimeWorker> {
    this.workers.set(worker.id, worker);
    return worker;
  }

  async heartbeat(workerId: string, load: RuntimeWorker["load"]): Promise<RuntimeWorker | undefined> {
    const existing = this.workers.get(workerId);
    if (!existing) return undefined;
    const next: RuntimeWorker = {
      ...existing,
      load,
      lastHeartbeatAt: toIso(new Date()),
      status: existing.status === "LOST" ? "READY" : existing.status
    };
    this.workers.set(workerId, next);
    return next;
  }

  async markStatus(workerId: string, status: WorkerStatus): Promise<RuntimeWorker | undefined> {
    const existing = this.workers.get(workerId);
    if (!existing) return undefined;
    const next: RuntimeWorker = { ...existing, status };
    this.workers.set(workerId, next);
    return next;
  }

  async getById(workerId: string): Promise<RuntimeWorker | undefined> {
    return this.workers.get(workerId);
  }

  async list(): Promise<RuntimeWorker[]> {
    return [...this.workers.values()].sort((a, b) => b.lastHeartbeatAt.localeCompare(a.lastHeartbeatAt));
  }

  async expireStale(now: Date, ttlMs: number): Promise<RuntimeWorker[]> {
    const cutoff = now.getTime() - ttlMs;
    const expired: RuntimeWorker[] = [];
    for (const worker of this.workers.values()) {
      if (worker.status === "LOST" || worker.status === "STOPPED") continue;
      const beat = new Date(worker.lastHeartbeatAt).getTime();
      if (beat < cutoff) {
        const next: RuntimeWorker = { ...worker, status: "LOST" };
        this.workers.set(worker.id, next);
        expired.push(next);
      }
    }
    return expired;
  }
}

export class InMemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, ExecutionLease>();

  async acquire({ executionId, workerId, ttlMs, now }: AcquireLeaseInput): Promise<ExecutionLease | undefined> {
    const existing = this.leases.get(executionId);
    if (existing && existing.status === "ACTIVE") {
      const expiresAt = new Date(existing.expiresAt).getTime();
      if (expiresAt > now.getTime()) return undefined;
    }
    const attempt = existing ? existing.attempt + 1 : 1;
    const lease: ExecutionLease = {
      executionId,
      workerId,
      acquiredAt: toIso(now),
      renewedAt: toIso(now),
      expiresAt: toIso(new Date(now.getTime() + ttlMs)),
      status: "ACTIVE",
      attempt
    };
    this.leases.set(executionId, lease);
    return lease;
  }

  async renew(executionId: string, workerId: string, now: Date, ttlMs: number): Promise<ExecutionLease | undefined> {
    const existing = this.leases.get(executionId);
    if (!existing || existing.workerId !== workerId || existing.status !== "ACTIVE") return undefined;
    const next: ExecutionLease = {
      ...existing,
      renewedAt: toIso(now),
      expiresAt: toIso(new Date(now.getTime() + ttlMs))
    };
    this.leases.set(executionId, next);
    return next;
  }

  async release(executionId: string, workerId: string, now: Date): Promise<ExecutionLease | undefined> {
    const existing = this.leases.get(executionId);
    if (!existing || existing.workerId !== workerId) return undefined;
    const next: ExecutionLease = { ...existing, status: "RELEASED", renewedAt: toIso(now) };
    this.leases.set(executionId, next);
    return next;
  }

  async reclaimExpired(now: Date): Promise<ExecutionLease[]> {
    const reclaimed: ExecutionLease[] = [];
    for (const lease of this.leases.values()) {
      if (lease.status !== "ACTIVE") continue;
      if (new Date(lease.expiresAt).getTime() < now.getTime()) {
        const next: ExecutionLease = { ...lease, status: "EXPIRED", renewedAt: toIso(now) };
        this.leases.set(lease.executionId, next);
        reclaimed.push(next);
      }
    }
    return reclaimed;
  }

  async reclaimByWorker(workerId: string, now: Date): Promise<ExecutionLease[]> {
    const reclaimed: ExecutionLease[] = [];
    for (const lease of this.leases.values()) {
      if (lease.workerId !== workerId || lease.status !== "ACTIVE") continue;
      const next: ExecutionLease = { ...lease, status: "RECLAIMED", renewedAt: toIso(now) };
      this.leases.set(lease.executionId, next);
      reclaimed.push(next);
    }
    return reclaimed;
  }

  async getByExecution(executionId: string): Promise<ExecutionLease | undefined> {
    return this.leases.get(executionId);
  }

  async listActive(): Promise<ExecutionLease[]> {
    return [...this.leases.values()].filter((lease) => lease.status === "ACTIVE");
  }

  async validateFencing(executionId: string, workerId: string, fencingToken: number): Promise<boolean> {
    const lease = this.leases.get(executionId);
    if (!lease) return false;
    if (lease.workerId !== workerId) return false;
    if (lease.status !== "ACTIVE") return false;
    if (lease.attempt !== fencingToken) return false;
    if (new Date(lease.expiresAt).getTime() < Date.now()) return false;
    return true;
  }
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly byExecution = new Map<string, ExecutionCheckpoint[]>();

  /**
   * Optional LeaseStore reference for fenced writes. Mirrors the wiring
   * contract of InMemoryExecutionRepository / InMemoryMemoryRepository — when
   * a substrate is present, writeFenced consults validateFencing. When absent
   * (unit-test composition without a lease substrate), writeFenced behaves
   * as unconditional write() because there is nothing to fence against.
   */
  constructor(private readonly leases?: LeaseStore) {}

  async write(checkpoint: ExecutionCheckpoint): Promise<ExecutionCheckpoint> {
    const bucket = this.byExecution.get(checkpoint.executionId) ?? [];
    bucket.push(checkpoint);
    this.byExecution.set(checkpoint.executionId, bucket);
    return checkpoint;
  }

  async writeFenced(
    checkpoint: ExecutionCheckpoint,
    fence: FencingToken
  ): Promise<FencedWriteOutcome> {
    // No-substrate fallback: see InMemoryExecutionRepository.saveFenced for
    // the same rationale. Production wires the LeaseStore through
    // createPersistenceLayer; unit tests that don't care about fencing can
    // omit it and writeFenced degrades to unconditional write semantics.
    if (!this.leases) {
      await this.write(checkpoint);
      return "COMMITTED";
    }
    const ok = await this.leases.validateFencing(
      fence.executionId,
      fence.workerId,
      fence.attempt
    );
    if (!ok) return "FENCED";
    await this.write(checkpoint);
    return "COMMITTED";
  }

  async listByExecution(executionId: string): Promise<ExecutionCheckpoint[]> {
    return [...(this.byExecution.get(executionId) ?? [])].sort((a, b) => a.sequence - b.sequence);
  }

  async latest(executionId: string): Promise<ExecutionCheckpoint | undefined> {
    const list = this.byExecution.get(executionId);
    if (!list || !list.length) return undefined;
    return list.reduce((acc, item) => (item.sequence > acc.sequence ? item : acc));
  }
}
