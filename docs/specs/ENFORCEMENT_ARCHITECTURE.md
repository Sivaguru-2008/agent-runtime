# Invariant Enforcement Architecture

This document describes the runtime components, middlewares, and transactional boundaries that guarantee invariant preservation within the distributed AI execution engine.

---

## 1. Architectural Enforcement Map

The following diagram illustrates where our runtime checks are anchored across different system layers:

```
            Client Request (HTTP / REST API)
                           │
                           ▼
                  [ Tenant Guard MW ] ──► Invariant: P2 (Tenant Isolation)
                           │
                           ▼
                 [ Distributed Scheduler ]
                           │
                           ▼
                   [ Recovery Loop ] ────► Invariant: R1 (Recovery Fence Monotonicity)
                           │
                           ▼
                    [ Job Queue ]
                           │
                           ▼
                  [ Worker Process ]
                           │
                           ▼
                 [ Execution Engine ]
                  ├── execute() ────────► Invariant: RP1 (Replay Side-Effect Mutex)
                  ├── runStep() ────────► Invariant: RP1 / R2 (State Reassembly)
                  └── runToolStep() ────► Invariant: S1 / S2 / S3 (Fencing, Drift)
                           │
                           ▼
               [ DedupingToolExecutor ]
                  ├── beginCall() ──────► Invariant: S2 (Durable Fence) / S3 (Drift Check)
                  └── mark*Fenced() ────► Invariant: L2 (Stale Write Blocked)
                           │
                           ▼
              [ Postgres repositories ]
                  ├── commitTerminal() ─► Invariant: P1 (Atomicity) / L2 (Fencing)
                  └── outboxDispatcher ─► Invariant: O1 (FIFO) / O2 (Timestamp)
```

---

## 2. Structural Layer Enforcement Details

### A. API Gateway / Middleware: Tenant Isolation Safeguard (P2)
*   **Enforcement Point:** Request validation layer and database access layer (`assertTenantId`).
*   **Implementation:** Before executing any SQL query, the postgres repositories assert that a non-empty `tenantId` is present on the model. If missing, it immediately throws `TENANT_ID_MISSING` and fails closed.

### B. Core Execution Engine: Replay Side-Effect Mutex (RP1)
*   **Enforcement Point:** `executionEngine.execute` / `runStep`.
*   **Implementation:** During step execution, the engine queries the event history for matches. If a completed event matches the sequence, it uses the cached outcome verbatim instead of invoking external model completion or tool triggers.

### C. Side Effect Deduping Boundary (S1, S2, S3, L2)
*   **Enforcement Point:** `DedupingToolExecutor` wrapping all tools.
*   **Implementation:**
    1.  **Durable Reservation:** Before tool execution, `beginCall` is invoked inside a database transaction. It verifies that the active lease matches the worker's attempt token. If it does not match, it throws `FenceLostError` before invoking the external side effect.
    2.  **drift Check (I5):** Checks `args_hash` equality on retry. If mismatch, throws `ReplayDivergenceError`.
    3.  **Fenced Commit:** After tool execution, results are committed via `markCompletedFenced` / `markFailedFenced` CTE queries that atomize verification of the lease attempt and result updates.

### D. Repository Transactional Fencing (L2, P1, R2)
*   **Enforcement Point:** `postgresExecutionRepository.ts` / `postgresCheckpointStore.ts`.
*   **Implementation:** State modifications are guarded using Common Table Expressions (CTEs):
    ```sql
    WITH fence AS (
      SELECT attempt FROM execution_leases
      WHERE execution_id = $1 AND worker_id = $2 AND attempt = $3 AND status = 'ACTIVE'
      FOR UPDATE
    )
    UPDATE executions ...
    WHERE EXISTS (SELECT 1 FROM fence)
    ```
    This bridges the gap between state inspection and update (TOCTOU).

### E. Event Outbox Flow (O1, O2)
*   **Enforcement Point:** `OutboxDispatcher` polling logic.
*   **Implementation:** Monotonic order is enforced via `not exists prev sequence < current` subqueries inside a `FOR UPDATE SKIP LOCKED` CTE. The event's original generation time is preserved across retries by mapping `original_timestamp`.

---

## 3. Telemetry and Alarm Strategy

Standard OpenTelemetry spans are injected at all invariant validation gates:

1.  **OTel Span Names:**
    *   `invariant.violation` — emitted when a fatal invariant check trips.
    *   `execution.fence_rejected` — emitted when a worker surrenders because it lost its fence.
2.  **OTel Attributes:**
    *   `invariant.id` (e.g., `S1`, `RP2`, `L2`)
    *   `invariant.severity` (`FATAL` or `INFO_SURRENDER`)
    *   `execution.id`
    *   `worker.id`
    *   `lease.attempt`
3.  **Alarm PromQL Rules:**
    *   `sum(rate(invariant_violation_total[5m])) > 0`: **Critical Alert** (possible data drift or engine bug).
    *   `sum(rate(execution_fence_rejected_total[1h])) > 100`: **Warning Alert** (high lease competition or network partitioning).
