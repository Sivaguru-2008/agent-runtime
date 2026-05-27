# Chaos Engineering & Survivability Certification

This document describes the chaos-injection harness and the survivability
certification process. The harness is opt-in, dev/test only, and integrates
with the existing reliability primitives — it never runs in production.

## Architecture

The chaos layer lives in `apps/api/src/infrastructure/chaos/`:

| File | Responsibility |
| --- | --- |
| `chaosConfig.ts` | Env gating. Returns `false` for `NODE_ENV ∈ {production, staging}` unconditionally. |
| `chaosController.ts` | Process-singleton registry of active scenarios + event recorder. |
| `redisChaosProxy.ts` | JS `Proxy` over an ioredis client. Injects latency, disconnects, pubsub drops, ack-path delays. |
| `pgChaosProxy.ts` | Wrapper around `PgClient`. Injects transient disconnects, statement timeouts, pool starvation. |
| `index.ts` | Public re-exports. |

The proxies are layered on at the **factory** level — see
`infrastructure/reliability/redisClient.ts` and
`infrastructure/persistence/postgres/pgClient.ts`. The public client APIs are
unchanged; chaos is purely additive.

### Safety Invariants

1. **Strict-prod refusal.** `assertChaosSafeEnvironment()` throws if invoked
   under `NODE_ENV=production` or `NODE_ENV=staging`. Both the controller and
   the proxy constructors call this defensively.
2. **Inert by default.** Without `CHAOS_ENABLED=true`, the factory wrappers
   are identity functions — the proxy is never constructed.
3. **No fabricated responses.** Faults only add delay or short-circuit
   selected commands. They never invent return values that the underlying
   driver would not have produced.

## Running the Suite

```bash
# Bring up the dependencies the chaos suite needs.
docker compose up -d postgres redis

# Set CHAOS-mode env. The chaos vitest config does this automatically, but
# explicit invocation is shown for clarity.
export CHAOS_ENABLED=true
export NODE_ENV=test

# Optional: point at an externally provisioned PG/Redis instead of
# spinning testcontainers.
# export CHAOS_DATABASE_URL=postgres://...
# export CHAOS_REDIS_URL=redis://...

# Run a single phase
cd apps/api
npm run chaos:phase1
npm run chaos:phase2
# ...

# Run everything + emit the certification report
npm run chaos:run
```

The harness skips cleanly if neither testcontainers nor `CHAOS_*_URL` envs
are available — no failed runs, just a single skip explanation per suite.

## Scenarios per Phase

### Phase 1 — Redis failure injection
1.1 Latency spikes &nbsp;·&nbsp; 1.2 Disconnect storms &nbsp;·&nbsp; 1.3 Partial pub/sub failure &nbsp;·&nbsp; 1.4 Delayed acks &nbsp;·&nbsp; 1.5 Recovery after reconnect

### Phase 2 — Postgres failure injection
2.1 Transient disconnects &nbsp;·&nbsp; 2.2 Statement-timeout exhaustion &nbsp;·&nbsp; 2.3 Pool starvation &nbsp;·&nbsp; 2.4 Recovery after clear &nbsp;·&nbsp; 2.5 No leaked clients

### Phase 3 — Worker survivability
3.1 Kill mid-execution &nbsp;·&nbsp; 3.2 Lease fencing &nbsp;·&nbsp; 3.3 Poison-pill → DLQ &nbsp;·&nbsp; 3.4 Replay recovery &nbsp;·&nbsp; 3.5 No duplicated commits

### Phase 4 — SSE failure
4.1 Reconnect storms &nbsp;·&nbsp; 4.2 Dropped token streams &nbsp;·&nbsp; 4.3 Partial replay buffer &nbsp;·&nbsp; 4.4 Dedup correctness &nbsp;·&nbsp; 4.5 Eventual consistency

### Phase 5 — Load shedding
5.1 Queue saturation &nbsp;·&nbsp; 5.2 503 response shape &nbsp;·&nbsp; 5.3 Retry-After bounds &nbsp;·&nbsp; 5.4 No cascading crash &nbsp;·&nbsp; 5.5 Tenant fairness (FIFO baseline)

### Phase 6 — Certification
Aggregates phase results into `docs/chaos-certification-report.{json,md}`.

## Writing New Scenarios

A new scenario should:

1. Use the real production class (no mocks).
2. Acquire a controller via `chaosController()`, register one or more
   `ChaosScenario`s with `times` set to bound the fault budget.
3. Drive the system under test.
4. Compute its pass/fail with `evaluateThresholds({...})` and persist
   via `recordPhase("phaseN.X.name", result)`.
5. Add the scenario key to `EXPECTED_SCENARIOS` in
   `test/chaos/phase6-certification.chaos.test.ts` so it counts toward the
   readiness score.

## Boundaries

The chaos layer deliberately does NOT:

- Replace `test/integration/postgres/chaos.integration.test.ts`, which
  exercises real container restarts and concurrent reclaim races.
- Run in production. The env gate is enforced in three places.
- Inject faults at the HTTP-edge layer — that is what the existing
  `circuitBreaker` / `loadShedder` integration tests cover.
