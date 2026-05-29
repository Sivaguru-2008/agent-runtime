# Invariant Matrix

Authoritative source: `INVARIANT_REGISTRY` in `apps/api/src/runtime/canonicalSemantics.ts`.

| ID | Category | Statement |
| --- | --- | --- |
| `S1` | safety | Side-effect uniqueness; no duplicate external execution |
| `S2` | safety | All external side effects require durable fences |
| `S3` | safety | Ambiguous effects require reconciliation quarantine |
| `RP1` | replay | Replay side-effect mutex blocks unsafe live effects after divergence |
| `RP2` | replay | Deterministic prefix equivalence before replay divergence |
| `RP3` | replay | Isolated replay execution must not collide or be concurrently owned |
| `L1` | lease | Lease attempt tokens are positive and monotonic |
| `L2` | lease | Stale lease mutations are rejected before durable state changes |
| `P1` | persistence | State and terminal events commit atomically |
| `P2` | persistence | Tenant isolation is enforced on persisted execution data |
| `O1` | ordering | Outbox FIFO order is preserved |
| `O2` | ordering | Original event timestamps are preserved during dispatch |
| `R1` | recovery | Recovery fence attempts are monotonic |
| `R2` | recovery | Recovery and retry paths obey recovery policy |
| `RT1` | retry | Single-flight: at most one active retry coordination per execution; duplicate retries are deduplicated, never double-driven |
| `RT2` | retry | Exclusive ownership: at most one owner epoch may hold `RETRY_EXECUTING` for an execution at a time |
| `RT3` | retry | Recovery serialization: at most one recovery coordinator per execution, and concurrent recovery executions are throttled |
| `RT4` | retry | Replay and recovery never overlap for the same execution; replay retries are isolated |
| `RT5` | retry | Retry attempts are strictly monotonic; only legal retry-state transitions are admitted |
| `RT6` | retry | Retry storm amplification is bounded (per-execution + global fan-out ceilings) |
| `RT7` | retry | Retries cannot bypass reconciliation: an ambiguous side effect must be reconciled before any re-attempt |
| `RT8` | retry | Retries cannot bypass fence validation: ownership is granted only after the durable fence/lease validates |
| `F1` | fence | A durable fence in EXECUTING precedes every external side effect |
| `F2` | fence | Side effects require a committed ownership context (claimant attempt == fence attempt == active lease) |
| `F3` | fence | A committed/reconciled fence is terminal; no duplicate committed effect |
| `F4` | fence | A stale lease holder cannot mutate fence state |
| `F5` | fence | Only legal fence-state transitions are admitted |
| `F6` | fence | Replay and retry resolve through the fence; they never bypass a committed fence or drift args silently |
| `F7` | fence | Canonical ownership context is internally consistent: `lease_epoch == fencing_token == ownership_version == attempt` and `worker_identity == workerId` (fail-closed) |
| `CAP1` | safety | Every registered tool must have an explicit capability declaration |
| `CAP2` | safety | Retry policy must conform to integration capability classification |
| `CAP3` | safety | Replay behavior must adhere to capability classification safety boundaries |
| `CAP4` | safety | Reconciliation is mandatory for non-idempotent or ambiguous side effects |
| `CA1` | coordination | Canonical correctness state is owned exclusively by Postgres; a durable concern may never be served by a Redis-backed adapter |
| `CA2` | coordination | Redis holds ephemeral coordination only; total Redis loss must not alter any committed correctness outcome |
| `CA3` | coordination | Ownership/fencing decisions resolve against the durable lease store; an ephemeral hint may seed work but never authorize a mutation |
| `CA4` | coordination | Recovery and replay reconstruct from durable sources; reconstruction must never require Redis-resident state |
| `CA5` | coordination | A Redis↔Postgres disagreement is resolved in favor of Postgres (fail-closed); the ephemeral view is discarded, never promoted |
| `CA6` | coordination | Every coordination concern carries an explicit authority classification |

`assertRuntimeInvariant()` records the invariant id, category, statement, and supplied context on the active OpenTelemetry span before throwing `InvariantViolation`.

## Coordination authority boundary (CA1–CA6)

