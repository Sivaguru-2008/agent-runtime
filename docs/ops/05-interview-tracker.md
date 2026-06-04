# Interview Tracking System

> Drives P1.1 (pipeline of 40) and P1.2 (20 interviews). The single most important activity in 90 days. Every interview ends in one artifact: a synthesis note in `docs/gtm/interviews/<date>-<company>.md`.
>
> **Mom Test law:** talk about their past behavior, not your idea. Do not pitch until the very end. Script: `docs/gtm/customer-discovery-interview-script.md`.

---

## Funnel targets

| Stage | Target | Why |
|---|---|---|
| Sourced (named targets) | 40 | ~50% reply rate assumption → 20 interviews |
| Outreach sent | 40 | personalized one-liners |
| Booked | 20 | ~5/week, weeks 2–5 |
| Completed + synthesized | 20 | the Phase 1 gate |
| Design-partner candidates | ≥8 | feeds `06-design-partner-tracker.md` |

---

## Pipeline tracker

> ICP: `pay` = payments/financial agents · `infra` = infra/ops agents · `plat` = platform-eng "make agents safe" · `out` = no real side effects (wrong ICP, note + drop).
> Stage: `sourced → sent → booked → done → synthesized`. Outcome: `candidate / not-fit / no-reply / dead`.

| # | Name | Company | Role | ICP | Channel | Warm? | Stage | Date | Outcome | Note file |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | sourced | | | |
| 2 | | | | | | | | | | |
| 3 | | | | | | | | | | |
| 4 | | | | | | | | | | |
| 5 | | | | | | | | | | |
| 6 | | | | | | | | | | |
| 7 | | | | | | | | | | |
| 8 | | | | | | | | | | |
| 9 | | | | | | | | | | |
| 10 | | | | | | | | | | |
| … | (extend to 40) | | | | | | | | | |

**Counts:** sourced `__/40` · sent `__/40` · booked `__/20` · done `__/20` · synthesized `__/20` · candidates `__`

---

## Sourcing kit — how to find 40 targets fast

**The 40 should skew toward people who've ALREADY shipped agents that act, not just talk.** Aim for a mix: ~15 payments/financial, ~15 infra/ops, ~10 platform-eng.

### Concrete search queries (copy-paste)
- **LinkedIn:** `("AI agent" OR "LLM agent") AND (refund OR payout OR billing OR Stripe) (engineer OR founder OR CTO)` · `"agent" AND "production" AND (fintech OR payments)` · `"platform engineer" AND ("agent reliability" OR "agent infrastructure")`
- **X/Twitter:** search `agent (stripe OR refund OR idempotency) (production OR prod)` · `langchain (production OR "in prod") (payments OR infra)` · people complaining about agent retries/double-actions are gold — they've felt the pain.
- **GitHub:** issues/discussions in agent frameworks (LangChain, LlamaIndex, CrewAI, Mastra) mentioning `idempotency`, `retry`, `duplicate`, `exactly-once` → the authors have the problem.
- **YC directory:** filter recent batches for "AI agents" + fintech/ops/infra; founders take cold founder DMs.
- **Communities:** r/LocalLLaMA, r/LLMDevs, agent-builder Discords/Slacks, payments-ops forums (e.g. fintech eng Slacks). Lurk, find people describing real workflows, DM them.
- **Job posts:** companies hiring "agent platform / agent reliability / AI infra" engineers have budget and the pain *right now* → reach the hiring manager.

### The referral engine (your best source after #1)
Every interview ends with "who else should I talk to about this?" A good interview yields 1–2 warm intros. By interview #5 the pipeline should be self-feeding — that's the signal you're talking to real people with a shared, acute problem.

### Inbound (Phase 2)
Anyone who engages with the launch/essays saying "this is my problem" → add as a target, tag source `launch`, DM same day.

---

## Outreach templates

**Cold (LinkedIn/X DM, ≤4 sentences, no pitch):**
```
Hi <name> — I'm researching how teams running AI agents that touch
<money/infra> handle a step failing mid-task (timeout, crash, bad API response).
Not selling anything — I'm trying to learn from people who've actually hit this.
Could I borrow 25 minutes to hear how you handle it today?
```

**Warm (intro'd):**
```
<mutual> suggested I reach out. I'm talking to teams running agents that take
real actions (refunds, payouts, infra changes) about what happens when a step
fails partway through. 25 min to hear how your setup handles it? No pitch.
```

**Follow-up (no reply after 4 days):**
```
Quick bump — still keen to hear how <company>'s agents handle a mid-task failure.
Even 15 min helps. If now's bad, no worries.
```

### Segment-specific openers (higher reply rate than generic)

**Payments/financial:**
```
Hi <name> — researching how teams whose agents issue refunds/payouts handle a
step failing after the money already moved. Not selling — learning from people
who've actually shipped this. 25 min to hear how <company> handles it?
```

**Infra/ops:**
```
Hi <name> — looking into what happens when an agent that provisions/deploys/writes
to systems of record dies partway through an action. How does <company> recover
that today? 25 min, no pitch — I'm just trying to learn from people who've built it.
```

**Platform-eng ("make our agents safe"):**
```
Hi <name> — saw you own agent reliability at <company>. I'm talking to platform
folks about the "make our agents production-safe" mandate — what triggered it and
what you've built so far. 25 min to compare notes? Not selling anything.
```

> Personalize the first line with something specific (a post, a repo, their role). Generic = ignored.

---

## Per-interview synthesis template (fill within 10 min, save to `docs/gtm/interviews/`)

```
# <Date> — <Company> — <Role>
ICP fit (in/adjacent/out):
Agents in prod touching real side effects? (y/n, what):
Has the pain bitten them? (specific story + cost):
Current solution + who built it + spend:
Pain severity (their words, 1-10):
Trigger that would make this a priority:
Decision-maker / budget owner:
Strongest quote (verbatim):
Design-partner candidate? (y/n + next step):
Referrals given:
```

---

## Rolling synthesis (update after every 5 interviews)

Paste a dated block here each milestone (5/10/15/20):

```
## After N interviews — <date>
- Which ICP hypothesis is converting (pay / infra / plat)?
- % with a specific PAST incident vs. only theoretical worry:
- Most common current workaround (= the real competitor):
- Most common trigger event (= the wedge message):
- WTP signals: how many would pay, for what unit?
- Action: keep ICP / pivot wedge / re-target?
```

> Feed the % and leading-ICP into `04-kpi-dashboard.md` (K2) every milestone.

---

## Quality guardrails (you're getting false positives if…)

🚩 "That's cool, I'd use that" (compliment ≠ commitment) · future-tense enthusiasm, zero past action · can't name a specific time or current spend · **you did most of the talking.**

✅ Unprompted war story with a $ cost · already built/bought a workaround · asks "when can I try it?" before you pitch · volunteers a referral · names a trigger event.

**The decision after 20:** double down on the converting ICP, pivot the wedge, or conclude the market is early — on evidence (`04-kpi-dashboard.md`), not conviction. → P3.4.
