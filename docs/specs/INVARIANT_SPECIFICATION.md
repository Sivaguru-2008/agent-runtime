# Runtime Invariant & Enforcement Specification

This document provides the formal specifications, violated-by scenarios, enforcement points, and failure handling semantics for all runtime correctness invariants of our correctness-critical distributed AI execution runtime.

---

## 1. Safety Invariants (S)

### S1: Side-Effect Uniqueness (No Double-Execution)
*   **Formal Statement:** $\forall (E_{id}, S_{seq})$, there exists at most one non-deduplicated external side effect execution.
*   **Violated-by:** Worker retries same step sequence with a new/different idempotency key, or misses the local dedup table.
*   **Enforcement Location:** `DedupingToolExecutor` at the tool call boundary.
*   **Runtime Assertion Strategy:** A lock/reservation checks if the idempotency key exists in `tool_call_dedup` before invocation.
*   **Recovery Implications:** If a step was committed, future attempts must reuse the cached output rather than re-executing.
*   **Observability Hooks:** OpenTelemetry attributes: `invariant.id: "S1"`, `execution.id`, `step.seq`, `tool.name`.

### S2: Durable Fenced External Side-Effects
*   **Formal Statement:** $\forall \text{external side effect}$, it MUST be reserved in durability under an active lease attempt token $T_{lease}$ prior to initiation.
*   **Violated-by:** Worker invokes tool without verifying it still owns the active lease, or when the lease has expired.
*   **Enforcement Location:** `DedupingToolExecutor.execute` (via `dedup.beginCall`).
*   **Runtime Assertion Strategy:** Database transaction ensures lease attempt matches the active lease sequence in `execution_leases`.
*   **Recovery Implications:** If lease expires, execution aborts mid-flight.
*   **Observability Hooks:** `invariant.id: "S2"`, `lease.attempt`.

### S3: Ambiguous Effects Reconciliation
*   **Formal Statement:** If a side-effect is in `RESERVED`/`IN_FLIGHT` and its status is unknown, the engine MUST NOT silently re-execute with drifted arguments or without resolving status.
*   **Violated-by:** Worker tries to execute the same step sequence with drifted inputs (`args_hash` mismatch).
*   **Enforcement Location:** `DedupingToolExecutor.execute` (via `ARG_DRIFT` mode check).
*   **Runtime Assertion Strategy:** Throws `ReplayDivergenceError` if `argsHash` does not match the reserved one.
*   **Recovery Implications:** Replay is suspended; human intervention or an explicit branch fork is required.
*   **Observability Hooks:** `invariant.id: "S3"`, `recorded.args_hash`, `observed.args_hash`.

---

## 2. Replay Invariants (RP)

### RP1: Replay Side-Effect Mutex
*   **Formal Statement:** Replaying an aggregate event log prefix MUST NOT emit new or duplicate external side effects.
*   **Violated-by:** Running execution replay on completed nodes and issuing live HTTP/Stripe calls.
*   **Enforcement Location:** `executionEngine.execute` / `runStep` (checking pre-existing event histories).
*   **Runtime Assertion Strategy:** Short-circuits steps that already possess corresponding logged outcome events.
*   **Recovery Implications:** Guarantees that replays are side-effect free.
*   **Observability Hooks:** `invariant.id: "RP1"`, `replay.event_id`.

### RP2: Deterministic Prefix Equivalence
*   **Formal Statement:** A replay event stream $E'$ must be payload-byte-identical to the original event stream $E$ for the prefix.
*   **Violated-by:** Bare globals (`Date.now()`, `Math.random()`) cause state representation divergence during replay.
*   **Enforcement Location:** `ReplayDivergenceDetector.compare`.
*   **Runtime Assertion Strategy:** Cryptographic hash verification of frame sequences.
*   **Recovery Implications:** Triggers `REPLAY_DETERMINISM_VIOLATED` if verification fails.
*   **Observability Hooks:** `invariant.id: "RP2"`, `expected.chain_hash`, `actual.chain_hash`.

---

## 3. Lease Invariants (L)

### L1: Token Monotonicity
*   **Formal Statement:** Lease attempts are strictly monotonic: $T_{lease}^{(k+1)} > T_{lease}^{(k)}$. No two workers hold active status for the same execution lease simultaneously.
*   **Violated-by:** Concurrency race in lease acquisition returns identical attempt numbers.
*   **Enforcement Location:** `PostgresLeaseStore` using database row locks (`FOR UPDATE`).
*   **Runtime Assertion Strategy:** PostgreSQL constraints block duplicate `(execution_id, attempt)` entries.
*   **Recovery Implications:** Prevents concurrent workers from simultaneously writing states.
*   **Observability Hooks:** `invariant.id: "L1"`, `lease.attempt`.

### L2: Stale Lease Write Rejection
*   **Formal Statement:** A worker with $T_{stale} < T_{current}$ MUST NOT mutate the execution state or append execution-scoped events.
*   **Violated-by:** GC-paused worker wakes up and commits completion after lease was transferred.
*   **Enforcement Location:** `PostgresExecutionRepository` via CTE write fences.
*   **Runtime Assertion Strategy:** SQL updates return `FENCED` on token mismatch, triggering a clean `StaleWorkerSurrender`.
*   **Recovery Implications:** Stale results are discarded safely without mutating state.
*   **Observability Hooks:** `invariant.id: "L2"`, `fenced.phase`.

