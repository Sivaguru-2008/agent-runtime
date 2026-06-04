# Week 1 — START HERE (the one-session ship runbook)

> Everything in this file is **yours to run** — it needs your accounts/credentials, so I can't do it for you. But the config is audited and the SDK build is verified green, so this is a sequence, not a debugging session. Block 4–5 hours, go top to bottom. Each step ends in an artifact you paste into `03-founder-dashboard.md`.
>
> Pre-reqs to have open before you start: a **Fly.io or Render account** (Render = fewer footguns), an **npm account**, a **Groq API key** (`gsk_…`), and a password manager for the owner key.

---

## ☐ Step 1 — P0.1 Commit & push (15 min)

```bash
git status                      # eyeball the modified/untracked set
git add -A
git commit -m "feat: ship SDK, signup, funnel, onboarding, explainability"
git push                        # then open a PR to main, let CI go green, merge
```
**Artifact:** clean `git status` on `main`, CI green. → dashboard P0.1 ✅

---

## ☐ Step 2 — P0.2 Deploy (the gate — everything depends on this)

Pick **one** path. Render is the lower-footgun option (its blueprint bakes in the model failover env; Fly needs it set as secrets).

### Path A — Render (recommended)
1. Push the repo (done in Step 1).
2. Render dashboard → **New → Blueprint** → point at this repo. `render.yaml` provisions the DB, injects `DATABASE_URL`, builds the image.
3. Set `GROQ_API_KEY` in the dashboard (it's `sync:false`).
4. Wait for build + first boot. Watch logs for the startup-listening line.

### Path B — Fly.io
```bash
fly launch --no-deploy --copy-config
fly postgres create --name agent-runtime-db
fly postgres attach agent-runtime-db
# CRITICAL: include MODEL_PROVIDER + CHAIN or failover won't engage —
# fly.toml [env] does NOT set these, only the non-secret vars.
fly secrets set \
  MODEL_PROVIDER=failover \
  MODEL_FAILOVER_CHAIN=groq,deterministic \
  GROQ_API_KEY=gsk_xxx
fly deploy
fly logs            # watch for "[startup] ✅ API server listening"
```

**If boot crashes:** check `09-deployment-checklist.md` §gotchas (almost always: missing `DATABASE_SSL=require`, or migration checksum drift). 2-hour hard stop → switch provider rather than keep debugging.

**Artifact:** a public HTTPS URL. Paste it into the dashboard KEY LINKS + below as `BASE`. → dashboard P0.2 🟡 (✅ after Step 6)

---

## ☐ Step 3 — Seed the owner key (5 min, one-off)

```bash
# Render: one-off Shell/Job with the service env, or locally with the DB URL:
DATABASE_URL='postgres://…' DATABASE_SSL=require node scripts/seed-owner-key.mjs

# Fly:
fly ssh console -C "sh -c 'cd /app && node scripts/seed-owner-key.mjs'"
```
Copy the printed `rawKey` (`sk_live_…`) into your password manager **now** — it's shown once.

**Artifact:** owner key stored. → set `KEY=sk_live_…` for the next steps.

---

## ☐ Step 4 — P0.3 Publish the SDK (build already verified ✅)

```bash
cd packages/sdk
# 1) point the README quickstart baseUrl at your BASE url (Step 2)
# 2) decide the name: keep @agent-platform/sdk only if you own that npm org, else rename
npm login
npm publish --access public      # prepublishOnly re-runs typecheck+test+build (already green)
```
Then the clean-room smoke test (full script in `10-sdk-publishing-checklist.md` §3):
```bash
mkdir /tmp/sdk-smoke && cd /tmp/sdk-smoke && npm init -y
npm install <your-published-name>
# run the example execution against BASE + KEY
```
**Artifact:** package live on npm; clean-room install runs an execution. → dashboard P0.3 ✅

---

## ☐ Step 5 — P0.4 Turn on invite-gated signup (10 min)

```bash
# Render dashboard env, or:  fly secrets set
SIGNUP_ENABLED=true
SIGNUP_OPEN=false
# redeploy so it takes effect
```
Walk: fresh email → invite code → developer key → first agent run against `BASE`. Mint a batch of invite codes for launch (paste into `07-launch-tracker.md`).

**Artifact:** working invite-gated signup. → dashboard P0.4 ✅

---

## ☐ Step 6 — P0.5 Stranger smoke test + verify (30 min)

Run the 5-call deploy verification from a **different** machine (`09-deployment-checklist.md` §verify): health → create agent → start task → inspect → replay. Then the full cold path with a **stopwatch**:

> incognito/clean machine: signup → `npm install <sdk>` → create agent → run task → see replay.

Record the minutes in `04-kpi-dashboard.md` (K5). If >10 min, the slowest single step is your #1 product bug — fix only that, re-time. Add an external uptime monitor on `GET BASE/health`; confirm green for 24h.

**Artifact:** time-to-first-replay number + green health monitor. → dashboard P0.2 ✅, P0.5 ✅

---

## ✅ Phase 0 exit gate (all true → start Phase 1)

- [ ] Code on `main`, CI green.
- [ ] Public URL, 5-call verify passes from a third machine, health green 24h.
- [ ] npm package installs clean and runs an execution.
- [ ] Invite-gated signup works end to end.
- [ ] Time-to-first-replay recorded (≤10 min, or the #1 bug is logged + fixed).

**The moment this gate is green, start outreach the same day** — don't wait for a "perfect" product. Open `05-interview-tracker.md` and the sourcing kit, send your first 5 messages. The clock on market contact starts now, not after more polish.

---

## What's already prepared for you (don't rebuild these)
- Deploy config (`fly.toml`, `render.yaml`, `Dockerfile`) — audited, coherent.
- `seed-owner-key.mjs` — works against managed Postgres.
- SDK — typecheck + build verified green; just needs `npm publish`.
- Landing page template — `docs/gtm/landing/index.html` (fill `REPLACE_*` tokens, deploy).
- 3 launch essays — `docs/gtm/essays/` (fill links, publish in Phase 2).
- Interview folder + template, ICP shell, WTP template, day-90 shell — all in `docs/gtm/`.
