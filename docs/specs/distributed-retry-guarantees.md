# Distributed Retry Guarantees

The formal guarantees the retry-coordination layer provides, each tied to the
invariant that enforces it, the code that realizes it, and the chaos test that
exercises it. Companion: [retry-coordination.md](./retry-coordination.md),
[retry-legality-matrix.md](./retry-legality-matrix.md).

Authoritative invariant source: `INVARIANT_REGISTRY` (`RT1..RT8`) in
`apps/api/src/runtime/canonicalSemantics.ts`. All assertions route through
`assertRuntimeInvariant`, which records `{ id, category, statement, context }`
on the active OpenTelemetry span before throwing `InvariantViolation`.

---

## Guarantee summary

| ID | Guarantee | Enforced by | Chaos coverage |
| :--- | :--- | :--- | :--- |
| **RT1** | Single-flight: at most one active retry coordination per execution; duplicate retries are deduplicated, never double-driven. | `requestRetry` + store `open`/`cas` | `chaos: queue redelivery + duplicate scheduler events` |
| **RT2** | Exclusive ownership: at most one owner epoch holds `RETRY_EXECUTING` at a time. | `claimExecution` (monotonic ownerEpoch) | `chaos: exclusive execution ownership under takeover races` |
| **RT3** | Recovery serialization + throttle: ≤ 1 recovery coordinator per execution; concurrent recoveries bounded. | `requestRecovery` + slot semaphore | `chaos: concurrent recovery takeover` |
| **RT4** | Replay and recovery never overlap for one execution; replay retries are isolated. | `assertNoReplayRecoveryOverlap` in `requestRetry`/`requestRecovery`/`claimExecution` | `chaos: replay/recovery overlap` |
| **RT5** | Strictly-monotonic attempts; only legal retry-state transitions. | `assertRetryTransition` + attempt checks | `retryStateMachine` + coordinator unit tests |
| **RT6** | Retry storm amplification bounded (per-execution + global windows). | `chargeStorm` soft-shed / hard-assert | `chaos: retry storm amplification` |
| **RT7** | Retries cannot bypass reconciliation. | RECONCILING gate in all three entry points | `chaos: ambiguity retries` |
| **RT8** | Retries cannot bypass fence validation. | `validateFence()` before EXECUTING in `claimExecution` | coordinator unit test `refuses ownership when fence validation fails` |

Tests: `apps/api/test/retry/retryStateMachine.test.ts`,
`apps/api/test/retry/retryCoordinator.test.ts`,
`apps/api/test/retry/retryChaos.test.ts` (47 cases; run under the default
`npm test`, no Docker required).

---

## 1. No duplicate retries (RT1)

**Claim.** For a single logical attempt `a` of execution `E`, at most one
`requestRetry` resolves to `ADMITTED`; all concurrent or repeated requests for
`a` resolve to `DEDUPED`.

**Proof sketch.** A coordination record is keyed by `executionId`. `store.open`
creates a `RETRY_PENDING` record **only** if none is active, returning the live
record otherwise (`opened = false`) — an atomic insert-if-absent. `tryAdmit`
then performs `PENDING → SCHEDULED` (or supersede) as a compare-and-set under
`ownershipKey = attempt`, `monotonic`. In the in-memory store, `cas` reads and
writes with no intervening `await`, so it is a synchronous critical section; in
Postgres it is one CTE under a row lock. The CAS applies at most once for a given
`(state, attempt)`. Therefore N concurrent admissions of `a` yield exactly one
`APPLIED` (ADMITTED); the rest observe `state ∈ {SCHEDULED, EXECUTING,
RECONCILING}` at the same `a` and return `DEDUPED`. ∎

**Consequence.** Duplicate scheduler events and at-least-once queue redeliveries
produce exactly one re-enqueue. The worker loop acks duplicates without
re-enqueueing.

---

## 2. Exclusive execution ownership (RT2)

**Claim.** At most one worker holds `RETRY_EXECUTING` for `E` at any instant, and
ownership moves only in the direction of increasing durable lease epoch.

**Proof sketch.** `claimExecution` keys ownership on `ownerEpoch = lease.attempt`.
The lease store guarantees `attempt` is strictly monotonic per execution
(`acquire`/`takeoverRecovery` increment; rollback throws) — so two distinct
workers can never share an epoch. The drive-to-EXECUTING CAS uses `monotonic`
ownership on `ownerEpoch`: a claim with `a < o` is rejected (`STALE_OWNER` ⇒
`STALE`); `a > o` restamps (takeover); `a == o` with a different worker is
unreachable under monotonicity, and if ever observed the code asserts **RT2** to
surface the corruption rather than admit a second owner. ∎

**Consequence.** "Only one retry may own execution at a time" holds across
failover and recovery takeover, not merely on the happy path.

---

## 3. Serialized + throttled recovery (RT3)

**Claim.** For each execution at most one recovery coordinator is admitted per
epoch, and the number of concurrent recovery sweeps never exceeds
`maxConcurrentRecoveries`.

