# Launch Tracking System

> Drives P2.2 (Show HN + X + LinkedIn). Source drafts: `docs/gtm/launch-show-hn-and-demo.md`. Lead with the demo video everywhere.
>
> **Hard gate:** do not launch until the front door is real — public URL (P0.2) + published SDK (P0.3) + working signup (P0.4) + demo video (P1.3) + landing page (P1.5) all green. A launch with no front door wastes the one-time attention spike.

---

## Pre-launch gate (all must be ✅ before posting)

| Precondition | Task | Status |
|---|---|---|
| Demo video uploaded (YouTube unlisted + mp4 fallback) | P1.3 | ⬜ |
| Landing page live (video + "Deploy your first agent" CTA) | P1.5 | ⬜ |
| SDK published; `npm install` verified from clean machine | P0.3 | ⬜ |
| Deployed API healthy; signup invite codes ready | P0.2/P0.4 | ⬜ |
| Funnel confirmed recording signups + source/UTM | P1.5 | ⬜ |
| 3 communities identified for soft shares (r/LocalLLaMA, agent Discords/Slacks) | — | ⬜ |
| Show HN body + X thread + LinkedIn post drafted | — | ⬜ |
| Calendar cleared for 3h keyboard time | — | ⬜ |

> If any row is ⬜ on launch morning → **postpone**. There is no partial launch.

---

## Launch day timeline (Tue–Thu, ~8–10am ET)

| Time | Action | Owner | Done |
|---|---|---|---|
| T-1 day | Final clean-machine `npm install` + signup smoke test; confirm health monitor green | you | ⬜ |
| T+0:00 | Post Show HN (title from the kit) | you | ⬜ |
| T+0:00–3:00 | **At keyboard. Reply to every comment within minutes.** Non-defensive on "Temporal does this." | you | ⬜ |
| T+2:00 | Post X thread (stagger ~2h after HN) | you | ⬜ |
| T+2:00 | Post LinkedIn founder post | you | ⬜ |
| T+3:00 | Soft-share demo (not pitch) in 3 communities | you | ⬜ |
| T+4:00 | First funnel check — signups + sources attributing? | you | ⬜ |
| EOD | Capture metrics + top-3 objections verbatim (below) | you | ⬜ |

---

## Launch metrics capture

| Metric | Value | Source |
|---|---|---|
| HN rank peak / points / comments | | HN |
| Unique visitors (launch day) | | funnel |
| Signups (launch day) | | funnel |
| Activation (signup → first run) | | funnel |
| **Inbound conversations booked** (the metric that matters) | | tracker |
| npm installs (delta) | | npm |
| X impressions / LinkedIn reactions | | platforms |

---

## Top 3 objections heard (verbatim — these rewrite your positioning)

1. `____________________`
2. `____________________`
3. `____________________`

> Feed these into `08-content-publishing-system.md` (next essay angle) and your launch-reply playbook. The strongest objection is free positioning research.

---

## Objection-reply playbook (prep before launch)

- **"Temporal/queue already does this."** → "For deterministic workflows, yes. The delta is LLM agents plan steps *dynamically* — a naive retry re-runs the plan, not the failed step. We fence side-effects at the SQL layer + diff replays via chain-hash. What does your Temporal setup do when the LLM re-plans differently on retry?"
- **"This is overkill — I just use idempotency keys."** → "That's exactly the right instinct. We make the idempotency key reservation live in the same transaction as the fence-token check, so a stale worker physically can't re-run a completed call. Where do you store the key today, and what validates it under a worker handoff?"
- **"Postgres + Redis sounds heavy."** → "No Redis in V1 — one Node process + Postgres. `npm install`, point at a URL, you're running. Try the deploy link."
- **"I'm not in production with agents yet."** → wrong-ICP, note it, ask who they know who is.

> Never get defensive. HN rewards naming the honest competitor and inviting the strongest objection.

---

## Post-launch (T+1 to T+7)

- [ ] Reply to every late comment/DM within the day.
- [ ] DM the design-partner offer to everyone who said "this is my problem" (feed `06`).
- [ ] Update `04-kpi-dashboard.md` (K3 signups, K4 activation).
- [ ] Log the launch verdict in `03-founder-dashboard.md` weekly row.
- [ ] Decide essay-2/3 angles from the objections (P2.1).
