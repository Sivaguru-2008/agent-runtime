# Fence State Machine (canonical, hardened)

Status: **canonical**. This document defines the hardened, explicitly-stated
fence protocol. It supersedes the lifecycle section (§1) of
[`fence-protocol.md`](./fence-protocol.md) — that document remains the
reference for the remote-idempotency-key threading, the product idempotency
grades (§6) and the crash-case prose (§5), all of which still hold. Where the
two disagree on *states or transitions*, this document wins.

Implementation:
- State machine — [`apps/api/src/runtime/fence/fenceState.ts`](../../apps/api/src/runtime/fence/fenceState.ts)
- Protocol + ownership — [`apps/api/src/runtime/fence/fenceProtocol.ts`](../../apps/api/src/runtime/fence/fenceProtocol.ts)
- Stores — [`inMemoryFenceStore.ts`](../../apps/api/src/infrastructure/persistence/inMemoryFenceStore.ts),
  [`postgresFenceStore.ts`](../../apps/api/src/infrastructure/persistence/postgres/postgresFenceStore.ts)
- Schema — [`db/migrations/0016_fence_state_machine.sql`](../../apps/api/db/migrations/0016_fence_state_machine.sql)
- Tests — [`apps/api/test/fence/`](../../apps/api/test/fence/)

---

## 0. Why a fence, and what it is

A **fence** is the durable coordination record that guards **exactly one
external side effect** — a Stripe refund, an email, a row written to a customer
DB, a file mutated on disk. It is identified by `(executionId, stepSeq)` and its
id is, by construction, the remote idempotency key:

```
fenceId = idempotencyKey = sha256(executionId || ':' || stepSeq)
```

The fence is **not** a lock over the external system; we cannot lock Stripe.
It is a *state machine over our knowledge of whether the effect happened*,
plus an ownership token that decides **who** is allowed to advance that
knowledge. Two properties make it a correctness layer rather than a cache:

1. **Every external side effect requires a durable fence in `EXECUTING`
   before it fires** (invariant **F1**). A crash is therefore always
   recoverable: the fence tells the next owner whether the call was ever
   dispatched.
2. **Every state change is a transactional compare-and-set** over both the
   expected state and the claimant's lease ownership (invariants **F4/F5**).
   A stale worker's write matches zero rows; it can never corrupt the ledger.

The fence is distinct from the **execution** state machine
([`canonicalSemantics.ts`](../../apps/api/src/runtime/canonicalSemantics.ts)):
one execution runs many steps; each side-effecting step owns one fence.

---

## 1. The eight states

| State | Kind | Meaning |
|---|---|---|
| `PENDING` | active | Fence durably reserved; the side effect has **not** been dispatched. |
| `EXECUTING` | active | Owner authorized; the external call is in flight. **The only state from which a side effect may fire.** |
| `COMMITTED` | terminal (absorbing) | Effect confirmed to have succeeded; outcome recorded. |
| `FAILED` | terminal (restartable) | Effect confirmed **not** to have taken (definitive negative); outcome recorded. |
| `AMBIGUOUS` | active | Owner lost the fence while `EXECUTING` (crash / lease loss). Outcome unknown — **quarantine**. |
| `RECONCILING` | active | A reconciler holds the fence and is verifying the true external outcome. |
| `RECONCILED` | terminal (absorbing) | Ambiguity resolved by verification: the effect **did** commit. Output recorded. |
| `EXPIRED` | terminal (restartable) | Lease expired before dispatch (safe), or reconciliation abandoned. |

**Restartable terminals** (`FAILED`, `EXPIRED`) have a single outgoing edge
back to `PENDING`, taken only under a strictly newer lease attempt. This keeps
the fence id — and therefore the remote idempotency key — **stable across
retries**, which is what lets the remote dedupe a re-dispatched call.
**Absorbing terminals** (`COMMITTED`, `RECONCILED`) are never re-opened: a
committed external effect is forever.

---

## 2. Transition diagram

