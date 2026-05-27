# Replay-Equivalent Execution (canonical spec)

Status: canonical. Replaces ad-hoc "replay" language in
`architecture.md`, `runtime-correctness-report.md`, and
`reliability-phase-v3.md` (the latter two archived).

## 1. Definition

> **A replay of execution `E` is replay-equivalent if the event sequence
> `E'` it produces satisfies: for every event in `E'` whose causal
> ancestors are fully recorded in `E`, the event's payload is
> byte-identical to its counterpart in `E`.**

Equivalence is at the **event boundary**, not at the wall clock, the RNG,
or the LLM-output level. The agent's source code itself is **not**
snapshotted — only the boundaries it crosses.

The unit of replay is the **execution**. Branching, divergence, and edits
are explicit, named operations. There is no implicit divergence; either a
replay is byte-equivalent to the original or it forks a new branch.

## 2. What replay guarantees

1. **Recorded events are reused verbatim.** A `MODEL_CALL` or `TOOL_CALL_*`
   event with status `SUCCEEDED` in `E` is never re-invoked in `E'`. Its
   `output` is returned to the user code as if the call had happened.
2. **Strict prefix equivalence under no-edit replay.** If no edits are
   applied, every event in `E'` is payload-byte-identical to its
   counterpart in `E`.
3. **Stable causal ordering.** Events in `E'` are emitted in the same
   `(stepSeq, subseq)` order as in `E` for the equivalent prefix.
4. **Idempotent under repeat.** Replaying the same execution twice with
   the same edits produces two byte-identical branch event streams (the
   branch_id differs; the events do not).

## 3. What replay does NOT guarantee

1. **LLM determinism.** LLMs are non-deterministic at the API. Replay uses
   the **recorded** LLM output, not a re-derived one. There is no attempt
   to re-call the LLM with the same prompt and check output match.
2. **Wall-clock equality.** Replay events have new `timestamp` values
   (clock at replay time). The replay branch table records the link to
   the original event's timestamp; queries that need original time
   read from there.
3. **Stream-token replay.** Streaming responses are recorded as a single
   completed `MODEL_CALL` event with the assembled body. Replay does not
   re-emit intermediate stream tokens. The dashboard may *animate*
   the assembled body for visual continuity, but the runtime API is
   synchronous.
4. **Replay of non-recorded external calls.** A tool implementation that
   makes a hidden HTTP request bypassing the `Tool` interface is invisible
   to the runtime. Replay does not protect against that — same constraint
   as any execution-replay system.
5. **Replay of in-process side effects.** Filesystem writes, in-memory
   caches, and process-state mutations inside the agent's Python/JS code
   are not snapshotted. The user's code between recorded boundaries is
   assumed to be a pure function of its inputs.

## 4. Determinism boundaries

Every source of non-determinism the agent uses **must** cross a recorded
boundary. The SDK provides four:

| Source | API (TS) | API (Python) | Event recorded |
|---|---|---|---|
| LLM call | `runtime.llm(prompt, opts)` | `runtime.llm(prompt, **opts)` | `MODEL_CALL` (full request + response) |
| Tool call | `@tool` decorated fn | `@tool` decorated fn | `TOOL_CALL_*` (via fence protocol — see [fence-protocol.md](./fence-protocol.md)) |
| Clock | `runtime.now()` | `runtime.now()` | `CLOCK_READ` (frozen timestamp) |
| RNG | `runtime.rng()` | `runtime.rng()` | `RNG_READ` (frozen value) |

Direct use of `Date.now()`, `Math.random()`, `time.time()`, or
`openai.completions.create(...)` outside `runtime.llm` **breaks replay**.
The SDK ships an opt-in lint rule (`@agent-runtime/no-bare-globals`) that
flags these in user code. We do not block the SDK from working without
the lint; we surface the divergence in the dashboard as
`REPLAY_DETERMINISM_VIOLATED` when detected at replay time.

## 5. Divergence rules

Replay must either (a) be strict-equivalent to the prefix or (b) explicitly
fork a new branch. There is no third option ("silently re-execute").

| Trigger | Behavior |
|---|---|
| No edits requested, all recorded events present | Strict equivalence. New `branch_id`, same payloads. |
| No edits, recorded execution incomplete | Resume live from the last recorded event. New events appended to a new branch_id. |
| User-requested edit at step N | Events 0..N-1 reused. Edit applied at N. From N onward, live execution. Branch parent = N. |
| `args_hash` mismatch on a tool replay (invariant I5) | Throw `ReplayDivergence(stepSeq, before, after)`. User chooses to fork (`replay(edits=…)`) or abort. |
| Recorded LLM `model_id` differs from current runtime model | Mandatory branch with the change marked in the branch diff. |
| Recorded `CLOCK_READ` would now be in the future | Mandatory branch (clock-relative decisions are now different). |

## 6. Streaming, parallel calls, ordering

