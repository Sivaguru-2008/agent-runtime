# @agent-platform/sdk

Official TypeScript SDK for the **Agent Runtime API**. Create, fetch, replay, list, and stream agent executions with full typing, typed errors, automatic retries, and first-class streaming.

- 🟦 **Fully typed** — every request and response is typed; terminal-state helpers included.
- 🔁 **Retry built in** — exponential backoff + jitter, honours `Retry-After`, never auto-retries unsafe mutations unless you opt in.
- 📡 **Streaming** — consume runtime events as an `async` iterator over SSE, scoped to a single execution.
- 🔐 **Auth** — `X-Api-Key` or `Authorization: Bearer`, your choice.
- 🪶 **Zero runtime dependencies** — uses the platform `fetch`. Node ≥ 20.11 (or any runtime with `fetch` + `ReadableStream`).

---

## Install

```bash
npm install @agent-platform/sdk
# or: pnpm add / yarn add / bun add
```

## Quickstart (≈ 2 minutes)

```ts
import { AgentRuntimeClient } from "@agent-platform/sdk";

const client = new AgentRuntimeClient({
  baseUrl: "https://api.example.com",
  apiKey: process.env.AGENT_API_KEY
});

// 1. Create an agent (a fresh tenant has none yet)
const agent = await client.createAgent({
  name: "my-first-agent",
  goal: "Summarise incident reports"
});

// 2. Start an execution
const execution = await client.createExecution({
  agentId: agent.id,
  prompt: "Summarise the latest incident report"
});

// 3. Wait for it to finish
const final = await client.waitForExecution(execution.id);

console.log(final.status);          // "COMPLETED" | "FAILED" | ...
console.log(final.output);          // structured agent output
console.log(final.tokenUsage.total);
```

That's the whole happy path. Everything below is detail.

---

## Configuration

```ts
const client = new AgentRuntimeClient({
  baseUrl: "https://api.example.com", // required
  apiKey: process.env.AGENT_API_KEY,  // sent as X-Api-Key by default
  authScheme: "x-api-key",            // or "bearer"
  timeoutMs: 30_000,                  // per-request timeout (0 disables)
  headers: { "x-tenant-hint": "eu" }, // merged into every request
  retry: {
    maxRetries: 3,
    baseDelayMs: 250,
    maxDelayMs: 10_000,
    jitter: 0.25,
    onRetry: ({ attempt, delayMs, error }) =>
      console.warn(`retry ${attempt} in ${delayMs}ms after ${error.code}`)
  },
  fetch: customFetch                  // optional fetch override (proxies/tests)
});
```

| Option       | Default        | Notes |
|--------------|----------------|-------|
| `baseUrl`    | —              | Required. Validated at construction. |
| `apiKey`     | —              | Optional only against an auth-disabled dev server. |
| `authScheme` | `"x-api-key"`  | `"x-api-key"` → `X-Api-Key` header; `"bearer"` → `Authorization: Bearer`. |
| `timeoutMs`  | `30000`        | Aborts the request and raises `TimeoutError`. |
| `retry`      | see above      | Backoff + jitter; honours server `Retry-After`. |

---

## API

### `createExecution(params)`

Starts a new execution for an agent (`POST /agents/:agentId/tasks`). Returns immediately; the runtime processes asynchronously.

```ts
const execution = await client.createExecution({
  agentId: "agent_123",
  prompt: "Draft release notes for v1.2",   // or `goal`, or `input`
  input: { repo: "core", since: "v1.1" },   // arbitrary structured input
  scheduleAt: "2026-06-03T09:00:00Z",        // optional: defer the run
  idempotencyKey: crypto.randomUUID()        // makes the create safe to retry
});
```

> **Idempotency:** `POST` is not auto-retried by default (a network blip could
> duplicate the side effect). Supply `idempotencyKey` and the SDK will both send
> the `Idempotency-Key` header **and** enable retries for that call.

### `getExecution(executionId)`

Fetches a single execution plus its observability envelope (`GET /executions/:id`).

```ts
const { execution, traceId, runtimeId } = await client.getExecution("exec_1");
```

### `waitForExecution(executionId, options?)`

Polls `getExecution` until the execution reaches a terminal state.

