# Replay Safety Policy Documentation

To ensure high-integrity and coordinate state mutations safely in clustered environments, this document establishes the **Replay Safety Classifications** and the governing policies for each category.

---

## 1. Safety Classifications

The runtime enforces four safety classifications over executions, steps, and tool calls:

### 1. `replay-safe`
- **Definition**: Operations that are purely read-only, side-effect-free, or idempotent, making them safe to execute live at any time (even during a drifted replay).
- **Examples**: `web.search`, `file.read`, `memory.summarize`, `runtime.inspect`, `code.execute` (in a restricted vm sandbox).
- **Policy**: Allowed to run live under all execution modes, including diverged replays.

### 2. `replay-equivalent`
- **Definition**: A replay execution that perfectly mirrors the event payloads and ordering of the original execution prefix.
- **Enforcement**: Any step executed in this state returns the persisted output verbatim from the parent execution events. Clock values and nested events are replicated, and no live APIs or tools are touched.
- **Policy**: The ideal replay state. Bypasses all live actions, ensuring 100% safety and determinism.

### 3. `replay-diverged`
- **Definition**: A replay execution that has branched or drifted from the original execution (due to modified inputs, changed step sequences, or missing events).
- **Enforcement**: The execution status transitions to `RUNNING`, allowing live execution for safe steps. However, the Replay Sandbox is activated for the remainder of the run.
- **Policy**: Permitted to continue executing, but subject to strict sandboxing boundaries.

### 4. `replay-unsafe`
- **Definition**: Operations that perform state mutations or non-idempotent side effects in external production systems.
- **Examples**: `sandbox.payment_refund` (Stripe charges), `sandbox.db_write` (database writes), third-party notification APIs.
- **Policy**: **Strictly blocked under replay.** Any attempt to execute a `replay-unsafe` operation during a replaying run (once diverged) throws `ReplaySandboxViolationError` immediately, transitioning the execution to a failed state to protect production integrity.

---

## 2. Enforcement Policy Matrices

### Replay Gating Matrix

| State | Safe Tool (`replay-safe`) | Unsafe Tool (`replay-unsafe`) | LLM Calls | Checkpoint Writes |
|---|---|---|---|---|
| **`replay-equivalent`** | Bypassed (returns cached) | Bypassed (returns cached) | Bypassed (returns cached) | Emitted (with original sequence) |
| **`replay-diverged`** | Executed Live | **BLOCKED (Throws error)** | Executed Live | Executed Live |

---

## 3. Operational Integrity Guidelines

- **Annotating Safe Tools**: All new tools added to the runtime must be annotated in the tool registry. Tools that perform database writes, charge users, send emails, or access non-idempotent third-party endpoints must be omitted from the safe set.
- **Developer/Admin Audits**: Divergence incidents are logged as `REPLAY_DIVERGENCE_DETECTED` events. Operators should monitor these events to identify unexpected non-determinism, code changes, or external data drift.