```
                       reserve
                          │
                          ▼
                     ┌─────────┐
        ┌────────────│ PENDING │◀───────────────┐
        │            └────┬────┘                 │ re-open
        │ lease-expired   │ begin (own+lease ok) │ (monotonic attempt)
        │ (no effect)     ▼                       │
        │            ┌───────────┐                │
        │       ┌────│ EXECUTING │────┐           │
        │       │    └─────┬─────┘    │           │
        │  ok   │          │ lost     │ definitive│
        │ commit│          │ fence    │ error     │
        ▼       ▼          ▼          ▼           │
   ┌─────────┐ ┌───────────┐  ┌──────────┐        │
   │ EXPIRED │ │ COMMITTED │  │  FAILED  │────────┘
   └────┬────┘ └───────────┘  └────┬─────┘
        │           (absorbing)    │  re-open (monotonic)
        │ re-open                  └──────────────┐
        │ (monotonic)                             ▼
        └──────────────────────────────────▶ PENDING

   EXECUTING ──lost fence──▶ AMBIGUOUS ──claim──▶ RECONCILING
                                 │                    │
                                 │ window elapsed     ├── verified committed ─▶ RECONCILED (absorbing)
                                 ▼                    ├── verified not-taken ──▶ FAILED
                              EXPIRED                 ├── abandoned ───────────▶ EXPIRED
                                                      └── inconclusive ────────▶ AMBIGUOUS
```

Authoritative adjacency (from [`fenceState.ts`](../../apps/api/src/runtime/fence/fenceState.ts)):

| From | Allowed `to` |
|---|---|
| `PENDING` | `EXECUTING`, `EXPIRED`, `FAILED` |
| `EXECUTING` | `COMMITTED`, `FAILED`, `AMBIGUOUS` |
| `AMBIGUOUS` | `RECONCILING`, `EXPIRED` |
| `RECONCILING` | `RECONCILED`, `FAILED`, `EXPIRED`, `AMBIGUOUS` |
| `FAILED` | `PENDING` (re-open) |
| `EXPIRED` | `PENDING` (re-open) |
| `COMMITTED` | — (absorbing) |
| `RECONCILED` | — (absorbing) |

The table is **self-validated at module load** (`validateFenceStateMachine`):
every state reachable from `PENDING`, every absorbing terminal has zero
out-edges, every restartable terminal has exactly one (`→ PENDING`), and
`terminal ⊎ active` partitions the state set. A malformed table is a
startup-time crash, not a runtime surprise. Edge count: **14**.

---

## 3. Ownership semantics

Every transition request carries a **claimant** `{ workerId, attempt }`. The
`attempt` is the lease fencing token (positive, monotonic per execution — the
existing `execution_leases.attempt`). The store gates each transition on one of
three ownership modes, evaluated **atomically with** the state check and the
write:

| Mode | Predicate | Used by |
|---|---|---|
| `exact` | `claimant.attempt === fence.leaseAttempt` | `commit`, `fail`, `resolveReconciliation` |
| `monotonic` | `claimant.attempt >= fence.leaseAttempt` | `beginSideEffect`, `reopen`, `markAmbiguous`, `beginReconciliation`, `expire` |
| `none` | always | (unused by the protocol; reserved) |

Reading the modes:

- **`exact` for commit/fail.** Only the worker that *began* the in-flight call
  may record its outcome. If the lease flipped during the call, the claimant's
  attempt no longer matches → the write matches zero rows → the caller is
  `FENCED` and must surrender. The new owner reconciles.
- **`monotonic` for takeover.** A newer owner may claim an *abandoned* fence
  (e.g. a `PENDING` fence whose reserver crashed, or an `EXECUTING` fence whose
  owner vanished). A **strictly older** attempt is always a zombie and is
  rejected — this is invariant **F4**, the stale-lease guard.
- **Re-open is monotonic too.** A `FAILED`/`EXPIRED` fence can only be
  re-opened under an attempt `>=` the one that settled it. A zombie cannot
  resurrect a settled fence.

`restampOwner` transitions (begin, reopen, ambiguate, reconcile-claim, expire)
rewrite `leaseAttempt`/`ownerWorkerId` to the claimant, transferring ownership.
Outcome-recording transitions (commit, fail) leave ownership untouched.