The Redis↔Postgres durability boundary is specified in full in [`coordination-boundary.md`](coordination-boundary.md), with the machine-readable durability authority matrix in `src/runtime/coordinationAuthority.ts`. Postgres is the sole authority for correctness state (leases, fences, checkpoints, event log, outbox, dedup, dead-letters, execution/worker/replay state); Redis is ephemeral coordination only (job queue, event bus, rate limit, quota, liveness, SSE de-dupe). `assertCoordinationAuthorityWiring` runs at container startup and **fails closed** if a durable concern is ever bound to a Redis adapter.

## Canonical fencing-token model

The runtime represents ownership as a **single, strictly-positive, strictly-monotonic** fencing token: `attempt`. The columns `lease_epoch`, `fencing_token`, and `ownership_version` are canonical *aliases* of that one value, and `worker_identity` is an alias of `workerId`. They exist so the durable schema and cross-system contracts can name the dimension explicitly — but they MUST never diverge.

- **`canonicalEpochOf(owner)`** returns the single token.
- **`assertCanonicalOwnershipConsistency(owner)`** (invariant **F7**) rejects any context whose present aliases disagree with `attempt`/`workerId`. It runs at the fence-protocol entry gate and again inside every `FenceStore.reserve`/`transition`, so a divergent context can never reach a compare-and-set.
- The Postgres CAS predicate compares **every** epoch dimension with **AND** (fail-closed), `coalesce`-ing absent aliases to the source-of-truth column. Migration `0020_canonical_epoch_consistency.sql` makes the columns `NOT NULL` and adds CHECK constraints so the aliases cannot diverge at rest.

Why a single token rather than four independent counters: "stale epochs can NEVER mutate" is only decidable if there is one authority to compare against. Four independently-advanced counters create the fail-open *ownership resurrection* hole — an OR-style check admits a holder that matches one drifted alias while another alias would reject it. F7 + fail-closed AND + the durable CHECK close that hole at three layers (assertion, query, schema).

## Mutation legality matrix

Every durable mutation in the runtime is gated on the canonical token. The legality of a write by a claimant at `attempt = a` against a live owner at `attempt = o` is:

| Mutation | Ownership mode | Legal iff | Illegal claimant outcome |
| --- | --- | --- | --- |
| Fence `reserve` (establish PENDING) | n/a (insert-if-absent) | always; collapses onto existing row | divergent canonical context → `InvariantViolation` (F7) |
| Fence `beginSideEffect` (PENDING→EXECUTING) | monotonic + restamp | `a >= o` **and** state == PENDING | `STALE_OWNER` (a<o) / `STALE_STATE` → surrender, no dispatch (F1/F4) |
| Fence `commit` (EXECUTING→COMMITTED) | exact | `a == o` **and** state == EXECUTING | `FENCED` → surrender, never double-write (F2/F3) |
| Fence `fail` (EXECUTING→FAILED) | exact | `a == o` **and** state == EXECUTING | `FENCED` |
| Fence `markAmbiguous` / `beginReconciliation` / `expire` / `reopen` | monotonic + restamp | `a >= o` **and** legal from-state | `STALE_OWNER`/`STALE_STATE` |
| Fence `resolveReconciliation` | exact | `a == o` (the reconciler that claimed it) | `LOST` |
| Lease `acquire` / `takeoverRecovery` | epoch increment | new attempt `= o + 1` (strictly increasing) | rollback (`a <= o`) → throw; active unexpired lease held → `undefined` |
| Lease `renew` / `release` | identity + active status | same `workerId` and status ∈ {LEASED, RENEWING, RECOVERY_OWNED} | `undefined` → lease lost |
| Fenced execution / checkpoint / event write | `validateFencing` | `workerId` matches **and** `attempt == fencing_token == lease_epoch` **and** lease active **and** not expired | `FENCED` → surrender |

`exact` (== owner) is used wherever an in-flight outcome is recorded: only the worker that *began* the call may record its result. `monotonic` (>= owner, with restamp) is used for takeover: a newer owner may claim an abandoned fence; a strictly-older zombie is always rejected. A failed ownership check **never mutates** durable state.
