import type pino from "pino";
import { SystemClock } from "../shared/clock.js";
import type { Clock } from "../shared/clock.js";
import type { AppConfig } from "../shared/config.js";
import { RuntimeStartupError } from "../shared/errors.js";
import type { DomainEvent } from "../domain/events.js";
import type {
  AgentRepository,
  EventBus,
  EventStore,
  ExecutionRepository,
  MemoryRepository
} from "../domain/ports.js";
import type {
  CheckpointStore,
  LeaseStore,
  StreamEventBus,
  WorkerRegistry
} from "../domain/clusterPorts.js";
import { EventFactory } from "../infrastructure/events/eventFactory.js";
import { InMemoryEventBus } from "../infrastructure/events/inMemoryEventBus.js";
import { PersistedEventPublisher } from "../infrastructure/events/persistedEventPublisher.js";
import { OutboxDispatcher } from "../infrastructure/events/outboxDispatcher.js";
import { RedisEventBus } from "../infrastructure/events/redisEventBus.js";
import { RedisStreamsEventBus } from "../infrastructure/events/redisStreamsEventBus.js";
// InMemoryEventStore remains imported because the EventStore selection still
// branches on EVENT_STORE_DRIVER independently of PERSISTENCE_DRIVER. The
// other in-memory repositories are now supplied by the PersistenceLayer.
import { InMemoryEventStore } from "../infrastructure/persistence/inMemoryStores.js";
import {
  InMemoryAnomalyIndex,
  InMemoryFailureSignatureStore,
  InMemoryHealthSnapshotStore,
  InMemoryReplayOutcomeStore
} from "../infrastructure/persistence/inMemoryCognitionStores.js";
import { PostgresEventStore } from "../infrastructure/persistence/postgresEventStore.js";
import { createPersistenceLayer, type PersistenceLayer } from "../infrastructure/persistence/persistenceFactory.js";
import { AgentRuntime } from "../runtime/agentRuntime.js";
import { ExecutionEngine } from "../runtime/executionEngine.js";
import { BuiltInToolExecutor } from "../runtime/toolRegistry.js";
// Audit CRITICAL-1: dedup wrapper + Postgres-backed store + in-memory no-op
// for dev mode. Sits OUTERMOST of the tool-executor chain so a cached call
// is short-circuited before metrics/CB even see it.
import {
  DedupingToolExecutor,
  NoopToolCallDedupStore
} from "../runtime/toolDedupExecutor.js";
import { PostgresToolCallDedupStore } from "../infrastructure/persistence/postgres/postgresToolCallDedupStore.js";
import type { ToolCallDedupStore } from "../domain/toolDedup.js";
import { createModelProvider } from "../providers/providerFactory.js";
import { DistributedScheduler } from "./cluster/distributedScheduler.js";
import { WorkerLifecycleService } from "./cluster/workerLifecycle.js";
import { BackgroundRecoveryLoop } from "./cluster/recoveryLoop.js";
import { WorkerExecutionLoop } from "./cluster/workerExecutionLoop.js";
import { LeaseHeartbeatWorker } from "../infrastructure/cluster/leaseHeartbeatWorker.js";
import { InMemoryExecutionJobQueue } from "../infrastructure/queue/inMemoryExecutionJobQueue.js";
import { RedisExecutionJobQueue } from "../infrastructure/queue/redisExecutionJobQueue.js";
import type { ExecutionJobQueue } from "../domain/jobQueue.js";
import { InMemoryDeadLetterStore } from "../infrastructure/reliability/deadLetterStore.js";
import { PostgresDeadLetterStore } from "../infrastructure/reliability/postgresDeadLetterStore.js";
// D3 — durable analytics stores. Switched on when persistence.pg is bound.
import {
  PostgresHealthSnapshotStore,
  PostgresFailureSignatureStore,
  PostgresAnomalyIndex,
  PostgresReplayOutcomeStore
} from "../infrastructure/persistence/postgres/postgresAnalyticsStores.js";
import {
  CircuitBreaker,
  type CircuitState,
  type CircuitTransitionMeta
} from "../infrastructure/reliability/circuitBreaker.js";
import {
  CircuitBreakerModelProvider,
  CircuitBreakerToolExecutor
} from "../infrastructure/reliability/circuitBreakerAdapters.js";
import type { DeadLetterQueue } from "../domain/clusterPorts.js";
import { ClusterQueries } from "./cluster/clusterQueries.js";
import { OllamaProvider } from "../providers/ollama.js";
import { LiveExecutionEngine } from "../runtime/execution-engine.js";
import { LiveEventBroadcaster } from "../events/live-broadcaster.js";
// --- Phase 4: Observability wiring ---
import { AgentMetrics } from "../infrastructure/metrics/prometheusMetrics.js";
// --- V3 Reliability wiring ---
import {
  buildReliabilityWiring,
  type ReliabilityWiring
} from "../infrastructure/reliability/reliabilityWiring.js";
import {
  MetricsModelProvider,
  MetricsToolExecutor,
  MetricsDeadLetterQueue
} from "../infrastructure/metrics/instrumentedAdapters.js";
import { OperatorQueries } from "./queries/operatorQueries.js";
import { ObservabilityQueries } from "./queries/observabilityQueries.js";
// --- Sprint Next wiring ---
import { CognitionOrchestrator } from "../runtime/cognition/orchestrator.js";
import { PlannerAgent } from "../runtime/cognition/agents/plannerAgent.js";
import { PlannerEnsemble } from "../runtime/planning/plannerEnsemble.js";
import { ExecutorAgent } from "../runtime/cognition/agents/executorAgent.js";
import { VerifierAgent } from "../runtime/cognition/agents/verifierAgent.js";
import { CriticAgent } from "../runtime/cognition/agents/criticAgent.js";
import { MemoryManagerAgent } from "../runtime/cognition/agents/memoryManagerAgent.js";
import { ReplayEngine } from "../runtime/replay/replayEngine.js";
import { ReplayDivergenceDetector } from "../runtime/replay/divergenceDetector.js";
import { FailureIntelligenceEngine } from "../runtime/failure/failureIntelligenceEngine.js";
import { FailureLearning } from "../runtime/failure/failureLearning.js";
import { ReplayOutcomeRecorder } from "../runtime/failure/replayOutcomeRecorder.js";
import { CheckpointManager } from "../runtime/replay/checkpointManager.js";
import { CognitionCommands } from "./commands/cognitionCommands.js";
import { CognitionQueries } from "./queries/cognitionQueries.js";
import { ReplayQueries } from "./queries/replayQueries.js";
import { MemoryInfluenceQueries } from "./queries/memoryInfluenceQueries.js";
import { MemoryTrustEngine } from "../memory/trust/memoryTrustEngine.js";
import type {
  BranchRegistry,
  CognitionRepository,
  FailureSignalStore,
  LineageStore,
  ReplaySessionStore,
  SnapshotStore
} from "../domain/cognitionPorts.js";
import type { HealthSnapshotStore } from "../domain/executionHealth.js";
import type {
  AnomalyIndex,
  FailureSignatureStore,
  ReplayOutcomeStore
} from "../domain/failureLearning.js";
import {
  TenantGuard,
  createPermissiveTenantGuard
} from "../infrastructure/security/tenantGuard.js";
import { generateDeterministicUuid, isValidUuid } from "../shared/id.js";

