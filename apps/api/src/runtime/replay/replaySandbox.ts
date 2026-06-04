import type { EventStore, ExecutionRepository, MemoryRepository, CommitTerminalInput, CommitTransitionInput, FencedAppendOutcome } from "../../domain/ports.js";
import type { DomainEvent } from "../../domain/events.js";
import type { Execution, MemoryRecord } from "../../domain/model.js";
import type { FencingToken, FencedWriteOutcome } from "../../domain/clusterPorts.js";
import type { ToolExecutor } from "../../domain/ports.js";
import { PersistedEventPublisher } from "../../infrastructure/events/persistedEventPublisher.js";
import { InvariantViolation, type InvariantId } from "../canonicalSemantics.js";

/**
 * Replay Execution Policy.
 */
export type ReplayExecutionPolicy =
  | "SAFE_REPLAYABLE"
  | "SIMULATED_REPLAY"
  | "BLOCKED_REPLAY"
  | "MANUAL_REPLAY_REQUIRED";

/**
 * Sandbox Escape Attempt Violation.
 * Invariant S_SANDBOX_ESCAPE.
 */
export class ReplaySandboxEscapeError extends InvariantViolation {
  readonly name = "ReplaySandboxEscapeError";
  constructor(message: string) {
    super(message, "S_SANDBOX_ESCAPE");
  }
}

/**
 * Unsafe Replay Action Violation.
 * Invariant S_UNSAFE_REPLAY.
 */
export class ReplaySandboxViolationError extends InvariantViolation {
  readonly name = "ReplaySandboxViolationError";
  constructor(message: string) {
    super(message, "S_UNSAFE_REPLAY");
  }
}

/**
 * Replay Policy Violation.
 * Invariant S_POLICY_VIOLATION.
 */
export class ReplayPolicyViolationError extends InvariantViolation {
  readonly name = "ReplayPolicyViolationError";
  constructor(message: string, id: InvariantId = "S_POLICY_VIOLATION") {
    super(message, id);
  }
}

/**
 * Governance Policies mapped per tool integration name.
 */
export const TOOL_REPLAY_POLICIES: Record<string, ReplayExecutionPolicy> = {
  "web.search": "SAFE_REPLAYABLE",
  "file.read": "SAFE_REPLAYABLE",
  "code.execute": "SAFE_REPLAYABLE",
  "memory.summarize": "SAFE_REPLAYABLE",
  "runtime.inspect": "SAFE_REPLAYABLE",
  "sandbox.db_write": "SIMULATED_REPLAY",
  "sandbox.payment_refund": "BLOCKED_REPLAY",
  "stripe.payment": "BLOCKED_REPLAY",
  "aws.infrastructure": "BLOCKED_REPLAY",
  "email.send": "SIMULATED_REPLAY",
  "slack.post": "SIMULATED_REPLAY",
  "infrastructure.mutate": "BLOCKED_REPLAY",
  "operator.restart": "MANUAL_REPLAY_REQUIRED"
};

/**
 * Simulated/Mock return payloads for SIMULATED_REPLAY integrations.
 */
export const TOOL_REPLAY_SIMULATIONS: Record<string, Record<string, any>> = {
  "sandbox.payment_refund": {
    status: "refunded",
    amount: 1200,
    currency: "usd",
    transactionId: "sim_ch_3M991823",
    message: "Simulated Stripe payment refund completed successfully."
  },
  "sandbox.db_write": {
    status: "written",
    rowsAffected: 1,
    ledgerId: "sim_ledger_881923",
    message: "Simulated database write successful."
  },
  "email.send": {
    status: "delivered",
    messageId: "sim_msg_9921",
    recipient: "user@example.com",
    message: "Simulated email dispatch successful."
  },
  "slack.post": {
    status: "posted",
    channel: "#alerts",
    message: "Simulated Slack notification posted."
  }
};

// Active sandbox registration maps on globalThis for circular-dependency-free store interception
const g = globalThis as any;
g.activeSandboxedEventStores = g.activeSandboxedEventStores || new Map();
g.activeSandboxedExecutionRepos = g.activeSandboxedExecutionRepos || new Map();

