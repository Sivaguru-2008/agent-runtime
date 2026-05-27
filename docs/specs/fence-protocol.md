# Fence Protocol (canonical spec)

Status: canonical. This document replaces the fencing language in the archived
`distributed-topology.md` and `reliability-phase-v3.md` for any new work.

## 0. Why this protocol exists

Tool calls produce **external side effects** — Stripe refunds, emails sent,
rows written to a customer database, files mutated on disk. Those effects
happen outside our transactional boundary. A fence held inside Postgres
cannot retroactively un-charge Stripe.

The only correct way to make external side effects safe under retries is to
thread a **deterministic idempotency key** through every call. The fence
protocol's job is to:

1. Pick that key the same way on every retry, so the remote service can
   dedupe.
2. Ensure that only one worker is logically responsible for the call at any
   instant (so we don't have N workers chasing N keys for the same step).
3. Persist the call outcome in a way that crash-mid-call is recoverable.

The fence is **a coordination token threaded into a key**, not a write lock
over external systems.

## 1. State machine (per (execution_id, step_seq))

```
        ┌────────────┐
        │   NONE     │   (no row in tool_calls)
        └─────┬──────┘
              │  TX1: insert(status=RESERVED, idempotency_key=k,
              │              fence_token_at_reserve=t, args_hash=h)
              ▼
        ┌────────────┐
        │  RESERVED  │   ← crash here = retry with SAME k (remote dedupes)
        └─────┬──────┘
              │  external call returns (200 or error)
              ▼
        ┌────────────┐
        │  RETURNED  │   (in-process; not persisted)
        └─────┬──────┘
              │  TX2: re-validate fence, upsert(status=SUCCEEDED|FAILED,
              │       result_json=r, completed_at=now())
              ▼
        ┌──────────────────────┐
        │ SUCCEEDED │  FAILED  │
        └──────────────────────┘
```

Any transition into a terminal state requires the worker's `fencing_token`
to still match the row in `leases` for the execution. Mismatch ⇒ abort the
TX and let the new owner resolve the call.

## 2. Schema (additive over what exists today)

The existing `tool_call_dedup` table from migration `0010_tool_call_dedup.sql`
is the right substrate. The §B protocol requires three additional columns
and one new index. These are added in a fresh migration:

```sql
ALTER TABLE tool_call_dedup
  ADD COLUMN IF NOT EXISTS fence_token_at_reserve BIGINT NULL,
  ADD COLUMN IF NOT EXISTS args_hash              TEXT   NULL,
  ADD COLUMN IF NOT EXISTS step_seq               INTEGER NULL;

-- Replay lookup path: "what was the recorded outcome of step N?"
CREATE INDEX IF NOT EXISTS idx_tool_call_dedup_replay
  ON tool_call_dedup (execution_id, step_seq)
  WHERE step_seq IS NOT NULL;
```

`leases` is renamed conceptually but the production table is
`execution_leases` and already has `attempt` (the fencing token) per
migration `0008_event_write_fencing.sql`. We use `attempt` as the token —
no schema change needed there.

### Field meanings

| Column | Meaning |
|---|---|
| `idempotency_key` | `sha256(execution_id || ':' || step_seq)`. Stable across retries. |
| `fence_token_at_reserve` | `execution_leases.attempt` observed when the call was reserved. Diagnostic only — the live fence check at commit reads the *current* attempt. |
| `args_hash` | `sha256(canonical_json(args))`. Detects arg drift on replay. Stable for legitimate retries. |
| `step_seq` | Position in the execution's step ordering, assigned at plan time. Stable across retries. |
| `status` | `RESERVED` → `SUCCEEDED` \| `FAILED`. |
| `output` | Captured response body. NULL while `RESERVED`. |
| `last_error` | Captured error message. NULL unless `FAILED`. |

We keep the legacy `IN_FLIGHT` value as a synonym for `RESERVED` during
the migration so existing code doesn't break — application code maps
`IN_FLIGHT → RESERVED` at read time. New writes use `RESERVED`.

## 3. Canonical pseudocode

This is the contract the runtime must implement. Any deviation requires a
spec update, not a code shortcut.

```ts
async function executeTool(
  ctx: { executionId: string; stepSeq: number; myToken: bigint; tenantId: string },
  tool: Tool,
  args: unknown
): Promise<unknown> {
  const idemKey = sha256(`${ctx.executionId}:${ctx.stepSeq}`);
  const argsHash = sha256(canonicalJson(args));

  // ---- TX1: reserve, or recover an existing row ----
  const reserved = await db.tx(async (t) => {
    const lease = await t.query(
      `SELECT attempt AS fencing_token FROM execution_leases
        WHERE execution_id = $1 AND status = 'ACTIVE' FOR UPDATE`,
      [ctx.executionId]
    );
    if (!lease || lease.fencing_token !== ctx.myToken) {
      throw new FencingLost("lease lost before reserve");
    }

    const existing = await t.query(
      `SELECT status, output, args_hash FROM tool_call_dedup
        WHERE execution_id = $1 AND step_seq = $2`,
      [ctx.executionId, ctx.stepSeq]
    );

    if (existing?.status === "SUCCEEDED") {
      return { cached: true, result: existing.output };
    }
    if (existing?.status === "FAILED") {
      // Retry policy decides whether to re-attempt. The dedup row is
      // moved back to RESERVED by the caller before re-entry; we treat
      // an unsolicited FAILED row here as "previous attempt errored,
      // current TX wants to retry" → wipe and reserve.
      await t.query(
        `UPDATE tool_call_dedup
            SET status='RESERVED', output=NULL, last_error=NULL,
                fence_token_at_reserve=$3, args_hash=$4, reserved_at=now()
          WHERE execution_id=$1 AND step_seq=$2`,
        [ctx.executionId, ctx.stepSeq, ctx.myToken, argsHash]
      );
      return { cached: false };
    }
    if (existing?.status === "RESERVED" || existing?.status === "IN_FLIGHT") {
      if (existing.args_hash !== argsHash) {
        throw new ArgDrift(existing.args_hash, argsHash); // INVARIANT I5
      }
      // Same call, same args, mid-flight. We use the SAME idem_key on
      // the upstream call so the remote dedupes the duplicate request.
      return { cached: false };
    }
    // No row → insert RESERVED.
    await t.query(
      `INSERT INTO tool_call_dedup
        (idempotency_key, execution_id, step_seq, tool_name,
         attempt, status, fence_token_at_reserve, args_hash,
         tenant_id, created_at, agent_id)
       VALUES ($1,$2,$3,$4,$5,'RESERVED',$6,$7,$8,now(),$9)`,
      [idemKey, ctx.executionId, ctx.stepSeq, tool.name,
       Number(ctx.myToken), ctx.myToken, argsHash, ctx.tenantId, tool.agentId]
    );
    return { cached: false };
  });

  if (reserved.cached) return reserved.result;

  // ---- External call (the ONLY un-transactional step) ----
  // The tool MUST accept `idempotencyKey` and pass it to the remote.
  let outcome: { kind: "ok"; value: unknown } | { kind: "err"; error: Error };
  try {
    const value = await tool.invoke(args, { idempotencyKey: idemKey });
    outcome = { kind: "ok", value };
  } catch (err) {
    outcome = { kind: "err", error: err as Error };
  }

  // ---- TX2: commit outcome (only if we still hold the fence) ----
  return await db.tx(async (t) => {
    const lease = await t.query(
      `SELECT attempt AS fencing_token FROM execution_leases
        WHERE execution_id = $1 AND status='ACTIVE' FOR UPDATE`,
      [ctx.executionId]
    );
    if (!lease || lease.fencing_token !== ctx.myToken) {
      // We lost the lease while the call was in flight. DO NOT mark
      // succeeded — the new owner is retrying with the same idem_key
      // and will receive the cached remote response. Our local
      // `outcome` is dropped; the row stays at RESERVED for the new
      // owner to converge.
      throw new FencingLost("lease lost during external call");
    }

    if (outcome.kind === "ok") {
      await t.query(
        `UPDATE tool_call_dedup
            SET status='SUCCEEDED', output=$3, completed_at=now()
          WHERE execution_id=$1 AND step_seq=$2`,
        [ctx.executionId, ctx.stepSeq, outcome.value]
      );
      // Domain event emitted within the same TX via the outbox.
      await appendEventFenced(t, ctx, {
        type: "TOOL_CALL_SUCCEEDED",
        stepSeq: ctx.stepSeq,
        idempotencyKey: idemKey,
        output: outcome.value,
      });
      return outcome.value;
    } else {
      await t.query(
        `UPDATE tool_call_dedup
            SET status='FAILED', last_error=$3, completed_at=now()
          WHERE execution_id=$1 AND step_seq=$2`,
        [ctx.executionId, ctx.stepSeq, outcome.error.message]
      );
      await appendEventFenced(t, ctx, {
        type: "TOOL_CALL_FAILED",
        stepSeq: ctx.stepSeq,
        idempotencyKey: idemKey,
        error: outcome.error.message,
      });
      throw outcome.error;
    }
  });
}
```

## 4. Invariants (must hold under chaos)

| ID  | Invariant | Test surface |
|-----|-----------|--------------|
| **I1** | **Side-effect uniqueness.** For any `(execution_id, step_seq)`, the external service either: (a) receives at most one *non-deduplicated* call, OR (b) the multiple calls share an idempotency key and the remote dedupes. | property test: random crash schedule × random redelivery × counted remote invocations with distinct keys |
| **I2** | **Token monotonicity.** `execution_leases.attempt` per execution is monotonically increasing. No two workers ever observe equal `(execution_id, attempt, status='ACTIVE')` simultaneously. | constraint + concurrency test |
| **I3** | **Reservation precedes side effect.** A `tool_call_dedup` row in `RESERVED` exists in Postgres before `tool.invoke()` returns. | unit test on `executeTool` |
| **I4** | **Stale-write blocked.** A worker whose `fencing_token` is stale cannot transition any `tool_call_dedup` row to `SUCCEEDED`/`FAILED`, nor append any `TOOL_CALL_*` event. | property test with simulated fence flip mid-flight |
| **I5** | **Args stability.** For any `(execution_id, step_seq)`, the `args_hash` is constant. Drift triggers explicit branch divergence (`ArgDrift`), never silent re-execution. | unit test on replay path |

## 5. Crash-case proof

| Case | Scenario | Resolution |
|------|----------|-----------|
| **A** | Tool returned 200; TX2 fails (DB blip) | Row stays `RESERVED`. Lease eventually expires. New owner retries with **same** `idemKey`. Remote returns cached response. New owner commits `SUCCEEDED`. |
| **B** | Process crash between tool return and TX2 | Identical to A. The `RESERVED` row + deterministic key is the recovery anchor. |
| **C** | Lease expires *during* a long tool call | Original worker (`token=N`) finishes call, opens TX2. `SELECT FOR UPDATE` on `execution_leases` returns `attempt=N+1`. Mismatch ⇒ `FencingLost`. New owner sees `RESERVED`, retries with same `idemKey`, remote dedupes. |
| **D** | Replay encounters drifted args | TX1 reads `RESERVED` row, computes new `args_hash`, mismatches. `ArgDrift` thrown. Engine surfaces this as `EXECUTION_REPLAY_DIVERGED`; user must explicitly fork (`replay(edits=…)`) to consent to a new branch. |
| **E** | Two workers race to retry | Only one holds the active lease (Postgres row-lock on `execution_leases`). The other gets `FencingLost` in TX1. |

## 6. Product constraint surfaced by this protocol

This is honest disclosure that lives in SDK docs, not buried in a comment:

> **Every external tool used inside an agent MUST be one of:**
>
> 1. **Idempotency-key aware** — accepts an `idempotency_key` / `Idempotency-Key`
>    header (Stripe, Plaid, most modern billing/payment APIs). Best grade. The
>    runtime threads `idemKey` into every call.
>
> 2. **`@tool(idempotent=True)`** — declared safe to retry (HTTP GET,
>    idempotent PUT, read-only RPC). Runtime may re-invoke without harm.
>
> 3. **`@tool(idempotent=False, fence_only=True)`** — non-idempotent and
>    cannot accept an idem key. The runtime falls back to fence-as-mutex;
>    correctness under partition is **not guaranteed**. This grade is
>    visible in the dashboard with a yellow shield icon. The honesty is a
>    feature.

A tool that lies about its idempotency grade is outside the protocol's
guarantees. We don't try to detect this.

## 7. What this protocol does NOT promise

- **No protection against tools that lie.** A tool annotated `idempotent=True`
  that secretly mutates external state under retries is a bug we cannot
  catch.
- **No protection against external idem-key cache eviction.** Stripe's
  idempotency-key cache TTL is 24h. Replays beyond that window may
  re-charge. The runtime exposes `replayDeadline` per execution and refuses
  replay after it elapses for executions with `idempotent=API` tools.
- **No cross-region quorum.** Single-Postgres fencing only. Multi-region
  deployments need an external quorum primitive — out of scope for V1.

## 8. Migration plan from the existing `DedupingToolExecutor`

The existing implementation in
[apps/api/src/runtime/toolDedupExecutor.ts](../../apps/api/src/runtime/toolDedupExecutor.ts)
covers most of the protocol. The required changes are:

1. **Drop the poll-then-fallthrough behavior.** When a sibling caller holds
   the slot, the new protocol does not poll — both callers issue the same
   idem key to the remote, the remote dedupes, both commit (only one wins
   the TX2 race; loser sees `SUCCEEDED` and returns the cached output).
   This removes the timeout-fallthrough correctness hazard.
2. **Re-validate fence inside `markCompleted` and `markFailed` TXs.**
   Currently `markCompleted` is a bare `UPDATE`. It must be wrapped in a
   transaction that first re-reads `execution_leases.attempt` and aborts
   on mismatch. This closes invariant **I4**.
3. **Thread `idempotencyKey` into the tool invocation.** The `ToolExecutor`
   interface needs an optional `idempotencyKey` in its invocation context,
   propagated to the underlying tool implementation. Stripe/Plaid wrappers
   pass it as `Idempotency-Key` header.
4. **Record `args_hash`** at reserve time and **check on retry** to enforce
   **I5**.
5. **Stop computing `idempotencyKey` from `(executionId + stepId + toolName +
   canonicalArgs)`** — that re-computes a new key when args drift, defeating
   the dedupe at the remote. The new key formula is `sha256(executionId ||
   ':' || stepSeq)`. Args drift is detected separately via `args_hash`.

Code-level pointers for the implementation pass:

- Migration: new `0015_tool_call_fence_columns.sql` adding the three columns
  and the replay index (see §2).
- `apps/api/src/domain/toolDedup.ts`: extend `ToolCallDedupStore` interface
  with `fenceTokenAtReserve` + `argsHash` parameters; add
  `markCompletedFenced(idempotencyKey, expectedToken, output)` and
  `markFailedFenced(idempotencyKey, expectedToken, error)`.
- `apps/api/src/infrastructure/persistence/postgresToolCallDedupStore.ts`
  (if it doesn't exist, this is where the new TX wraps live): implement
  the fence-aware marks as a single `WITH lease_ok AS (...) UPDATE ...`
  CTE so the fence read and the write are atomic.
- `apps/api/src/runtime/toolDedupExecutor.ts`: remove poll-fallthrough,
  re-derive key from `(executionId, stepSeq)` instead of args, thread the
  key to `inner.execute`.
- `apps/api/src/domain/ports.ts`: `ToolExecutor.execute` input grows an
  optional `idempotencyKey: string`.

## 9. Open questions (resolve before V2)

- **Step-seq assignment.** Today `step_seq` is implicit in `execution_steps`
  insert order. For determinism it needs to be assigned at *plan* time, not
  *execute* time, so a planner re-run produces the same numbering. Punt:
  V1 uses execute-order numbering and accepts that replay-with-different-
  plan is a branch divergence.
- **Parallel tool calls within one step.** Today `step_seq` is per-step,
  but a planner that emits N parallel tool calls in one step needs N
  distinct seqs. Resolution: parallel calls get `step_seq.subseq`
  notation (`"5.0"`, `"5.1"`, …) stored as TEXT, ordered lexicographically.
  Punt to V2; V1 assumes serial tool calls per step.
- **Tool args > 1 MB.** `args_hash` is fine for any size; `args_json` is
  capped at the Postgres JSONB limit (~ 1 GB but practical limit ~ 1 MB
  for performance). Large-payload tools should store args by content-hash
  in S3 and pass a reference. Out of scope for V1.