A failed ownership check **never mutates**. The store returns `STALE_OWNER`
with the unchanged record; the protocol surfaces `StaleFenceOwnerError` (begin)
or `FENCED` (commit/fail). This is the single most important property: a stale
worker is structurally incapable of changing fence state.

### 3.1 Canonical fencing-token model (F7, fail-closed)

`attempt` is the **single** canonical fencing token. The durable columns
`lease_epoch`, `fencing_token`, and `ownership_version` are aliases of it, and
`worker_identity` is an alias of `ownerWorkerId`. They MUST never diverge:

- Invariant **F7** (`assertCanonicalOwnershipConsistency`) rejects any claimant
  whose supplied aliases disagree with `attempt`/`workerId`. It runs at the
  protocol entry gate (`reserveOrResolve`) **and** inside every
  `FenceStore.reserve`/`transition`, so a divergent context can never reach the
  compare-and-set.
- The Postgres CAS evaluates the ownership predicate over **every** epoch
  dimension with **AND** (fail-closed), `coalesce`-ing any absent alias to
  `lease_attempt`. An OR across aliases would be fail-open: a stale holder
  matching one drifted alias could mutate (*ownership resurrection*). AND closes
  that hole.
- Migration `0020_canonical_epoch_consistency.sql` makes the alias columns
  `NOT NULL` and adds CHECK constraints binding them to the source-of-truth
  column, so even an out-of-band UPDATE cannot create divergence at rest.

On valid data (aliases == source of truth, guaranteed by F7 + the CHECK) the
AND predicate is exactly equivalent to comparing `lease_attempt` alone — the
in-memory store, which compares the single `attempt`, is therefore behaviourally
identical to Postgres.

---

## 4. Transactional boundaries

The protocol has exactly **one** un-transactional step — the external call
itself — bracketed by two atomic transitions:

```
  TX_begin:   PENDING ──(monotonic own, atomic CAS)──▶ EXECUTING
              │
              ▼
  [ external side effect — the ONLY non-transactional step ]
              │
              ▼
  TX_commit:  EXECUTING ──(exact own, atomic CAS)──▶ COMMITTED | FAILED
```

`FenceStore.transition` is the atomic primitive. In Postgres it is a single
`UPDATE … WHERE fence_id = $1 AND state = $expectedFrom AND <ownership>` under
the row's write lock — the state check, ownership check and write happen with
no interleaving window. In memory it is a synchronous read-check-write on the
single-threaded event loop, which is the same guarantee. When the `UPDATE`
matches zero rows, **no mutation occurred**; a follow-up read (on the
no-write path only) classifies the failure as `STALE_STATE`, `STALE_OWNER`
or `MISSING`.

`reserve` is an atomic insert-if-absent (`INSERT … ON CONFLICT DO NOTHING`),
so concurrent reservers collapse onto one row — the structural basis of
**side-effect uniqueness** (one fence per `(executionId, stepSeq)`).

---

## 5. Lifecycle operations

The runtime calls these (see `FenceProtocol`):

| Operation | Transition(s) | Ownership | Purpose |
|---|---|---|---|
| `reserveOrResolve` | create `PENDING`, or resolve existing | monotonic | The entry gate (see §6). |
| `beginSideEffect` | `PENDING → EXECUTING` | monotonic + restamp | Authorize dispatch. Asserts `EXECUTING` before returning (**F1**). |
| `commit` | `EXECUTING → COMMITTED` | exact | Record success. `FENCED` if lease lost. |
| `fail` | `EXECUTING → FAILED` | exact | Record definitive failure. `FENCED` if lease lost. |
| `markAmbiguous` | `EXECUTING → AMBIGUOUS` | monotonic + restamp | Quarantine on fence loss. |
| `beginReconciliation` | `AMBIGUOUS → RECONCILING` | monotonic + restamp | Claim for verification. |
| `resolveReconciliation` | `RECONCILING → {RECONCILED, FAILED, EXPIRED, AMBIGUOUS}` | exact | Record the verified verdict. |
| `expire` | `PENDING\|AMBIGUOUS → EXPIRED` | monotonic + restamp | Reap a stalled fence. |
| `reopen` (internal) | `FAILED\|EXPIRED → PENDING` | monotonic + restamp | Restart under a fresh attempt. |

