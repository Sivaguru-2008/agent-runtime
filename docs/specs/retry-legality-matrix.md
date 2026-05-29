# Retry Legality Matrix

The decidable rules that govern every retry-coordination decision. Authoritative
sources: `apps/api/src/runtime/retry/retryState.ts` (transitions) and
`apps/api/src/runtime/retry/retryCoordinator.ts` (decisions). Companion:
[retry-coordination.md](./retry-coordination.md).

---

## 1. Transition legality

A transition `from → to` is admissible iff `to ∈ RETRY_TRANSITIONS[from]`.
Self-transitions (`from === to`) are idempotent no-ops. Any other edge throws
`IllegalRetryTransitionError` (classified `InvariantViolation`, code **RT5**).
`✓` = legal, `·` = illegal, `=` = idempotent self.

| from \ to | PENDING | SCHEDULED | EXECUTING | BLOCKED | RECONCILING | SETTLED | ABORTED |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **RETRY_PENDING** | = | ✓ | · | ✓ | ✓ | ✓ | ✓ |
| **RETRY_SCHEDULED** | · | = | ✓ | ✓ | ✓ | ✓ | ✓ |
| **RETRY_EXECUTING** | ✓ | · | = | ✓ | ✓ | ✓ | ✓ |
| **RETRY_BLOCKED** | ✓ | · | · | = | ✓ | ✓ | ✓ |
| **RETRY_RECONCILING** | ✓ | · | · | · | = | ✓ | ✓ |
| **RETRY_SETTLED** | · | · | · | · | · | = | · |
| **RETRY_ABORTED** | · | · | · | · | · | · | = |

Structural properties enforced at module load by `validateRetryStateMachine`:
every state reachable from `RETRY_PENDING`; terminals (`SETTLED`, `ABORTED`)
absorbing; `active ⊎ terminal` partition the state set; exclusive states
(`SCHEDULED`, `EXECUTING`, `RECONCILING`) ⊆ active. Note the asymmetry: a
coordination only ever re-enters `SCHEDULED` *via* `PENDING` (so `SCHEDULED →
PENDING` and `BLOCKED/EXECUTING → SCHEDULED` are illegal direct edges — the
coordinator normalizes through `PENDING`), while both terminals are reachable
from every active state because the execution's terminal outcome is authoritative.

---

## 2. `requestRetry` decision matrix (single-flight admission)

Inputs: requested logical `attempt = a`; live coordination at `attempt = o`,
state `S`, mode `m`; failure type `f`. Evaluated top-to-bottom; first match wins.

| # | Condition | Decision | State effect |
| :-- | :--- | :--- | :--- |
| 1 | `a` not a positive integer | **throws RT5** | — |
| 2 | `f ∈ {AMBIGUOUS_EXTERNAL_COMMIT, TOOL_NON_IDEMPOTENT}` and not reconciled | **RECONCILE_REQUIRED** | → RECONCILING |
| 3 | `f` non-retryable ∧ non-replayable (`RECOVERY_SEMANTICS_MAP`) | **ABORTED** | → ABORTED |
| 4 | per-execution storm count > hard ceiling | **throws RT6** | — |
| 5 | per-execution storm count > soft, or global > soft | **BLOCKED** | → BLOCKED (extended backoff) |
| 6 | in-flight (SCHEDULED+EXECUTING) ≥ `maxInFlightRetries` | **BLOCKED** | → BLOCKED (extended backoff) |
| 7 | no record, or record terminal | **ADMITTED** | open → SCHEDULED@a |
| 8 | active, mode conflict (replay×recovery) | **throws RT4** | — |
| 9 | `a < o` | **DEDUPED** | unchanged |
| 10 | `a == o`, `S ∈ {PENDING, BLOCKED}` | **ADMITTED** | → SCHEDULED@a |
| 11 | `a == o`, `S ∈ {SCHEDULED, EXECUTING, RECONCILING}` | **DEDUPED** | unchanged |
| 12 | `a > o`, `S == RECONCILING` | **RECONCILE_REQUIRED** | unchanged (RT7) |
| 13 | `a > o`, otherwise | **ADMITTED** | supersede → SCHEDULED@a |

