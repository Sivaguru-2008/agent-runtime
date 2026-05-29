# Canonical Retry Coordination & Distributed Recovery Semantics

This specification documents the canonical retry-coordination layer that
serializes every re-attempt of an execution — transient-failure retries,
crash/lease-loss recovery, and replay re-drives — so that **duplicate retries,
recovery races, and concurrent execution corruption are unrepresentable rather
than merely unlikely**.

Authoritative sources:

- State machine — `apps/api/src/runtime/retry/retryState.ts`
- Coordinator + store port — `apps/api/src/runtime/retry/retryCoordinator.ts`
- In-memory CAS store — `apps/api/src/runtime/retry/inMemoryRetryStore.ts`
- Invariants `RT1..RT8` — `INVARIANT_REGISTRY` in `apps/api/src/runtime/canonicalSemantics.ts`
- Live wiring — `apps/api/src/application/cluster/workerExecutionLoop.ts`,
  `apps/api/src/application/cluster/distributedScheduler.ts`

Related specs: [retry-legality-matrix.md](./retry-legality-matrix.md),
[recovery-serialization-diagrams.md](./recovery-serialization-diagrams.md),
[distributed-retry-guarantees.md](./distributed-retry-guarantees.md),
[distributed-ownership-protocol.md](./distributed-ownership-protocol.md),
[fence-state-machine.md](./fence-state-machine.md),
[recovery-matrix.md](./recovery-matrix.md).

---

## 1. Where retry coordination sits

The runtime has three nested correctness layers, each with its own state machine
validated at module load:

| Layer | Question it answers | State machine | Spec |
| :--- | :--- | :--- | :--- |
| **Execution** | Where is the execution in its overall lifecycle? | `canonicalSemantics.ts` | [execution-semantics-reference](./execution-semantics-reference.md) |
| **Retry coordination** (this doc) | *Who* may re-drive the execution after a failure, *when*, and under what restrictions? | `retry/retryState.ts` | this doc |
| **Fence** | Has *this one* external side effect committed exactly once? | `fence/fenceState.ts` | [fence-state-machine](./fence-state-machine.md) |

A "retry coordination" is the durable-ish record, keyed by `executionId`, that
every re-attempt must pass through. It is **the single chokepoint** for retry
ownership, single-flight admission, recovery serialization, replay isolation,
ambiguity gating, backpressure, throttling, and arbitration.

The coordinator is a **policy + canonical-state layer**. Cross-process ownership
serialization is still enforced *durably* by the lease store's monotonic-epoch
CAS (`acquire` / `takeoverRecovery` / `validateFencing`; see
[distributed-ownership-protocol](./distributed-ownership-protocol.md)). The
coordinator adds, on top of that durable substrate: in-process single-flight,
arbitration, recovery throttling, retry backpressure, the storm guard, and the
canonical retry state model with its `RT1..RT8` assertions.

---

## 2. Two ownership counters

Keeping two ownership dimensions separate is what makes the guarantees decidable.

| Counter | Source | Role | Invariants |
| :--- | :--- | :--- | :--- |
| **`attempt`** | the queue envelope's `job.attempt` (logical) | **single-flight key**: two deliveries of the same logical attempt are the *same* retry and must dedupe | RT1, RT5 |
| **`ownerEpoch`** | the durable lease epoch `lease.attempt` | **execution-ownership key**: strictly monotonic per execution by construction of the lease store, so two workers can never hold the same epoch | RT2, RT8 |

A claim at `ownerEpoch = a` against a live executing owner at `ownerEpoch = o`:

- `a < o` → the claimant is a **zombie**; it surrenders (`STALE`).
- `a == o`, different worker → **impossible** under a monotonic lease store;
  the coordinator asserts `RT2` to surface the corruption.
- `a > o` → a legitimate **takeover** (failover / recovery); the higher epoch
  restamps ownership.

Admission at `attempt = a` against a live coordination at `attempt = o`:

- `a < o` → a late duplicate; **DEDUPED** (a newer retry already supersedes).
- `a == o` and state ∈ {SCHEDULED, EXECUTING, RECONCILING} → a duplicate
  scheduler event / queue redelivery; **DEDUPED** (single-flight).