export class SandboxedEventStore implements EventStore {
  private readonly childEvents: DomainEvent[] = [];

  constructor(
    private readonly innerStore: EventStore,
    private readonly childExecutionId: string,
    private readonly parentExecutionId?: string
  ) {
    (globalThis as any).activeSandboxedEventStores.set(childExecutionId, this);
  }

  getChildEvents(): DomainEvent[] {
    return this.childEvents;
  }

  async append(event: DomainEvent): Promise<DomainEvent> {
    if (event.aggregateId !== this.childExecutionId) {
      throw new ReplaySandboxEscapeError(
        `Replay sandbox escape: attempt to append event for non-isolated aggregate '${event.aggregateId}'`
      );
    }
    const persisted = { ...event, sequence: this.childEvents.length + 1 };
    this.childEvents.push(persisted as any);
    return persisted as any;
  }

  async appendFenced(event: DomainEvent, fence: FencingToken): Promise<FencedAppendOutcome> {
    if (fence.executionId !== this.childExecutionId) {
      throw new ReplaySandboxEscapeError(
        `Replay sandbox escape: attempt to append fenced event for non-isolated execution '${fence.executionId}'`
      );
    }
    const persisted = await this.append(event);
    return { outcome: "COMMITTED", event: persisted };
  }

  async listByAggregate(aggregateType: string, aggregateId: string): Promise<DomainEvent[]> {
    if (aggregateId === this.childExecutionId) {
      return this.childEvents as any[];
    }
    if (aggregateId === this.parentExecutionId) {
      return this.innerStore.listByAggregate(aggregateType as any, aggregateId);
    }
    throw new ReplaySandboxEscapeError(
      `Replay sandbox escape: forbidden event retrieval for foreign aggregate '${aggregateId}'`
    );
  }

  async listByExecution(executionId: string): Promise<DomainEvent[]> {
    if (executionId === this.childExecutionId) {
      return this.childEvents as any[];
    }
    if (executionId === this.parentExecutionId) {
      return this.innerStore.listByExecution(executionId);
    }
    throw new ReplaySandboxEscapeError(
      `Replay sandbox escape: forbidden event retrieval for foreign execution '${executionId}'`
    );
  }

  async lastForExecution(executionId: string): Promise<DomainEvent | undefined> {
    const list = await this.listByExecution(executionId);
    return list[list.length - 1];
  }

  async listRecent(limit: number): Promise<DomainEvent[]> {
    return this.childEvents.slice(-limit).reverse() as any[];
  }

  async listAfterSequence(afterSequence: number, limit: number): Promise<DomainEvent[]> {
    return this.childEvents
      .filter((e) => (e.sequence ?? 0) > afterSequence)
      .slice(0, limit) as any[];
  }
}

/**
 * Sandboxed Execution Repository.
 * Intercepts all db writes, redirecting mutations targeting the child execution
 * to an isolated in-memory cache, and blocking mutations to other executions.
 */
export class SandboxedExecutionRepository implements ExecutionRepository {
  private readonly childExecutions = new Map<string, Execution>();

  constructor(
    private readonly innerRepo: ExecutionRepository,
    private readonly childExecutionId: string,
    private readonly parentExecutionId?: string
  ) {
    (globalThis as any).activeSandboxedExecutionRepos.set(childExecutionId, this);
  }

  async save(execution: Execution, fence?: FencingToken): Promise<void> {
    if (execution.id !== this.childExecutionId) {
      throw new ReplaySandboxEscapeError(
        `Replay sandbox escape: attempt to mutate foreign execution '${execution.id}'`
      );
    }
    this.childExecutions.set(execution.id, execution);
  }

  async saveFenced(execution: Execution, fence: FencingToken): Promise<FencedWriteOutcome> {
    if (execution.id !== this.childExecutionId || fence.executionId !== this.childExecutionId) {
      throw new ReplaySandboxEscapeError(
        `Replay sandbox escape: attempt to mutate foreign execution/fence '${execution.id}'`
      );
    }
    await this.save(execution, fence);
    return "COMMITTED";
  }