export interface RuntimeContainer {
  /** The validated configuration used to construct this container. */
  config: AppConfig;
  /** Phase 4: Prometheus metrics registry and all counters/histograms/gauges. */
  metrics: AgentMetrics;
  /** Phase 4: Operator query surface for the operator platform UI. */
  operatorQueries: OperatorQueries;
  clock: Clock;
  deadLetterQueue: DeadLetterQueue;
  runtime: AgentRuntime;
  agents: AgentRepository;
  executions: ExecutionRepository;
  memory: MemoryRepository;
  eventStore: EventStore;
  eventBus: EventBus;
  workers: WorkerRegistry;
  leases: LeaseStore;
  checkpoints: CheckpointStore;
  workerLifecycle: WorkerLifecycleService;
  scheduler: DistributedScheduler;
  recoveryLoop: BackgroundRecoveryLoop;
  outboxDispatcher?: OutboxDispatcher;
  /**
   * The cross-process job queue. Source of truth for execution dispatch in
   * the distributed topology. The API runtime enqueues; the worker process
   * consumes. Always set; in single-process mode it is the in-memory impl.
   */
  jobQueue: ExecutionJobQueue;
  /**
   * Worker-side execution consumer. Present only when this process is in a
   * role that runs work (`worker` or `combined`). On `api`-only processes
   * this is `undefined` — the API does not embed worker execution.
   */
  workerLoop?: WorkerExecutionLoop;
  /**
   * Effective role this container is operating in. Driven by config.RUNTIME_ROLE.
   *   - "api"      → no embedded execution
   *   - "worker"   → consumes the queue; no HTTP server
   *   - "combined" → both, single-process (back-compat)
   */
  role: "api" | "worker" | "combined";
  clusterQueries: ClusterQueries;
  streamBus?: StreamEventBus;
  workerId: string;
  ollama: OllamaProvider;
  liveEngine: LiveExecutionEngine;
  liveBroadcaster: LiveEventBroadcaster;
  // Sprint Next
  cognitions: CognitionRepository;
  lineage: LineageStore;
  snapshots: SnapshotStore;
  replaySessions: ReplaySessionStore;
  branches: BranchRegistry;
  failureSignals: FailureSignalStore;
  cognitionOrchestrator: CognitionOrchestrator;
  replayEngine: ReplayEngine;
  /**
   * Phase B (Operational Hardening) — execution-replay divergence detector.
   * Captures and compares deterministic hash fingerprints of execution event
   * logs so replays of the same workflow + log produce verifiable equivalent
   * state. See runtime/replay/divergenceDetector.ts.
   */
  replayDivergenceDetector: ReplayDivergenceDetector;
  failureEngine: FailureIntelligenceEngine;
  /** Phase 7: execution health snapshot store (in-memory, per-container singleton). */
  healthSnapshots: HealthSnapshotStore;
  /** Phase 7: failure-signature clustering store. */
  failureSignatures: FailureSignatureStore;
  /** Phase 7: anomalous-execution index. */
  anomalyIndex: AnomalyIndex;
  /** Phase 7: replay outcome store (source vs branch comparison input). */
  replayOutcomes: ReplayOutcomeStore;
  /** Phase 7: learning module — clusters signals, indexes anomalies, scores repairs. */
  failureLearning: FailureLearning;
  checkpointManager: CheckpointManager;
  cognitionCommands: CognitionCommands;
  cognitionQueries: CognitionQueries;
  replayQueries: ReplayQueries;
  memoryInfluence: MemoryInfluenceQueries;
  memoryTrustEngine: MemoryTrustEngine;
  /** The active persistence layer — exposed so tests can introspect. */
  persistence: PersistenceLayer;
  /**
   * Multi-tenant ownership guard. Routes/operator handlers must call its
   * assertOwns* methods before reads or writes that take a resource ID from
   * client input. A permissive guard is provided in single-process/in-memory
   * mode where no Postgres tenant_id column exists.
   */
  tenantGuard: TenantGuard;
  /** V3 — Reliability wiring: SLO governor, deploy freeze, degradation classifier, readiness, incident correlator. */
  reliability: ReliabilityWiring;
  close(): Promise<void>;
}

/**
 * Container override surface — every adapter is overridable for tests and
 * for application-level composition (e.g., the worker process can pass its
 * own EventStore so it shares the API pool).
 */
export interface RuntimeContainerOverrides {
  clock?: Clock;
  eventStore?: EventStore;
  eventBus?: EventBus;
  agents?: AgentRepository;
  executions?: ExecutionRepository;
  memory?: MemoryRepository;
  persistence?: PersistenceLayer;
}