- `a == o` and state ∈ {PENDING, BLOCKED} → **ADMITTED**.
- `a > o` → a genuinely newer attempt; **ADMITTED** by superseding the old one
  (arbitration: newest wins) — unless the current state is RECONCILING, in which
  case **RECONCILE_REQUIRED** (RT7).

---

## 3. Retry states

Six coordination states are required; a seventh absorbing success terminal
(`RETRY_SETTLED`) makes the machine total. See
[recovery-serialization-diagrams](./recovery-serialization-diagrams.md) for the
diagram and [retry-legality-matrix](./retry-legality-matrix.md) for the full
edge table.

| State | Kind | Meaning |
| :--- | :--- | :--- |
| `RETRY_PENDING` | active (entry) | A retry was *requested* (a recoverable failure occurred) but the coordinator has not admitted it. No owner minted, nothing enqueued. |
| `RETRY_SCHEDULED` | active, exclusive | Admitted: a single-flight owner+attempt was minted, a backoff assigned, work (re-)enqueued. |
| `RETRY_EXECUTING` | active, exclusive | A worker claimed sole execution ownership (lease acquired, fence validated) and is re-driving. |
| `RETRY_BLOCKED` | active | Cannot proceed now: backpressure/arbitration denied, a storm shed it, or a lease/slot race was lost. Parked, not abandoned. |
| `RETRY_RECONCILING` | active, exclusive | Gated behind reconciliation of an ambiguous side effect. No re-dispatch until the true external outcome is verified. |
| `RETRY_ABORTED` | terminal | Abandoned: non-retryable, exhausted (→ DLQ), superseded/cancelled, reconciliation gave up, or a zombie surrendered. Absorbing. |
| `RETRY_SETTLED` | terminal | The execution reached a durable terminal outcome; no further retry will be coordinated. Absorbing. |

`RETRY_PENDING` is the restartable re-entry hub. Both terminals are reachable
from every active state, because the *execution's* terminal outcome is
authoritative over the coordination's local view.

---

## 4. Canonical semantics (the six definitions)

### 4.1 Retry ownership

Ownership of execution is exclusive and keyed on the durable lease epoch
(`ownerEpoch`). `RetryCoordinator.claimExecution` drives a coordination to
`RETRY_EXECUTING` only after the fence/lease validates (RT8) and only if the
claimant's epoch is `>=` the live owner's (RT2). A strictly-higher epoch takes
over; a strictly-lower epoch is a zombie and surrenders. The worker loop calls
`claimExecution` immediately after lease acquisition and **surrenders the job
(ack + release, no re-delivery)** on any non-`OWNED` outcome.

### 4.2 Retry deduplication (single-flight)

`RetryCoordinator.requestRetry` is the admission gate. At most one active
coordination exists per execution. Concurrent or repeated requests for the same
logical `attempt` resolve to exactly one `ADMITTED`; all others are `DEDUPED`.
This is what defeats **duplicate scheduler events** and **queue redelivery
races**: N concurrent deliveries of one logical retry produce one re-enqueue.

### 4.3 Recovery serialization

`RetryCoordinator.requestRecovery` admits at most one recovery coordinator per
execution (an equal-or-newer recovery epoch already owning ⇒ `ALREADY_OWNED`)
and bounds the number of concurrent recoveries process-wide via a throttle slot
(`THROTTLED`). The scheduler's recovery sweep calls it before
`takeoverRecovery`; the durable `takeoverRecovery` CAS picks the single
cross-process winner, and the coordinator adds throttling + the canonical state.

### 4.4 Replay retry rules (isolation)

A replay re-drive is coordinated in `mode: "replay"`. A replay coordination and a
recovery coordination for the same execution are **mutually exclusive** (RT4):
requesting recovery over an active replay (or a replay retry over an active
recovery) is rejected/asserted. Replay executions are themselves separate
executions (`parentExecutionId` set) with their own lease key space (see
`RP3` in [distributed-ownership-protocol](./distributed-ownership-protocol.md)),
so live and replay ownership never collide.

### 4.5 Ambiguity retry restrictions

