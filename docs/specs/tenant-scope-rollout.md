# Tenant-Scope Rollout — replay, side-effects, recovery, certifications

_Follow-up to `docs/specs/multi-tenant-rls.md` §Caveats. Closes the deferred
"join-only tables" item and extends tenant scoping to side effects, recovery
checkpoints, and certifications._

## 0. Where we started (already shipped, committed)

Application-layer isolation was already comprehensive and is unchanged here:

- **Auth → `TenantContext`** on every authenticated request.
- **`TenantGuard.assertOwns*`** on every resource-by-id route (agents,
  executions, cognitions, replay sessions, branches, failure signals,
  checkpoints, DLQ) → `CrossTenantAccessError` (403).
- **`tenant_id` columns + WHERE-scoped writes** on `agents`, `executions`,
  `cognition_graphs`, `memory_records`, `execution_dead_letters`, and the
  security tables.
- **RLS defense-in-depth** (`0024_tenant_rls.sql`) on those directly-columned
  tables, in non-breaking "transparent when unset" mode, with
  `withTenantRlsScope()` as the per-transaction on-ramp.

`0024` explicitly deferred the **join-only tables** and did not cover side
effects or certifications. This rollout closes that gap.

## 1. What this change adds

### Migration `0025_tenant_scope_replay_sideeffects.sql`

Denormalizes `tenant_id text not null default 'system'` onto the eight
remaining tenant-scoped resource tables, backfills each from its owning
aggregate (best-effort, mirroring `0005`), adds `idx_*_tenant` indexes, and
**extends the `0024` transparent-when-unset RLS policy** to them:

| Requirement bullet | Tables |
| --- | --- |
| Tenant-scoped replay data | `replay_sessions`, `replay_snapshots`, `replay_branches` |
| Tenant-scoped recovery checkpoints | `execution_checkpoints` |
| Tenant-scoped certifications | `replay_certifications` |
| Tenant-scoped side effects | `event_outbox`, `event_outbox_dlq` |
| (failure intelligence) | `failure_signals` |

The migration is **additive and idempotent**: every column defaults to
`'system'`, so legacy writers stay valid; RLS stays transparent for connections
that do not set `app.current_tenant`, so workers, the recovery loop, the outbox
dispatcher, and the migration runner keep working the instant it lands.

### Runtime propagation (defense-in-depth above the DB default)

New writes stamp the real owning tenant rather than relying on the `'system'`
default + backfill:

- **Hot append path** (`postgresExecutionRepository`): `event_outbox` and the
  terminal `execution_checkpoints` insert use `execution.tenantId` — already in
  memory, **no subquery**, and it never touches the dispatcher's claim CTE,
  per-execution FIFO, or fencing (exactly-once + fencing semantics unchanged).
- **Outbox → DLQ**: the dispatcher carries `tenant_id` from the claimed row into
  the DLQ insert, so a dead-lettered side effect keeps its tenant.
- **Cold/operator paths** (`replay_sessions`, `replay_certifications`,
  `execution_checkpoints` fenced/standalone, `failure_signals`): prefer the
  caller-supplied `tenantId`, else `coalesce(..., (select tenant_id from
  executions where id::text = $exec::text), 'system')`. The subquery is a
  text-compare so it **can never raise** — an unresolvable execution simply
  yields `'system'`.
- **`replay_branches`**: resolves via a PK lookup on `cognition_graphs`
  (already tenant-columned by `0005`), so no scan.

Domain types `ReplaySession`, `ReplayCertification`, `ReplayCheckpoint` gained an
**optional** `tenantId` (mirrors `Execution.tenantId`), so reads surface the
owning tenant and back-compat fixtures still type-check.

### Observability

`AgentMetrics.tenantOperationsTotal` — an **additive** counter labelled
`(tenant_id, operation)`. It is deliberately separate from the latency
histograms (which are intentionally cardinality-bounded); a per-tenant label on
those would multiply series by tenant count. Wired at run submission
(`POST /agents/:agentId/tasks`).

### RLS on-ramp

`withSystemRlsScope(db, fn)` sets `app.bypass_rls=on` for the cross-tenant
background paths (recovery loop, outbox dispatcher, DLQ remediation, migration
runner) that legitimately sweep every tenant in one pass. Together with
`withTenantRlsScope()` on request paths, this is what makes the STRICT flip
safe.

## 2. Staged rollout to STRICT (deny-by-default)

RLS is shipped enforcing-when-scoped / transparent-when-unset. To reach
deny-by-default:

1. **Land `0025`** (non-breaking — done by this change).
2. **Connect the app as an ordinary role** (non-`SUPERUSER`, non-`BYPASSRLS`);
   `FORCE ROW LEVEL SECURITY` already subjects the table owner.
3. **Wire the GUC on every path:** `withTenantRlsScope(scopeFromContext(
   request.tenant))` on request-scoped repository reads/writes;
   `withSystemRlsScope` on the background sweeps. Adopt incrementally — until
   STRICT is flipped this is behaviourally a no-op, so partial adoption is safe.
4. **Flip STRICT.** Apply the deny-by-default policy below (a **manual** script,
   NOT an auto-running migration — auto-running it before step 3 completes would
   make every un-scoped connection see/write nothing and strand the workers).

```sql
-- STRICT flip for the 0025 tables. Apply ONLY after step 3 is complete and
-- verified against a real Postgres. Pair with the equivalent 0024 strict block.
begin;
do $$
declare t text;
  scoped_tables text[] := array[
    'replay_sessions','replay_snapshots','replay_branches','failure_signals',
    'execution_checkpoints','replay_certifications','event_outbox','event_outbox_dlq'];
begin
  foreach t in array scoped_tables loop
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format($f$
      create policy tenant_isolation on %I
        using (app_rls_bypassed() or tenant_id = app_current_tenant())
        with check (app_rls_bypassed() or tenant_id = app_current_tenant())
    $f$, t);
  end loop;
end $$;
commit;
```

## 3. Verification status

- **Typecheck:** green (`tsc -p tsconfig.json --noEmit`).
- **Unit (Docker-free):** green, incl. `test/tenantScopePropagation.test.ts`
  (tenantId round-trip, metric, GUC helpers, migration structure).
- **RLS *behaviour* (enforcing vs. transparent vs. bypass) and the backfill
  joins are Postgres features** — they MUST be validated by the integration
  suite (`vitest --config vitest.integration.config.ts`) against testcontainers
  Postgres **before deploy**. That suite requires Docker, which was unavailable
  in the authoring environment, so the SQL is correct-by-construction (mirrors
  the committed `0002`/`0005`/`0024` patterns) but has NOT been executed here.

## 4. Invariants preserved

- **Replay determinism** — `tenant_id` is attribution metadata only; it is never
  folded into any frame digest, chain hash, or fingerprint, and no replay
  computation changed.
- **Exactly-once** — the outbox `tenant_id` is carried through SELECT→INSERT and
  never participates in the claim CTE, visibility timeout, or retry/DLQ
  decisioning.
- **Fencing** — the fence-guarded checkpoint write adds one projected column to
  the `INSERT ... SELECT FROM fence`; the fence CTE gate is untouched.
- **Never break** — every column defaults to `'system'`; RLS is transparent
  until STRICT is manually flipped.