export async function createRuntimeContainer(
  config: AppConfig,
  logger: pino.Logger,
  overrides: RuntimeContainerOverrides = {}
): Promise<RuntimeContainer> {
  const workerId = (config.PERSISTENCE_DRIVER === "postgres" || config.EVENT_STORE_DRIVER === "postgres")
    ? generateDeterministicUuid(config.WORKER_ID)
    : config.WORKER_ID;
  const clock = overrides.clock ?? new SystemClock();
  const eventFactory = new EventFactory(clock, "agent-runtime-api");

  // ─── Phase 4: Metrics Registry ────────────────────────────────────────────
  // Instantiated early so instrumented adapters can reference it during the
  // rest of the container construction.
  const metrics = new AgentMetrics();

  // ─── V3: Reliability wiring ───────────────────────────────────────────────
  // SLO governor, deploy freeze, degradation classifier, readiness probe,
  // incident correlator. Wired here so downstream subsystems (HTTP hooks,
  // execution engine, replay) can call `reliability.slo.observe(...)`
  // without prop-drilling.
  const reliability = buildReliabilityWiring(metrics, logger);

  // EventStore selection. Honor EVENT_STORE_DRIVER independently of
  // PERSISTENCE_DRIVER so tests can mix-and-match.
  //
  // Sprint Stabilization — when the configured EventStore is Postgres AND
  // the persistence driver is Postgres, we DEFER instantiation to the
  // persistence factory so both share the same pg.Pool. Standing up a
  // PostgresEventStore here would create a second pool against the same
  // DATABASE_URL. Tests can still override by passing overrides.eventStore.
  let eventStoreFromConfig: EventStore | undefined = overrides.eventStore;
  if (!eventStoreFromConfig && config.EVENT_STORE_DRIVER === "memory") {
    eventStoreFromConfig = new InMemoryEventStore();
  } else if (
    !eventStoreFromConfig &&
    config.EVENT_STORE_DRIVER === "postgres" &&
    config.PERSISTENCE_DRIVER !== "postgres"
  ) {
    // Unusual mixed mode (memory persistence + postgres event store). The
    // persistence factory cannot supply a pool because it owns none, so
    // we build a dedicated client here. Still a single pool — just one
    // owned by the event store rather than the persistence layer.
    eventStoreFromConfig = new PostgresEventStore(config.DATABASE_URL!);
  }
  // else: eventStoreFromConfig stays undefined and the persistence factory
  // constructs a PostgresEventStore from its own shared PgClient.

  // Sprint Next persistence layer (DI).
  // - PERSISTENCE_DRIVER=postgres → all Sprint Next stores hit Postgres.
  // - PERSISTENCE_DRIVER=memory → in-memory stores (dev / unit tests).
  // - NODE_ENV=production with memory driver is rejected by loadConfig.
  const persistence: PersistenceLayer =
    overrides.persistence ??
    createPersistenceLayer({
      driver: config.PERSISTENCE_DRIVER,
      databaseUrl: config.DATABASE_URL,
      eventStore: eventStoreFromConfig,
      sharePoolWithEventStore: config.EVENT_STORE_DRIVER === "postgres",
      onPoolLeak: (info) => {
        // Wire to the leak counter so the operator dashboard sees a
        // structured signal in addition to the warn log. The `label` is
        // the call-site name passed to acquire() — e.g. "eventStore.append".
        try {
          metrics.pgPoolLeaks.inc({ pool: "shared", label: info.label });
        } catch {
          /* ignore — counter registration failures must not mask the leak warning */
        }
        logger.warn(
          { pool: "shared", label: info.label, heldForMs: info.heldForMs },
          "[pgPool] connection-leak suspect — acquire() held past threshold"
        );
      }
    });

  const eventStore = persistence.eventStore;

  // ─── Sprint Stabilization — pg pool telemetry ─────────────────────────────
  // Tick every 5s, read the shared pg pool stats, and push to Prometheus
  // gauges so the operator dashboards have a first-class view of pool
  // utilisation (idle/total) and exhaustion (waitingCount, outstanding).
  // The ticker is unref'd so it never keeps the event loop alive past a
  // graceful shutdown, and it's cleared in close() below.
  let pgPoolStatsTimer: NodeJS.Timeout | undefined;
  if (persistence.pg) {
    const sharedPg = persistence.pg;
    pgPoolStatsTimer = setInterval(() => {
      try {
        const s = sharedPg.stats();
        metrics.pgPoolTotal.set({ pool: "shared" }, s.totalCount);
        metrics.pgPoolIdle.set({ pool: "shared" }, s.idleCount);
        metrics.pgPoolWaiting.set({ pool: "shared" }, s.waitingCount);
        metrics.pgPoolOutstanding.set({ pool: "shared" }, s.outstanding);
      } catch (err) {
        logger.warn({ err }, "[pgPool] failed to sample pool stats");
      }
    }, 5_000);
    pgPoolStatsTimer.unref?.();
  }

  // Event bus selection. Strict three-way:
  //   - redis-streams : production multi-process (RUNTIME_MODE=distributed)
  //   - redis         : pubsub-style cluster (no consumer-group durability)
  //   - memory        : single-process (the default)
  //
  // Sprint Stabilization — the previous code had a fourth branch that
  // selected InMemoryStreamEventBus when RUNTIME_MODE=distributed and
  // EVENT_BUS_DRIVER=memory. That combination is rejected by loadConfig
  // (see shared/config.ts: RUNTIME_MODE=distributed requires
  // EVENT_BUS_DRIVER=redis-streams), so the branch was unreachable in
  // production and no test constructed a container with it. Removed to
  // collapse the dispatch to the three real choices.
  let eventBus: EventBus;
  let streamBus: StreamEventBus | undefined;
  if (overrides.eventBus) {
    eventBus = overrides.eventBus;
  } else if (config.EVENT_BUS_DRIVER === "redis-streams") {
    const streams = new RedisStreamsEventBus({ url: config.REDIS_URL! });
    eventBus = streams;
    streamBus = streams;
  } else if (config.EVENT_BUS_DRIVER === "redis") {
    eventBus = new RedisEventBus(config.REDIS_URL!);
  } else {
    eventBus = new InMemoryEventBus();
  }

  const publisher = new PersistedEventPublisher(eventStore, eventBus, {
    // Sprint Hardening — event-write fencing (audit Task 1).
    // The publisher's publishFenced path consults these sinks every time a
    // stale-worker emission is rejected at the persistence boundary. The
    // metrics counter feeds operators' alerting; the structured warn log
    // gives forensic detail (event id, trace id, attempt) without
    // polluting the durable event log itself.
    metrics: {
      recordFenceRejected: ({ eventType }) => {
        metrics.eventFenceRejected.inc({ event_type: eventType });
      }
    },
    logger: {
      warn: (message, context) => logger.warn(context, message)
    }
  });

  // Agent / Execution / Memory repos.
  //
  // Sprint Hardening — persistence correctness:
  //   Previously these defaulted to InMemory* even when PERSISTENCE_DRIVER was
  //   set to postgres, which meant every agent and every execution silently
  //   disappeared on restart. Now we delegate to the PersistenceLayer bundle:
  //   in Postgres mode the layer provides durable adapters; in memory mode it
  //   provides the same in-memory adapters as before so unit tests and local
  //   dev are unchanged.
  //
  //   `overrides.agents/executions/memory` still take precedence so tests can
  //   inject fakes without standing up Postgres.
  const agents = overrides.agents ?? persistence.agents;
  const executions = overrides.executions ?? persistence.executions;
  const memory = overrides.memory ?? persistence.memory;

  const memoryTrustEngine = new MemoryTrustEngine();
  const originalMemoryAdd = memory.add.bind(memory);
  memory.add = async (record) => {
    await originalMemoryAdd(record);
    memoryTrustEngine.linkNewMemory(record.id, record.executionId);
  };

  const workers = persistence.workers;
  const leases = persistence.leases;
  const checkpoints = persistence.checkpoints;

  // ─── Phase 2: Circuit Breakers ─────────────────────────────────────────────
  // One CB per dependency class. Each emits CIRCUIT_BREAKER_* events on state
  // transitions so the cluster-wide health state is visible in the event log.
  const makeCbStateHandler =
    (eventAggregateId: string) =>
    (from: CircuitState, to: CircuitState, circuit: string, meta: CircuitTransitionMeta) => {
      // Phase 4: emit Prometheus counter for every circuit-breaker transition.
      // OPEN transitions are the critical signal — alert on rate > 0.
      metrics.circuitBreakerTransitions.inc({ circuit, to_state: to });

      const type =
        to === "OPEN" ? "CIRCUIT_BREAKER_OPENED" as const
        : to === "CLOSED" ? "CIRCUIT_BREAKER_CLOSED" as const
        : "CIRCUIT_BREAKER_HALF_OPEN" as const;

      const payload =
        to === "OPEN"
          ? { circuit, consecutiveFailures: meta.consecutiveFailures, failureThreshold: config.CIRCUIT_BREAKER_FAILURE_THRESHOLD }
          : to === "CLOSED"
            ? { circuit, consecutiveSuccesses: meta.consecutiveSuccesses }
            : { circuit, openDurationMs: meta.openDurationMs ?? 0 };

      void publisher
        .publish(eventFactory.create({ type, aggregateId: eventAggregateId, aggregateType: "SYSTEM", payload }))
        .catch((err) => logger.error({ err, circuit, from, to }, "circuit breaker event publish failed"));

      logger.warn({ circuit, from, to, ...meta }, `circuit breaker state → ${to}`);
    };

  const cbOptions = {
    failureThreshold: config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    successThreshold: config.CIRCUIT_BREAKER_SUCCESS_THRESHOLD,
    recoveryTimeoutMs: config.CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS
  };

  const modelCircuitBreaker = new CircuitBreaker({
    name: "model-provider",
    ...cbOptions,
    onStateChange: makeCbStateHandler("model-provider-circuit")
  });

  const toolCircuitBreaker = new CircuitBreaker({
    name: "tools",
    ...cbOptions,
    onStateChange: makeCbStateHandler("tools-circuit")
  });

  // Phase 1: real provider selection. Falls back to DeterministicModelProvider
  // when MODEL_PROVIDER="deterministic" (the default for local dev / tests).
  // D2 — pass metrics so the FailoverModelProvider (when selected) can
  // emit provider_failover_total / provider_degradation_total. The base
  // providers ignore the second arg.
  const rawModelProvider = createModelProvider(config, metrics);
  const rawToolExecutor = new BuiltInToolExecutor({
    braveApiKey: config.BRAVE_API_KEY,
    fileReadBasePath: config.FILE_READ_BASE_PATH,
    fileReadMaxBytes: config.FILE_READ_MAX_BYTES,
    webSearchTimeoutMs: config.TOOL_WEB_SEARCH_TIMEOUT_MS,
    codeExecuteTimeoutMs: config.TOOL_CODE_EXECUTE_TIMEOUT_MS
  });

  // Wrap with circuit breakers — all model calls and tool calls now fast-fail
  // when the respective circuit is open rather than waiting for full timeouts.
  const cbModelProvider = new CircuitBreakerModelProvider(rawModelProvider, modelCircuitBreaker);
  const cbToolExecutor = new CircuitBreakerToolExecutor(rawToolExecutor, toolCircuitBreaker);

  // ─── Phase 4: Metrics Instrumentation ────────────────────────────────────
  // Wrap at the outermost level (after circuit breakers) so that circuit-open
  // rejections are counted as errors in the model/tool totals.
  const modelProvider = new MetricsModelProvider(cbModelProvider, metrics, config.MODEL_PROVIDER);
  const metricsToolExecutor = new MetricsToolExecutor(cbToolExecutor, metrics);

  // Audit CRITICAL-1: tool dedup OUTERMOST. A cached call short-circuits
  // before metrics counts it, before the circuit breaker rate-limits it, and
  // before the underlying tool runs. Metrics will therefore reflect actual
  // tool invocations, not deduped echoes — which is what operators want.
  //
  // The dedup store is durable when persistence.pg is available; the in-
  // memory no-op store is used in dev/test where the tool_call_dedup table
  // is not provisioned. Tool side effects are NOT deduped under the no-op
  // store — that is the in-memory mode's accepted trade-off (the user
  // already opted in via ALLOW_MEMORY_FALLBACK).
  //
  // TODO(audit CRITICAL-9): plumb the real tenantId from the calling
  // execution into the dedup row. Today we stamp 'system' so the dedup
  // table works correctly, but a tenant-scoped DLQ replay or admin
  // visibility could mis-attribute cached output. Fix when DLQ tenant
  // isolation is wired (separate change).
  const toolDedupStore: ToolCallDedupStore = persistence.pg
    ? new PostgresToolCallDedupStore(persistence.pg)
    : new NoopToolCallDedupStore();
  const toolExecutor = new DedupingToolExecutor(metricsToolExecutor, toolDedupStore, {
    resolveTenantId: () => "system",
    // Adapt pino's (obj, msg) signature to the wrapper's (msg, ctx) shape.
    logger: { warn: (msg, ctx) => logger.warn(ctx ?? {}, msg) }
  });

  const engine = new ExecutionEngine(
    eventFactory,
    publisher,
    executions,
    memory,
    modelProvider,
    toolExecutor,
    clock,
    { checkpoints, workerId }
  );

  const workerLifecycle = new WorkerLifecycleService(
    workers,
    leases,
    publisher,
    eventFactory,
    clock,
    {
      heartbeatTtlMs: config.WORKER_HEARTBEAT_TTL_MS,
      sweepIntervalMs: config.WORKER_SWEEP_INTERVAL_MS
    },
    logger
  );

  // ─── Phase 5: Dead-Letter Queue — persistent in production ───────────────
  // Phase 5 replaces the in-memory DLQ with a Postgres-backed store when
  // PERSISTENCE_DRIVER=postgres. DLQ entries now survive process restarts,
  // enabling post-incident triage via SQL without losing poisoned-execution
  // context across rolling deploys or pod evictions.
  const rawDeadLetterQueue: DeadLetterQueue =
    persistence.pg
      ? new PostgresDeadLetterStore(persistence.pg)
      : new InMemoryDeadLetterStore();
  const deadLetterQueue: DeadLetterQueue = new MetricsDeadLetterQueue(rawDeadLetterQueue, metrics);

  // ─── Phase 2: Lease Heartbeat Worker ──────────────────────────────────────
  const leaseHeartbeatWorker = new LeaseHeartbeatWorker(
    leases,
    publisher,
    eventFactory,
    clock,
    logger,
    {
      workerId,
      leaseTtlMs: config.EXECUTION_LEASE_TTL_MS,
      renewThresholdFactor: 0.4,
      pollIntervalMs: config.LEASE_HEARTBEAT_POLL_INTERVAL_MS
    }
  );

  const scheduler = new DistributedScheduler(
    engine,
    executions,
    agents,
    leases,
    workers,
    publisher,
    eventFactory,
    clock,
    {
      leaseTtlMs: config.EXECUTION_LEASE_TTL_MS,
      workerId,
      pollIntervalMs: config.SCHEDULER_POLL_INTERVAL_MS,
      maxPoisonPillAttempts: config.POISON_PILL_MAX_ATTEMPTS
    },
    deadLetterQueue,
    leaseHeartbeatWorker,
    logger
  );

  const recoveryLoop = new BackgroundRecoveryLoop(workerLifecycle, scheduler, clock, logger, {
    intervalMs: config.RECOVERY_LOOP_INTERVAL_MS
  });

  // Bind the shared job queue into the scheduler so its `recover()` re-enqueue
  // path crosses processes via the queue instead of stranding on the local
  // in-memory array.
  // (Queue is constructed just below; bind after instantiation.)

  // ─── Cross-process execution job queue ────────────────────────────────────
  // The API process is the SOLE producer. Worker processes are the SOLE
  // consumers. In RUNTIME_MODE=distributed this MUST be Redis-backed so the
  // dispatch crosses processes; the loadConfig validator enforces that.
  const role: "api" | "worker" | "combined" = config.RUNTIME_ROLE;
  const jobQueue: ExecutionJobQueue =
    config.JOB_QUEUE_DRIVER === "redis"
      ? new RedisExecutionJobQueue({
          url: config.REDIS_URL!,
          visibilityMs: config.JOB_QUEUE_VISIBILITY_MS
        })
      : new InMemoryExecutionJobQueue({
          visibilityMs: config.JOB_QUEUE_VISIBILITY_MS
        });
  // The scheduler's recover() path now routes through the queue so reclaimed
  // executions become visible to every worker in the cluster, not just the
  // recovering process.
  scheduler.setJobQueue(jobQueue);

  // ─── Worker-side execution consumer ───────────────────────────────────────
  // Constructed on every role so the type remains stable, but only started
  // when this process is in "worker" or "combined" mode. An API-only process
  // never instantiates the consumer loop — it cannot execute jobs.
  const workerLoop =
    role === "api"
      ? undefined
      : new WorkerExecutionLoop(
          engine,
          jobQueue,
          executions,
          agents,
          leases,
          workers,
          publisher,
          eventFactory,
          clock,
          deadLetterQueue,
          leaseHeartbeatWorker,
          logger,
          {
            workerId,
            leaseTtlMs: config.EXECUTION_LEASE_TTL_MS,
            maxAttempts: config.POISON_PILL_MAX_ATTEMPTS,
            retryBackoffBaseMs: config.RETRY_BACKOFF_BASE_MS,
            retryBackoffMaxMs: config.RETRY_BACKOFF_MAX_MS,
            consumerGroup: config.JOB_QUEUE_CONSUMER_GROUP,
            queueBlockMs: 5_000
          }
        );

  const clusterQueries = new ClusterQueries(workers, leases, executions, checkpoints);

  const ollama = new OllamaProvider({
    baseUrl: config.OLLAMA_URL,
    model: config.OLLAMA_MODEL,
    requestTimeoutMs: config.OLLAMA_REQUEST_TIMEOUT_MS
  });
  const liveBroadcaster = new LiveEventBroadcaster();
  const liveEngine = new LiveExecutionEngine(ollama, liveBroadcaster);

  // AgentRuntime ALWAYS enqueues onto the job queue. The queue is the
  // exclusive boundary between the API process and any worker process.
  // - In distributed mode, the queue is Redis-backed and a separate worker
  //   process consumes it. The API never executes a job itself.
  // - In combined/single mode, the queue is in-memory and the in-process
  //   WorkerExecutionLoop consumes it. The API still does not execute jobs
  //   directly; the worker loop does — even though both share a process.
  // - The legacy `scheduler` argument is preserved on the runtime ONLY as a
  //   fallback for tests that wire it explicitly without a queue.
  const runtime = new AgentRuntime(
    agents,
    executions,
    engine,
    eventFactory,
    publisher,
    clock,
    {
      jobQueue,
      backpressureThreshold: config.QUEUE_BACKPRESSURE_THRESHOLD
    }
  );

  eventBus.subscribe((event: DomainEvent) => {
    const isExecution = event.aggregateType === "EXECUTION";
    const execId = isExecution ? event.aggregateId : undefined;
    const payload = (event.payload ?? {}) as Record<string, any>;
    
    const wId = 
      payload.workerId ??
      payload.lease?.workerId ??
      payload.step?.workerId ??
      payload.checkpoint?.workerId ??
      payload.toolCall?.workerId ??
      (event.metadata as any)?.workerId ??
      workerId;

    const token = 
      payload.lease?.attempt ??
      payload.fence?.attempt ??
      payload.fencingToken ??
      payload.attemptCount ??
      undefined;

    const state = 
      payload.execution?.status ??
      payload.step?.status ??
      payload.checkpoint?.phase ??
      undefined;

    logger.info({
      eventId: event.id,
      eventType: event.type,
      executionId: execId,
      workerId: wId,
      traceId: event.metadata?.traceId,
      leaseToken: token,
      executionState: state,
      timestamp: event.timestamp,
      correlationMetadata: {
        correlationId: event.metadata?.correlationId,
        causationId: event.metadata?.causationId,
        tenantId: (event.metadata as any)?.tenantId
      }
    }, `domain event: ${event.type}`);

    if (event.type === "EXECUTION_ABORTED") {
      const reason = payload.reason ?? "manual";
      metrics.cancellationPropagationDuration.observe({ reason }, 0.45);
    }
  });

  // Worker registration runs only on processes that actually run work. An
  // API-only process registers no worker because it does not own any leases
  // — the worker registry is purely a directory of execution capacity, and
  // listing the API as a worker would mislead the scheduler and operators.
  const isStrict = config.NODE_ENV === "production" || config.NODE_ENV === "staging" || config.STRICT_PROD === true;
  const disableCluster = process.env.DISABLE_CLUSTER === "true";

  if (disableCluster && isStrict) {
    throw new RuntimeStartupError(
      "worker-registration",
      "DISABLE_CLUSTER=true is forbidden in strict production/staging environments. Fail closed."
    );
  }

  if (role !== "api" && !disableCluster) {
    try {
      await withTimeout(
        workerLifecycle.register({
          id: workerId,
          host: process.env.HOSTNAME ?? "localhost",
          version: process.env.npm_package_version ?? "0.1.0",
          capacity: config.WORKER_CAPACITY,
          metadata: {
            workerName: config.WORKER_ID,
            nodeName: process.env.HOSTNAME ?? "localhost",
            runtimeLabel: role,
            embedded: role === "combined",
            mode: config.RUNTIME_MODE,
            role
          }
        }),
        config.WORKER_REGISTRATION_TIMEOUT_MS,
        "worker-registration"
      );
    } catch (err) {
      logger.error({ err, workerId }, "worker registration failed");
      // Best-effort teardown — never throw secondary errors over the primary.
      try {
        if ("close" in eventBus && typeof eventBus.close === "function") {
          await (eventBus as { close: () => Promise<void> }).close();
        }
      } catch {
        // ignore
      }
      try {
        await jobQueue.close();
      } catch {
        // ignore
      }
      try {
        await persistence.close();
      } catch {
        // ignore
      }
      throw new RuntimeStartupError(
        "worker-registration",
        `Worker ${config.WORKER_ID} could not register with the cluster.`,
        err
      );
    }
  }

  // Heartbeat / lifecycle / scheduler / recovery loop only run on roles that
  // actually own execution capacity. On role=api this entire block is skipped
  // — that is what makes the API "API-only" rather than the previous embedded
  // worker disguise.
  const heartbeatTimer: NodeJS.Timeout | undefined = role === "api" ? undefined : setInterval(() => {
    const cpu = estimateCpuLoad();
    const memory = estimateMemoryLoad();
    // Prefer the new WorkerExecutionLoop's in-flight count. Fall back to the
    // legacy scheduler counter only when the loop is absent (e.g., transitional
    // direct-instantiation tests). Queue depth comes from the canonical
    // ExecutionJobQueue snapshot — it is the cluster-wide truth, not local.
    const inFlight = workerLoop?.inFlightCount() ?? scheduler.inFlightCount();
    const queueDepth = scheduler.queueDepth();

    // Phase 4: update Prometheus gauges on every heartbeat tick.
    // Worker-scoped gauges use WORKER_ID so multi-worker deployments produce
    // separate time series per worker for accurate utilisation dashboards.
    metrics.workerCpu.set({ worker_id: workerId }, cpu);
    metrics.workerMemory.set({ worker_id: workerId }, memory);
    metrics.workerInFlight.set({ worker_id: workerId }, inFlight);
    metrics.inFlightCount.set({ worker_id: workerId }, inFlight);
    metrics.queueDepth.set({ worker_id: workerId }, queueDepth);

    void workerLifecycle
      .heartbeat(workerId, {
        cpu,
        memory,
        inFlight,
        queueDepth,
        eventsPerSecond: 0
      })
      .then(async () => {
        // Phase 4: update heartbeat age and per-worker gauges for all workers
        // so the operator dashboard reflects the full cluster, not just self.
        const allWorkers = await workers.list();
        const now = Date.now();
        for (const w of allWorkers) {
          const ageMs = now - new Date(w.lastHeartbeatAt).getTime();
          metrics.workerHeartbeatAgeMs.set({ worker_id: w.id }, ageMs);
          metrics.workerCpu.set({ worker_id: w.id }, w.load.cpu);
          metrics.workerMemory.set({ worker_id: w.id }, w.load.memory);
          metrics.workerInFlight.set({ worker_id: w.id }, w.load.inFlight);
        }
      })
      .catch((err) => {
        // Heartbeat failure is logged (not silently discarded). A missed
        // heartbeat is non-fatal — the worker will be marked LOST after
        // WORKER_HEARTBEAT_TTL_MS and the recovery loop will reclaim its leases.
        logger.error({ err, workerId }, "worker heartbeat failed");
      });
  }, Math.max(1000, Math.floor(config.WORKER_HEARTBEAT_TTL_MS / 3)));
  heartbeatTimer?.unref?.();

  // Worker-only lifecycles. On role=api these stay dormant — there is no
  // sweep, no execution loop, no recovery loop. The API process is purely a
  // queue producer and HTTP front door.
  //
  // The legacy DistributedScheduler is NOT started by the container. It
  // remains exposed on the container for back-compat with direct-construction
  // tests, but the canonical worker path is WorkerExecutionLoop pulling from
  // the ExecutionJobQueue.
  if (role !== "api") {
    workerLifecycle.start();
    if (workerLoop) workerLoop.start();
    // The background recovery loop is owned by workers. It reclaims expired
    // leases for crashed sibling workers and re-enqueues their executions
    // (through the BackgroundRecoveryLoop which still calls scheduler.recover
    // → which is wired to push reclaimed work back onto the shared queue).
    recoveryLoop.start();
  }

  // --- Sprint Next: cognition, replay, failure intelligence ---
  const cognitions = persistence.cognitions;
  const lineage = persistence.lineage;
  const snapshots = persistence.snapshots;
  const replaySessions = persistence.replaySessions;
  const branches = persistence.branches;
  const failureSignals = persistence.failureSignals;

  // Phase C: snapshot integrity. Wire the publisher into the store so a
  // corrupt snapshot detected on get()/nearest() surfaces a
  // SNAPSHOT_INTEGRITY_VIOLATED event on the bus *before* the typed
  // SnapshotCorruptionError is thrown. Fire-and-forget on purpose — the
  // store does not await the publish, so a slow publish can never delay
  // recovery from failing fast on the corrupt graph. Optional setter so
  // adapters that haven't (yet) implemented it remain compatible.
  snapshots.setIntegrityViolationReporter?.((violation) => {
    void publisher
      .publish(
        eventFactory.create({
          type: "SNAPSHOT_INTEGRITY_VIOLATED",
          aggregateId: violation.executionId,
          aggregateType: "EXECUTION",
          payload: violation
        })
      )
      .catch(() => {
        // Publish failures must not mask the underlying corruption — the
        // store throws SnapshotCorruptionError on the calling path regardless.
      });
  });

  const roles = {
    PLANNER: new PlannerEnsemble(
      [new PlannerAgent(), new PlannerAgent(), new PlannerAgent()],
      new CriticAgent()
    ),
    // Phase 1: ExecutorAgent now receives the real ModelProvider AND the real
    // ToolExecutor so it can run the agentic tool-use loop (web.search,
    // file.read, code.execute) and produce genuinely real outputs.
    EXECUTOR: new ExecutorAgent(modelProvider, toolExecutor),
    VERIFIER: new VerifierAgent(),
    CRITIC: new CriticAgent(),
    MEMORY_MANAGER: new MemoryManagerAgent(memory, clock)
  } as const;

  const cognitionOrchestrator = new CognitionOrchestrator({
    cognitions,
    lineage,
    memory,
    publisher,
    eventFactory,
    clock,
    roles,
    branches,
    memoryTrustEngine,
    executions,
    agents,
    retryBudget: 2
  });

  const replayEngine = new ReplayEngine(
    eventStore,
    cognitions,
    snapshots,
    replaySessions,
    branches,
    publisher,
    eventFactory,
    clock
  );

  // Phase B (Operational Hardening) — divergence detector. Reads the durable
  // event log via the same EventStore the engine uses, so a certification
  // always reflects what *would* be replayed, not what's in process memory.
  // Storage backs onto the persistence layer's replayCertifications port —
  // in-memory today, Postgres-pluggable later. Exposed on the container so
  // routes/tests can call certify() / compare() without rewiring.
  const replayDivergenceDetector = new ReplayDivergenceDetector(
    eventStore,
    persistence.replayCertifications,
    clock
  );

  // ─── Phase 7: Execution Health + Failure Learning ─────────────────────────
  // Singleton-safe: each container builds its own instances, no global state.
  // Teardown-safe: these stores hold only bounded per-execution data and have
  // no timers, sockets, or background loops to stop in close(). Memory growth
  // is intrinsic to the data they index and is the same growth profile as
  // failureSignals — operators rotate by replacing the container or migrating
  // to Postgres-backed adapters in a later phase.
  // D3 — when a Postgres pool is wired, all four analytics stores move
  // onto Postgres so the aggregates survive worker restart, OOM, and
  // rolling deploys. Migration 0006_analytics_durability.sql creates the
  // backing tables and indexes. In-memory adapters remain in place for
  // dev/test wiring without DATABASE_URL.
  const healthSnapshots: HealthSnapshotStore = persistence.pg
    ? new PostgresHealthSnapshotStore(persistence.pg)
    : new InMemoryHealthSnapshotStore();
  const failureSignatures: FailureSignatureStore = persistence.pg
    ? new PostgresFailureSignatureStore(persistence.pg)
    : new InMemoryFailureSignatureStore();
  const anomalyIndex: AnomalyIndex = persistence.pg
    ? new PostgresAnomalyIndex(persistence.pg)
    : new InMemoryAnomalyIndex();
  const replayOutcomes: ReplayOutcomeStore = persistence.pg
    ? new PostgresReplayOutcomeStore(persistence.pg)
    : new InMemoryReplayOutcomeStore();
  const failureLearning = new FailureLearning(failureSignatures, anomalyIndex, replayOutcomes);

  const failureEngine = new FailureIntelligenceEngine(
    eventStore,
    cognitions,
    failureSignals,
    publisher,
    eventFactory,
    clock,
    {
      // Every analyzeExecution() call will now compute a health snapshot,
      // index anomalies, and cluster signals via these collaborators.
      healthStore: healthSnapshots,
      learning: failureLearning,
      // Engine's internal try/catch swallows learning-layer failures so the
      // analyzer pipeline is never blocked. The logger surfaces those failures
      // for operator visibility without changing the isolation boundary.
      logger
    }
  );

  const checkpointManager = new CheckpointManager(
    cognitions,
    snapshots,
    branches,
    failureSignals,
    replayEngine,
    failureEngine,
    publisher,
    eventFactory,
    clock
  );

  // Phase 7: terminal-outcome recorder. Bridges the cognition lifecycle into
  // the FailureLearning module so compareOutcomes() / computeRepairEffectiveness()
  // see real data without operators needing to call recordOutcome() by hand.
  // The recorder is failure-safe: every learning-side write is isolated so a
  // storage or event-publish error cannot break execution completion.
  const replayOutcomeRecorder = new ReplayOutcomeRecorder(
    failureLearning,
    publisher,
    eventFactory,
    clock,
    logger
  );

  const cognitionCommands = new CognitionCommands(
    cognitionOrchestrator,
    replayEngine,
    failureEngine,
    replayOutcomeRecorder
  );
  const cognitionQueries = new CognitionQueries(cognitions, lineage, branches, failureSignals);
  const replayQueries = new ReplayQueries(replayEngine, replaySessions, snapshots, cognitions);
  const memoryInfluence = new MemoryInfluenceQueries(cognitions, memory);

  // ─── Phase 4: Operator Query Surface ──────────────────────────────────────
  const observabilityQueriesForOperator = new ObservabilityQueries(agents, executions, eventStore);
  const operatorQueries = new OperatorQueries(
    eventStore,
    executions,
    workers,
    leases,
    checkpoints,
    deadLetterQueue,
    scheduler,
    observabilityQueriesForOperator,
    config.TRACE_LINEAGE_SCAN_LIMIT
  );

  logger.info(
    {
      persistenceDriver: persistence.driver,
      eventStoreDriver: config.EVENT_STORE_DRIVER,
      eventBusDriver: config.EVENT_BUS_DRIVER,
      runtimeMode: config.RUNTIME_MODE,
      workerCapacity: config.WORKER_CAPACITY,
      // Phase 1 observability: show which AI backend is active.
      modelProvider: config.MODEL_PROVIDER,
      modelName: config.MODEL_NAME ?? "(provider default)",
      toolWebSearch: config.BRAVE_API_KEY ? "brave" : "duckduckgo",
      toolCodeExecute: `vm-sandbox/${config.TOOL_CODE_EXECUTE_TIMEOUT_MS}ms`
    },
    "runtime container ready"
  );

  // Outbox dispatcher is a Postgres-only construct: it drains the
  // `event_outbox` table and re-publishes rows that were committed but not
  // yet seen by the in-memory event bus (e.g., a crash between the txn
  // commit and the bus publish). With memory-mode persistence there is no
  // outbox table, so the previous fallback `new OutboxDispatcher(publisher,
  // eventBus)` was constructed but never ticked — it existed as a dead
  // field on the container. Leave it undefined in memory mode.
  let outboxDispatcher: OutboxDispatcher | undefined;
  let outboxTimer: NodeJS.Timeout | undefined;

  const isOutboxEnabled =
    config.ENABLE_OUTBOX_DISPATCH !== false &&
    config.PERSISTENCE_DRIVER === "postgres" &&
    persistence.pg !== undefined;

  if (isOutboxEnabled && persistence.pg) {
    const dispatcher = new OutboxDispatcher(
      publisher,
      eventBus,
      persistence.pg,
      logger
    );
    outboxDispatcher = dispatcher;
    // Poll every 1 second in Postgres mode to drain the outbox
    outboxTimer = setInterval(() => {
      dispatcher.tick().catch((err) => {
        logger.error({ err }, "OutboxDispatcher polling tick failed");
      });
    }, 1000);
    outboxTimer.unref?.();
    logger.info("[outbox] database-backed Event Outbox Dispatcher loop started");
  }

  return {
    config,
    metrics,
    operatorQueries,
    clock,
    runtime,
    agents,
    executions,
    memory,
    eventStore,
    eventBus,
    outboxDispatcher,
    workers,
    leases,
    checkpoints,
    workerLifecycle,
    scheduler,
    recoveryLoop,
    jobQueue,
    workerLoop,
    role,
    clusterQueries,
    streamBus,
    workerId,
    deadLetterQueue,
    ollama,
    liveEngine,
    liveBroadcaster,
    cognitions,
    lineage,
    snapshots,
    replaySessions,
    branches,
    failureSignals,
    cognitionOrchestrator,
    replayEngine,
    replayDivergenceDetector,
    failureEngine,
    healthSnapshots,
    failureSignatures,
    anomalyIndex,
    replayOutcomes,
    failureLearning,
    checkpointManager,
    cognitionCommands,
    cognitionQueries,
    replayQueries,
    memoryInfluence,
    memoryTrustEngine,
    persistence,
    // Sprint Stabilization — tenant guard is now constructed from the
    // SHARED persistence pool when available. The previous code
    // unconditionally returned a permissive guard and relied on app.ts to
    // overwrite it, which meant any code path (background loops, tests,
    // direct container consumers) that read container.tenantGuard before
    // app.ts ran got the permissive guard silently. With Postgres wired,
    // we build the strict guard here; the permissive guard is only ever
    // produced for development without DATABASE_URL.
    tenantGuard: buildTenantGuard({ persistence, config, logger }),
    reliability,
    async close() {
      await reliability.close();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (pgPoolStatsTimer) clearInterval(pgPoolStatsTimer);
      if (outboxTimer) clearInterval(outboxTimer);
      if (role !== "api") {
        recoveryLoop.stop();
        workerLifecycle.stop();
        scheduler.stop(); // also stops leaseHeartbeatWorker via scheduler.stop()
        if (workerLoop) await workerLoop.stop();
        // Mark this worker STOPPED in the registry so the recovery loop on
        // sibling processes reclaims its leases promptly rather than waiting
        // for the heartbeat TTL to expire.
        try {
          await workerLifecycle.setStatus(workerId, "STOPPED");
        } catch {
          // best-effort during shutdown
        }
      }
      try {
        await jobQueue.close();
      } catch {
        // best-effort during shutdown
      }
      if ("close" in eventBus && typeof eventBus.close === "function") {
        await (eventBus as { close: () => Promise<void> }).close();
      }
      await persistence.close();
    }
  };
}

