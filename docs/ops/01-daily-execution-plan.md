# Daily Execution Plan

> Solo founder, ~6 focused hours/day. Optimize for **shipping an artifact every day**. The plan is front-loaded: Phase 0 is a 5-day sprint; Phases 1–3 settle into a repeatable weekly rhythm.
>
> **Rule:** every day must close with one concrete artifact logged in `03-founder-dashboard.md`. A day with no artifact is a red day.

---

## The daily template (use this shape every day)

| Block | Time | Purpose |
|---|---|---|
| **Morning standup (10 min)** | start | Open `03-founder-dashboard.md`. Read "the one rule". Pick today's primary artifact. |
| **Deep block 1 (2h)** | AM | The hardest/most-leverage task. No Slack, no codebase rabbit holes. |
| **Outreach/contact block (1h)** | midday | Send interview requests, follow up partners, reply to inbound. *Non-negotiable in Phases 1–3.* |
| **Deep block 2 (2h)** | PM | Second task or finish the morning artifact. |
| **Wrap (20 min)** | EOD | Log artifact + update the relevant tracker + set tomorrow's primary artifact. |

**The contact block is sacred.** In Phases 1–3, if you do nothing else, send 3 outreach messages or run 1 interview. Code is optional; contact is not.

---

## Phase 0 — Week 1 (the 5-day ship sprint)

The whole product already exists uncommitted. This week is pushing, not building.

| Day | Primary artifact | Tasks | Hours |
|---|---|---|---|
| **Mon** | Code on `main`, CI green | P0.1 | 1.5 (rest: read deploy runbook, create Fly/Render + npm accounts) |
| **Tue** | Public API URL live | P0.2 (`09-deployment-checklist.md`) | 4 |
| **Wed** | npm package published | P0.3 (`10-sdk-publishing-checklist.md`) | 2 + buffer for P0.2 spillover |
| **Thu** | Working invite-gated signup | P0.4 | 1.5 |
| **Fri** | Timed stranger smoke test + week-1 review | P0.5 + Friday ritual | 1 + fix |

**Phase 0 exit gate (must be true Friday EOD):** public URL + npm package + working signup + a time-to-first-replay number. If not, Phase 0 spills into Monday — do not start Phase 1 until the gate is green. *Everything downstream depends on a working front door.*

---

## Phases 1–3 — the repeatable weekly rhythm

Once Phase 0 ships, every week looks like this. Tasks slot in per the sprint plan (`02-weekly-sprint-plan.md`).

| Day | Theme | Default blocks |
|---|---|---|
| **Mon** | Plan + pipeline | Standup → book the week's interviews/partner calls → deep block on the sprint's build artifact (landing page, essay, demo) |
| **Tue** | Interview day | 2–3 interviews + immediate synthesis (10 min each) → contact block (refill pipeline) |
| **Wed** | Build/ship day | Deep block on the week's shippable (essay draft, landing fix, video) → 1 interview |
| **Thu** | Interview day | 2–3 interviews + synthesis → contact block |
| **Fri** | Synthesize + review | Update rolling synthesis + `04-kpi-dashboard.md` → Friday ritual (3 questions) → publish/ship the week's artifact |

**Interview target: 5/week** during weeks 2–5. Front-load Tue/Thu; use Wed as overflow.

---

## Phase-specific daily focus

### Phase 1 (Weeks 2–5) — Market contact
- **Daily minimum:** 1 interview booked or run, OR 3 outreach sent. Never zero.
- Week 2: pipeline (P1.1) + start interviews + record demo (P1.3) on a build day.
- Week 3: interviews + draft landing page (P1.5).
- Week 4: interviews + write ICP doc (P1.4) once you hit 10 interviews.
- Week 5: finish 20 interviews + landing page live + rolling synthesis complete.

### Phase 2 (Weeks 6–9) — Launch & partners
- Week 6: write + publish essay 1 (P2.1); finalize launch assets.
- Week 7: **launch day** (P2.2) — clear the calendar, 3h at keyboard for replies. Essay 2.
- Week 8: convert inbound + interviews → design partners (P2.3); essay 3; onboard partners hands-on.
- Week 9: get to 5 activated partners; watch the funnel (P2.4); fix the #1 drop-off.

### Phase 3 (Weeks 10–13) — Money
- Week 10: pricing conversations with every active partner (P3.1).
- Week 11: push the strongest signal to a written commitment (P3.2).
- Week 12: if P3.2 landed, wire Stripe metered billing (P3.3); else, more pricing pressure.
- Week 13: Day-90 review (P3.4) — write the decision memo.

---

## Anti-drift tripwires (check at standup)

- **Codebase magnetism:** if today's primary artifact is a code change with no user attached, stop and ask "which interview/partner/launch does this serve?" If none → it's drift.
- **Two-week zero:** if the last two Fridays both answered "zero" to "how many real conversations?" — abandon today's plan and spend the whole day on pipeline.
- **Polish creep:** "just make the UI nicer" / "one more refactor" → only allowed if a real user tripped on it (P2.4 evidence). Otherwise delete the task.