```ts
const final = await client.waitForExecution("exec_1", {
  timeoutMs: 120_000,
  pollIntervalMs: 1_000,
  onPoll: (e) => console.log(e.status)
});
```

### `replayExecution(executionId)`

Re-runs a recorded execution (`POST /executions/:id/replay`). Requires a developer+ key. Returns the new replay execution.

```ts
const replay = await client.replayExecution("exec_1");
console.log(replay.parentExecutionId); // "exec_1"
```

### `listExecutions(params?)`

Lists executions (`GET /executions`), filtered server-side. Without `agentId`, returns every execution your API key can see, newest first.

```ts
// All recent failures across every agent you own
const failures = await client.listExecutions({
  status: ["FAILED", "DEAD_LETTERED"],
  limit: 20
});

// Scoped to a single agent
const forAgent = await client.listExecutions({ agentId: "agent_123" });
```

### `streamExecution(params?)`

Streams runtime events over SSE as an `async` iterator (`GET /events/stream`). When `executionId` is set, only events for that execution are yielded.

```ts
const ac = new AbortController();

for await (const event of client.streamExecution({
  executionId: "exec_1",
  afterSequence: 0,     // resume from a sequence cursor
  signal: ac.signal     // stop the stream anytime
})) {
  console.log(event.type, event.sequence);
  if (event.type === "COGNITION_COMPLETED") ac.abort();
}
```

---

## Error handling

Every failure is an instance of `AgentRuntimeError`, with a specific subclass per HTTP status. Branch on the type — no string parsing.

```ts
import {
  AgentRuntimeError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServiceUnavailableError,
  ServerError,
  TimeoutError,
  NetworkError
} from "@agent-platform/sdk";

try {
  await client.createExecution({ agentId, prompt });
} catch (err) {
  if (err instanceof RateLimitError) {
    console.warn(`Backing off for ${err.retryAfterMs}ms`);
  } else if (err instanceof NotFoundError) {
    console.error("Agent does not exist");
  } else if (err instanceof AgentRuntimeError) {
    console.error(`[${err.code}] ${err.message} (HTTP ${err.status})`);
  } else {
    throw err; // not from the SDK
  }
}
```

| Subclass                  | HTTP        | `retryable` |
|---------------------------|-------------|-------------|
| `ValidationError`         | 400         | no |
| `AuthenticationError`     | 401         | no |
| `AuthorizationError`      | 403         | no |
| `NotFoundError`           | 404         | no |
| `ConflictError`           | 409         | no |
| `RateLimitError`          | 429         | yes |
| `ServiceUnavailableError` | 503         | yes |
| `ServerError`             | 5xx (≠ 503) | yes |
| `TimeoutError`            | —           | yes |
| `NetworkError`            | —           | yes |
| `ConfigurationError`      | — (local)   | no |

Every error carries `status`, `code`, `retryable`, `retryAfterMs?`, `errorId?` (server correlation id on 500s), and the raw `body`.

---

## Retry semantics

- **Safe methods** (`GET`) are retried automatically on `429`, `503`, `5xx`, timeouts, and network errors.
- **Mutations** (`POST`) are **not** retried unless you pass an `idempotencyKey` to `createExecution`.
- A server `Retry-After` header (seconds or HTTP-date) always overrides the backoff curve.
- Backoff is exponential (`baseDelayMs · 2^attempt`, capped at `maxDelayMs`) with jitter to avoid thundering herds.

---

## TypeScript

The SDK ships its own `.d.ts`. Import any domain type:

```ts
import type {
  Execution,
  ExecutionStatus,
  ExecutionEvent,
  CreateExecutionParams
} from "@agent-platform/sdk";

import { isTerminalStatus, TERMINAL_STATUSES } from "@agent-platform/sdk";
```

---

## Examples

Runnable scripts live in [`examples/`](./examples):

```bash
AGENT_API_URL=http://localhost:4000 \
AGENT_API_KEY=sk_dev_xxx \
AGENT_ID=agent_123 \
npx tsx examples/quickstart.ts
```

- [`quickstart.ts`](./examples/quickstart.ts) — create + wait for completion
- [`streaming.ts`](./examples/streaming.ts) — follow events live over SSE
- [`replay.ts`](./examples/replay.ts) — list executions + replay one

---

## Development

```bash
npm run build       # tsc → dist/ (ESM + .d.ts)
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest
```

## License

MIT
