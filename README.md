# Runtime + Observability Infrastructure for Autonomous AI Agents

This repository is the first working MVP scaffold for a startup-grade AI infrastructure platform: persistent agent runtime, event-sourced execution traces, replayable failures, memory access tracking, and live runtime monitoring.

The first implemented surface is the backend foundation in `apps/api`: Fastify + TypeScript, clean architecture boundaries, an event bus, an event store port, an agent runtime, execution tracing, replay, and read-model projections.

## Quick Start

```bash
npm install
docker compose up -d
cp apps/api/.env.example apps/api/.env
npm run dev
```

API defaults to `http://localhost:4000`.

Useful endpoints:

- `POST /agents` create an agent
- `GET /agents` list agents with runtime state
- `POST /agents/:agentId/tasks` start a traced task
- `GET /executions/:executionId` inspect timeline and graph
- `POST /executions/:executionId/replay` replay a failed execution as a new branch
- `GET /events/stream` live Server-Sent Events feed

See [docs/architecture.md](./docs/architecture.md) for the V1 system shape and pointers to the canonical correctness specs:

- [`docs/specs/fence-protocol.md`](./docs/specs/fence-protocol.md) — how external side effects are made safe under retries.
- [`docs/specs/replay-equivalent-execution.md`](./docs/specs/replay-equivalent-execution.md) — what replay guarantees and what it does not.

Older design notes live in [`docs/_archive/`](./docs/_archive/README.md) and are not authoritative.
