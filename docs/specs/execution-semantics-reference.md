# Execution Semantics Reference

Authoritative source: `apps/api/src/runtime/canonicalSemantics.ts`.

## Transition Table

| From | Legal To |
| --- | --- |
| `CREATION` | `SCHEDULING` |
| `SCHEDULING` | `LEASE_ACQUISITION`, `RECOVERING`, `DEAD_LETTERED`, `QUEUED`, `CANCELLED` |
| `LEASE_ACQUISITION` | `RUNNING`, `REPLAYING`, `RECOVERING`, `SCHEDULING`, `DEAD_LETTERED`, `FAILED`, `QUEUED` |
| `RUNNING` | `SIDE_EFFECT_PENDING`, `COMMITTED`, `FAILED`, `EXPIRED`, `AMBIGUOUS`, `RECONCILIATION_REQUIRED`, `CANCELLED` |
| `SIDE_EFFECT_PENDING` | `RUNNING`, `FAILED`, `AMBIGUOUS`, `RECONCILIATION_REQUIRED` |
| `REPLAYING` | `RUNNING`, `COMPLETED`, `FAILED`, `AMBIGUOUS`, `RECONCILIATION_REQUIRED`, `SIDE_EFFECT_PENDING` |
| `RECOVERING` | `RUNNING`, `AMBIGUOUS`, `RECONCILIATION_REQUIRED`, `DEAD_LETTERED`, `FAILED`, `SIDE_EFFECT_PENDING`, `COMMITTED` |
| `COMMITTED` | `COMPLETED`, `FAILED` |
| `COMPLETED` | none |
| `FAILED` | `LEASE_ACQUISITION`, `DEAD_LETTERED` |
| `AMBIGUOUS` | `RECONCILIATION_REQUIRED`, `FAILED`, `COMPLETED`, `RUNNING`, `RECOVERING` |
| `RECONCILIATION_REQUIRED` | `RECOVERING`, `DEAD_LETTERED`, `FAILED`, `RUNNING` |
| `DEAD_LETTERED` | none |
| `EXPIRED` | `RECONCILIATION_REQUIRED`, `DEAD_LETTERED` |
| `QUEUED` | `LEASE_ACQUISITION`, `SCHEDULING`, `RUNNING`, `RECOVERING`, `CANCELLED` |
| `CANCELLED` | none |

## Start Resolution

`resolveExecutionStartStatus()` chooses:

| Condition | Target |
| --- | --- |
| `parentExecutionId` exists | `REPLAYING` |
| current status is `RECOVERING` or fence attempt is greater than 1 | `RECOVERING` |
| otherwise | `RUNNING` |

The chosen target is immediately checked by `assertTransition()`.

## Lease Ownership

Every lease-owned mutation must carry `executionId`, `workerId`, and a positive integer `attempt`. `validateFencingToken()` enforces token shape and optional source-to-target transition legality before a durable write path proceeds.
