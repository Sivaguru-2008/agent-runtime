# Runtime Constitution

Authoritative source: `apps/api/src/runtime/canonicalSemantics.ts`.

This constitution is executable. Runtime modules must import execution transitions, replay policy, recovery decisions, ambiguity hooks, lease checks, and invariant assertions from `canonicalSemantics.ts`. Compatibility modules may re-export these symbols, but they must not redefine them.

## Authority Rules

1. Execution state changes are legal only when `assertTransition()` accepts them.
2. Replay execution must preserve deterministic prefix equivalence until divergence.
3. A diverged replay may execute only replay-safe tools.
4. External side effects require durable idempotency and lease fencing.
5. Ambiguous external commits transition through `AMBIGUOUS` to `RECONCILIATION_REQUIRED`.
6. Recovery and retry decisions use `RECOVERY_SEMANTICS_MAP` and `assertRetryAllowed()`. Every re-attempt — transient retry, crash/lease-loss recovery, replay re-drive — is serialized through the canonical retry-coordination layer (`runtime/retry/`, invariants `RT1..RT8`): single-flight admission, epoch-keyed exclusive ownership, serialized + throttled recovery, replay/recovery mutual exclusion, reconciliation gating, fence-validated ownership, retry backpressure, and a bounded storm guard. See [retry-coordination.md](./retry-coordination.md).
7. Durable lease-owned mutations require a positive fencing token and ownership identity.
8. Runtime startup or tests may call `runStructuralValidation()` to reject undefined states, unreachable states, illegal transition destinations, terminal states with illegal outgoing edges (only `RESTARTABLE_TERMINAL_STATES`, currently `FAILED`, may leave the terminal set), missing recovery policies, and inconsistent recovery semantics. The recovery taxonomy is checked by `validateRecoveryTable()`, which enforces that every failure code round-trips to its category key, that `recoverable` equals `retryable OR replayable`, and that a `terminal` failure is neither retryable, replayable, nor recoverable. `RUNTIME_CONSTITUTION` runs this validation at module load, so any drift fails fast on import.

## Canonical States

`CREATION`, `SCHEDULING`, `LEASE_ACQUISITION`, `RUNNING`, `SIDE_EFFECT_PENDING`, `REPLAYING`, `RECOVERING`, `COMMITTED`, `COMPLETED`, `FAILED`, `AMBIGUOUS`, `RECONCILIATION_REQUIRED`, `DEAD_LETTERED`, `EXPIRED`, `QUEUED`, `CANCELLED`.

## Compatibility

`runtime/stateMachine.ts`, `runtime/invariants.ts`, `runtime/failure/failureSemantics.ts`, `runtime/failure/failureClassification.ts`, `runtime/toolRegistry.ts`, and `domain/replay.ts` retain legacy import paths by re-exporting canonical definitions.