---

## 4. Persistence Invariants (P)

### P1: Single-Transaction State & Event Durability
*   **Formal Statement:** Terminal state updates and terminal outbox events MUST commit atomically within a single DBMS transaction.
*   **Violated-by:** Execution status transitions to `COMPLETED` but the outbox write fails.
*   **Enforcement Location:** `PostgresExecutionRepository.commitTerminal`.
*   **Runtime Assertion Strategy:** Transactional context manages both status update and outbox insertion.
*   **Recovery Implications:** Guarantees that at-least-once outbox dispatch is atomic with the state shift.
*   **Observability Hooks:** `invariant.id: "P1"`.

### P2: Tenant Isolation Isolation Safeguard
*   **Formal Statement:** Every persistent write MUST carry a valid, authenticated `tenant_id`.
*   **Violated-by:** Writing rows with empty `tenant_id` that default to system or leak cross-tenant.
*   **Enforcement Location:** `assertTenantId` inside execution, memory, and dedup repositories.
*   **Runtime Assertion Strategy:** Asserts that `tenantId` is non-empty string before querying.
*   **Recovery Implications:** Avoids cross-tenant leaks.
*   **Observability Hooks:** `invariant.id: "P2"`, `tenant.id`.

---

## 5. Ordering Invariants (O)

### O1: Outbox FIFO Monotonicity
*   **Formal Statement:** Event outbox dispatcher MUST process events per execution ID in sequential order.
*   **Violated-by:** Dispatcher tick fetches sequence $N+1$ and publishes it before sequence $N$.
*   **Enforcement Location:** `OutboxDispatcher.tickDatabase` query CTE.
*   **Runtime Assertion Strategy:** Subquery guarantees no lower sequence is pending or processing.
*   **Recovery Implications:** Guarantees in-order downstream delivery.
*   **Observability Hooks:** `invariant.id: "O1"`, `event.sequence`.

### O2: Original Timestamp Preservation
*   **Formal Statement:** Published events MUST carry the original producer-side timestamp.
*   **Violated-by:** Redelivery overwrites event timestamp with transmission time.
*   **Enforcement Location:** `OutboxDispatcher` reading `original_timestamp`.
*   **Runtime Assertion Strategy:** Verifies that timestamp of sent event matches DB column value.
*   **Recovery Implications:** Prevents event time-travel or historical rewrite.
*   **Observability Hooks:** `invariant.id: "O2"`.

---

## 6. Recovery Invariants (R)

### R1: Recovery Fence Monotonicity
*   **Formal Statement:** Recovery loop MUST increment the fencing token $T_{lease}$ prior to re-queueing the work.
*   **Violated-by:** Work is re-queued while previous worker holds an active lease, leading to races.
*   **Enforcement Location:** `recoveryLoop.ts` during job reclaim.
*   **Runtime Assertion Strategy:** Increments `attempt` count and sets lease to `ACTIVE`.
*   **Recovery Implications:** Stale worker is instantly fenced out.
*   **Observability Hooks:** `invariant.id: "R1"`, `lease.new_attempt`.

### R2: Recovery Path Fence Checks
*   **Formal Statement:** Rebuilding execution state from checkpoints MUST validate the fence token.
*   **Violated-by:** Restoring from a checkpoint constructed by a stale owner.
*   **Enforcement Location:** `executionEngine.writeCheckpoint` / `hydrateForRecovery`.
*   **Runtime Assertion Strategy:** Fenced writing of checkpoints via database-level checks.
*   **Recovery Implications:** Safe state reassembly from the last consistent transaction.
*   **Observability Hooks:** `invariant.id: "R2"`.

---

## 7. Invariant Failure Handling Semantics

When an invariant assertion fails at runtime, the system adheres to a strict fail-safe posture:

```
                  ┌───────────────────────────┐
                  │ Invariant Violation /     │
                  │ Fencing Rejection Trip    │
                  └─────────────┬─────────────┘
                                │
          ┌─────────────────────┴─────────────────────┐
          ▼                                           ▼
[Fencing Rejection / Stale]               [System Invariant Breach]
- Surrender immediately                   - Log CRITICAL to Telemetry
- Skip terminal DB writes                 - Stop processing immediately
- Return input execution ref              - Fail-closed / Alert Operators
- Legitimate owner converges              - Dead-letter affected queue job
```

1.  **Fencing Surrender (Expected Distributed Contention):**
    *   If a write or event publication returns `FENCED` (stale worker), the worker halts all execution steps, rejects terminal state saves, and silently surrenders. The active new owner takes over.
2.  **System Invariant Violations (Fatal Bugs):**
    *   If an invariant like Argument Drift (I5) or Tenant ID Violation occurs, the worker immediately throws a fatal exception, dead-letters the job, and logs a critical telemetry event. It refuses to continue to prevent data corruption.
