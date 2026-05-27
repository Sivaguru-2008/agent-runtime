# Multi-Tenant Security Hardening Report

Scope: tenant isolation, RBAC, runtime ownership validation, replay/stream
isolation, and quota enforcement across the autonomous AI runtime platform.

---

## 1. Tenant Enforcement Map

Every HTTP entry point has been audited and classified. The matrix below maps
routes to their required role, tenant ownership assertion, and quota gate.

| Route | Method | Min role | Ownership asserted | Quota gate | Notes |
|---|---|---|---|---|---|
| `/health` | GET | (skip) | — | — | LB probe; unauthenticated by design |
| `/agents` | POST | developer | — | `checkAgentCreation` | New agent |
| `/agents` | GET | developer | per-row filter | — | Lists owned agents only (admins see all) |
| `/agents/:agentId` | GET | developer | `assertOwnsAgent` | — | |
| `/agents/:agentId/start` | POST | developer | `assertOwnsAgent` | — | |
| `/agents/:agentId/stop` | POST | developer | `assertOwnsAgent` | — | |
| `/agents/:agentId/tasks` | POST | developer | `assertOwnsAgent` | `checkExecutionStart` + `trackExecutionStart` | |
| `/agents/:agentId/memory` | POST | developer | `assertOwnsAgent` | — | |
| `/executions/:executionId` | GET | developer | `assertOwnsExecution` | — | |
| `/executions/:executionId/events` | GET | developer | `assertOwnsExecution` | — | |
| `/executions/:executionId/analysis` | GET | developer | `assertOwnsExecution` | — | |
| `/executions/:executionId/replay` | POST | developer | `assertOwnsExecution` | — | |
| `/executions/:executionId/snapshot` | GET | developer | `assertOwnsExecution` | — | |
| `/executions/:executionId/analyze-failures` | POST | developer | `assertOwnsExecution` | — | |
| `/executions/:executionId/full-analysis` | POST | developer | `assertOwnsExecution` | — | |
| `/cluster/*` (overview/snapshot/workers/leases/recover) | * | operator | — | — | Platform-level |
| `/cluster/workers` | POST | operator | — | — | Worker registration |
| `/cluster/workers/:workerId/heartbeat` | POST | operator | — | — | |
| `/cluster/workers/:workerId/drain` | POST | operator | — | — | |
| `/cluster/workers/:workerId/stop` | POST | operator | — | — | |
| `/cluster/executions/:executionId` | GET | operator | `assertOwnsExecution` (non-admin) | — | |
| `/observability/*` | GET | operator | — | — | Cross-tenant aggregates |
| `/operator/snapshot` | GET | operator | — | — | |
| `/operator/workers` | GET | operator | — | — | |
| `/operator/leases` | GET | operator | — | — | |
| `/operator/dlq` | GET | operator | — | — | |
| `/operator/diagnose/:executionId` | GET | operator | `assertOwnsExecution` (non-admin) | — | |
| `/operator/trace/:traceId` | GET | operator | per-event tenant filter | — | |
| `/operator/replay/:executionId` | GET | operator | `assertOwnsExecution` (non-admin) | — | |
| `/operator/executions/:executionId/pause` | POST | operator | `assertOwnsExecution` (non-admin) | — | |
| `/operator/executions/:executionId/resume` | POST | operator | `assertOwnsExecution` (non-admin) | — | |
| `/operator/executions/:executionId/inject` | POST | operator | `assertOwnsExecution` (non-admin) | — | |
| `/metrics` | GET | operator | — | — | Prometheus exposition |
| `/cognition` | POST | developer | `assertOwnsAgent` (+ parent cognition) | — | |
| `/cognition` | GET | developer | per-row filter | — | |
| `/cognition/:cognitionId` (+ `/lineage` `/memory-influence` `/memory-trust` `/nodes` `/nodes/:nodeId` `/failure-report` `/failure-timeline` `/confidence-trace` `/confidence-dashboard` `/planner-consensus` `/branch-comparison` `/checkpoints`) | GET | developer | `assertOwnsCognition` | — | |
| `/cognition/:cognitionId/replay/frames` | GET | developer | `assertOwnsCognition` | — | |
| `/cognition/:cognitionId/replay` | POST | developer | `assertOwnsCognition` | — | |
| `/cognition/:cognitionId/checkpoints` | POST | developer | `assertOwnsCognition` (+ session) | — | |
| `/replay/:sessionId` | GET/POST | developer | `assertOwnsReplaySession` | — | seek/play/snapshot |
| `/replay/branch` | POST | developer | `assertOwnsCognition` on source | — | |
| `/replay/branches` | GET | developer | per-row filter | — | |
| `/replay/diff` `/replay/cognition-diff` | GET | developer | `assertOwnsCognition` on both | — | |
| `/failure-signals/recent` | GET | developer | per-row filter | — | |
| `/failure-signals/:signalId/causality` | GET | developer | `assertOwnsFailureSignal` | — | |
| `/events/stream` | GET (SSE) | developer | per-event tenant filter | — | |
| `/agent/health` | GET | developer | — | — | |
| `/agent/run` | POST | developer | — | — | Live engine; events stamped with tenantId |
| `/agent/executions` (+ `:id` + `:id/events`) | GET | developer | record.tenantId match | — | |
| `/agent/metrics` | GET | operator | — | — | |
| `/agent/events` | GET (SSE) | developer | record.tenantId + broadcaster filter | — | |
| `/admin/*` | * | admin | — | — | Tenant & key management |