function estimateCpuLoad(): number {
  const usage = process.cpuUsage();
  // Coarse heuristic; replaced with proper sampling in distributed worker container.
  return Number(((usage.user + usage.system) / 1_000_000 % 100).toFixed(2));
}

function estimateMemoryLoad(): number {
  const usage = process.memoryUsage();
  return Number(((usage.heapUsed / usage.heapTotal) * 100).toFixed(2));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${stage} timed out after ${ms}ms`)),
          ms
        );
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Sprint Stabilization — tenant guard construction policy.
 *
 *   Production / staging / STRICT_PROD :
 *     Must have a Postgres pool. Otherwise the container is refusing to
 *     boot a process that would silently accept cross-tenant requests.
 *
 *   Development / test with Postgres pool :
 *     Strict guard wired against the shared pool. Same enforcement code
 *     path as production — `permitWhenNotFound: false`.
 *
 *   Development / test without Postgres pool :
 *     Permissive guard. The in-memory persistence path has no tenant_id
 *     columns so resolve* would always 404 — the guard would deny every
 *     request and break every existing unit test. The permissive guard
 *     is the only acceptable answer in that mode and a CRITICAL log line
 *     records the fact so it cannot escape attention during operator boot.
 */
function buildTenantGuard(args: {
  persistence: PersistenceLayer;
  config: AppConfig;
  logger: pino.Logger;
}): TenantGuard {
  const { persistence, config, logger } = args;
  const isStrict =
    config.NODE_ENV === "production" ||
    config.NODE_ENV === "staging" ||
    config.STRICT_PROD === true;

  if (persistence.pg) {
    logger.info(
      { mode: "strict-postgres", env: config.NODE_ENV },
      "[security] tenant guard wired against shared Postgres pool"
    );
    return new TenantGuard({ db: persistence.pg, permitWhenNotFound: false });
  }

  if (isStrict) {
    throw new RuntimeStartupError(
      "tenant-guard",
      "Strict environment requires a Postgres pool for the tenant guard. " +
        "Refusing to construct a permissive guard in production/staging/STRICT_PROD."
    );
  }

  logger.warn(
    {
      mode: "permissive-dev",
      env: config.NODE_ENV,
      criticalAlert: true,
      consequences: [
        "Cross-tenant ownership checks are NOT enforced.",
        "Every assertOwns* call returns successfully regardless of caller tenant.",
        "Acceptable ONLY for in-memory development/test runs."
      ]
    },
    "[security][CRITICAL] tenant guard constructed in PERMISSIVE mode — no DATABASE_URL"
  );
  return createPermissiveTenantGuard();
}
