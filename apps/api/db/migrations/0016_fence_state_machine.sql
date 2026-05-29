-- 0016_fence_state_machine.sql
--
-- Canonical fence state machine per docs/specs/fence-state-machine.md.
--
-- Migrations 0010 + 0015 gave the dedup table a deterministic key, a reserved
-- marker, terminal COMPLETED/FAILED, args_hash drift detection and a forensic
-- fence_token_at_reserve. What it CANNOT express is the explicit lifecycle the
-- hardened protocol requires:
--
--     PENDING → EXECUTING → COMMITTED | FAILED | AMBIGUOUS
--               AMBIGUOUS → RECONCILING → RECONCILED | FAILED | EXPIRED
--               FAILED | EXPIRED → PENDING   (restartable re-open)
--
-- The dedup row's RESERVED status conflates PENDING (no effect dispatched) with
-- EXECUTING (effect in flight), and has no representation for AMBIGUOUS /
-- RECONCILING / RECONCILED / EXPIRED. That distinction is exactly what makes a
-- crash-after-side-effect recoverable: we must know whether the external call
-- was ever dispatched.
--
-- This migration adds a dedicated `execution_fences` table — one row per
-- (execution_id, step_seq) — that is the authoritative ledger of fence state.
-- The dedup table remains the remote-idempotency-key + output cache; the fence
-- table is the correctness state machine. They are kept consistent by the
-- application (FenceProtocol), not by a DB trigger, because the protocol must
-- also thread the key into the remote call between the two writes.
--
-- The CHECK constraints encode the same legal-state and legal-resolution sets
-- the TypeScript table enforces, so an out-of-band UPDATE cannot put a row into
-- an undefined state. Transition legality (which from→to edges are allowed) is
-- enforced by the application CTE in postgresFenceStore.ts, which mirrors
-- src/runtime/fence/fenceState.ts.

begin;

create table if not exists execution_fences (
  fence_id        text primary key,
  execution_id    text not null,
  step_seq        integer not null,
  tenant_id       text not null,
  tool_name       text not null,
  idempotency_key text not null,
  args_hash       text not null,
  state           text not null
    check (state in ('PENDING','EXECUTING','COMMITTED','FAILED',
                     'AMBIGUOUS','RECONCILING','RECONCILED','EXPIRED')),
  -- Worker currently responsible for the fence and the lease attempt that
  -- owns it. The CAS in postgresFenceStore.ts gates every transition on
  -- lease_attempt (monotonic or exact) so a stale worker can never mutate.
  owner_worker_id text not null,
  lease_attempt   bigint not null check (lease_attempt > 0),
  output          jsonb null,
  last_error      text null,
  resolution      text null check (resolution in ('COMMITTED','FAILED','ABANDONED')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One fence per logical step. This is the structural guarantee behind
  -- side-effect uniqueness (invariant S1/F3): two reservations for the same
  -- (execution_id, step_seq) collapse onto one row.
  constraint execution_fences_step_unique unique (execution_id, step_seq)
);

-- Replay / recovery lookup: "what is the fence for step N of execution X?"
create index if not exists idx_execution_fences_step
  on execution_fences (execution_id, step_seq);

-- Reaper scan: find PENDING/EXECUTING/AMBIGUOUS fences older than the lease
-- TTL so a sweeper can EXPIRE or reconcile them.
create index if not exists idx_execution_fences_active
  on execution_fences (state, updated_at)
  where state in ('PENDING','EXECUTING','AMBIGUOUS','RECONCILING');

-- Tenant-scoped forensics.
create index if not exists idx_execution_fences_tenant
  on execution_fences (tenant_id, created_at desc);

comment on table execution_fences is
  $cmt$Authoritative per-(execution_id, step_seq) fence state machine (docs/specs/fence-state-machine.md). Eight explicit states; every external side effect must hold a fence in EXECUTING before it fires. Transition legality + ownership are enforced by the application CAS in postgresFenceStore.ts.$cmt$;

comment on column execution_fences.state is
  'One of PENDING, EXECUTING, COMMITTED, FAILED, AMBIGUOUS, RECONCILING, RECONCILED, EXPIRED.';
comment on column execution_fences.lease_attempt is
  'Lease attempt that owns the fence. Transitions are gated monotonically (>=) or exactly (==) on this value — a stale attempt is rejected, never applied (invariant F4).';
comment on column execution_fences.resolution is
  'Set when the fence settles: COMMITTED (effect took), FAILED (effect did not take), ABANDONED (verification gave up).';

commit;
