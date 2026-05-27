# Distributed Execution Topology

Status: implemented · Owner: runtime
Replaces the prior “single-process distributed simulation” in which the API
process embedded its own worker loop and the scheduler queue lived inside the
same Node.js heap as the HTTP handlers.

## 1. Topology Map

```
                ┌──────────────────────────────┐
                │        Client / SDK          │
                └──────────────┬───────────────┘
                               │  HTTPS (REST + SSE)
                               ▼
                ┌──────────────────────────────┐
                │      API process (N×)        │
                │  RUNTIME_ROLE=api            │
                │                              │
                │  - Fastify (auth, RL, audit) │
                │  - AgentRuntime              │
                │  - Backpressure check        │
                │  - executions.save(QUEUED)   │
                │  - publish TASK_SCHEDULED    │
                │  - jobQueue.enqueue(...)     │
                │  - SSE stream (event bus)    │
                │                              │
                │  ✗ No ExecutionEngine        │
                │  ✗ No lease ownership        │
                │  ✗ No heartbeat              │
                │  ✗ No recovery loop          │
                └──────┬─────────────┬─────────┘
                       │             │
   enqueue / depth     │             │   publish / subscribe
   (Redis LIST + ZSET) │             │   (Redis Streams)
                       ▼             ▼
                ┌──────────────────────────────────────┐
                │  Redis (queue + ephemeral fanout)    │
                │   ready / delayed / inflight ZSETs   │
                │   stream agent-runtime.events        │
                └──────┬───────────────┬───────────────┘
                       │               │
                       │               │
                       ▼               ▼
        ┌──────────────────────────────────────┐
        │       Worker process (M×)            │
        │  RUNTIME_ROLE=worker                 │
        │                                      │
        │  - WorkerExecutionLoop               │
        │  - LeaseStore.acquire (atomic)       │
        │  - ExecutionEngine.execute           │
        │  - LeaseHeartbeatWorker (renews)     │
        │  - WorkerLifecycleService            │
        │     (register / heartbeat / sweep)   │
        │  - BackgroundRecoveryLoop            │
        │     (reclaim crashed siblings)       │
        │  - DLQ on poison pill                │
        │  - Retry with exponential backoff    │
        │                                      │
        │  ✗ No HTTP server                    │
        │  ✗ No auth / rate limit / audit      │
        └──────────────┬───────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────┐
        │             Postgres                 │
        │  events / executions / agents /      │
        │  cognitions / lineage / branches /   │
        │  workers / leases / checkpoints /    │
        │  dead_letter_queue                   │
        └──────────────────────────────────────┘
```

The API process and the worker process share a Postgres cluster and a Redis
cluster but exchange work *only* through the `ExecutionJobQueue` interface
on Redis. There is no in-API execution path, no shared in-memory queue, no
back-channel.

## 2. Execution Lifecycle Map

```
┌──────────────┐
│ POST /tasks  │
│  (API)       │
└──────┬───────┘
       │
       ▼
[ AgentRuntime ]
  • backpressure check (queue.depth ≥ threshold → 503)
  • executions.save(QUEUED)
  • publish TASK_SCHEDULED
  • jobQueue.enqueue(ExecutionJob)        ── ack to client (HTTP 202) ──►
       │
       ▼
[ Redis ready LIST ]
       │   BRPOP (worker pulls)
       ▼
[ WorkerExecutionLoop ]
  • leases.acquire(executionId, workerId, ttl)   (atomic, returns lease.attempt)
  • if lease.attempt > maxAttempts → DLQ + EXECUTION_DEAD_LETTERED
  • publish EXECUTION_LEASED
  • heartbeatWorker.track(executionId, lease)
  • engine.execute({ ..., validateLease })
       │
       ▼
[ ExecutionEngine ]
  • EXECUTION_STARTED → checkpoint INITIALIZED
  • PLANNING step → checkpoint PLANNING
  • MEMORY_RETRIEVAL → checkpoint MEMORY_RETRIEVAL
  • TOOL_CALL (per enabled tool)
  • MODEL_GENERATION → checkpoint MODEL_GENERATION
  • assertFencing(validateLease) ── reclaimed? → throw FencingViolationError
  • executions.save(COMPLETED)
  • EXECUTION_COMPLETED
       │
       ▼
[ WorkerExecutionLoop — post-execute ]
  • heartbeatWorker.untrack
  • leases.release → EXECUTION_LEASE_RELEASED
  • on success     → jobQueue.ack(receiptId)
  • on fence-lost  → jobQueue.ack (winner already executing)
  • on transient   → jobQueue.enqueue({ ...attempt+1, notBefore=now+backoff })
                     + jobQueue.ack(receiptId)
                     + RETRY_TRIGGERED event
  • on attempts exhausted → DLQ + EXECUTION_DEAD_LETTERED
```

