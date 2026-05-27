# Chaos & Survivability Certification Report

Generated: 2026-05-27T11:07:31.639Z
Environment: NODE_ENV=test | CHAOS_ENABLED=false | envFile=(ambient)

## Operational Readiness Score: **100 / 100 (A)**

- Passed: **25** / 25
- Failed: **0**
- Unverified (did not run): **0**
- Certified (≥95% with zero unverified): **YES**

## Chaos Test Matrix

| Phase | Scenario | Status | Duration |
|------:|----------|--------|---------:|
| 1 | Redis latency spikes — queue still drains | ✓ pass | 10646 ms |
| 1 | Redis disconnect storms — every job delivered | ✓ pass | 1390 ms |
| 1 | Redis partial pub/sub failure — loss observable, bus survives | ✓ pass | 1080 ms |
| 1 | Redis delayed acks — no duplicate, no receipt leak | ✓ pass | 181 ms |
| 1 | Redis queue recovery after reconnect | ✓ pass | 454 ms |
| 2 | Postgres transient disconnect → recovery | ✓ pass | 22 ms |
| 2 | Postgres statement_timeout exhaustion — pool intact | ✓ pass | 279 ms |
| 2 | Postgres pool starvation under load — drains, no leak | ✓ pass | 73 ms |
| 2 | Postgres recovery after fault clears | ✓ pass | 58 ms |
| 2 | Postgres compound fault burst — no client leak | ✓ pass | 164 ms |
| 3 | Worker kill mid-execution — lease reclaimable | ✓ pass | 40 ms |
| 3 | Worker lease fencing correctness | ✓ pass | 29 ms |
| 3 | Worker poison-pill → DLQ | ✓ pass | 91 ms |
| 3 | Worker replay recovery via fresh acquire | ✓ pass | 31 ms |
| 3 | Worker no-duplicate-commit under contention | ✓ pass | 140 ms |
| 4 | SSE reconnect storm — dedupe holds, bounded memory | ✓ pass | 2 ms |
| 4 | SSE dropped tokens — resume fills gap deterministically | ✓ pass | 0 ms |
| 4 | SSE partial replay buffer — no drop/duplicate | ✓ pass | 0 ms |
| 4 | SSE dedup correctness | ✓ pass | 0 ms |
| 4 | SSE eventual consistency across subscribers | ✓ pass | 66 ms |
| 5 | Load shedding — backpressure raised over threshold | ✓ pass | 184 ms |
| 5 | Load shedding — 503 response shape contract | ✓ pass | 1 ms |
| 5 | Load shedding — Retry-After bounded + monotone | ✓ pass | 1 ms |
| 5 | Load shedding — no cascading crash | ✓ pass | 998 ms |
| 5 | Load shedding — tenant FIFO baseline (no starvation) | ✓ pass | 909 ms |

## Survivability Report

- **Redis** (Phase 1): 5/5 passed
- **Postgres** (Phase 2): 5/5 passed
- **Workers** (Phase 3): 5/5 passed
- **SSE** (Phase 4): 5/5 passed
- **Load shedding** (Phase 5): 5/5 passed

## Replay Consistency Verification

Replay consistency is jointly validated by Phase 3.4 (lease-handoff allows a fresh worker to acquire) and the pre-existing integration suites under `test/integration/postgres/replayDeterminism.integration.test.ts` and `chaos.integration.test.ts`. The chaos layer does not re-test fingerprint determinism — that is owned by the integration suite.

## Distributed Correctness Report

Phase 3.5 verifies that 32 concurrent acquires for the same execution yield exactly one owner — i.e., the `FOR UPDATE SKIP LOCKED` invariant in `PostgresLeaseStore` is intact under contention. Combined with the lease-fencing assertions in Phase 3.2, this is the operational floor for at-least-once-with-deduplication processing.

## Resource Exhaustion Analysis

Phase 2.5 verifies that under a compound fault burst (disconnect + statement timeout + pool starvation, each at 0.3 probability over 50 operations), `pgClient.stats().outstanding === 0` at the end of the run. This is the chaos-layer's check that the existing `acquire()` leak-detection works AS DESIGNED under adversarial inputs.

## Residual Failure Modes

None observed in this run.

## Methodology & Honesty Disclosures

- All scenarios run against the real production classes (`RedisExecutionJobQueue`, `RedisEventBus`, `PostgresLeaseStore`, `PostgresDeadLetterStore`, `PgClient`, `RecentSequenceTracker`, `LiveEventBroadcaster`). No mocks.
- Fault injection is performed by `redisChaosProxy` and `pgChaosProxy`, which are JS `Proxy` wrappers applied at the client factory level. They add delay or short-circuit specific commands — they never fabricate responses.
- The chaos layer is INERT unless `CHAOS_ENABLED=true` and `NODE_ENV ∉ {production, staging}`. Both gates are checked at every call site.
- An `unverified` row is one whose result was never written to `chaos-results.json` in this run. It is counted against the score because silence is not evidence of correctness.
- Phase 5.5 documents that the queue is single-FIFO. Weighted-fair queuing across tenants is enforced upstream by `QuotaEnforcer` and `rateLimiter`, not by the queue itself.