### Streaming
A `runtime.llm()` call with `stream=True` returns an async iterator at the
SDK surface. The runtime collects the full assembled response and emits
**one** `MODEL_CALL` event at completion. Replay returns the same async
iterator interface, yielding the recorded body in a single chunk (or in
synthesized chunks if the SDK is asked to preserve the visual cadence —
opt-in flag `replay_animate_streams`).

### Parallel calls
A planner step may emit multiple tool calls in a single planning round.
Each call receives a deterministic `(stepSeq, subseq)` where `subseq` is
assigned in the order the planner declared them. Replay executes them in
`(stepSeq, subseq)` order, **not** wall-clock order. Each has its own
idempotency key derived from `sha256(executionId || ':' || stepSeq || ':'
|| subseq)`.

For V1, the planner is assumed to emit serial tool calls per step
(`subseq` always 0). True-parallel within a step is V2.

### Event ordering
`events` table has a `sequence BIGSERIAL` column. Total order within an
execution is `sequence` ascending. We do not use vector clocks; a
single-writer Postgres event store is totally ordered for free.

## 7. Minimal replay engine

This is the canonical implementation. ~150 lines of real code. Single
process, synchronous, no queue.

```ts
async function replay(
  rootExecutionId: string,
  edits: Edit[] = []
): Promise<Execution> {
  const events = await db.query(
    `SELECT * FROM events
      WHERE aggregate_id = $1 AND aggregate_type = 'execution'
      ORDER BY sequence ASC`,
    [rootExecutionId]
  );

  const branchId = newUuid();
  const newExecutionId = newUuid();
  await db.query(
    `INSERT INTO replay_branches
       (id, parent_execution_id, replay_execution_id, requested_at, diff)
     VALUES ($1, $2, $3, now(), $4)`,
    [branchId, rootExecutionId, newExecutionId, JSON.stringify({ edits })]
  );

  const state = new ExecutionState();
  let divergedAt: number | null = null;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const editHere = edits.find((e) => e.appliesAt(ev));

    if (editHere) {
      divergedAt = i;
      break;
    }

    // Strict-equivalent: rewrite the event under the new execution_id +
    // branch_id, preserving the payload byte-for-byte.
    await appendEvent(newExecutionId, branchId, {
      ...ev,
      sequence: undefined, // re-assigned on insert
      replayOf: ev.id,
    });
    state.apply(ev);
  }

  if (divergedAt === null) {
    // Either fully equivalent or the recorded execution is itself
    // incomplete. If incomplete, resume live from `state`.
    if (state.isTerminal()) return state.finalize(newExecutionId);
    return await executeLive(newExecutionId, branchId, state);
  }

  // Apply the edit, then run live from the divergence point.
  const editedState = state.applyEdit(edits[divergedAt]);
  return await executeLive(newExecutionId, branchId, editedState);
}
```

`executeLive` is the same code path as a fresh execution — there is no
"replay mode" inside the engine. Once divergence happens, the run is
just a normal execution with a non-empty starting state. This is the
key simplification.

## 8. Replay reads tool outputs from `tool_call_dedup`

For tool calls specifically, replay does **not** re-emit them from the
event log — it reads from the `tool_call_dedup` table by `(execution_id,
step_seq)`. This is the source-of-truth pair:

- `events` records that a tool call happened (`TOOL_CALL_SUCCEEDED` with
  `idempotency_key` and a reference).
- `tool_call_dedup` holds the captured output (which may be large; we
  don't want it in the event payload).

The fence protocol guarantees the two are atomically consistent: the
`SUCCEEDED` event and the `SUCCEEDED` dedup row are written in the same
TX2.

## 9. Replay deadline

Some external services have a finite idempotency-key window (Stripe: 24h).
Replays of executions containing API-grade idempotent tools after that
window risk re-charging. The runtime computes a per-execution
`replay_deadline` = min over all recorded `TOOL_CALL_SUCCEEDED` events of
`tool.idem_ttl` from the tool registry, applied to the call's
`completed_at`.

```ts
const replayDeadline = Math.min(
  ...toolCalls.map((c) => c.completed_at + tool(c.tool_name).idemTtlMs)
);
```

`POST /executions/:id/replay` returns HTTP 410 Gone if `now() >
replay_deadline`. The user can override with `?force=true&accept_risk=true`,
which records `REPLAY_OVERRODE_DEADLINE` in the branch.

## 10. What this spec does NOT cover

- Re-prompting the LLM (a "live re-run with same inputs"). That is not
  replay; that is a fresh execution and uses the normal run API with
  `parent_execution_id` set for lineage tracking only.
- Cross-execution replay (replaying across forks of a sibling execution).
  Out of scope.
- Replay of agent code changes (the user changed their `@agent` body
  between original and replay). The runtime detects code-hash drift via
  the recorded `agent_code_hash` in `EXECUTION_STARTED`; mismatch is a
  mandatory branch with a `code_drift: true` flag on the branch diff.