## 3. Worker Coordination

### Registration
On boot, each worker calls `WorkerLifecycleService.register({ id, host,
capacity, ... })` which writes a row to `workers` in Postgres and emits
`WORKER_REGISTERED`. Crash-restart is idempotent — the same WORKER_ID
overwrites the previous row. Production should use a unique WORKER_ID per
pod (e.g. `worker-$(hostname)-$$`) so historical activity is auditable.

### Heartbeats and Capability
The container starts a heartbeat timer at `WORKER_HEARTBEAT_TTL_MS / 3`. Each
tick records `cpu / memory / inFlight / queueDepth` into the `workers` row
and emits `WORKER_HEARTBEAT`. The scheduler reads `worker.capacity` per tick
to determine how many jobs to draw from the queue — a worker can be drained
by lowering its capacity dynamically.

### Crash Detection
Two layers detect a dead worker:
1. **Worker registry sweep**: `workerLifecycle.sweep()` marks any worker
   whose `lastHeartbeatAt` is older than `WORKER_HEARTBEAT_TTL_MS` as LOST
   and reclaims its active leases (emits `WORKER_LOST` and
   `EXECUTION_LEASE_RECLAIMED`).
2. **Lease expiry**: `leases.reclaimExpired()` independently catches any
   active lease whose `expiresAt` has passed. Together these are
   belt-and-braces — a worker that loses CPU but keeps Redis open still has
   its leases reclaimed once heartbeat ages out.

### Recovery
`BackgroundRecoveryLoop.tick()` runs on every worker on a fixed interval.
It calls `sweep()` then `scheduler.recover()`. With the new topology,
`recover()` re-enqueues reclaimed executions **onto the shared
`ExecutionJobQueue`** (not the in-process scheduler array). Any healthy
worker — including a freshly-started one — picks them up.

Because the recovery loop runs on every worker and `reclaimExpired` uses
`FOR UPDATE SKIP LOCKED` in the Postgres lease store, two workers racing
the recovery loop converge without double-processing the same lease.

### Graceful Shutdown
Workers handle SIGTERM by:
1. Stopping the heartbeat and lifecycle sweep.
2. Refusing to pull new messages from the queue (the loop sets
   `stopRequested=true`).
3. Letting in-flight executions complete normally, with leases renewed by
   the heartbeat worker until they finalise.
4. Releasing leases, ack-ing successful jobs / nack-ing without backoff
   any partially-consumed messages so siblings claim them.
5. Marking the worker `STOPPED` in the registry.
6. Closing the queue and persistence connections.

### Fencing
Every lease acquisition increments `lease.attempt` atomically in Postgres.
The ExecutionEngine takes that value as a fencing token and re-validates it
immediately before its final result write via
`LeaseStore.validateFencing(executionId, workerId, token)`. If the token no
longer matches (lease reclaimed and re-acquired by a sibling at attempt+1),
the engine aborts with `FencingViolationError`. The stale worker emits
`EXECUTION_FENCE_VIOLATED` and drops out without overwriting the winner's
result.

This makes execution-ownership **atomic across the cluster**: only one
worker holds a valid fencing token at any instant; concurrent workers fail
their fencing check and stop voluntarily.

## 4. Reliability Surfaces

| Surface | Mechanism | Config |
|---|---|---|
| Retry policy | Exponential backoff carried on the job envelope; re-enqueued with `notBefore = now + base · 2^(attempt-1)` capped at `RETRY_BACKOFF_MAX_MS`. | `RETRY_BACKOFF_BASE_MS`, `RETRY_BACKOFF_MAX_MS`, `POISON_PILL_MAX_ATTEMPTS` |
| Dead-letter queue | Postgres-backed `DeadLetterStore`. Once `lease.attempt > maxAttempts`, the execution is pushed to DLQ and never re-enqueued without operator action. | `POISON_PILL_MAX_ATTEMPTS` |
| Backpressure | `AgentRuntime.runTask` queries `queue.depth()` before persisting; rejects with `BackpressureError → HTTP 503` when over threshold. | `QUEUE_BACKPRESSURE_THRESHOLD` |
| Visibility timeout | The Redis queue keeps an `inflight` ZSET scored by deadline. A consumer that fails to ack within `JOB_QUEUE_VISIBILITY_MS` has its message returned to `ready`. | `JOB_QUEUE_VISIBILITY_MS` (must ≥ `EXECUTION_LEASE_TTL_MS`) |
| Idempotency | `jobQueue.enqueue` is NX on `jobId`. Duplicate enqueue is a no-op. Combined with lease atomicity at execute time, this prevents duplicate execution. | n/a |

