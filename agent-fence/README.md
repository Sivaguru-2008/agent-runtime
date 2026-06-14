# agent-fence

[![CI](https://github.com/Sivaguru-2008/agent-runtime/actions/workflows/agent-fence-ci.yml/badge.svg)](https://github.com/Sivaguru-2008/agent-runtime/actions/workflows/agent-fence-ci.yml)
[![npm](https://img.shields.io/npm/v/agent-fence.svg)](https://www.npmjs.com/package/agent-fence)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Your agent crashed mid-run. It restarted. Stripe charged twice.

This is not a bug in your agent. It is a missing primitive.

`agent-fence` is that primitive. It wraps any existing agent and ensures irreversible side effects — charges, emails, database writes — never fire twice, even across crashes and retries.

```bash
npm install agent-fence
```

```ts
import { fence } from "agent-fence"

const agent = fence.wrap(myAgent, {
  effects: {
    stripeCharge: "IRREVERSIBLE",
    sendEmail: "IRREVERSIBLE",
    readInventory: "IDEMPOTENT"
  }
})

// Agent crashes and restarts.
// stripeCharge   → [SUPPRESSED] — recorded response returned
// sendEmail      → [SUPPRESSED] — recorded response returned
// readInventory  → re-executes normally (idempotent, safe to repeat)
```

## The problem

Agent retries are inevitable — processes crash, networks blip, orchestrators replay steps. Duplicate side effects are not inevitable, but they are what you get by default: a retried run re-charges the card and re-sends the email. Every team that hits this builds the same thing from scratch — an outbox table, a committed-effects log, an operation-ID dedup scheme — and wires it into every tool by hand. `agent-fence` packages that pattern as a runtime primitive you wrap once.

## How it works

Declare each tool as `IRREVERSIBLE` (must fire at most once) or `IDEMPOTENT` (safe to repeat). Idempotent tools pass straight through. For every irreversible tool call, the fence checks a committed-effects log first:

```
                       ┌─────────────┐
                       │  Tool call  │
                       └──────┬──────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  Check committed-effects log   │
              │  (operation_id = hash of       │
              │   runId + tool + input)        │
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

The `operation_id` is `sha256(runId + toolName + inputHash)`. Reuse the **same `runId`** across a crash and its restart (a workflow / job / order id — not a random per-process value) and the retry matches the committed row. A separate **intent log** records every attempt as `PENDING → COMMITTED | SUPPRESSED`, giving you a full audit trail of what was intended versus what actually fired.

## Installation

```bash
npm install agent-fence
```

```ts
import { fence } from "agent-fence"

// `myAgent` is your function that dispatches tool calls: (toolName, input) => result
const agent = fence.wrap(myAgent, {
  effects: {
    chargeCard: "IRREVERSIBLE",
    lookupOrder: "IDEMPOTENT"
  },
  runId: "order-4242" // stable across restarts
})

await agent("chargeCard", { amount: 4242 })
```

## Storage

State lives in a single committed-effects table plus an intent log. Two adapters ship in the box; `better-sqlite3` and `pg` are **optional dependencies**, so you only install the driver you use.

### SQLite (default, zero config)

```ts
const agent = fence.wrap(myAgent, {
  effects,
  storage: "sqlite",
  connectionString: "./agent-fence.db" // a real file persists across restarts
})
```

### Postgres (production)

```ts
const agent = fence.wrap(myAgent, {
  effects,
  storage: "postgres",
  connectionString: process.env.DATABASE_URL
})
```

Tables are created automatically on first use. You can also pass any `StorageAdapter` instance (e.g. to share one connection across many fences).

## Works with

The wrap target is always *the function that dispatches tool calls*, which every framework reduces to.

**OpenAI** (function calling) — wrap the tool-execution layer:

```ts
const dispatch = fence.wrap(
  (name, args) => runTool(name, args),
  { effects, runId: threadId }
)
for (const call of message.tool_calls) {
  const result = await dispatch(call.function.name, JSON.parse(call.function.arguments))
}
```

**Anthropic** (`tool_use`) — intercept before tool dispatch:

```ts
const dispatch = fence.wrap((name, input) => runTool(name, input), { effects, runId })
for (const block of message.content) {
  if (block.type === "tool_use") await dispatch(block.name, block.input)
}
```

**LangChain** — fence a tool's `.invoke()`:

```ts
import { createFence } from "agent-fence"
const f = createFence({ effects, runId })
const fencedCharge = f.wrapTool("chargeCard", (input) => chargeTool.invoke(input))
await fencedCharge({ amount: 4242 })
```

**Any custom agent** — wrap whatever function routes tool calls by name:

```ts
const agent = fence.wrap(myDispatcher, { effects, runId })
```

Runnable versions of all three live in [`examples/`](./examples) — each prints `[COMMITTED]` on the first run and `[SUPPRESSED]` on the second:

```bash
npm run example:openai      # or: npx tsx examples/openai-agent.ts
npm run example:anthropic
npm run example:langchain
```

## Honest limits

`agent-fence` gives **at-most-once on retry**: once an effect is committed, it never fires again for the same `runId` + input. There is one irreducible gap — the instant between a side effect *succeeding* and its commit being *written*. If the process dies in that window, the effect was never recorded and may fire again on restart. The intent log surfaces exactly this case: an effect stuck in `PENDING` was attempted but never confirmed. For true exactly-once on money movement, pair the fence with provider-side idempotency keys (e.g. Stripe's `Idempotency-Key`) — the fence handles dedup across your whole agent; the provider key closes the last millisecond.

## License

MIT
