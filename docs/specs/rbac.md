# Role-Based Access Control (RBAC)

Production-grade authorization for the agent runtime API. This document is the
reference for the role model, the capability matrix, where each protected
resource is enforced, and how authorization decisions are audited.

> Source of truth for the matrix: `apps/api/src/infrastructure/security/permissions.ts`.
> The `role_permissions` DB table (migration `0026_rbac_roles.sql`) is a snapshot
> of that matrix for forensics/BI — it is **not** read for live enforcement.

## 1. Roles

Six canonical roles. Five form an **operational chain** (each a strict superset
of the one below); `auditor` is a **side role** for read-only compliance.

| Role        | Weight | Summary |
|-------------|:------:|---------|
| `owner`     |  60    | Superuser. Every permission, including tenant lifecycle and minting keys at any role. |
| `admin`     |  50    | Tenant configuration, API-key management, audit read, all operator powers. |
| `operator`  |  40    | Recovery / break-glass / cluster controls, certification capture, observability. |
| `developer` |  30    | Create agents, run tasks, replay & branch, tool execution (own tenant). |
| `auditor`   |  20    | **Read-only compliance**: audit log, certifications, observability, tenant metadata. No writes. |
| `viewer`    |  10    | Minimal read of own agents / executions / replays. |

The legacy `readonly` label maps to `viewer`
(`normalizeRole()` at the auth boundary; migration rewrites stored rows).

### Why a capability matrix, not just a weight ladder

A linear weight ladder cannot express `auditor`: it needs **broader read** than
`developer` (audit log, certifications) but **zero write**. Any single weight
high enough to read the audit log on a ladder would also unlock writes. So the
named protected resources are enforced by an explicit per-role permission set;
the weight ladder is retained only for coarse `requireRole()` gating of
operator/cluster diagnostics.

## 2. Permission matrix

Permissions are named `<resource>:<action>`. ✓ = granted.

| Permission            | viewer | auditor | developer | operator | admin | owner |
|-----------------------|:------:|:-------:|:---------:|:--------:|:-----:|:-----:|
| `agent:read`          |   ✓    |    ✓    |     ✓     |    ✓     |   ✓   |   ✓   |
| `execution:read`      |   ✓    |    ✓    |     ✓     |    ✓     |   ✓   |   ✓   |
| `replay:read`         |   ✓    |    ✓    |     ✓     |    ✓     |   ✓   |   ✓   |
| `agent:write`         |        |         |     ✓     |    ✓     |   ✓   |   ✓   |
| `execution:write`     |        |         |     ✓     |    ✓     |   ✓   |   ✓   |
| `replay:write`        |        |         |     ✓     |    ✓     |   ✓   |   ✓   |
| `tool:execute`        |        |         |     ✓     |    ✓     |   ✓   |   ✓   |
| `certification:read`  |        |    ✓    |     ✓     |    ✓     |   ✓   |   ✓   |
| `certification:write` |        |         |           |    ✓     |   ✓   |   ✓   |
| `recovery:execute`    |        |         |           |    ✓     |   ✓   |   ✓   |
| `observability:read`  |        |    ✓    |           |    ✓     |   ✓   |   ✓   |
| `tenant:read`         |        |    ✓    |           |    ✓     |   ✓   |   ✓   |
| `audit:read`          |        |    ✓    |           |          |   ✓   |   ✓   |
| `tenant:configure`    |        |         |           |          |   ✓   |   ✓   |
| `apikey:manage`       |        |         |           |          |   ✓   |   ✓   |
| `tenant:admin`        |        |         |           |          |       |   ✓   |

> `tenant:admin` is owner-exclusive and reserved for destructive tenant
> lifecycle (delete / ownership transfer). Admins can still *provision* tenants
> via `tenant:configure`, so there is no owner-bootstrap deadlock.

**Inheritance** is built by union along the chain, so a permission added to
`developer` automatically flows up to operator/admin/owner.
**Least privilege**: `auditor` holds no mutating permission; `viewer` holds only
the three reads; `auditor` and `developer` are deliberately incomparable.

## 3. Protected resources → enforcement

Authorization is layered: **middleware** (API-key auth attaches the tenant
context) → **per-route guard** (`requirePermission` / `requireRole`) → **tenant
ownership** (`TenantGuard.assertOwns*`, with owner/admin cross-tenant bypass).

