# Deployment Checklist (P0.2 / EN-1)

> Step-by-step to a public HTTPS URL serving the real API against managed Postgres, so a stranger with the SDK + key can run a traced, replayable execution. Canonical runbook: `docs/deploy.md`. This is the executable checklist version.
>
> **Artifact:** a public URL + a seeded `sk_live_…` owner key + 24h-green health monitor. Time-box: 4h first time, 2h hard stop before switching provider.

---

## Pre-flight (before touching a deploy target)

- [ ] P0.1 done — code is on `main`, CI green.
- [ ] A Fly.io **or** Render account created.
- [ ] A Groq API key (`gsk_…`) ready — or an Anthropic key if using `MODEL_PROVIDER=claude`.
- [ ] A secret manager / password vault ready to store the owner key (it's shown once).
- [ ] Read `docs/deploy.md §5` (the 3 known gotchas) so you recognize them on sight.

---

## Production invariants (boot refuses to start unless ALL hold)

> Enforced by `loadConfig` in `apps/api/src/shared/config.ts`. A `NODE_ENV=production` boot `exit(2)`s otherwise.

- [ ] `DATABASE_URL` set (managed Postgres connection string).
- [ ] `DATABASE_SSL=require` (managed PG TLS — else the `SELECT 1` boot probe fails the handshake).
- [ ] `AUTH_ENABLED=true` (unauthenticated prod is rejected).
- [ ] `PERSISTENCE_DRIVER=postgres` and `EVENT_STORE_DRIVER=postgres`.
- [ ] `EVENT_BUS_DRIVER=memory` (SSE via Postgres LISTEN/NOTIFY — **no Redis**, leave `REDIS_URL` unset).
- [ ] `RUNTIME_MODE=single` (V1 single-process topology).
- [ ] `MODEL_PROVIDER=failover`, `MODEL_FAILOVER_CHAIN=groq,deterministic` (a Groq outage degrades, never 500s — see memory `project_provider-outage-resilience`).

---

## Path A — Fly.io

```bash
# from repo root
fly launch --no-deploy --copy-config         # uses ./fly.toml
fly postgres create --name agent-runtime-db  # single node ok for V1
fly postgres attach agent-runtime-db          # injects DATABASE_URL secret

fly secrets set \
  DATABASE_SSL=require \
  AUTH_ENABLED=true \
  MODEL_PROVIDER=failover \
  MODEL_FAILOVER_CHAIN=groq,deterministic \
  GROQ_API_KEY=gsk_xxx

fly deploy                                     # builds apps/api/Dockerfile
fly logs                                       # watch "[startup] ✅ API server listening"
```
- [ ] `fly deploy` succeeded.
- [ ] `fly logs` shows the startup-listening line (not an `exit(2)`).

## Path B — Render (alternative)

- [ ] Push repo → Render dashboard → **New → Blueprint** pointing at this repo.
- [ ] `render.yaml` provisions DB + injects `DATABASE_URL` + builds the image.
- [ ] Set `GROQ_API_KEY` in the dashboard (it's `sync: false`).

---

## Seed the first owner key (one-off)

> RBAC escalation guard: no key can mint a key more privileged than itself, so the first `owner` key is seeded out-of-band (see memory `project_rbac`).

```bash
# Fly: run inside a machine with DATABASE_URL + DATABASE_SSL
fly ssh console -C "sh -c 'cd /app && node scripts/seed-owner-key.mjs'"

# Render: one-off Job/Shell with the same env, or locally:
DATABASE_URL='postgres://…' DATABASE_SSL=require node scripts/seed-owner-key.mjs
```
- [ ] Ran the seed script **once**.
- [ ] Copied the printed `rawKey` (`sk_live_…`) into the secret manager. (Shown once.)

---

## Verify (the EN-1 acceptance test — from a NON-deploy machine)

```bash
BASE=https://agent-runtime-api.fly.dev
KEY=sk_live_xxx

curl -fsS "$BASE/health"                                            # 1. liveness (no auth)
AGENT=$(curl -fsS -X POST "$BASE/agents" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"deploy-smoke"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')   # 2. create agent
EXEC=$(curl -fsS -X POST "$BASE/agents/$AGENT/tasks" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"input":"hello"}' | sed -n 's/.*"executionId":"\([^"]*\)".*/\1/p') # 3. start task
curl -fsS "$BASE/executions/$EXEC" -H "authorization: Bearer $KEY"   # 4. inspect timeline
curl -fsS -X POST "$BASE/executions/$EXEC/replay" -H "authorization: Bearer $KEY" # 5. replay
```
- [ ] All 5 calls succeed from a third machine.
- [ ] Execution appears with a timeline.
- [ ] Replay returns a new branch id.
- [ ] External uptime monitor (Better Uptime / Fly metrics) on `GET /health` — **green for 24h.**

> If a field name differs, trust the SDK's `examples/quickstart.ts` over this curl.

---

## Known gotchas (pre-checked — `docs/deploy.md §5`)

| Symptom | Cause | Fix |
|---|---|---|
| Boot crash on migrations | Checksum drift (hand-edited migration / CRLF) | Fix in dev, commit, redeploy. `MIGRATIONS_REPAIR_CHECKSUMS` is **ignored in prod** by design (memory `project_migration-checksum-recovery`). |
| Boot `exit(2)` on DB connect | Missing `DATABASE_SSL=require` | Set it; the `SELECT 1` probe needs TLS for managed PG. |
| API 500s on LLM calls | Provider outage not classified | Confirm `MODEL_FAILOVER_CHAIN=groq,deterministic` (memory `project_provider-outage-resilience`). |
| Prod logging crashes | `Date.now` determinism patch wrapping logging | Already handled — logger uses shared `trueClock` (memory `project_determinism-guard-logging`). |
| Tried to add Redis | Not needed in V1 | Leave `REDIS_URL` unset; `EVENT_BUS_DRIVER=memory`. |

---

## Done when
- [ ] Public URL live, all 5 verify calls pass from a third machine, health green 24h.
- [ ] Owner key stored securely.
- [ ] URL pasted into `03-founder-dashboard.md` KEY LINKS.
- [ ] Unblocks P0.3 (SDK baseUrl + smoke test) and P0.4 (signup).

## On every later change (redeploy)
- [ ] `fly deploy` (or Render auto-deploy on push).
- [ ] Re-run the 5-call verify.
- [ ] Confirm migrations applied cleanly (no checksum drift).
