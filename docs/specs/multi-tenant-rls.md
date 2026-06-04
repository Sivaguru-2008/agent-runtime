# Multi-Tenant Isolation — Review & RLS Recommendation

_Production-hardening sprint, finding #4._

## 1. Current isolation model (as-found)

Tenant isolation today is **application-layer only**:

- **Auth → TenantContext.** `registerApiKeyAuth` resolves an API key to a
  `{ tenantId, role }` and attaches it to every request (`request.tenant`).
- **RBAC.** `requireRole(minRole)` gates privileged routes.
- **Ownership resolver.** `TenantGuard` resolves a resource's owning tenant
  (via `tenant_id` columns or aggregate→agent/execution joins) and
  `assertOwns*` throws `CrossTenantAccessError` (HTTP 403) on mismatch. Admins
  bypass for operator tooling.
- **Scoped writes.** Repositories carry `tenant_id` on `agents`, `executions`,
  `cognition_graphs`, `memory_records`, `execution_dead_letters`, plus the
  security tables (`api_keys`, `audit_log`, `tenant_quotas`, `quota_usage`,
  `events_archive`, `retention_policies`, `tool_call_dedup`).

Migration `0002_production_hardening.sql` explicitly chose this **"WHERE
tenant_id = $tenantId"** approach _"rather than Postgres RLS"_.

## 2. Audit findings

**Route-layer guard coverage is comprehensive.** Every resource-by-id route in
`routes.ts`, `sprintNextRoutes.ts`, and `operatorRoutes.ts` calls the matching
`guard.assertOwns*` before touching the resource (agents, executions,
cognitions, replay sessions, branches, failure signals, checkpoints, DLQ).
Operator/observability aggregate routes are correctly gated by
`requireRole("operator")` and intentionally cross-tenant.

**Structural weaknesses of an app-layer-only model (the real risk):**

1. **Single point of forgetting.** Isolation depends on every current _and
   future_ route remembering to call `assertOwns*`. One missed call, one new
   repository method, one raw query, or one background job that reads by id
   re-opens the IDOR hole (OWASP API1:2023). There is no backstop.
2. **`permitWhenNotFound` in dev.** The permissive guard (in-memory/dev) returns
   `null` and allows access when a resource→tenant lookup finds no row. This is
   correct for dev but means isolation is *entirely* a production-Postgres
   property — there is nothing below the application asserting it.
3. **Background / queue paths.** Workers, the recovery loop, the outbox
   dispatcher, and DLQ tooling operate with system-level identity and do not run
   the request-scoped guard. Their correctness w.r.t. tenant attribution relies
   on carrying `tenant_id` correctly on every write.

**Defense-in-depth added by this sprint:**

- `0024_tenant_rls.sql` — database-enforced RLS (below).
- `withTenantRlsScope()` (`infrastructure/security/tenantRlsScope.ts`) — the
  per-transaction wiring primitive that activates RLS enforcement, with
  `scopeFromContext()` honoring the admin bypass.

## 3. RLS recommendation & rollout

`0024_tenant_rls.sql` enables + FORCEs RLS on the tenant-scoped resource tables
(`agents`, `executions`, `cognition_graphs`, `memory_records`,
`execution_dead_letters`) with a policy keyed on two transaction-local GUCs:

| GUC | Meaning |
| --- | --- |
| `app.current_tenant` | the requesting tenant; rows of other tenants are invisible |
| `app.bypass_rls=on`  | explicit admin/system cross-tenant bypass |

The policy ships in **non-breaking mode**: it is _enforcing_ for any connection
that sets `app.current_tenant`, and _transparent_ for connections that do not
(today's app code, workers, the migration runner) — so the migration can land
with zero behavioural change.

### Staged rollout to full enforcement

1. **Land `0024`** (non-breaking). RLS is now active for any scoped connection.
2. **Connect as a non-superuser role.** RLS is bypassed for `SUPERUSER` /
   `BYPASSRLS` roles. The app's `DATABASE_URL` role must be ordinary;
   `FORCE ROW LEVEL SECURITY` already subjects the table owner.
3. **Wire `withTenantRlsScope()`** into tenant-scoped repository reads/writes
   (and `scopeFromContext(request.tenant)` at the route boundary). Each call
   sets `app.current_tenant` (and `app.bypass_rls` for admins) for the
   transaction. Adopt incrementally, table by table.
4. **Flip to STRICT mode.** Once every scoped path sets the GUC, apply the
   STRICT policy block at the bottom of `0024_tenant_rls.sql`. It removes the
   "transparent when unset" clause, so a connection with no tenant context (and
   no bypass) sees and writes **nothing** — deny-by-default at the database.

### Caveats

- RLS does not cover the event log / projections that are intentionally
  cross-tenant for operators; those remain gated by `requireRole`.
- Per-transaction `set_config(..., true)` is reset at COMMIT/ROLLBACK, so a
  pooled connection never leaks one request's tenant into the next.
- Migrating the join-only tables (`replay_sessions`, `replay_branches`,
  `failure_signals`, `execution_checkpoints`) to RLS requires either denormalised
  `tenant_id` columns or subquery policies; tracked as follow-up.
