# Deploy the Agent Runtime API (hosted instance)

Goal of this runbook: a public HTTPS URL serving the real API against managed
Postgres, so a stranger with the SDK and an API key can run a traced,
replayable agent execution. This is task **EN-1** in the execution plan.

The API already runs pending migrations on boot, fails fast in production on a
bad schema/connection, drains gracefully on `SIGTERM`, and exposes an
unauthenticated `/health` for load-balancer probes. The only code change deploy
needed was **TLS for managed Postgres** (`DATABASE_SSL`, see below).

---

## 0. Production invariants (enforced by `loadConfig`)

A `NODE_ENV=production` boot will **refuse to start** unless all of these hold
(`apps/api/src/shared/config.ts`):

- `DATABASE_URL` is set.
- `PERSISTENCE_DRIVER=postgres` and `EVENT_STORE_DRIVER=postgres`.
- `AUTH_ENABLED=true` (unauthenticated prod is rejected).
- For managed Postgres: `DATABASE_SSL=require` (else the `SELECT 1` boot probe
  fails its TLS handshake and the process `exit(2)`s).

`/health` and `/metrics` bypass auth; every other route needs an API key.

---

## 1. Required environment

| Var | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | strict durability + auth enforcement |
| `DATABASE_URL` | `postgres://…` | managed Postgres connection string |
| `DATABASE_SSL` | `require` | TLS handshake against managed PG |
| `AUTH_ENABLED` | `true` | required in prod |
| `PERSISTENCE_DRIVER` | `postgres` | durable execution state |
| `EVENT_STORE_DRIVER` | `postgres` | durable event log / replay history |
| `EVENT_BUS_DRIVER` | `memory` | V1 SSE via Postgres `LISTEN/NOTIFY`, no Redis |
| `RUNTIME_MODE` | `single` | one process (V1 topology) |
| `MODEL_PROVIDER` | `failover` | resilient LLM execution |
| `MODEL_FAILOVER_CHAIN` | `groq,deterministic` | Groq outage degrades, never 500s |
| `GROQ_API_KEY` | `gsk_…` | (or `ANTHROPIC_API_KEY` with `MODEL_PROVIDER=claude`) |

Leave `REDIS_URL` unset — V1 needs no Redis.

---

## 2. Deploy to Fly.io

```bash
# from the repo root
fly launch --no-deploy --copy-config        # uses ./fly.toml
fly postgres create --name agent-runtime-db # managed Postgres (single node ok for V1)
fly postgres attach agent-runtime-db        # injects DATABASE_URL secret

fly secrets set \
  DATABASE_SSL=require \
  AUTH_ENABLED=true \
  MODEL_PROVIDER=failover \
  MODEL_FAILOVER_CHAIN=groq,deterministic \
  GROQ_API_KEY=gsk_xxx

fly deploy                                   # builds apps/api/Dockerfile
fly logs                                     # watch "[startup] ✅ API server listening"
```

## 2b. Deploy to Render (alternative)

Push the repo, then **New → Blueprint** in the Render dashboard pointing at this
repo. `render.yaml` provisions the database, injects `DATABASE_URL`, and builds
the image. Set `GROQ_API_KEY` in the dashboard (it is `sync: false`).

---

## 3. Seed the first owner API key (one-off)

The RBAC escalation guard means no key can mint a key more privileged than
itself, so the first `owner` key is seeded out-of-band. Run **once** against the
production DB:

```bash
# Fly: run inside a machine that has DATABASE_URL + DATABASE_SSL
fly ssh console -C "sh -c 'cd /app && node scripts/seed-owner-key.mjs'"

# Render: use a one-off Job / Shell with the same env, or locally:
DATABASE_URL='postgres://…' DATABASE_SSL=require node scripts/seed-owner-key.mjs
```

Copy the printed `rawKey` (`sk_live_…`) into your secret manager — it is shown
**once**. This is the key the SDK and your first design partners authenticate
with until self-serve key issuance (EN-3) lands.

---

## 4. Verify (the acceptance test for EN-1)

From a machine that is **not** the deploy host, with `BASE` = the public URL and
`KEY` = the seeded owner key:

```bash
BASE=https://agent-runtime-api.fly.dev
KEY=sk_live_xxx

# 1. liveness (no auth)
curl -fsS "$BASE/health"

# 2. create an agent
AGENT=$(curl -fsS -X POST "$BASE/agents" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"deploy-smoke"}' | tee /dev/stderr | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

# 3. start a traced task
EXEC=$(curl -fsS -X POST "$BASE/agents/$AGENT/tasks" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"input":"hello"}' | sed -n 's/.*"executionId":"\([^"]*\)".*/\1/p')

# 4. inspect the execution timeline
curl -fsS "$BASE/executions/$EXEC" -H "authorization: Bearer $KEY"

# 5. replay it as a new branch
curl -fsS -X POST "$BASE/executions/$EXEC/replay" -H "authorization: Bearer $KEY"
```

**Done when:** all five calls succeed from a third machine, the execution
appears with a timeline, and replay returns a new branch id. Add an external
uptime monitor (Better Uptime / Fly metrics) on `GET /health` and confirm green
for 24h.

> Exact request/response field names come from the SDK and `interfaces/http/routes.ts`;
> if a field differs, prefer the SDK's `examples/quickstart.ts` over this curl.

---

## 5. Known deploy gotchas (pre-checked)

- **Migration checksum drift** — never hand-edit an applied migration; CRLF
  normalization can change a checksum and crash boot. `MIGRATIONS_REPAIR_CHECKSUMS`
  is **ignored in production** by design. Fix drift in dev, commit, redeploy.
- **Determinism `Date.now` patch** — must never wrap prod logging/metrics; the
  shared `trueClock` is used by the logger, so production logging is unaffected.
- **No Redis** — keep `EVENT_BUS_DRIVER=memory`; SSE uses Postgres LISTEN/NOTIFY.