---

## 6. The entry gate: `reserveOrResolve`

This single method is what makes **replay and retry unable to bypass a fence**
(invariant **F6**). Given a step's coordinates and the claimant, it returns:

| Result | When | Caller action |
|---|---|---|
| `RESERVED` | no fence, or an abandoned `PENDING`, or a re-opened restartable terminal | proceed to `beginSideEffect` |
| `RESOLVED_COMMITTED` | fence is `COMMITTED`/`RECONCILED` (same args) | return recorded output; **do not dispatch** |
| `ARG_DRIFT` | recorded `argsHash` ≠ observed | refuse silent re-run; surface replay divergence |
| `AMBIGUOUS` | a prior `EXECUTING` fence was orphaned, or already `AMBIGUOUS` | route to reconciliation; **do not dispatch** |
| `RECONCILING` | a reconciler holds it | back off |
| `IN_FLIGHT` | same-attempt sibling mid-call | back off; the remote idempotency key dedupes |
| `STALE` | claimant attempt older than the owner | surrender (zombie) |

**Drift takes precedence over everything.** A replay carrying different args
than the recorded reservation is never served a cached commit and never
silently re-run — it is surfaced as divergence so a human consents to a fork.
This closes the replay-bypass hole: a replay cannot reach a tool dispatch
without either matching the recorded args (→ cached) or being explicitly
flagged as divergent.

---

## 7. Replay interaction

| Replay situation | Fence behaviour |
|---|---|
| Re-running a step whose fence is `COMMITTED` with **identical** args | `RESOLVED_COMMITTED` — the recorded output is returned; the external effect is **not** re-dispatched. |
| Re-running with **drifted** args | `ARG_DRIFT` — surfaced as `ReplayDivergenceError`; the engine refuses to execute and the user must explicitly fork (`replay(edits=…)`). |
| Replay landing on a `FAILED`/`EXPIRED` fence | restartable re-open under a fresh attempt; the effect is re-dispatched (verified-not-taken, so safe). |
| Replay landing on an `AMBIGUOUS` fence | routed to reconciliation; never re-dispatched blind. |

Replay-safe / idempotent tools (`isReplaySafeTool`) may legitimately re-run;
the fence still records their outcome but a re-dispatch is harmless. The fence
protocol composes with the **replay side-effect mutex** (invariant RP1): after
a replay diverges, unsafe live effects are blocked at the engine layer *and*
the fence layer refuses a committed-fence bypass.

---

## 8. Recovery interaction

When a worker recovers an execution under a new lease attempt, the fence is the
recovery anchor:

| Fence state found | Recovery decision |
|---|---|
| `PENDING` | reserver crashed before dispatch — **no effect**. Claim it (monotonic) and proceed. |
| `EXECUTING` (older attempt) | prior owner vanished mid-call — **outcome unknown**. Move to `AMBIGUOUS`, reconcile. |
| `COMMITTED` / `RECONCILED` | effect is done. Return the recorded output; continue past the step. |
| `FAILED` / `EXPIRED` | effect did not take. Re-open and re-run. |
| `AMBIGUOUS` / `RECONCILING` | reconciliation in progress or pending; do not dispatch. |

Recovery fence attempts are monotonic (invariant R1), so a recovered worker
always wins ownership over the crashed predecessor, and the predecessor — if it
revives — is rejected as a zombie (F4).

---

## 9. Ambiguity handling

An `EXECUTING` fence whose owner is lost is the only genuinely hard case: the
external call **may or may not** have reached the remote. We never guess. The
fence moves to `AMBIGUOUS` (a quarantine — no dispatch is permitted from it),
then a reconciler claims it (`RECONCILING`) and runs a **verification hook**
(`verificationRegistry`, see [`reconciliationManager.ts`](../../apps/api/src/runtime/failure/reconciliationManager.ts)):