| Protected resource     | Routes (examples)                                                        | Permission |
|------------------------|--------------------------------------------------------------------------|------------|
| **Replay access**      | `POST /executions/:id/replay`, `POST /replay/:id/{seek,play,snapshot}`, `POST /replay/branch`, `POST /cognition/:id/{replay,checkpoints}`, `GET /operator/replay/:id` | `replay:write` (mutations) / `replay:read` (scrubber) |
| **Certifications**     | `GET /executions/:id/certification`, `POST /executions/:id/certification` | `certification:read` / `certification:write` |
| **Recovery controls**  | `POST /cluster/recover`, `POST /cluster/workers/:id/{drain,stop}`, `POST /cluster/workers`, `POST /operator/executions/:id/{pause,resume,inject}`, `POST/DELETE /operator/freeze`, `POST /admin/dlq/:id/resolve` | `recovery:execute` |
| **Execution controls** | `POST /agents/:id/{start,stop,tasks}`, `POST /cognition`, `POST /agent/run`, `POST /executions/:id/analyze-failures`, `…/full-analysis` | `execution:write` |
| **Tool execution**     | `POST /agents/:id/tasks` (also requires `execution:write`)               | `tool:execute` |
| **Tenant configuration** | `POST /admin/tenants`, `PATCH /admin/tenants/:id/quotas`, `POST /admin/retention/*` (`tenant:configure`); `POST/GET/DELETE /admin/api-keys` (`apikey:manage`) | `tenant:configure` / `apikey:manage` |
| Observability          | `GET /cluster/*`, `GET /observability/*`, `GET /operator/*` reads, `GET /agent/metrics`, `GET /admin/dlq` | `observability:read` |
| Compliance / audit     | (audit-read surfaces)                                                    | `audit:read` |

### Privilege-escalation guard

`POST /admin/api-keys` additionally rejects minting a key whose role exceeds the
caller's own weight — an `admin` cannot create an `owner` key. Only `owner` can
mint `owner`/`admin` keys.

### Bootstrapping the first owner

Because of the escalation guard, no API path can mint the initial `owner` key
(and a freshly-migrated DB has none). Seed it out-of-band — the same way the
first admin key has always been created:

```
DATABASE_URL=postgres://… node scripts/seed-owner-key.mjs [--tenant <id>] [--name <label>]
```

The script stores only the SHA-256 hash and prints the raw key once. It refuses
to create a second active owner for a tenant unless `--force` is passed.

### Cross-tenant access

`canAccessAllTenants(role)` is `owner || admin`. Every ownership check
(`TenantGuard`, RLS scope, route-level `role === admin` filters) defers to it,
so `owner` inherits admin's cross-tenant reach and no other role can escape its
tenant. Application-layer checks sit on top of the Postgres RLS policies
(`docs/specs/multi-tenant-rls.md`).

## 4. Audit logging of authorization decisions

`requirePermission()` / `requireRole()` stamp `request.authz`
(`{ decision, permission?, requiredRole?, actorRole? }`):

- **Denials** emit an immediate structured `warn` log
  (`security: "AUTHZ_DENY"`) — a real-time signal independent of the
  fire-and-forget audit write.
- The audit logger (`onResponse`) persists `authz` into
  `audit_log.metadata.authz` alongside the action, actor role, status code, IP,
  and request id. Forensic queries can therefore answer *“which keys were denied
  `recovery:execute` last week”* by joining `audit_log` against `role_permissions`.

## 5. Database

Migration `0026_rbac_roles.sql`:

1. Rewrites existing `api_keys.role = 'readonly'` → `'viewer'`.
2. Replaces the `api_keys` role CHECK constraint with the 6-role allow-list.
3. Sets the column default to `'viewer'` (least-privilege default).
4. Creates and populates `role_permissions(role, permission)` — the queryable
   snapshot of the matrix, rebuilt idempotently on each run.

## 6. Extending the model

1. Add the literal to `Permission` and `ALL_PERMISSIONS` in `permissions.ts`.
2. Grant it in the appropriate base set(s); inheritance propagates upward.
3. Guard the route with `requirePermission("<new>")`.
4. Add the rows to `role_permissions` in a new migration.
5. Add matrix + enforcement assertions to `apps/api/test/rbac.test.ts`.

Because `requirePermission` accepts only a typed `Permission`, an unmapped
string cannot accidentally guard a route — the compiler rejects it.