## 5. Configuration Reference

```
# API process (one or more replicas)
RUNTIME_MODE=distributed
RUNTIME_ROLE=api
JOB_QUEUE_DRIVER=redis
EVENT_BUS_DRIVER=redis-streams
PERSISTENCE_DRIVER=postgres
REDIS_URL=redis://...
DATABASE_URL=postgres://...
QUEUE_BACKPRESSURE_THRESHOLD=2000

# Worker process (one or more replicas, scaled independently)
RUNTIME_MODE=distributed
RUNTIME_ROLE=worker
JOB_QUEUE_DRIVER=redis
EVENT_BUS_DRIVER=redis-streams
PERSISTENCE_DRIVER=postgres
REDIS_URL=redis://...
DATABASE_URL=postgres://...
WORKER_ID=worker-$(hostname)-$$
WORKER_CAPACITY=4
EXECUTION_LEASE_TTL_MS=30000
JOB_QUEUE_VISIBILITY_MS=45000   # must be ≥ lease TTL
POISON_PILL_MAX_ATTEMPTS=3
RETRY_BACKOFF_BASE_MS=500
RETRY_BACKOFF_MAX_MS=60000
```

Launch:
```
node dist/server.js          # API replicas
node dist/workerProcess.js   # worker replicas
```

The `loadConfig` validator rejects mismatched combinations (e.g.,
`RUNTIME_MODE=distributed` with `JOB_QUEUE_DRIVER=memory`, or
`RUNTIME_MODE=distributed` with `RUNTIME_ROLE=combined`) at boot.

## 6. Remaining Distributed Risks

These are explicit known gaps left for follow-on work — the system is no
longer a simulation, but it is not yet hardened against every distributed
failure mode.

1. **Redis as single-master queue.** The current `RedisExecutionJobQueue`
   uses `LIST` and `ZSET` primitives directly. A Redis primary failover
   loses recent entries that hadn't replicated. Mitigation: pair with
   sentinel/cluster; for stronger guarantees move to Postgres-backed queue
   table or Redis Streams with consumer groups + AOF=`always`.

2. **Snapshot drift on the job envelope.** `ExecutionJob` carries an
   `agentSnapshot` and `executionSnapshot` for low-latency dispatch. If
   the agent row is mutated (e.g., tool config edit) *after* enqueue and
   *before* worker pickup, the worker still executes against the old
   snapshot until the next re-read inside the engine. Acceptable for the
   current use-case but documented for future tightening.

3. **No quorum on lease ownership across regions.** Lease atomicity is
   single-Postgres. A multi-region deployment with cross-region replicas
   would need a quorum-aware lease primitive (e.g. via etcd) to prevent
   a region split-brain from issuing duplicate fencing tokens.

4. **DLQ replay is operator-driven.** Once an execution lands in the DLQ
   it is *never* automatically re-enqueued. There is no "replay-from-DLQ"
   admin endpoint yet. Operators currently inspect via SQL.

5. **Cross-process clock skew.** Visibility timeout, lease TTL, and retry
   backoff are all wall-clock based. Significant clock skew between API
   and worker pods can produce spurious early reclaims. Mitigation: NTP
   on every node; keep `JOB_QUEUE_VISIBILITY_MS` ≥ 1.5× `EXECUTION_LEASE_TTL_MS`.

6. **Worker capacity is advisory, not enforced.** A worker reports its
   `capacity` but nothing prevents it from over-pulling if the loop
   schedules multiple jobs faster than the engine can ack. The current
   loop is bounded by `inFlight < capacity`, but a misconfigured deploy
   that ignores the heartbeat-reported value would not be caught here.

7. **Live event bus (RedisStreamsEventBus) is best-effort ephemeral.**
   The ephemeral pub/sub lane is used for SSE responsiveness; only
   high-priority events go to the durable stream. A client reconnecting
   after a low-priority event was emitted to the ephemeral lane only
   will not see it on replay. Acceptable for human-facing dashboards;
   not acceptable for audit reconstruction. Mitigation already in place:
   the Postgres event store is the audit source of truth.
