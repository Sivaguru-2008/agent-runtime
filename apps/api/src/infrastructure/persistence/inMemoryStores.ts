import type { DomainEvent } from "../../domain/events.js";
import type { Agent, Execution, MemoryRecord } from "../../domain/model.js";
import type { AgentRepository, EventStore, ExecutionRepository, MemoryRepository, CommitTerminalInput, CommitTransitionInput, FencedAppendOutcome } from "../../domain/ports.js";
import type { FencingToken, FencedWriteOutcome, LeaseStore, CheckpointStore } from "../../domain/clusterPorts.js";
import { FencingViolationError } from "../../runtime/executionEngine.js";
import { assertTransition } from "../../runtime/canonicalSemantics.js";

export class InMemoryEventStore implements EventStore {
  private readonly events: DomainEvent[] = [];
  private readonly byExecution = new Map<string, DomainEvent[]>();
  private readonly byAggregate = new Map<string, DomainEvent[]>();

  /**
   * Optional LeaseStore reference for fenced appends. When provided,
   * appendFenced() consults validateFencing() — matching the SQL fence the
   * Postgres adapter enforces. When omitted (e.g. a unit test that exercises
   * append() without caring about fencing), appendFenced behaves as
   * unconditional append() so legacy tests are unaffected.
   *
   * Setter rather than ctor arg keeps backwards-compat with all existing
   * `new InMemoryEventStore()` call sites — the persistence factory wires
   * the lease store after construction.
   */
  private leases?: LeaseStore;

  setLeaseStore(leases: LeaseStore): void {
    this.leases = leases;
  }

  async append(event: DomainEvent): Promise<DomainEvent> {
    const persisted = { ...event, sequence: this.events.length + 1 };
    this.events.push(persisted);
    this.indexEvent(persisted);
    return persisted;
  }

  /**
   * In-memory parity for PostgresEventStore.appendFenced. The contract is
   * identical: if the fence does not match a live ACTIVE lease, NO event is
   * persisted and NO index update happens — replay sees nothing.
   *
   * The race the Postgres adapter solves (concurrent UPDATE of the lease row
   * mid-INSERT) does not exist in the in-memory substrate because everything
   * runs single-threaded; a validateFencing() call followed by an append is
   * effectively atomic. The substrate still must respect the surrender
   * contract so engine-level tests that rely on the FENCED branch see the
   * same observable behavior as production.
   */
  async appendFenced(event: DomainEvent, fence: FencingToken): Promise<FencedAppendOutcome> {
    if (this.leases) {
      const ok = await this.leases.validateFencing(fence.executionId, fence.workerId, fence.attempt);
      if (!ok) return { outcome: "FENCED" };
    }
    const persisted = { ...event, sequence: this.events.length + 1 };
    this.events.push(persisted);
    this.indexEvent(persisted);
    return { outcome: "COMMITTED", event: persisted };
  }

  async listByAggregate(aggregateType: DomainEvent["aggregateType"], aggregateId: string): Promise<DomainEvent[]> {
    return this.byAggregate.get(aggregateKey(aggregateType, aggregateId)) ?? [];
  }

  async listByExecution(executionId: string): Promise<DomainEvent[]> {
    const sandboxed = (globalThis as any).activeSandboxedEventStores?.get(executionId);
    if (sandboxed) {
      return sandboxed.listByExecution(executionId);
    }
    return this.byExecution.get(executionId) ?? [];
  }

  async lastForExecution(executionId: string): Promise<DomainEvent | undefined> {
    const list = this.byExecution.get(executionId) ?? [];
    if (list.length === 0) return undefined;
    return list[list.length - 1];
  }

  async listRecent(limit: number): Promise<DomainEvent[]> {
    return this.events.slice(-limit).reverse();
  }

  async listAfterSequence(afterSequence: number, limit: number): Promise<DomainEvent[]> {
    const result: DomainEvent[] = [];
    for (const event of this.events) {
      if ((event.sequence ?? 0) > afterSequence) {
        result.push(event);
        if (result.length >= limit) break;
      }
    }
    return result;
  }

