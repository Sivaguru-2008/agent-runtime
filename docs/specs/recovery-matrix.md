# Recovery Matrix

Authoritative source: `RECOVERY_SEMANTICS_MAP` in `apps/api/src/runtime/canonicalSemantics.ts`.

| Failure | Retryable | Replayable | Reconcilable | Terminal | Human |
| --- | --- | --- | --- | --- | --- |
| `LEASE_STOLEN` | yes | yes | no | no | no |
| `LEASE_EXPIRY` | yes | yes | no | no | no |
| `HEARTBEAT_TIMEOUT` | yes | yes | no | no | no |
| `CHECKPOINT_FENCE_REJECTED` | yes | yes | yes | no | no |
| `STALE_WORKER_MUTATION` | no | no | no | yes | no |
| `REPLAY_DIVERGENCE` | no | no | yes | yes | yes |
| `TOOL_TIMEOUT` | yes | yes | no | no | no |
| `PROVIDER_TIMEOUT` | yes | yes | no | no | no |
| `TOOL_CRASH` | yes | yes | yes | no | no |
| `PROCESS_CRASH` | yes | yes | yes | no | no |
| `PARTIAL_COMMIT` | yes | no | yes | no | no |
| `TOOL_NON_IDEMPOTENT` | no | no | yes | no | yes |
| `AMBIGUOUS_EXTERNAL_COMMIT` | no | no | yes | no | yes |
| `RECOVERY_ABORTED` | no | no | no | yes | no |
| `EXECUTION_CANCELLED` | no | no | no | yes | no |
| `DLQ_ESCALATED` | no | no | no | yes | yes |
| `NETWORK_PARTITION` | yes | yes | no | no | no |
| `DUPLICATE_DELIVERY` | no | yes | no | no | no |
| `OUTBOX_FAILURE` | yes | yes | yes | no | no |
| `UNKNOWN_RUNTIME_FAILURE` | yes | yes | no | no | no |

Retry paths must call `assertRetryAllowed()`. Ambiguity and non-idempotent failures must not be re-enqueued as ordinary retries.

## Enforced Consistency

`validateRecoveryTable()` (invoked by `runStructuralValidation()` at module load) enforces these invariants over the table above, so the matrix cannot drift silently:

- Every `Failure` code round-trips to its category key.
- `Retryable OR Replayable` equals the category's recoverable-by-default flag (`RECOVERABLE_BY_DEFAULT`). A category is recoverable iff at least one recovery path exists.
- A `Terminal` failure is neither retryable nor replayable, and therefore is never recoverable-by-default. `Reconcilable` and `Human` may still be set on a terminal failure (e.g. `REPLAY_DIVERGENCE`), routing it to manual reconciliation rather than automated retry.
