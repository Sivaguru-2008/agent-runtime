# Contributing to agent-fence

Thanks for helping out. The package is intentionally small — a single runtime primitive — so contributions should keep it focused.

## Getting started

```bash
npm install        # installs dev tooling + optional sqlite/pg drivers
npm test           # run the suite (vitest)
npm run typecheck  # tsc --noEmit
npm run build      # emit dist/
```

Requires **Node 20+** (the test toolchain — vitest and better-sqlite3 — dropped Node 18). The library itself only uses stable Node APIs.

To watch the runtime behavior end to end:

```bash
npm run demo            # crash → restart walkthrough, prints [COMMITTED] then [SUPPRESSED]
npm run example:openai  # same story wired through an OpenAI-style agent
```

## Running tests

Tests live in [`tests/`](./tests) and run on an in-memory or temp-file SQLite database, so no external services are needed.

- `tests/fence.test.ts` — core suppression / passthrough logic
- `tests/sqlite.test.ts` — storage adapter (write, read, dedup)
- `tests/retry.test.ts` — full crash + restart scenario

```bash
npm test              # once
npm run test:watch    # watch mode
```

Please add a test for any behavior change. If you touch the fence logic, a crash/restart test is the most valuable kind.

## Adding a new storage adapter

Adapters implement the `StorageAdapter` interface in [`src/storage/base.ts`](./src/storage/base.ts):

```ts
interface StorageAdapter {
  init(): Promise<void>
  getCommitted(operationId: string): Promise<CommittedEffect | null>
  putCommitted(effect: CommittedEffect): Promise<PutResult> // honor UNIQUE(operation_id, tool_name, input_hash)
  recordIntent(intent: IntentRecord): Promise<void>
  updateIntentStatus(id: string, status: IntentStatus): Promise<void>
  close(): Promise<void>
}
```

Use [`src/storage/sqlite.ts`](./src/storage/sqlite.ts) or [`src/storage/postgres.ts`](./src/storage/postgres.ts) as a template, and follow these rules:

1. **`putCommitted` must be conflict-safe.** Insert-or-ignore on `(operation_id, tool_name, input_hash)` and return `{ inserted: false, row }` with the *existing* row when a duplicate is detected. This is what makes dedup correct under concurrency.
2. **Lazy-load the driver.** `import()` the client inside `init()` and throw a clear "install X" error if it is missing, so the dependency stays optional.
3. **Create tables in `init()`** with `IF NOT EXISTS`; never assume migrations have run.
4. Map your driver's snake_case columns back to the camelCase `CommittedEffect` / `IntentRecord` shapes.

Wire it up in `resolveStorage()` in [`src/fence.ts`](./src/fence.ts) (or let users pass an instance via `storage: myAdapter`), and copy `tests/sqlite.test.ts` to cover write / read / dedup against your backend.

## Submitting a PR

1. Fork and branch off `main` (`git checkout -b fix-thing`).
2. Make the change with a test.
3. Make sure `npm run typecheck`, `npm test`, and `npm run build` all pass — CI runs exactly these on Node 20 and 22.
4. Keep the scope tight and the description plain: what changed and why.
5. Open the PR.

## Scope

This package is the fence primitive and nothing more — no UI, dashboard, replay timeline, cloud service, or telemetry. Proposals that keep the core small and the wrap call one line are very welcome; feature creep will be politely declined.
