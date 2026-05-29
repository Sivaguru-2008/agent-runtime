# Idempotency Capability Policy & Safety Matrices

This document defines the formal correctness contracts, capability classifications, and safety enforcement policies for all integrations and tools within our correctness-critical distributed AI runtime.

---

## 1. Side-Effect Capability Classifications

Every tool or remote integration registered with the runtime must declare one of the following side-effect capability classes:

| Capability Class | Replay Policy | Retry Policy | Verification Model | Example Integrations |
| :--- | :--- | :--- | :--- | :--- |
| **`SAFE_IDEMPOTENT`** | Safe to execute live at any time (even after replay divergence). | Safe to auto-retry freely on transient failure. | None (Read-only or naturally side-effect-free). | `web.search`, `file.read`, `code.execute`, `memory.summarize`, `runtime.inspect` |
| **`CONDITIONALLY_IDEMPOTENT`** | Safe to retry/replay only if executing inside a valid durable fence. | Safe to retry only under active fence verification. | Fence verification (verifies claimant token, epoch, and step sequence). | `sandbox.db_write` (using unique transactional fences). |
| **`NON_IDEMPOTENT`** | Never safe to execute live during replay (must match deterministic cache). | Prohibited from auto-retry without first performing reconciliation lookup. | Auto-reconciliation via the Reconciliation Engine (verifies key + args fingerprint). | `sandbox.payment_refund` (Stripe payments/refunds). |
| **`UNSAFE`** | Never safe to execute or retry without explicit human/operator approval. | Prohibited from auto-retry. Requires manual override. | Manual operator override (quarantined in `RECONCILIATION_REQUIRED` state). | Custom high-privilege operations, irreversible shell executions. |

---

## 2. Retry Legality Matrix

The following matrix dictates the legality of retries under different failure and capability scenarios:

| Failure Type / Step Mode | `SAFE_IDEMPOTENT` | `CONDITIONALLY_IDEMPOTENT` | `NON_IDEMPOTENT` | `UNSAFE` |
| :--- | :---: | :---: | :---: | :---: |
| **Transient Error (e.g. timeout)** | **ALLOWED** (Auto-retry) | **ALLOWED** (Only with valid Fencing Token) | **BLOCKED** (Requires reconciliation) | **BLOCKED** (Requires Operator Approval) |
| **Deterministic Crash (after side-effect)** | **ALLOWED** (No side-effects) | **ALLOWED** (Fence filters double-fire) | **BLOCKED** (Requires reconciliation) | **BLOCKED** (Requires Operator Approval) |
| **Unreconciled Ambiguity** | **ALLOWED** | **BLOCKED** (Fence Monotonicity) | **BLOCKED** (Quarantine / DLQ) | **BLOCKED** (Operator Quarantine) |
| **Operator Override (COMMIT)** | **ALLOWED** | **ALLOWED** (Re-uses token) | **ALLOWED** (Bypasses execution) | **ALLOWED** (Bypasses execution) |
| **Operator Override (ABORT)** | **BLOCKED** (Terminated) | **BLOCKED** (Terminated) | **BLOCKED** (Terminated) | **BLOCKED** (Terminated) |

---

## 3. Replay Safety Matrix

Replays run executions from recorded event histories. The following matrix determines the sandboxing behavior of the replay engine when running tool steps:

| Step Match / Divergence State | `SAFE_IDEMPOTENT` | `CONDITIONALLY_IDEMPOTENT` | `NON_IDEMPOTENT` | `UNSAFE` |
| :--- | :---: | :---: | :---: | :---: |
| **Matches Recorded Step (Deterministic Prefix)** | **ALLOWED** (Return cached) | **ALLOWED** (Return cached) | **ALLOWED** (Return cached) | **ALLOWED** (Return cached) |
| **Step Arguments Drifted (Before Divergence)** | **ALLOWED** (Re-execute live) | **BLOCKED** (Throws divergence) | **BLOCKED** (Throws divergence) | **BLOCKED** (Throws divergence) |
| **Diverged (Running Live Code Branch)** | **ALLOWED** (Safe live execute) | **BLOCKED** (Throws Invariant `RP1`) | **BLOCKED** (Throws Invariant `RP1`) | **BLOCKED** (Throws Invariant `RP1`) |

---

## 4. Integration Correctness Contracts

To ensure correctness and eliminate safety degradation, all new integration/reconciliation contracts must adhere to the following rules:

1. **Explicit Capability Declarations (`CAP1`)**: Every provider must implement the `getCapability()` method returning its side-effect safety level. Failure to declare capability causes the runtime to crash instantly rather than falling back to an unverified state.
2. **Idempotency Stability (`CAP2`)**: For `CONDITIONALLY_IDEMPOTENT` and `NON_IDEMPOTENT` integrations, the `idempotencyKey` must be derived deterministically from the execution flow coordinate `(executionId, stepSequence)` rather than call arguments, preventing argument drift from generating duplicate remote side effects.
3. **Deterministic Verification Fingerprints (`CAP4`)**: Every non-idempotent provider contract must supply a `verifyIdempotency` implementation that hashes and compares arguments to detect argument drift at the remote provider's boundary before executing reconciliation lookup.
4. **Fail-Closed Escalation**: If verification lookup returns `UNKNOWN` or throws a partition error, the reconciliation engine must quarantine the execution in `RECONCILIATION_REQUIRED` and alert operators rather than falling back to dangerous retry.
