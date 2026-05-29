# Canonical Replay Semantics Specification

This document formalizes the canonical replay semantics for the AI execution runtime. It shifts the runtime core from "fake determinism" (simulating identical execution under non-deterministic conditions) to strict, verifiable **replay-equivalent execution**.

Implementation: `apps/api/src/runtime/replay/replayExecutionCoordinator.ts`, `replayEquivalentSemantics.ts`, `replayLifecycle.ts`, `replayAssertions.ts`.

---

## 0. Replay Lifecycle States

| State | Meaning |
|---|---|
| `REPLAY_PENDING` | Child execution registered; parent log loaded; no steps reconstructed yet. |
| `REPLAYING` | Active reconstruction in progress. |
| `REPLAY_EQUIVALENT` | Current prefix matches parent `EXECUTION_STEP_COMPLETED` events; live APIs suppressed. |
| `REPLAY_DIVERGED` | Input/order/log mismatch; sandbox active for remaining live steps. |
| `REPLAY_UNSAFE` | Blocked non-safe live side effect attempted after divergence. |
| `REPLAY_ABORTED` | Replay cancelled (abort, fence loss, failure). |
| `REPLAY_VERIFIED` | Full prefix replay completed with observable equivalence to parent. |

Transitions are enforced by `assertReplayLifecycleTransition` (see `replayLifecycle.ts`). Domain events: `REPLAY_DIVERGENCE_DETECTED`, `REPLAY_LIFECYCLE_TRANSITIONED`.

---

## 1. Core Definition of Replay Equivalence

> **A replay $E'$ of an execution $E$ is replay-equivalent if the event sequence it produces satisfies: for every event in $E'$ whose causal ancestors are fully recorded in $E$, the event's payload is byte-identical to its counterpart in $E$.**

Equivalence is enforced at the **event boundary**, not at the wall clock, RNG seed, or LLM-output generation level.

---

## 2. Replay Guarantees

The AI runtime provides the following guarantees during a replay:

1. **Verbatim Replay of Persisted Outputs**: Any step (e.g., `PLANNING`, `MEMORY_RETRIEVAL`, `TOOL_CALL`, `MODEL_GENERATION`) that occurred in $E$ and has a corresponding `EXECUTION_STEP_COMPLETED` event will be replayed verbatim. No live LLM completion, external database lookup, or tool invocation is performed.
2. **Clock Freezing (Deterministic Durations)**: The replayed step events preserve the original `startedAt`, `completedAt`, and `durationMs` values verbatim, preventing clock drift.
3. **Strict Prefix Equivalence**: Until the replay diverges, all emitted events (including nested events like `MEMORY_RETRIEVED`, `MODEL_COMPLETED`, or `TOOL_CALLED`) are payload-byte-identical and emitted in the exact sequence as original execution $E$.
4. **Stable Causal Ordering**: Steps are executed in the exact `(stepSeq, subseq)` order declared originally.

---

## 3. What Replay Does NOT Guarantee

1. **LLM API Determinism**: Replay relies on replaying the **recorded** LLM response (`MODEL_COMPLETED` payload), not on re-querying the LLM. Any live re-querying is classified as a fresh run, not a replay.
2. **External System Timestamps**: Replays are mapped to a new execution ID and branch; while step durations are frozen, the execution record's overall metadata captures the current database transaction times.
3. **In-Memory/In-Process Side Effects**: Unregistered local variables, process memory state, or non-SDK filesystem writes are not snapshotted.
4. **Verbatim Replay on Drift**: If the execution input or sequence is edited, the prefix remains equivalent up to the drift point, after which live execution takes over (with sandbox isolation active).

---

## 4. Boundaries of Determinism

| Boundary | Recorded Event | Replay Behavior |
|---|---|---|
| **LLM Call** | `MODEL_COMPLETED` | Bypassed. Returns persisted response body and token usage. |
| **Tool Call** | `TOOL_CALLED` / `TOOL_CALL_SUCCEEDED` | Bypassed under equivalence. Uses captured output in `tool_call_dedup`. |
| **Clock Read** | `CLOCK_READ` | Returns frozen recorded timestamp. |
| **RNG Read** | `RNG_READ` | Returns frozen recorded value or seeded equivalent. |

---

## 5. Replay-Equivalent Behavior Rules

1. **No-Edit Path**: If the task input, step order, and agent code remain identical, the replay is **100% equivalent** (`replay-equivalent`).
2. **Divergence Path**: If a mismatch is detected (different input parameters, different step ordering, or missing events):
   - Switch safety classification from `replay-equivalent` to `replay-diverged`.
   - Publish a `REPLAY_DIVERGENCE_DETECTED` event outlining the reason (`INPUT_MISMATCH`, `ORDER_MISMATCH`, or `MISSING_STEP`).
   - Fall back to live execution for the remaining steps.
   - Activate the **Replay Sandbox** to block any non-safe/state-mutating tool calls.
