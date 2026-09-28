# Agent Runtime — AI Infrastructure Platform

[![CI](https://github.com/Sivaguru-2008/agent-runtime/actions/workflows/agent-fence-ci.yml/badge.svg)](https://github.com/Sivaguru-2008/agent-runtime/actions/workflows/agent-fence-ci.yml)

Startup-grade infrastructure for running, tracing, and observing autonomous AI agents.

**What it does:**
- Persistent agent runtime with execution tracing and event sourcing
- Replayable failures — replay any failed execution as a new branch
- Memory access tracking and live runtime monitoring
- Exactly-once side-effect guarantees via the [`agent-fence`](./agent-fence) protocol
- Live SSE event feed and a Next.js operator dashboard

---

## Requirements

- **Node.js** >= 20.11 — [download](https://nodejs.org)
- **Docker** — for Postgres and Redis — [download](https://www.docker.com/products/docker-desktop)
- **Groq API key** (free) — for real AI execution — [get one](https://console.groq.com/keys)

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres + Redis
docker compose up -d

# 3. Configure the API
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env:
#   - Set GROQ_API_KEY to your Groq key (get one free at https://console.groq.com/keys)
#   - Optionally set GOOGLE_CLIENT_ID + SESSION_SECRET for Google Sign-In

# 4. Configure the Web app
cp apps/web/.env.example apps/web/.env
# Edit apps/web/.env:
#   - Run: node apps/api/scripts/seed-operator-key.mjs  → paste the printed key as RUNTIME_API_KEY
#   - Set the same SESSION_SECRET and GOOGLE_CLIENT_ID as in apps/api/.env (if using Google Sign-In)

# 5. Start everything
npm run dev
```

- **API** → `http://localhost:4000`
- **Dashboard** → `http://localhost:3000`

> **No Groq key?** Set `MODEL_PROVIDER=deterministic` in `apps/api/.env` to run without any API key. The agent uses static seeded outputs — great for local testing.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agents` | Create an agent |
| `GET` | `/agents` | List agents with runtime state |
| `POST` | `/agents/:agentId/tasks` | Start a traced task |
| `GET` | `/executions/:executionId` | Inspect timeline and graph |
| `POST` | `/executions/:executionId/replay` | Replay a failed execution as a new branch |
| `GET` | `/events/stream` | Live Server-Sent Events feed |

---

## Project Structure

```
apps/
  api/    — Fastify + TypeScript backend (event bus, agent runtime, traces, replay)
  web/    — Next.js operator dashboard (live event feed, execution graph, RBAC)
packages/
  sdk/    — TypeScript SDK for interacting with the runtime
agent-fence/  — Exactly-once side-effect protocol library (published to npm)
agent-runtime/ — CLI agent harness using the runtime
docs/         — Architecture, specs, ops runbooks, deployment guide
```

---

## Documentation

- [`docs/architecture.md`](./docs/architecture.md) — V1 system design
- [`docs/deploy.md`](./docs/deploy.md) — Deploy to Render / Fly.io / Docker
- [`docs/specs/fence-protocol.md`](./docs/specs/fence-protocol.md) — Exactly-once side-effect safety
- [`docs/specs/replay-equivalent-execution.md`](./docs/specs/replay-equivalent-execution.md) — Replay guarantees
- [`docs/ops/`](./docs/ops/) — Week-1 runbook, deployment checklist

---

## License

[MIT](./LICENSE)