  async commitTerminal(input: CommitTerminalInput): Promise<FencedWriteOutcome> {
    if (input.execution.id !== this.childExecutionId) {
      throw new ReplaySandboxEscapeError(
        `Replay sandbox escape: attempt to commit terminal state for foreign execution '${input.execution.id}'`
      );
    }
    this.childExecutions.set(input.execution.id, input.execution);
    return "COMMITTED";
  }

  async commitTransition(input: CommitTransitionInput): Promise<FencedWriteOutcome> {
    if (input.execution.id !== this.childExecutionId) {
      throw new ReplaySandboxEscapeError(
        `Replay sandbox escape: attempt to commit transition state for foreign execution '${input.execution.id}'`
      );
    }
    this.childExecutions.set(input.execution.id, input.execution);
    return "COMMITTED";
  }

  async getById(id: string): Promise<Execution | undefined> {
    if (id === this.childExecutionId) {
      return this.childExecutions.get(id) ?? this.innerRepo.getById(id);
    }
    if (id === this.parentExecutionId) {
      return this.innerRepo.getById(id);
    }
    throw new ReplaySandboxEscapeError(
      `Replay sandbox escape: forbidden execution lookup for foreign execution '${id}'`
    );
  }

  async listByAgent(agentId: string): Promise<Execution[]> {
    const list = await this.innerRepo.listByAgent(agentId);
    const sandboxed = [...this.childExecutions.values()].filter((e) => e.agentId === agentId);
    const merged = new Map<string, Execution>();
    for (const e of list) {
      merged.set(e.id, e);
    }
    for (const e of sandboxed) {
      merged.set(e.id, e);
    }
    return [...merged.values()];
  }

  async listByStatus(status: Execution["status"]): Promise<Execution[]> {
    const list = await this.innerRepo.listByStatus(status);
    const sandboxed = [...this.childExecutions.values()].filter((e) => e.status === status);
    const merged = new Map<string, Execution>();
    for (const e of list) {
      merged.set(e.id, e);
    }
    for (const e of sandboxed) {
      merged.set(e.id, e);
    }
    return [...merged.values()];
  }

  async detectPartialCommit(executionId: string) {
    return { isConsistent: true, actualStatus: "RUNNING" as const };
  }

  isOutboxEnabled(): boolean {
    return false;
  }
}

/**
 * Sandboxed Memory Repository.
 * Captures episodic/RAG memory entries without persisting to production storage.
 */
export class SandboxedMemoryRepository implements MemoryRepository {
  private readonly childMemories: MemoryRecord[] = [];

  constructor(
    private readonly innerRepo: MemoryRepository,
    private readonly childExecutionId: string
  ) {}

  async add(record: MemoryRecord): Promise<void> {
    if (record.executionId !== this.childExecutionId) {
      throw new ReplaySandboxEscapeError(
        `Replay sandbox escape: attempt to persist memory record for foreign execution '${record.executionId}'`
      );
    }
    this.childMemories.push(record);
  }

  async addFenced(record: MemoryRecord, fence: FencingToken): Promise<FencedWriteOutcome> {
    if (record.executionId !== this.childExecutionId || fence.executionId !== this.childExecutionId) {
      throw new ReplaySandboxEscapeError(
        `Replay sandbox escape: attempt to persist fenced memory for foreign execution/fence '${record.executionId}'`
      );
    }
    await this.add(record);
    return "COMMITTED";
  }

  async search(agentId: string, query: string, limit: number): Promise<MemoryRecord[]> {
    const parentRecords = await this.innerRepo.search(agentId, query, limit);
    const childRecords = this.childMemories.filter((r) => r.agentId === agentId);
    return [...childRecords, ...parentRecords].slice(0, limit);
  }

  async listByAgent(agentId: string): Promise<MemoryRecord[]> {
    const parentRecords = await this.innerRepo.listByAgent(agentId);
    const childRecords = this.childMemories.filter((r) => r.agentId === agentId);
    return [...childRecords, ...parentRecords];
  }
}

/**
 * Sandboxed Event Publisher.
 * Suppresses external event bus distribution completely while retaining isolated storage.
 */
