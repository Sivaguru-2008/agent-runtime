# agent-fence

[![CI](https://github.com/Sivaguru-2008/agent-runtime/actions/workflows/agent-fence-ci.yml/badge.svg)](https://github.com/Sivaguru-2008/agent-runtime/actions/workflows/agent-fence-ci.yml)
[![npm](https://img.shields.io/npm/v/agent-fence.svg)](https://www.npmjs.com/package/agent-fence)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Your agent charged the card. The call timed out. It retried. Stripe charged twice.**

Agent retries are inevitable — processes crash, networks blip, orchestrators replay steps. Duplicate side effects are what you get by default: a retried run re-charges the card, re-sends the email, re-writes the row. `agent-fence` wraps your existing agent and makes irreversible effects fire **at most once** per logical run — across retries, crashes, and replays.

```bash
npm install agent-fence
```

## Quickstart

Declare which tools are irreversible, wrap your tool dispatcher once, and reuse a stable `runId` across retries:

```ts
import { fence } from "agent-fence";

// `chargeCard` is your real side effect: (toolName, input) => result
const agent = fence.wrap(chargeCard, {
  effects: { chargeCard: "IRREVERSIBLE" }, // must fire at most once
  storage: "sqlite",
  runId: "order-4242", // same id across the crash + retry
});

await agent("chargeCard", { amountCents: 8484 }); // → [COMMITTED] card charged
await agent("chargeCard", { amountCents: 8484 }); // → [SUPPRESSED] recorded response returned, card NOT re-charged
```

See it move money exactly once across a retry:

```bash
npm run demo        # examples/duplicate-charge.ts — charges twice without the fence, once with it
```

## Scope — what this is, and what it is not

Be precise; the failure mode is silent double-spend.

**What it is:** automatic idempotency/dedup **at the fence**. You label tools `IRREVERSIBLE` or `IDEMPOTENT`; the fence keeps a durable committed-effects log keyed by `(runId, tool, input)` and returns the recorded response instead of re-running an irreversible effect that already succeeded. One `wrap()`, no rewrite of your agent.

**What it is not:**

- **Not a workflow engine.** It does not rewrite your agent into durable steps the way Temporal / Restate / DBOS do. There is no scheduler, no replay determinism harness, no versioned workflow code — it is a thin dedup layer you drop in front of tool calls. If you want full durable execution, use one of those; if you just need "don't charge twice on retry," this is far less to adopt.
- **Not magic exactly-once against arbitrary external APIs.** The fence guarantees **at-most-once on retry** for effects it sees commit. It cannot retract a charge the upstream API already accepted, and there is one irreducible window — between an effect *succeeding* and its commit being *written* — where a crash can lose the record and allow a re-fire on restart. The intent log surfaces exactly this case (an effect stuck in `PENDING`). For true exactly-once on money movement, pair the fence with provider-side idempotency keys (e.g. Stripe's `Idempotency-Key`): the fence dedups across your whole agent, the provider key closes the last millisecond. See [Honest limits](#honest-limits).

## How it works

Idempotent tools pass straight through. For every irreversible call, the fence checks a committed-effects log first:

```
                       ┌─────────────┐
                       │  Tool call  │
                       └──────┬──────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  Check committed-effects log   │
              │  operation_id = sha256(        │
              │    runId + tool + inputHash)   │
              └───────┬───────────────┬────────┘
                   found           not found
                      │                │
                      ▼                ▼
              ┌──────────────┐  ┌──────────────┐
              │ [SUPPRESSED] │  │ Execute tool │
              │ return the   │  └──────┬───────┘
              │ recorded     │         │
              │ response     │         ▼
              └──────────────┘  ┌──────────────┐
                                │ Write to log │
                                │ [COMMITTED]  │
                                └──────────────┘
```

The `operation_id` is `sha256(runId + toolName + inputHash)`, where `inputHash` is a SHA-256 of the canonicalized input (object key order doesn't matter). Reuse the **same `runId`** across a crash and its restart — a workflow / job / order id, **not** a random per-process value — and the retry matches the committed row. Before returning a recorded response the fence re-verifies the stored input hash (on by default), so it never hands back a stale result for a different input. A separate **intent log** records every attempt as `PENDING → COMMITTED | SUPPRESSED`, giving you an audit trail of what was intended versus what actually fired.

## Storage

State lives in a single committed-effects table plus an intent log. Two adapters ship in the box; `better-sqlite3` and `pg` are **optional dependencies**, so you only install the driver you use. Tables are created automatically on first use.

### SQLite (default, zero config)

```ts
const agent = fence.wrap(myAgent, {
  effects,
  storage: "sqlite",
  connectionString: "./agent-fence.db", // a real file persists across restarts
});
```

> A real file path is durable. `":memory:"` is for tests/demos only — it is lost when the process exits.

### Postgres (production)

```ts
const agent = fence.wrap(myAgent, {
  effects,
  storage: "postgres",
  connectionString: process.env.DATABASE_URL,
});
```

You can also pass any `StorageAdapter` instance — e.g. to share one connection across many fences.

## Core API

```ts
import { fence, createFence, Fence, withRun } from "agent-fence";
```

| Entry point | Use it for |
| --- | --- |
| `fence.wrap(dispatch, config)` | Wrap a `(toolName, input) => result` dispatcher. Returns a fenced `(toolName, input, callOpts?)` plus `.fence` and `.close()`. |
| `createFence(config)` / `new Fence(config)` | A reusable fence with no bound dispatcher. |
| `f.dispatch(toolName, input, exec, callOpts?)` | Run one tool: `exec` performs the real side effect. |
| `f.wrapTool(toolName, fn)` | Fence a single `(input) => result` function (handy for LangChain `.invoke`). |
| `f.wrapDispatcher(dispatch)` | Like `wrap`, but as a method on an existing fence. |
| `withRun(runId, fn)` | Run `fn` with an ambient `runId` that fenced calls inherit. |
| `f.close()` | Release storage handles. |

### `FenceConfig`

| Option | Default | Meaning |
| --- | --- | --- |
| `effects` | — | `{ toolName: "IRREVERSIBLE" \| "IDEMPOTENT" }`. |
| `storage` | `"sqlite"` | `"sqlite"`, `"postgres"`, or a `StorageAdapter` instance. |
| `connectionString` | `"agent-fence.db"` | SQLite file path or Postgres URL. |
| `runId` | `"default"` | Stable id for one logical run; **must** match across a retry. |
| `defaultEffect` | `"IDEMPOTENT"` | Classification for tools not listed in `effects`. |
| `failOpen` | `true` | On storage failure, run the tool anyway (and warn) rather than block it. |
| `verifyInputHash` | `true` | Re-check the recorded input hash before suppressing a duplicate. |
| `clock` | system clock | Injectable wall clock for audit timestamps; the fence never reads `Date` directly. |
| `logger` | console (stderr) | `LoggerOptions` or a custom `FenceLogger`. |

`runId` can also be passed per call (`agent(tool, input, { runId })`) and overrides the config/ambient value.

## Works with any agent framework

The wrap target is always *the function that dispatches tool calls*, which every framework reduces to.

```ts
// OpenAI function calling — wrap the tool-execution layer:
const dispatch = fence.wrap((name, args) => runTool(name, args), { effects, runId: threadId });
for (const call of message.tool_calls) {
  await dispatch(call.function.name, JSON.parse(call.function.arguments));
}

// Anthropic tool_use — intercept before dispatch:
const dispatch = fence.wrap((name, input) => runTool(name, input), { effects, runId });
for (const block of message.content) {
  if (block.type === "tool_use") await dispatch(block.name, block.input);
}

// LangChain — fence a single tool's .invoke():
const f = createFence({ effects, runId });
const fencedCharge = f.wrapTool("chargeCard", (input) => chargeTool.invoke(input));
```

Runnable versions live in [`examples/`](./examples) — each prints `[COMMITTED]` on the first run and `[SUPPRESSED]` on the second:

```bash
npm run demo                # duplicate-charge: two charges without the fence, one with it
npm run demo:crash          # crash + restart against a real DB file
npm run example:openai      # or: example:anthropic / example:langchain
```

## Honest limits

`agent-fence` gives **at-most-once on retry**: once an effect is committed, it never fires again for the same `runId` + input. There is one irreducible gap — the instant between a side effect *succeeding* and its commit being *written*. If the process dies in that window, the effect was never recorded and may fire again on restart. The intent log surfaces exactly this case: an effect stuck in `PENDING` was attempted but never confirmed. By default the fence **fails open** (`failOpen: true`) — if storage is unreachable it runs the tool and warns loudly rather than blocking it; set `failOpen: false` to fail closed instead. For true exactly-once on money movement, pair the fence with provider-side idempotency keys (e.g. Stripe's `Idempotency-Key`) — the fence handles dedup across your whole agent; the provider key closes the last millisecond.

## License

MIT