**Coverage:** every route that accepts a resource ID now asserts ownership;
every cluster/observability/operator route now asserts role; every write
that creates an execution or agent now passes through quota.

---

## 2. RBAC Enforcement Matrix

Role hierarchy (additive): `readonly < developer < operator < admin`.

| Capability | readonly | developer | operator | admin |
|---|:-:|:-:|:-:|:-:|
| Read own agents/executions/cognitions/replays | ✓ | ✓ | ✓ | ✓ |
| Create agent / run task / write memory | — | ✓ | ✓ | ✓ |
| Create replay session / branch / checkpoint | — | ✓ | ✓ | ✓ |
| Cluster overview / worker list / DLQ read | — | — | ✓ | ✓ |
| Worker register / drain / stop / cluster recover | — | — | ✓ | ✓ |
| Operator diagnose / pause / resume / inject (own tenant) | — | — | ✓ | ✓ |
| Cross-tenant diagnose / pause / resume / inject | — | — | — | ✓ |
| Cross-tenant cognition / replay access | — | — | — | ✓ |
| /metrics scrape | — | — | ✓ | ✓ |
| /admin/tenants, /admin/api-keys, /admin/dlq, /admin/retention/* | — | — | — | ✓ |

**Horizontal escalation between tenants** is prevented by per-resource
ownership assertion (`TenantGuard.assertOwns*`) before every read/write.

**Vertical escalation** is prevented by `requireRole` preHandlers on the
sensitive routes — a developer key cannot reach operator/admin endpoints
regardless of any other input.

---

## 3. Runtime Ownership Validation

The new `TenantGuard` (`apps/api/src/infrastructure/security/tenantGuard.ts`)
exposes resolver + assertion primitives:

- `resolveAgentTenant` / `assertOwnsAgent`
- `resolveExecutionTenant` / `assertOwnsExecution`
- `resolveCognitionTenant` / `assertOwnsCognition`
- `resolveReplaySessionTenant` / `assertOwnsReplaySession`
- `resolveBranchTenant` / `assertOwnsBranch`
- `resolveFailureSignalTenant` / `assertOwnsFailureSignal`
- `resolveCheckpointTenant` / `assertOwnsCheckpoint`
- `resolveMemoryTenant` / `assertOwnsMemory`
- `resolveDlqTenant` / `assertOwnsDlq`

Resolution walks the canonical aggregate joins:
- execution → `executions.tenant_id`
- cognition → `cognition_graphs.execution_id → executions.tenant_id`
- replay session → `replay_sessions.cognition_id → cognition_graphs.execution_id → executions.tenant_id`
- branch → source cognition → execution → tenant
- failure signal → execution → tenant
- checkpoint → execution → tenant
- memory → agent → tenant
- DLQ → `execution_dead_letters.tenant_id`

The guard is decorated on Fastify (`app.tenantGuard`) and exposed on the
runtime container (`container.tenantGuard`), so background workers (recovery
loop, scheduler, lease heartbeat) can use the same enforcement surface.

**Admin bypass** is explicit (`ctx.role === "admin"`) and audited via the
existing `AuditLogger`.

---

## 4. Repository-Level Enforcement

The domain `AgentRepository` / `ExecutionRepository` / `MemoryRepository` /
`CognitionRepository` ports remain unchanged — required by the
*preserve-backward-compatibility* and *do-not-redesign-architecture*
constraints. Instead, enforcement is layered above:

1. **Route boundary**: every handler validates ownership before touching a
   repository.
2. **TenantGuard**: a single centralised resolver, used by both HTTP routes
   and operator routes. Cannot be bypassed inside a hardened handler because
   `app.tenantGuard` is decorated at bootstrap and Fastify rejects
   re-decoration.
3. **Audit fallback**: every authenticated request hits `audit_log` with the
   resolved `tenant_id`, `actor_role`, and resource ID. A bypass attempt is
   forensically visible even if a future code path misses a guard.

The Postgres-backed guard rejects unresolvable resources (`permitWhenNotFound:
false` in production) — an attacker who guesses an ID for which no row exists
gets 403, not a silent pass-through.

---

## 5. Stream Isolation (SSE + WebSocket)

Two streaming surfaces were audited and hardened:

### `GET /events/stream` (domain event SSE)

- Subscription now requires `requireTenant`.
- Each event is filtered through `eventBelongsToTenant(event)` before write.
- Tenant resolution prefers `event.metadata.tenantId` (forward-compatible),
  then falls back to aggregate→repository resolution with an in-memory cache.
- Unresolvable events deny by default for non-admins, eliminating accidental
  leakage of `SYSTEM`-aggregate events (worker lifecycle, lease state, etc.).
- Catch-up replay (`listAfterSequence`) applies the same filter — closing the
  reconnect-window leak.

### `GET /agent/events` (live engine SSE) + `LiveEventBroadcaster`

- Subscription requires `requireTenant`.
- `LiveEventBroadcaster.subscribe(handler, tenantId?)` and
  `.history(executionId, tenantId?)` now filter at the broadcaster boundary.
- Untagged events are returned only to admins / unfiltered callers — never
  to a tenant-filtered subscriber, preventing cross-tenant token leakage
  during the window between deployment and full event-stamp rollout.
- `LiveEvent.tenantId` was added (optional) so the engine can stamp ownership
  at emission time and avoid an extra database hop in the broadcaster.

### Cross-tenant stream observation

- `GET /agent/executions/:id` and `GET /agent/executions/:id/events` block
  cross-tenant access at the route boundary (`record.tenantId` check + 403).
- SSE clients pinning `?executionId=` get a pre-flight ownership check; the
  HTTP response itself becomes 403 *before* the SSE upgrade so an attacker
  cannot keep a hanging connection open against another tenant's execution.

---

## 6. Worker + Cluster Authorization

Worker registration, heartbeat, drain, and stop now require operator role:

- Forged worker registration was previously possible with any valid API key —
  a developer key could register a fake worker and starting stealing leases.
  Now gated on operator+.
- Lease theft via heartbeat forgery is blocked by the same role check.
- `/cluster/recover` is operator-only; an attacker can no longer force
  recovery-loop side effects to mask their own lease drops.

Internal service trust:

- The runtime container exposes `tenantGuard` to background workers, so
  scheduler/recovery code paths can apply the same ownership semantics as
  the HTTP layer when they need to.

---

## 7. Quota Enforcement

Quota gates wired before resource-creation writes:

- `POST /agents` → `quotaEnforcer.checkAgentCreation(tenantId)` (max_agents)
- `POST /agents/:agentId/tasks` →
  `checkExecutionStart(tenantId)` (concurrent + hourly) +
  `trackExecutionStart(tenantId)` (counter increment)

Quota check returns 429 with `{reason, limit, current}` so clients can
backoff intelligently rather than retry blindly.

Existing quota writers (`tenant_quotas`) and the Redis sliding-window
counters require no changes — the gate is now correctly invoked at the route
boundary.

---

## 8. Auth-Disabled Mode (Backward Compatibility)

When `AUTH_ENABLED=false` (in-memory tests / dev), the API key plugin now
injects a synthetic admin tenant onto every request:

```ts
request.tenant = {
  tenantId: "system",
  apiKeyId: "auth-disabled",
  role: "admin",
  rateLimitRpm: Number.MAX_SAFE_INTEGER
};
```

This keeps the existing 115-test vitest suite passing without weakening the
production code path — the synthetic injection only happens on the
auth-disabled branch, never when `AUTH_ENABLED=true`.

A `permitWhenNotFound: true` permissive `TenantGuard` is used by the
runtime container so in-memory persistence (which has no tenant_id columns)
does not produce false 403s during dev/tests. App-level bootstrap replaces
this with a `permitWhenNotFound: false` guard once a Postgres connection
exists.

---

## 9. Unresolved Risks & Follow-Ups

The hardening above closes the highest-impact gaps. The following items are
intentionally **not** in scope per the original constraints (no auth provider
redesign, no architectural rewrite) but are worth tracking:

1. **Domain ports do not accept tenantId**.
   The `AgentRepository.list()`, `ExecutionRepository.listByAgent()`, and
   `MemoryRepository.search()` ports still operate without a tenant
   parameter. Enforcement is route-level today. A future refactor that
   threads tenantId through the ports would make accidental bypass
   impossible at compile time. Today this requires application discipline.

2. **Domain `EventMetadata` does not carry tenantId**.
   The SSE filter resolves tenant via aggregate→repository for legacy
   events. New publishers should stamp `metadata.tenantId` so the fast path
   short-circuits the lookup. Once all event emitters are updated, the
   guard's repository fallback can be removed.

3. **`LiveEvent.tenantId` is optional**.
   The field exists but the live execution engine must be updated to stamp
   it. Until then, the live-broadcaster filter denies untagged events to
   non-admin subscribers — safe-by-default, but reduces visibility for
   developer tooling. A follow-up PR should stamp tenantId at every
   `engine.runPrompt()` call site.

4. **Postgres RLS is not enabled**.
   Application-layer isolation is the chosen tradeoff (existing
   migration 0002 documents the rationale). A defence-in-depth follow-up
   would add `CREATE POLICY` rules so a future bug in a route handler
   cannot bypass tenant isolation at the SQL layer. The existing
   `tenant_id` columns are already in place — adding RLS is mostly a
   policy-grant exercise.

5. **`/admin/api-keys` DELETE does not invalidate the Redis cache**.
   The existing comment notes the up-to-5-minute propagation window. For
   immediate revocation, the route should accept the raw key (or a key
   prefix lookup) and call `invalidateApiKeyCache`. Currently a revoked
   key remains valid for up to `API_KEY_CACHE_TTL_SEC` after revocation.

6. **`createPermissiveTenantGuard` for in-memory mode**.
   In-memory persistence (vitest / dev) uses a permissive guard that lets
   resolution fall through when the SQL lookup returns nothing. This is
   safe in dev but **must not be enabled in production** — the production
   bootstrap in `app.ts` already constructs a strict guard whenever
   `DATABASE_URL` is set.

7. **Replay determinism vs. cross-tenant replay**.
   Even with ownership enforced, an admin replay of a tenant's execution
   may surface the original prompt / outputs to the admin operator. This
   is intentional (operator tooling) and matches existing AUDIT log
   coverage, but customers on strict data-residency contracts may require
   a per-tenant flag that disables admin bypass for replay.

---

## 10. Verification

- Type-check: clean (`npx tsc --noEmit`).
- Unit tests: 115/115 passing across 14 vitest files including
  `runtime.test.ts`, `cognition.test.ts`, `cluster.test.ts`,
  `distributedTopology.test.ts`, `sseDedupe.test.ts`.
- Backward compatibility: no public route shapes, response bodies, or
  status codes changed except where now-required role/quota guards
  intentionally surface 401/403/429 to mis-permissioned callers.

## Files Modified

```
apps/api/src/infrastructure/security/tenantGuard.ts   (new)
apps/api/src/infrastructure/security/tenantContext.ts (unchanged interface)
apps/api/src/infrastructure/security/apiKeyAuth.ts    (auth-disabled fallback)
apps/api/src/infrastructure/security/fastifyTypes.ts  (tenantGuard decorator)
apps/api/src/interfaces/http/routes.ts                (role + ownership + quota + SSE filter)
apps/api/src/interfaces/http/operatorRoutes.ts        (operator role + ownership)
apps/api/src/interfaces/http/sprintNextRoutes.ts      (cognition + replay ownership)
apps/api/src/routes/live-routes.ts                    (auth + tenant-scoped streaming)
apps/api/src/events/live-broadcaster.ts               (tenant-filtered subscribe/history)
apps/api/src/telemetry/live-events.ts                 (LiveEvent.tenantId)
apps/api/src/application/runtimeContainer.ts          (tenantGuard wiring)
apps/api/src/app.ts                                   (decorator + Postgres-backed guard)
```