export class SandboxedEventPublisher extends PersistedEventPublisher {
  constructor(
    sandboxedStore: EventStore,
    private readonly childExecutionId: string
  ) {
    super(sandboxedStore, {
      publish: async () => {}, // Suppress event bus broadcasting
      subscribe: () => () => {}
    });
  }

  async publish(event: DomainEvent): Promise<DomainEvent> {
    if (event.aggregateId !== this.childExecutionId) {
      throw new ReplaySandboxEscapeError(
        `Replay sandbox escape: attempt to publish event for foreign aggregate '${event.aggregateId}'`
      );
    }
    return this.eventStore.append(event);
  }

  async publishDurable(event: DomainEvent): Promise<DomainEvent> {
    return this.publish(event);
  }

  async publishFenced(event: DomainEvent, fence: FencingToken): Promise<any> {
    if (event.aggregateId !== this.childExecutionId || fence.executionId !== this.childExecutionId) {
      throw new ReplaySandboxEscapeError(
        `Replay sandbox escape: attempt to publish fenced event for foreign aggregate/fence '${event.aggregateId}'`
      );
    }
    const persisted = await this.eventStore.append(event);
    return { outcome: "COMMITTED", event: persisted };
  }
}

/**
 * Sandboxed Tool Executor (ReplaySafeToolInterceptor).
 * Enforces strict capability safety policies and provides simulation.
 */
export class SandboxedToolExecutor implements ToolExecutor {
  constructor(
    private readonly innerExecutor: ToolExecutor,
    private readonly childExecutionId: string,
    private readonly isDiverged: () => boolean,
    private readonly isOperatorApproved: () => boolean
  ) {}

  get inner(): ToolExecutor {
    return this.innerExecutor;
  }

  async execute(input: {
    toolName: string;
    args: Record<string, unknown>;
    executionId: string;
    agentId: string;
    signal?: AbortSignal;
    idempotencyKey?: string;
    attempt?: number;
    stepSeq?: number;
    argsHash?: string;
    workerId?: string;
  }): Promise<Record<string, unknown>> {
    if (input.executionId !== this.childExecutionId) {
      throw new ReplaySandboxEscapeError(
        `Replay sandbox escape: tool execution targeted foreign execution '${input.executionId}'`
      );
    }

    if (!this.isDiverged()) {
      throw new ReplaySandboxViolationError(
        `Replay sandbox violation: attempt to execute tool '${input.toolName}' live during non-diverged replay-equivalent execution.`
      );
    }

    const policy = TOOL_REPLAY_POLICIES[input.toolName] ?? "BLOCKED_REPLAY";

    // 1. BLOCKED_REPLAY NEVER executes
    if (policy === "BLOCKED_REPLAY") {
      throw new ReplayPolicyViolationError(
        `Replay policy violation: tool '${input.toolName}' is BLOCKED during replay sandbox execution.`
      );
    }

    // 2. MANUAL_REPLAY_REQUIRED requires operator approval
    if (policy === "MANUAL_REPLAY_REQUIRED") {
      if (!this.isOperatorApproved()) {
        throw new ReplayPolicyViolationError(
          `Replay policy violation: tool '${input.toolName}' requires manual operator approval before execution.`
        );
      }
      return this.innerExecutor.execute(input);
    }

    // 3. SIMULATED_REPLAY intercepts and suppresses the side effect
    if (policy === "SIMULATED_REPLAY") {
      const simulatedPayload = TOOL_REPLAY_SIMULATIONS[input.toolName] ?? {
        simulated: true,
        success: true,
        message: `Simulated result returned for ${input.toolName}`
      };
      return {
        ...simulatedPayload,
        durationMs: 0,
        toolName: input.toolName,
        isSimulated: true
      };
    }

    // 4. SAFE_REPLAYABLE is allowed to run live (e.g. web search, file read)
    if (policy === "SAFE_REPLAYABLE") {
      return this.innerExecutor.execute(input);
    }

    throw new ReplayPolicyViolationError(
      `Replay policy violation: tool '${input.toolName}' has an unhandled governance policy '${policy}'.`
    );
  }
}
