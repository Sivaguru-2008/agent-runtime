# Architecture (V1)

V1 scope: a single-process runtime that runs agents safely, records every
side effect with a deterministic idempotency key, and lets developers
replay any execution from any point. One Node process. One Postgres. One
UI page. No Redis, no worker pool, no Kubernetes — those return in V2
when scale demands.

For the canonical correctness contracts, see:

- [`specs/fence-protocol.md`](./specs/fence-protocol.md) — the side-effect
  safety protocol every tool call passes through.
- [`specs/replay-equivalent-execution.md`](./specs/replay-equivalent-execution.md)
  — what "replay" guarantees and what it does not.

Historical design notes are in [`_archive/`](./_archive/README.md) and
are not authoritative.

## 1. Topology

```
              ┌─────────────────────────┐
              │  Python SDK (V1.1)      │
              │  TS SDK (V1.0)          │
              └────────────┬────────────┘
                           │ HTTPS (REST + SSE)
              ┌────────────▼────────────┐
              │  Node process (Fastify) │
              │   • HTTP routes         │
              │   • Execution engine    │
              │   • Fence protocol      │
              │   • Replay engine       │
              │   • SSE via LISTEN/NOTIFY │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  Postgres 16            │
              │   events / executions / │
              │   leases / tool_calls / │
              │   replay_branches       │
              └─────────────────────────┘

              ┌─────────────────────────┐
              │  Next.js UI             │
              │   /e/:executionId       │
              └─────────────────────────┘
```

**No Redis.** SSE updates use Postgres `LISTEN`/`NOTIFY`. The Redis adapters
in `apps/api/src/infrastructure/queue/` and `events/` remain in the tree
for V2 use but are not wired in V1's `runtimeContainer`.

**No worker process split.** `workerProcess.ts` is V2. V1 executes
agents in the same Node process that serves the HTTP API. Boot-time scan
of `execution_leases` with `expires_at < now()` handles recovery from a
process restart — no heartbeat needed in a single-process model.

## 2. Folder map (what to read first)

```
apps/api/
  db/
    schema.sql              # source of truth for fresh installs
    migrations/             # applied in order
  src/
    domain/                 # event/entity/port types
    runtime/                # agent + execution engine
      executionEngine.ts    # canonical engine (the other one, execution-engine.ts, is being retired)
      toolDedupExecutor.ts  # implements the fence protocol per specs/fence-protocol.md
      replay/               # replay engine; see specs/replay-equivalent-execution.md
    infrastructure/
      persistence/          # Postgres adapters
      events/               # event store + bus (Postgres LISTEN/NOTIFY in V1)
    interfaces/http/        # Fastify routes
    application/            # use cases (commands + queries)

apps/web/
  app/                      # Next.js routes; /e/[executionId] is the only required page in V1
```

## 3. Data model (V1)

The schema in `apps/api/db/schema.sql` is the source of truth. Five
tables carry V1 semantics:

| Table | Role |
|---|---|
| `events` | Append-only event log. Source of truth for execution history. |
| `executions` | Projection: current status of each execution. Rebuildable from `events`. |
| `execution_leases` | Per-execution fence token (`attempt`). One row, one active worker. |
| `tool_call_dedup` | Per-step fence anchor: `RESERVED` → `SUCCEEDED`/`FAILED` with `idempotency_key`. See [`specs/fence-protocol.md`](./specs/fence-protocol.md). |
| `replay_branches` | Parent/child execution lineage for replays. |

Everything else in the schema (memory, outbox, DLQ, quotas) is V2
infrastructure that exists but is non-critical for V1's correctness
guarantees. Removing the outbox specifically is risky and out of scope
for this pass.

## 4. Lifecycle (V1)

1. `POST /agents` → row in `agents`.
2. `POST /agents/:id/tasks` → row in `executions(status='RUNNING')`,
   lease acquired in `execution_leases`, engine begins.
3. Engine runs steps. Every tool call:
   1. Computes `idempotencyKey = sha256(executionId || ':' || stepSeq)`.
   2. Reserves a `tool_call_dedup` row in the same TX that re-validates
      the lease (`SELECT … FOR UPDATE`).
   3. Invokes the tool, passing `idempotencyKey` so the remote can dedupe.
   4. Commits `SUCCEEDED`/`FAILED` in a TX that re-validates the lease.
      Lost fence ⇒ abort; the next owner converges via the same
      `idempotencyKey`.
4. On completion, `executions.status='COMPLETED'`; lease released.
5. `POST /executions/:id/replay` → new `branch_id`, replay engine streams
   events into the new execution, diverges on the first edit. See
   [`specs/replay-equivalent-execution.md`](./specs/replay-equivalent-execution.md).

## 5. API surface (V1)

Commands:
- `POST /agents`
- `POST /agents/:agentId/tasks`
- `POST /executions/:executionId/replay`

Queries:
- `GET /agents`
- `GET /executions/:executionId`
- `GET /executions/:executionId/events`
- `GET /events/stream` (SSE; backed by Postgres `LISTEN`/`NOTIFY`)

Deferred to V2 — start/stop agents, agent state machine, projections
endpoints, DLQ admin, observability overview. They exist as code today
but are not part of the V1 wedge.

## 6. Local development

```bash
npm install
docker compose up -d        # Postgres only; Redis service is deprecated
npm run dev
```

The Redis service in `docker-compose.yml` should be removed in a
follow-on PR; V1 does not use it.

## 7. Production deployment (V1)

- One container running `node dist/server.js`.
- Managed Postgres (Neon, Aurora, Supabase, or self-hosted).
- No Redis. No queue. No worker pool.
- Hosted on Fly.io / Render / Railway. Single region.

Scaling thresholds — when these are crossed, V2 work begins:
- > 50 paying customers → add a Postgres-backed job queue and a worker
  process. Still no Redis.
- p99 dispatch > 500 ms or queue depth > 1k → introduce Redis Streams
  with consumer groups.
- Multi-region requirement → external quorum primitive for leases.

## 8. What V1 explicitly does NOT include

This list is short on purpose. Anything not here that is being built is
not V1.

- Worker process split, queue, distributed leases, DLQ admin
- Vector memory, semantic retrieval, episodic memory UI
- Multi-tenant RBAC / SSO (single API key in env var)
- Docker tool sandbox
- Multi-region failover
- Compliance audit export, signed ledgers
- "SLO governance", deploy freeze, incident war-room UI
- Cinematic UI animations, color tokens, popovers, hover HUDs
- Second SDK language until Python has 1 000 weekly installs

See `_archive/README.md` for the rationale and pointers to the deferred
designs.