  private indexEvent(event: DomainEvent): void {
    const aggregateBucket = this.byAggregate.get(aggregateKey(event.aggregateType, event.aggregateId)) ?? [];
    aggregateBucket.push(event);
    this.byAggregate.set(aggregateKey(event.aggregateType, event.aggregateId), aggregateBucket);

    const executionIds = collectExecutionIds(event);
    for (const executionId of executionIds) {
      const bucket = this.byExecution.get(executionId) ?? [];
      bucket.push(event);
      this.byExecution.set(executionId, bucket);
    }
  }
}

function aggregateKey(aggregateType: DomainEvent["aggregateType"], aggregateId: string): string {
  return `${aggregateType}:${aggregateId}`;
}

function collectExecutionIds(event: DomainEvent): Set<string> {
  const ids = new Set<string>();
  if (event.aggregateType === "EXECUTION") ids.add(event.aggregateId);
  const candidates = [
    readPath(event.payload, ["execution", "id"]),
    readPath(event.payload, ["step", "executionId"]),
    readPath(event.payload, ["toolCall", "executionId"]),
    readPath(event.payload, ["replayExecutionId"])
    // parentExecutionId is intentionally omitted: indexing it would append child
    // replay/lifecycle events onto the parent's execution log and break replay
    // watermark checks (false STALE_PARENT_LOG divergence).
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) ids.add(candidate);
  }
  return ids;
}