| Verification verdict | Fence transition | Effect |
|---|---|---|
| `COMMITTED` (provider confirms the effect happened) | `RECONCILING → RECONCILED` | record the verified output; subsequent reserves return it. |
| `FAILED` (provider confirms the effect did **not** happen) | `RECONCILING → FAILED` | restartable; the step re-runs safely. |
| `ABANDONED` (cannot verify within the window) | `RECONCILING → EXPIRED` | human-gated; operator decides. |
| `INCONCLUSIVE` | `RECONCILING → AMBIGUOUS` | re-quarantine for another pass. |

For tools with **no** verification hook and which are **not** replay-safe, an
orphaned in-flight fence is an unrecoverable double-fire hazard: the engine
raises `AmbiguityDetectedError` (invariant **S3**) and escalates to an operator
rather than risk a duplicate side effect. *Honesty over silent re-execution.*

**Reconciliation races** are resolved by the same ownership CAS: the first
reconciler to claim wins `RECONCILING` under its attempt; a losing reconciler
gets `STALE_STATE` on claim and `STALE_OWNER` on any resolve attempt against a
fence claimed by another.

---

## 10. Reconciliation triggers

A fence enters the reconciliation pipeline when any of these is observed:

1. **Recovery sweep** finds an `EXECUTING` fence owned by a dead/older lease
   attempt → `reserveOrResolve` returns `AMBIGUOUS`.
2. **Commit/fail FENCED** — a worker finishes its call but discovers the lease
   flipped; it surrenders and the new owner's `reserveOrResolve` quarantines.
3. **Lease-expiry reaper** promotes a long-stalled `EXECUTING` fence (no
   heartbeat past the lease TTL) to `AMBIGUOUS` via `markAmbiguous`.
4. **Explicit operator action** on a fence escalated as `AmbiguityDetectedError`.

A reaper that finds a `PENDING` fence past the lease TTL (no effect ever
dispatched) takes the safe path instead: `expire` (`PENDING → EXPIRED`), which
is restartable.

---

## 11. Invariants (mathematically enforced)

| ID | Invariant | Enforcement point |
|---|---|---|
| **F1** | A durable fence in `EXECUTING` precedes every external side effect. | `beginSideEffect` asserts `EXECUTING`; the executor dispatches only after. |
| **F2** | Side effects require a committed ownership context (claimant attempt == fence attempt == active lease). | `exact`/`monotonic` ownership on begin/commit. |
| **F3** | A committed/reconciled fence is absorbing — no duplicate committed effect. | absorbing terminals in the table; `reserveOrResolve → RESOLVED_COMMITTED`; `beginSideEffect` throws `DuplicateCommittedEffectError` on a committed fence; the commit CAS applies once. |
| **F4** | A stale lease holder cannot mutate fence state. | ownership predicate in the atomic CAS; failed check → `STALE_OWNER`, never a write. |
| **F5** | Only legal transitions are admitted. | `assertFenceTransition` in the store (in-memory and Postgres); table self-validated at load. |
| **F6** | Replay/retry resolve through the fence; never bypass a commit or drift args silently. | `reserveOrResolve` (`RESOLVED_COMMITTED` / `ARG_DRIFT`). |

These compose with the pre-existing safety invariants S1 (side-effect
uniqueness), S2 (durable fences required), S3 (ambiguity quarantine), L1/L2
(lease monotonicity / stale-mutation rejection) and R1 (recovery monotonicity)
registered in `INVARIANT_REGISTRY`.

---

## 12. What this protocol does **not** promise

(Unchanged from [`fence-protocol.md` §7](./fence-protocol.md).) No protection
against tools that lie about idempotency; no protection against the remote's
idempotency-key cache eviction (Stripe's ~24h TTL — see `replayDeadline`); no
cross-region quorum (single-Postgres fencing only). The fence makes our
*knowledge* of the effect correct and our *coordination* exclusive; it cannot
make a non-idempotent remote safe beyond the remote's own dedupe window.
