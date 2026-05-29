# Redis ↔ Postgres Coordination Authority Boundary

This spec is the single authoritative statement of **who owns what** across the
Redis/Postgres split in the distributed AI runtime, and the runtime guards that
keep that boundary from eroding.

It exists because the boundary used to be *implicit* — scattered across
container wiring, production invariants, and SQL CTEs — which made the only
question that matters ("could a correctness decision ever depend on Redis
durability?") something you had to reconstruct by reading the whole system.

Machine-readable source of truth: [`src/runtime/coordinationAuthority.ts`](../../apps/api/src/runtime/coordinationAuthority.ts)
(`COORDINATION_AUTHORITY_MATRIX`). Invariants `CA1..CA6` are registered in
[`canonicalSemantics.ts`](../../apps/api/src/runtime/canonicalSemantics.ts).

---

## 1. The boundary, stated once

| | **Postgres** | **Redis** | **Process memory** |
|---|---|---|---|
| **Role** | Canonical correctness authority | Ephemeral coordination | In-process single-flight |
| **Holds** | Leases, fences, checkpoints, event log, outbox, dedup, dead-letters, execution/worker/replay state | Job queue, event/stream bus, rate limit, quota, liveness, SSE de-dupe | Retry coordinator (RT1..RT8) |
| **On total loss** | **Data-loss incident** (this is truth) | **Tolerated** — reconstructable or loss-safe | Rebuilt from durable lease + execution state on next claim |
| **May authorize a mutation?** | **Yes** — sole authority | **Never** | Never (delegates cross-process serialization to the durable lease) |

The one-line contract: **Postgres is durable truth; Redis is a delivery/coordination
hint that can never change a committed outcome.**

---

## 2. Durability Authority Matrix

Generated from `COORDINATION_AUTHORITY_MATRIX`. `Must-never-depend-on-Redis`
is the property the startup wiring guard (CA1) enforces.

### 2.1 Durable truth — Postgres (must never depend on Redis)

| Concern | Authority | Durability | Reconstructable | Reconstruction source |
|---|---|---|---|---|
| `EXECUTION_STATE` | Postgres | Durable truth | No | `executions` table (event log re-derives history) |
| `EXECUTION_LEASE` | Postgres | Durable truth | No | `execution_leases`; expiry + serialized `takeoverRecovery` |
| `FENCE_STATE` | Postgres | Durable truth | No | `execution_fences` PENDING→EXECUTING→COMMITTED ledger |
| `EXECUTION_CHECKPOINT` | Postgres | Durable truth | No | `execution_checkpoints` (recovery anchor) |
| `EVENT_LOG` | Postgres | Durable truth | No | `events` (append-only, fenced) |
| `EVENT_OUTBOX` | Postgres | Durable truth | No | `event_outbox`, drained by `OutboxDispatcher` |
| `TOOL_CALL_DEDUP` | Postgres | Durable truth | No | `tool_call_dedup` (idempotency key) |
| `DEAD_LETTER` | Postgres | Durable truth | No | dead-letter table |
| `WORKER_REGISTRY` | Postgres | Durable truth | Yes | `runtime_workers`; re-registration + heartbeat |
| `REPLAY_METADATA` | Postgres | Durable truth | Yes | snapshots / replay_sessions / certifications / externalities; derivable from event log |

### 2.2 Reconstructable / process-local

| Concern | Authority | Durability | Reconstructable | Reconstruction source |
|---|---|---|---|---|
| `RETRY_COORDINATION` | Process | Reconstructable | Yes | rebuilt from durable lease epoch + execution state on next claim |

### 2.3 Ephemeral coordination — Redis (loss-tolerant)

| Concern | Authority | Durability | Reconstructable | Loss behavior |
|---|---|---|---|---|
| `JOB_QUEUE` | Redis | Ephemeral | Yes | recovery loop re-enqueues from durable execution + lease state |
| `EVENT_BUS` | Redis | Ephemeral | Yes | durable event log + outbox re-publish |
| `RATE_LIMIT` | Redis | Ephemeral | No | fails open to a fresh window (not a correctness concern) |
| `QUOTA` | Redis | Ephemeral | No | soft enforcement; counter window resets |
| `LIVENESS` | Redis | Ephemeral | Yes | absence ⇒ "assume not-live" (fail-safe) |
| `SSE_DEDUPE` | Redis | Ephemeral | No | may re-deliver an SSE frame (idempotent on client) |

---

## 3. Coordination invariants (CA1–CA6)

| ID | Statement | Enforced by |
|---|---|---|
| **CA1** | Canonical correctness state is owned exclusively by Postgres; a durable concern may never be served by a Redis-backed adapter. | `assertCoordinationAuthorityWiring` at container startup — fails closed. |
| **CA2** | Redis holds ephemeral coordination only; total Redis loss must not alter any committed outcome. | `assertEphemeralLossSafe` + matrix `reconstructable` flags. |
| **CA3** | Ownership/fencing decisions resolve against the durable lease store; an ephemeral hint may seed work but never authorize a mutation. | `assertCanonicalOwnershipConsistency(lease)` in the worker loop at lease-acquire; fenced writes (`saveFenced`/`appendFenced`/`writeFenced`). |
| **CA4** | Recovery and replay reconstruct from durable sources; reconstruction must never require Redis state. | `assertReconstructionDurable(sources)`. |
| **CA5** | An observed Redis↔Postgres disagreement is resolved in favor of Postgres (fail-closed); the ephemeral view is discarded, never promoted. | `reconcileOwnershipView` / `assertOwnershipResolvesToDurable`. |
| **CA6** | Every coordination concern carries an explicit authority classification. | `classifyConcern` throws on an unclassified concern. |

---

## 4. Recovery & Reconstruction Rules

These rules define how the system reconstructs state after each failure class.
The governing principle: **reconstruction reads only `§2.1`/`§2.2` sources.**

### 4.1 Redis failover / data loss (FLUSHALL, replica promotion with lag)
1. **Ownership is unaffected.** Leases live in Postgres; no lease is lost.
2. **In-flight jobs** that were only in the Redis queue are recovered by the
   background recovery loop: the durable lease expires (`reclaimExpired`), and
   the execution is re-enqueued from durable execution state. `JOB_QUEUE` is
   `reconstructable`.
3. **Lost bus messages** are re-published from the durable `event_outbox`
   (`EVENT_BUS` is `reconstructable`); live subscribers reconcile against the
   `events` log.
4. **A stale job envelope** that outlived its epoch reconciles to `STALE` against
   the durable lease (CA5). It can never re-drive a superseded execution because
   the worker re-acquires the lease and the fencing token comes from Postgres.
5. **No checkpoint, event, fence, or dedup record is affected** — none live in Redis.

### 4.2 Postgres failover (primary promotion)
1. Durable truth is preserved (synchronous replication assumed for the
   correctness tier).
2. Leases that were active at failover **expire by wall clock**; the serialized
   `takeoverRecovery` CTE mints a strictly-higher epoch (`attempt + 1`) so the
   new owner fences out any zombie holder from the pre-failover epoch
   (monotonicity proof: [`distributed-ownership-protocol.md` §6](distributed-ownership-protocol.md)).
3. Recovery ownership is **single-flight**: only one recovery worker can move a
   lease `EXPIRED → RECOVERY_OWNED`.

### 4.3 Coordination desynchronization (Redis ahead of / behind Postgres)
- Redis **behind** Postgres (stale snapshot): `STALE` — discard the hint, proceed
  on the durable view. Expected and benign.
- Redis **ahead** of Postgres (claims an epoch Postgres never minted): `IMPOSSIBLE`
  — fail closed (CA5). Under canonical authority Postgres mints every epoch, so a
  higher ephemeral epoch means genuine corruption or a restore that rolled
  Postgres back behind a surviving Redis. Surrender rather than execute on a
  phantom.

### 4.4 Replay after Redis loss
Replay reconstructs deterministically from the durable `events` log (+ snapshots /
checkpoints). It never reads Redis. `assertReconstructionDurable(["EVENT_LOG",
"REPLAY_METADATA", "EXECUTION_CHECKPOINT"])` is the guard. See
[`replay-semantics-spec.md`](replay-semantics-spec.md).

---

## 5. Distributed Persistence Guarantees

1. **G1 — Ownership durability.** At most one worker holds an active lease per
   execution, and that fact survives any Redis loss. Ownership is minted and
   validated only in Postgres.
2. **G2 — Fenced-write atomicity.** Every state-mutating write commits only if a
   live, canonically-consistent lease still backs it, verified in the same
   transaction (`saveFenced`/`appendFenced`/`writeFenced`). A stale worker's
   write affects 0 rows.
3. **G3 — Side-effect uniqueness across loss.** Tool-call dedup and the fence
   ledger are durable; a side effect is not re-fired after a Redis flush.
4. **G4 — At-least-once delivery despite bus loss.** Committed events reach
   subscribers via the durable outbox even if the Redis bus drops the live
   publish.
5. **G5 — Bounded reconstruction.** Every ephemeral concern is either
   reconstructable from durable truth or explicitly loss-safe (degrades to a safe
   default). No correctness outcome depends on a Redis datum persisting.
6. **G6 — Monotonic recovery.** Recovery always advances the epoch; a recovered
   execution can never be re-driven under a stale token.

---

## 6. Verification

- Unit: [`test/coordinationAuthority.test.ts`](../../apps/api/test/coordinationAuthority.test.ts)
  — matrix integrity, wiring guard (CA1), loss-safety (CA2), reconstruction (CA4),
  ownership reconciliation (CA3/CA5), CA6.
- Boundary survival: [`test/coordinationBoundary.test.ts`](../../apps/api/test/coordinationBoundary.test.ts)
  — durable truth survives total ephemeral loss; ownership recovers via durable
  expiry + takeover; stale Redis envelopes cannot resurrect ownership; replay
  reconstructs from the durable event log.
- Chaos (testcontainers): [`test/chaos/phase1-redis.chaos.test.ts`](../../apps/api/test/chaos/phase1-redis.chaos.test.ts)
  (Redis fault injection), `phase2-postgres`, `phase7-ownership`, `replayChaos`.
- Startup guard: `assertCoordinationAuthorityWiring` runs in
  [`runtimeContainer.ts`](../../apps/api/src/application/runtimeContainer.ts) on
  every boot.