function readPath(source: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

export class InMemoryAgentRepository implements AgentRepository {
  private readonly agents = new Map<string, Agent>();

  async save(agent: Agent): Promise<void> {
    this.agents.set(agent.id, agent);
  }

  async getById(id: string): Promise<Agent | undefined> {
    return this.agents.get(id);
  }

  async list(): Promise<Agent[]> {
    return [...this.agents.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export class InMemoryExecutionRepository implements ExecutionRepository {
  private readonly executions = new Map<string, Execution>();

  /**
   * Optional LeaseStore reference for fenced writes. When provided,
   * saveFenced() consults validateFencing() before mutating in-process state
   * — matching the SQL fence the Postgres adapter enforces. Unit tests that
   * exercise fenced behavior MUST pass a leaseStore here; legacy tests that
   * never call saveFenced may omit it.
   */
  constructor(
    private readonly leases?: LeaseStore,
    private readonly memory?: MemoryRepository,
    private readonly events?: EventStore,
    private readonly checkpoints?: CheckpointStore
  ) {}

  async save(execution: Execution, fence?: FencingToken): Promise<void> {
    if (fence) {
      const outcome = await this.saveFenced(execution, fence);
      if (outcome === "FENCED") {
        throw new FencingViolationError(execution.id, fence.workerId);
      }
      return;
    }

    const isLeasedState = execution.status !== "CREATION" && execution.status !== "SCHEDULING" && execution.status !== "QUEUED";
    if (isLeasedState && this.leases) {
      const activeLeases = await this.leases.listActive();
      const hasActive = activeLeases.some(l => l.executionId === execution.id && new Date(l.expiresAt).getTime() > Date.now());
      if (hasActive) {
        throw new FencingViolationError(execution.id, "unknown-unfenced-active-lease");
      }
    }
    this.executions.set(execution.id, execution);
  }

  async saveFenced(execution: Execution, fence: FencingToken): Promise<FencedWriteOutcome> {
    // Fallback: when no LeaseStore is wired (e.g. a unit test that composes
    // this adapter directly without a lease substrate), saveFenced behaves
    // as unconditional save(). The Postgres adapter has no equivalent
    // fallback — production wires the LeaseStore via createPersistenceLayer
    // and exercises the conditional SQL — but unit tests that don't care
    // about fencing should not be forced to set one up. Fencing IS the
    // contract; this fallback is an honest reflection that without a lease
    // substrate there is nothing to fence against.
    if (!this.leases) {
      this.executions.set(execution.id, execution);
      return "COMMITTED";
    }
    const ok = await this.leases.validateFencing(
      fence.executionId,
      fence.workerId,
      fence.attempt,
      fence.leaseId,
      fence.expiration
    );
    if (!ok) return "FENCED";
    this.executions.set(execution.id, execution);
    return "COMMITTED";
  }

  async commitTerminal(input: CommitTerminalInput): Promise<FencedWriteOutcome> {
    return this.commitTransition({
      execution: input.execution,
      events: [input.event],
      memoryRecord: input.memoryRecord,
      checkpoint: input.checkpoint && input.checkpointSequence !== undefined ? {
        phase: input.execution.status === "COMPLETED" ? "COMPLETION" : "PLANNING",
        sequence: input.checkpointSequence,
        state: input.checkpoint
      } : undefined,
      fence: input.fence
    });
  }

  private validateRepositoryTransition(executionId: string, from: any, to: any): void {
    if (from === to) return;
    const terminalFrom = from === "COMPLETED" || from === "FAILED" || from === "DEAD_LETTERED" || from === "CANCELLED";
    const terminalTo = to === "COMPLETED" || to === "FAILED" || to === "DEAD_LETTERED" || to === "CANCELLED";
    if (terminalFrom) {
      if (from === "FAILED" && (to === "LEASE_ACQUISITION" || to === "DEAD_LETTERED")) {
        return;
      }
      throw new Error(`Illegal execution state transition out of terminal state: '${from}' -> '${to}' for execution '${executionId}'`);
    }
    if (terminalTo) {
      return;
    }
    assertTransition(executionId, from, to);
  }

  async commitTransition(input: CommitTransitionInput): Promise<FencedWriteOutcome> {
    if (this.leases && input.fence) {
      const ok = await this.leases.validateFencing(
        input.fence.executionId,
        input.fence.workerId,
        input.fence.attempt,
        input.fence.leaseId,
        input.fence.expiration
      );
      if (!ok) return "FENCED";
    }

    // Transactional Validation Hook: Repository Write Status Transition
    const original = this.executions.get(input.execution.id);
    if (original) {
      const from = original.status;
      const to = input.execution.status;
      if (from !== to) {
        this.validateRepositoryTransition(input.execution.id, from, to);
      }
    }

    await this.save(input.execution, input.fence);

    if (input.memoryRecord && this.memory) {
      if (input.fence) {
        const memoryOutcome = await this.memory.addFenced(input.memoryRecord, input.fence);
        if (memoryOutcome === "FENCED") {
          if (original) {
            this.executions.set(input.execution.id, original);
          } else {
            this.executions.delete(input.execution.id);
          }
          return "FENCED";
        }
      } else {
        await this.memory.add(input.memoryRecord);
      }
    }

    if (input.events && input.events.length > 0 && this.events) {
      for (const event of input.events) {
        await this.events.append(event);
      }
    }

    if (input.checkpoint && this.checkpoints) {
      const chk = {
        id: "in-memory-chk-" + Math.random(),
        executionId: input.execution.id,
        workerId: input.fence?.workerId ?? "local",
        sequence: input.checkpoint.sequence,
        phase: input.checkpoint.phase as any,
        state: input.checkpoint.state,
        createdAt: new Date().toISOString()
      };
      if (input.fence) {
        const chkOutcome = await this.checkpoints.writeFenced(chk, input.fence);
        if (chkOutcome === "FENCED") {
          if (original) {
            this.executions.set(input.execution.id, original);
          } else {
            this.executions.delete(input.execution.id);
          }
          return "FENCED";
        }
      } else {
        await this.checkpoints.write(chk);
      }
    }

    return "COMMITTED";
  }

  async detectPartialCommit(executionId: string): Promise<{
    isConsistent: boolean;
    actualStatus: Execution["status"];
    lastEventSeq?: number;
    error?: string;
  }> {
    const execution = await this.getById(executionId);
    if (!execution) {
      return { isConsistent: true, actualStatus: "CREATION" };
    }

    const actualStatus = execution.status;
    if (!this.events) {
      return { isConsistent: true, actualStatus };
    }

    const events = await this.events.listByExecution(executionId);
    const lastEvent = events[events.length - 1];

    if (actualStatus === "COMPLETED") {
      if (!lastEvent || lastEvent.type !== "EXECUTION_COMPLETED") {
        return {
          isConsistent: false,
          actualStatus,
          lastEventSeq: lastEvent ? Number(lastEvent.sequence) : undefined,
          error: `Partial commit anomaly: execution is marked COMPLETED but last event in log is ${
            lastEvent ? lastEvent.type : "NONE"
          }`
        };
      }
    }

    if (actualStatus === "FAILED") {
      if (!lastEvent || lastEvent.type !== "EXECUTION_FAILED") {
        return {
          isConsistent: false,
          actualStatus,
          lastEventSeq: lastEvent ? Number(lastEvent.sequence) : undefined,
          error: `Partial commit anomaly: execution is marked FAILED but last event in log is ${
            lastEvent ? lastEvent.type : "NONE"
          }`
        };
      }
    }

    if (lastEvent) {
      if (lastEvent.type === "EXECUTION_COMPLETED" && actualStatus !== "COMPLETED") {
        return {
          isConsistent: false,
          actualStatus,
          lastEventSeq: Number(lastEvent.sequence),
          error: `Partial commit anomaly: event log terminates at EXECUTION_COMPLETED but execution status is ${actualStatus}`
        };
      }
      if (lastEvent.type === "EXECUTION_FAILED" && actualStatus !== "FAILED") {
        return {
          isConsistent: false,
          actualStatus,
          lastEventSeq: Number(lastEvent.sequence),
          error: `Partial commit anomaly: event log terminates at EXECUTION_FAILED but execution status is ${actualStatus}`
        };
      }
    }

    return {
      isConsistent: true,
      actualStatus,
      lastEventSeq: lastEvent ? Number(lastEvent.sequence) : undefined
    };
  }

  isOutboxEnabled(): boolean {
    return false;
  }

  async getById(id: string): Promise<Execution | undefined> {
    const sandboxed = (globalThis as any).activeSandboxedExecutionRepos?.get(id);
    if (sandboxed) {
      return sandboxed.getById(id);
    }
    return this.executions.get(id);
  }

  async listByAgent(agentId: string): Promise<Execution[]> {
    return [...this.executions.values()]
      .filter((execution) => execution.agentId === agentId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly records = new Map<string, MemoryRecord>();

  /** See InMemoryExecutionRepository — same wiring contract. */
  constructor(private readonly leases?: LeaseStore) {}

  async add(record: MemoryRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async addFenced(record: MemoryRecord, fence: FencingToken): Promise<FencedWriteOutcome> {
    // See InMemoryExecutionRepository.saveFenced for fallback rationale.
    if (!this.leases) {
      this.records.set(record.id, record);
      return "COMMITTED";
    }
    const ok = await this.leases.validateFencing(
      fence.executionId,
      fence.workerId,
      fence.attempt,
      fence.leaseId,
      fence.expiration
    );
    if (!ok) return "FENCED";
    this.records.set(record.id, record);
    return "COMMITTED";
  }

  async search(agentId: string, query: string, limit: number): Promise<MemoryRecord[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.records.values()]
      .filter((record) => record.agentId === agentId)
      .map((record) => ({
        record,
        score: terms.reduce((score, term) => score + (record.content.toLowerCase().includes(term) ? 1 : 0), 0)
      }))
      .sort((a, b) => b.score - a.score || b.record.createdAt.localeCompare(a.record.createdAt))
      .slice(0, limit)
      .map(({ record }) => record);
  }

  async listByAgent(agentId: string): Promise<MemoryRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