A failure classified `AMBIGUOUS_EXTERNAL_COMMIT` or `TOOL_NON_IDEMPOTENT` may
**not** be retried directly. `requestRetry` routes it to `RETRY_RECONCILING`
(decision `RECONCILE_REQUIRED`) and refuses to let any newer attempt supersede a
reconciling coordination (RT7). Only `resolveReconciliation` can leave that
state: `NOT_COMMITTED → RETRY_PENDING` (safe to retry), `COMMITTED →
RETRY_SETTLED` (the effect stands), `ABANDONED → RETRY_ABORTED` (human/DLQ). This
mirrors the fence-layer S3/F6 reconciliation contract at the retry tier.

### 4.6 Concurrent retry prevention

The combination of single-flight admission (RT1), exclusive epoch-keyed
ownership (RT2), and the legal-only transition table (RT5) means: at most one
retry is admitted per logical attempt, at most one worker may be `RETRY_EXECUTING`
at a time, and a stale attempt or epoch can never drive execution. The
in-memory store realises each `cas`/`open` as a synchronous critical section (no
`await` between read and write), the faithful in-process analogue of the
Postgres CTE-under-row-lock.

---

## 5. Introduced mechanisms

| Mechanism | Where | Behaviour |
| :--- | :--- | :--- |
| **Single-flight retry coordination** | `requestRetry` + store `open`/`cas` | One coordination per execution; duplicates DEDUPED. |
| **Recovery throttling** | `requestRecovery` + `recoverySlots` semaphore | Ceiling of `maxConcurrentRecoveries` concurrent recovery sweeps; over-limit ⇒ `THROTTLED`. The ceiling check and the slot reserve are one synchronous critical section (no leak under bursts). |
| **Retry backpressure** | `requestRetry` `maxInFlightRetries` | When too many coordinations are SCHEDULED/EXECUTING, new retries are `BLOCKED` and re-enqueued with an *extended* backoff — shed by delay, never dropped. |
| **Retry arbitration** | `requestRetry` attempt comparison | When attempts contend, the strictly-newer attempt wins and supersedes; equal/older dedupe. Deterministic, monotonic. |
| **Storm guard** | `chargeStorm` (per-execution + global sliding windows) | Soft breach ⇒ shed (`BLOCKED`); hard breach ⇒ assert `RT6`. Charged once per external `requestRetry`. |

Defaults (`DEFAULT_RETRY_COORDINATOR_CONFIG`): `maxConcurrentRecoveries = 8`,
`maxInFlightRetries = 1024`, per-execution storm window `60 s` with soft `8` /
hard `64`, global window `1 s` soft `2000`, shed backoff `× 4` floored at `1 s`.

---

## 6. Live enforcement points

| Site | Call | Enforces |
| :--- | :--- | :--- |
| `WorkerExecutionLoop.executeJobInner` (after lease acquire, before engine) | `claimExecution` | RT2, RT8 — surrenders on non-OWNED |
| `WorkerExecutionLoop.executeJobInner` (success) | `settle` | terminalizes the coordination |
| `WorkerExecutionLoop.executeJobInner` (ambiguous) | `enterReconciliation` | RT7 quarantine |
| `WorkerExecutionLoop.executeJobInner` (transient error) | `requestRetry` | RT1/RT5/RT6/RT7 + backpressure/arbitration; gates the re-enqueue |
| `WorkerExecutionLoop.poisonPill` | `abort` | terminalizes on dead-letter |
| `DistributedScheduler.recoverOne` (before `takeoverRecovery`) | `requestRecovery` | RT3, RT4 — skips on non-ADMITTED, releases slot in `finally` |

The happy path is unchanged: a first attempt claims OWNED, runs, settles; a
single transient failure is ADMITTED and re-enqueued exactly as before. The
coordinator only *changes* behaviour on the defect cases it exists to prevent.

---

## 7. Failure taxonomy linkage

Retry legality also derives from the failure taxonomy in
[recovery-matrix.md](./recovery-matrix.md). `requestRetry` consults
`RECOVERY_SEMANTICS_MAP`:

- `retryable === false && replayable === false` ⇒ `ABORTED` (dead-letter).
- `AMBIGUOUS_EXTERNAL_COMMIT` / `TOOL_NON_IDEMPOTENT` ⇒ `RECONCILE_REQUIRED`.
- otherwise ⇒ subject to single-flight / storm / backpressure as above.

This is the same policy the worker loop's pre-existing `assertRetryAllowed`
enforced; the coordinator subsumes and extends it with single-flight, the
canonical state, and the storm/backpressure layers.
