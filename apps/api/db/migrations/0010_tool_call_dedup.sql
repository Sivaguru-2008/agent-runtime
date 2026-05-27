-- 0010_tool_call_dedup.sql
--
-- Audit finding CRITICAL-1 — tool side effects double-fire under queue
-- redelivery or lease reclaim. The fencing model protects events and state
-- mutations, but tool effects (HTTP, file write, code execution, payment,
-- email) execute before any fence is checked. Under the default 30 s queue
-- visibility timeout, any model call that takes > 30 s causes the job to be
-- re-delivered to a sibling worker, which re-runs the engine end-to-end and
-- fires the same tool calls a second time.
--
-- This migration introduces a durable dedup table the ToolExecutor consults
-- on every call. A stable idempotencyKey (derived deterministically from
-- executionId + stepId + toolName + canonicalized args) maps to the recorded
-- output of the first successful execution.
--
-- Concurrency contract:
--   • An IN_FLIGHT marker is inserted at call start (INSERT … ON CONFLICT DO
--     NOTHING). A sibling worker arriving with the same key sees an existing
--     IN_FLIGHT row and polls for COMPLETED rather than re-executing.
--   • On success the row transitions to COMPLETED with the captured output.
--     Future calls short-circuit and return the cached output.
--   • On failure the row transitions to FAILED with the error message. The
--     ExecutorPolicy (caller-controlled) decides whether to retry from FAILED
--     or treat the failure as terminal — this table records the fact, not
--     the policy.
--
-- Why we do NOT use the events table:
--   We could persist tool dedup via an idempotency-keyed event, but the
--   read pattern is a single point lookup by key with a possible polling
--   wait — a dedicated table with a simple PK and small JSON output column
--   is faster and avoids polluting the event log with tool implementation
--   details. The fact that a tool was called IS captured by TOOL_CALLED;
--   this table only stores what was returned so a second caller can echo it.
--
-- Rollout / backward compatibility:
--   • New table, no existing column changes. Safe to apply against live
--     databases — zero rows means every first call falls through to the
--     real tool (existing behavior).
--   • A future change can flip a feature flag to fail-closed when the
--     executor cannot reach this table; default for now is best-effort.

begin;

create table if not exists tool_call_dedup (
  idempotency_key text primary key,
  execution_id    text not null,
  agent_id        text not null,
  tool_name       text not null,
  -- Lease attempt at the time of the FIRST call. A second attempt with a
  -- different attempt count can decide whether to honor the cache or refuse
  -- (e.g. tools that are bound to a specific attempt of an execution).
  attempt         integer not null,
  status          text not null check (status in ('IN_FLIGHT', 'COMPLETED', 'FAILED')),
  -- Captured response of a successful execution. NULL while IN_FLIGHT.
  output          jsonb null,
  -- Captured error message of a failed execution. NULL while IN_FLIGHT / COMPLETED.
  last_error      text null,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz null,
  -- Tenant for isolation. Required so a tenant cannot read another tenant's
  -- cached tool output via key collision (deterministic keys CAN collide
  -- across tenants if two tenants run the same tool against the same args
  -- — they should still not share the cache).
  tenant_id       text not null
);

-- Hot path lookup is by primary key — covered. Secondary index for forensics
-- ("show me every cached tool call for execution X").
create index if not exists idx_tool_call_dedup_execution
  on tool_call_dedup(execution_id);

-- Forensic / quota index — count tool calls per tenant in a time window.
create index if not exists idx_tool_call_dedup_tenant_created
  on tool_call_dedup(tenant_id, created_at desc);

-- Garbage collection — IN_FLIGHT rows older than (say) 1h are worker crashes
-- that left a marker without a terminal status. A background job promotes
-- them to FAILED so subsequent callers retry instead of polling forever.
-- We do not enforce this with a constraint; the cleanup happens in app code.
create index if not exists idx_tool_call_dedup_inflight_stale
  on tool_call_dedup(created_at)
  where status = 'IN_FLIGHT';

comment on table tool_call_dedup is
  $cmt$Per-call dedup cache for ToolExecutor (audit CRITICAL-1). Each row is the durable receipt of one logical tool invocation, keyed by a deterministic idempotencyKey. Tools with side effects MUST consult this table before executing.$cmt$;

commit;
