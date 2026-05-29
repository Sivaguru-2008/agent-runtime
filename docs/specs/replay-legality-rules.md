# Replay Legality Rules

Rules enforced at runtime via `replayAssertions.ts` and `ReplayExecutionCoordinator`.

## 1. When replay is legal

- Child execution MUST set `parentExecutionId` (invariant **RP2**).
- Parent event log MUST be readable and non-empty for recovery replay.
- Fence token, when present, MUST target the child `executionId` (invariant **F6**).
- Only one active coordinator session per child execution id (invariant **RP3**).

## 2. When replay is illegal

| Condition | Result |
|---|---|
| Missing `parentExecutionId` | `InvariantViolation` (RP2) |
| Mutating `aggregateId === parentExecutionId` | `InvariantViolation` (RP3) |
| Concurrent `beginReplay` on same execution | `InvariantViolation` (RP3) |
| Live non-safe tool during `REPLAY_EQUIVALENT` | `InvariantViolation` (CAP3) |
| Live non-safe tool after `REPLAY_DIVERGED` | `InvariantViolation` (RP1) |
| Bypassing fence / ownership checks | `FencingViolationError` / `StaleWorkerSurrender` |

## 3. Replay NEVER

1. Emits real external side effects during equivalent prefix reconstruction.
2. Mutates parent production execution rows or parent event aggregates.
3. Bypasses fence validation on durable writes.
4. Bypasses lease ownership validation when `validateLease` is wired.

## 4. Stale and partial persistence

- **Stale replay**: parent log `max(sequence) > watermark` at `beginReplay` → divergence reason `STALE_PARENT_LOG`.
- **Partial persistence**: missing `EXECUTION_STEP_COMPLETED` at expected index → `MISSING_STEP`.
- **Post-reconciliation replay**: allowed only when tool outcome is read from dedup/events; live `NON_IDEMPOTENT` tools require reconciliation before retry (CAP4).

## 5. Observable-equivalence verification

On successful completion without divergence, coordinator transitions to `REPLAY_VERIFIED` when `replayStepCount === parentCompletedStepCount`. Operators may compare child vs parent step payloads using `stepsObservablyEquivalent`.