Worker-loop handling of each decision: `ADMITTED`/`BLOCKED` → re-enqueue (BLOCKED
with the coordinator's extended backoff); `DEDUPED`/`RECONCILE_REQUIRED` → ack
without re-enqueue; `ABORTED` → dead-letter.

---

## 3. `claimExecution` decision matrix (exclusive ownership)

Inputs: claim epoch `a` (= `lease.attempt`); live coordination state `S`, owner
epoch `o`, owner worker `wo`, mode `m`; claim mode `mc`; `validateFence()`.

| # | Condition | Outcome |
| :-- | :--- | :--- |
| 1 | `a` not a positive integer | **throws RT5** |
| 2 | `validateFence()` returns false | **FENCED** (surrender; RT8) |
| 3 | `S == RECONCILING` | **RECONCILE_REQUIRED** (RT7) |
| 4 | active, mode conflict (replay×recovery) | **throws RT4** |
| 5 | `S == EXECUTING`, `a < o` | **STALE** (zombie surrenders; RT2) |
| 6 | `S == EXECUTING`, `a == o`, `wo == self` | **OWNED** (idempotent) |
| 7 | `S == EXECUTING`, `a == o`, `wo ≠ self` | **throws RT2** (impossible epoch collision) |
| 8 | `S == EXECUTING`, `a > o` | **OWNED** (legitimate takeover) |
| 9 | `S ∈ {PENDING, SCHEDULED, BLOCKED}` (drive to EXECUTING) | **OWNED** on success, else **STALE** |
| 10 | no record / terminal | bootstrap then **OWNED** |

Fence validation (row 2) happens *before* any state is mutated, so a worker that
lost its lease between acquire and claim never reaches `RETRY_EXECUTING` (RT8).

---

## 4. `requestRecovery` decision matrix (serialization + throttle)

Inputs: recovery epoch `a`; live coordination state `S`, owner epoch `o`, mode
`m`; `replayActive`; process recovery-slot count `n`, ceiling `M`.

| # | Condition | Decision |
| :-- | :--- | :--- |
| 1 | `a` not a positive integer | **throws RT5** |
| 2 | `replayActive` | **BLOCKED** (RT4) |
| 3 | active, `m == replay` | **throws RT4** |
| 4 | active, `m == recovery`, `o ≥ a` | **ALREADY_OWNED** (RT3 serialize) |
| 5 | `n ≥ M` | **THROTTLED** (RT3 throttle) |
| 6 | claim CAS loses to a newer epoch | **ALREADY_OWNED** |
| 7 | active `S == RECONCILING` | **BLOCKED** (RT7) |
| 8 | otherwise | **ADMITTED** (reserve slot; `release()` frees it) |

The ceiling check (5) and the slot reserve are a single synchronous critical
section, so a burst of concurrent recoveries can never exceed `M`.

---

## 5. Legality by failure type

Combines `RECOVERY_SEMANTICS_MAP` (see [recovery-matrix.md](./recovery-matrix.md))
with the retry-coordination routing. "Retry path" is the decision `requestRetry`
yields for a fresh coordination on that failure.

| Failure | Retry path | Rationale |
| :--- | :--- | :--- |
| `LEASE_STOLEN`, `LEASE_EXPIRY`, `HEARTBEAT_TIMEOUT` | ADMITTED | recoverable; new epoch re-drives |
| `TOOL_TIMEOUT`, `PROVIDER_TIMEOUT`, `TOOL_CRASH`, `PROCESS_CRASH` | ADMITTED | transient; retryable |
| `NETWORK_PARTITION`, `OUTBOX_FAILURE`, `UNKNOWN_RUNTIME_FAILURE` | ADMITTED | retryable-by-default |
| `CHECKPOINT_FENCE_REJECTED`, `PARTIAL_COMMIT` | ADMITTED | retryable; reconcilable if needed |
| `DUPLICATE_DELIVERY` | DEDUPED (single-flight) | not a fresh attempt |
| `AMBIGUOUS_EXTERNAL_COMMIT`, `TOOL_NON_IDEMPOTENT` | RECONCILE_REQUIRED | RT7 — must reconcile first |
| `REPLAY_DIVERGENCE` | ABORTED | non-retryable; human-gated |
| `STALE_WORKER_MUTATION`, `RECOVERY_ABORTED`, `EXECUTION_CANCELLED`, `DLQ_ESCALATED` | ABORTED | terminal / non-retryable |

---

## 6. Invariant cross-reference

| Decision rule | Invariant |
| :--- | :--- |
| §2 rows 7,9–13 (one admission per attempt) | **RT1** single-flight |
| §3 rows 5–8 (epoch-keyed exclusivity) | **RT2** ownership |
| §4 rows 4–6,8 (one recovery; bounded slots) | **RT3** recovery serialization/throttle |
| §2 row 8, §3 row 4, §4 rows 2,3 | **RT4** replay/recovery overlap |
| §1 (transition table), §2 row 1, §3 row 1 | **RT5** monotonic attempts / legal transitions |
| §2 rows 4,5 (storm ceilings) | **RT6** storm amplification |
| §2 rows 2,12; §3 row 3; §4 row 7 | **RT7** no reconciliation bypass |
| §3 row 2 (fence before ownership) | **RT8** no fence bypass |