**Proof sketch.** *Serialization:* `requestRecovery` returns `ALREADY_OWNED` when
an active recovery coordination already owns an equal-or-newer epoch, and the
durable `takeoverRecovery` CAS (`EXPIRED → RECOVERY_OWNED`) admits exactly one
cross-process winner regardless. *Throttle:* the ceiling check
`recoverySlots ≥ M` and the reserve `recoverySlots += 1` execute with **no
`await` between them**, so they form one critical section under the
single-threaded event loop; a burst cannot slip past the gate after the check
but before the increment. Every non-admitted path and every error path calls
`release()`; the admitted path returns `release` to the caller, which the
scheduler invokes in a `finally`. Thus `0 ≤ recoverySlots ≤ M` is invariant, and
the defensive `assertRecoverySerialized` never trips. ∎

---

## 4. No replay/recovery overlap; replay isolation (RT4)

**Claim.** A replay coordination and a recovery coordination for the same
execution cannot both be active.

**Proof sketch.** Each coordination record carries a single `mode ∈ {normal,
replay, recovery}`. `assertNoReplayRecoveryOverlap` is evaluated at every entry
point (`requestRetry`, `requestRecovery`, `claimExecution`) against the live
record: a `recovery` request over a `replay`-mode active record (and vice versa)
fails the assertion. Because there is exactly one record per execution and modes
are checked before any transition, the two modes are mutually exclusive in time.
Replay executions are additionally distinct executions (`parentExecutionId` set)
with an isolated lease key space (`RP3`), so they never share a lease row with
the live execution. ∎

---

## 5. Monotonic attempts, legal transitions (RT5)

**Claim.** No duplicate or replayed attempt drives an execution, and no illegal
coordination transition is ever applied.

**Proof sketch.** `requestRetry`/`requestRecovery`/`claimExecution` assert the
attempt/epoch is a positive integer up-front. Every state change passes through
`assertRetryTransition`, the single chokepoint that admits only edges in
`RETRY_TRANSITIONS` (validated total + absorbing-terminal at module load). The
store's `cas` calls it *before* writing, so an illegal edge throws and leaves
state untouched. Superseding always moves the single-flight `attempt` strictly
forward (monotonic ownership), so an older attempt can never overwrite a newer
coordination. ∎

---

## 6. Bounded retry storms (RT6)

**Claim.** The number of retries admitted for one execution within the storm
window is bounded by the soft limit; runaway amplification trips a hard assert.

**Proof sketch.** `chargeStorm` maintains a per-execution sliding window and a
global window, charged exactly once per external `requestRetry` (the internal
single-flight loop does **not** re-charge). Above the per-execution soft limit
(or global soft limit) the decision is `BLOCKED` — the retry is shed by extended
backoff, not dropped. Above the per-execution hard ceiling the coordinator
asserts **RT6**, treating runaway fan-out as a coordination bug rather than mere
load. Hence admitted retries per window ≤ soft limit; the remainder are shed or
hard-stopped. ∎

**Backpressure corollary.** When in-flight coordinations (SCHEDULED+EXECUTING)
reach `maxInFlightRetries`, new retries are `BLOCKED` with extended backoff — the
queue absorbs the pressure instead of the workers.

---

## 7. No reconciliation bypass (RT7)

**Claim.** An ambiguous external side effect cannot be retried until its true
outcome is reconciled.

**Proof sketch.** `requestRetry` routes `AMBIGUOUS_EXTERNAL_COMMIT` /
`TOOL_NON_IDEMPOTENT` to `RETRY_RECONCILING` and returns `RECONCILE_REQUIRED`;
a newer attempt arriving while the record is `RETRY_RECONCILING` also returns
`RECONCILE_REQUIRED` (never supersedes). `claimExecution` returns
`RECONCILE_REQUIRED` and `requestRecovery` returns `BLOCKED` against a reconciling
record. The only exits from `RETRY_RECONCILING` are via `resolveReconciliation`
(`NOT_COMMITTED → PENDING`, `COMMITTED → SETTLED`, `ABANDONED → ABORTED`). ∎

This is the retry-tier analogue of the fence layer's S3/F6 reconciliation
contract: a possibly-committed side effect is never blindly re-fired.

---

## 8. No fence bypass (RT8)

**Claim.** A retry takes execution ownership only after the durable fence/lease
validates.

**Proof sketch.** `claimExecution` calls `validateFence()` **before** any state
mutation; a false result returns `FENCED` without creating or advancing a
coordination record. Only after a true result does the loop drive the record to
`RETRY_EXECUTING`, where `assertFenceValidatedBeforeOwnership` confirms the state.
A worker whose lease was reclaimed between `acquire` and `claim` therefore
surrenders instead of executing. ∎

---

## 9. Cross-process scope & limits

The coordinator is a **process-local policy + canonical-state layer**.

- **Cross-process serialization** of ownership and recovery is enforced *durably*
  by the lease store's monotonic-epoch CAS (`acquire`, `takeoverRecovery`,
  `validateFencing`) — see
  [distributed-ownership-protocol.md](./distributed-ownership-protocol.md). Two
  workers in separate processes are serialized there regardless of their separate
  coordinator instances.
- **In-process** the shared coordinator (wired once in `runtimeContainer` and
  passed to both `DistributedScheduler` and `WorkerExecutionLoop`) adds
  single-flight, arbitration, recovery throttling, retry backpressure, the storm
  guard, and the canonical retry state with `RT1..RT8`.
- A production multi-process deployment that wants the single-flight/throttle
  guarantees to span processes can back `RetryCoordinationStore` with the same
  Postgres CTE-under-row-lock pattern the lease/fence stores already use; the
  port (`open` + `cas`) is defined for exactly that substitution. The in-memory
  store is the reference implementation and the test substrate.
