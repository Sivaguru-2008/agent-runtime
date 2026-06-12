# Outreach Kit — 40 Targets + Messages (P1.1)

> Everything needed to go from zero to 40 sent in two sittings. Companies are named;
> find the person on LinkedIn with the role-title queries, log each one in
> `docs/ops/05-interview-tracker.md`, send, and follow the cadence.
>
> **The ask is 20 minutes about how THEY handle agent incidents today. Never pitch
> first. Mom Test rules — past behavior, not your idea.** Script:
> `docs/gtm/customer-discovery-interview-script.md`.

---

## 1. The three messages

### A. Cold LinkedIn InMail / connection note — risk & compliance buyers (ICP: pay)

> Subject (InMail): **After an AI-agent incident, who reconstructs what happened?**
>
> Hi {{Name}} — I spent years in payment risk, now building infrastructure for AI-agent
> audit trails. I'm interviewing risk and compliance leaders about one specific moment:
> an automated system acted on a customer account, and someone had to reconstruct
> exactly what it did and why — from logs never designed for that.
>
> Not selling anything on this call — I'm 20 interviews into mapping how teams actually
> handle this today. Would 20 minutes next week be crazy?

*Why this works: leads with their lived incident, not your product. The payment-risk
background is the credibility hook — use it in the first sentence, always.*

### B. Cold email / DM — founders & eng leads shipping agents (ICP: pay/infra)

> Subject: **double-fired tool calls in prod?**
>
> Hi {{Name}} — saw {{company}} runs agents that {{do the thing: issue refunds /
> touch billing / call payment APIs}}. Quick question from someone who spent years in
> payment risk: when an agent retries and a side effect fires twice — or a customer
> disputes what the agent did — how do you reconstruct it today?
>
> I'm interviewing teams about this (not pitching). 15–20 min sometime this week?

*Personalize the {{do the thing}} clause from their docs/launch posts — one specific
detail doubles reply rate. If they've posted publicly about retries/idempotency pain,
quote it back.*

### C. Warm-intro ask (send to anyone who knows the target)

> Hey {{mutual}} — I'm researching how teams running AI agents handle incident
> reconstruction (the "prove what the agent did" problem). I think {{Name}} at
> {{company}} deals with exactly this. Would you intro us? Two lines is plenty —
> happy to send a forwardable blurb.

**Forwardable blurb:** *"Sivaguru spent years in payment risk and is building
audit-trail infrastructure for AI agents. He's interviewing people who run agents in
production about how they reconstruct incidents — 20 minutes, no pitch."*

### Follow-up cadence (per target, then stop)
- **Day 0:** send. Log `sent` in tracker.
- **Day 3:** bump — *"Floating this up — happy to work around your schedule."*
- **Day 7:** final — *"Last nudge, then I'll leave you alone. If there's someone
  better on your team for 'what did the agent actually do' questions, point me?"*
- **No reply after day 10:** mark `no-reply`, move on. Never a 4th touch.

---

## 2. The 40 targets

> Find the person: LinkedIn → company → role query → pick whoever owns agent
> behavior/risk. One name per company to start; log in tracker `05` with ICP tag.
> Verify each company's current state before sending (funding/pivots move fast).

### Tier 1 — Payments & fintech (15) — ICP `pay`, message A or B
Role queries: `"model risk" OR "AI risk" OR "AI governance"`, `"head of risk"`,
`"trust and safety" AND agent`, `"applied AI" AND (payments OR risk)`.

| # | Company | Why them | Likely role to find |
|---|---|---|---|
| 1 | Stripe | agents + payments APIs; idempotency culture | Applied-AI eng lead / risk PM |
| 2 | Adyen | enterprise payments, EU AI Act exposure | AI governance / model risk |
| 3 | Block (Square) | AI in seller tools touching money | Head of AI platform / risk |
| 4 | PayPal | announced AI dispute-resolution work | VP AI risk / disputes platform |
| 5 | Wise | cross-border ops automation | Platform eng lead, ops automation |
| 6 | Ramp | agentic finance ops, ships fast | AI eng lead / CTO office |
| 7 | Brex | AI assistants on corporate spend | Head of AI / platform risk |
| 8 | Mercury | banking ops automation | Eng lead, risk & compliance tooling |
| 9 | Klarna | publicly all-in on AI service agents | AI governance / service-agent lead |
| 10 | Affirm | underwriting decisions, audit burden | Model risk management |
| 11 | Plaid | data + actions on bank accounts | Platform security / AI eng |
| 12 | Marqeta | issuing APIs agents will call | Solutions eng / risk product |
| 13 | Checkout.com | EU regulated, AI ops push | AI risk / compliance eng |
| 14 | Chime | consumer fintech support automation | Support-automation eng lead |
| 15 | Airwallex | cross-border + AI ops | Head of AI engineering |

### Tier 2 — Agent companies with real side effects (15) — ICP `infra`, message B
They feel double-fire/retry pain personally; founders answer DMs. Role queries:
founder/CTO directly, or `"agent infrastructure"`, `"platform engineer"`.

| # | Company | Why them | Likely role |
|---|---|---|---|
| 16 | Sierra | customer-service agents acting on accounts | Founding eng / platform |
| 17 | Decagon | support agents with refund/billing actions | CTO / founding eng |
| 18 | Lindy | general agents w/ tool side effects | Founder/CTO |
| 19 | Cognition (Devin) | autonomous actions, audit questions | Platform eng lead |
| 20 | Factory | enterprise SDLC agents | Founding eng |
| 21 | Dust | enterprise agent platform (EU!) | Founder/CTO |
| 22 | 11x | sales agents sending real outreach | Head of eng |
| 23 | Artisan | outbound agents, real emails sent | Founding eng |
| 24 | Bland | voice agents taking actions mid-call | Infra lead |
| 25 | Vapi | voice-agent platform, tool calls | Platform eng |
| 26 | Retell | voice agents for ops | Founding eng |
| 27 | Cresta | contact-center agents at enterprises | VP eng / platform |
| 28 | Forethought | support automation with actions | Eng lead |
| 29 | Intercom (Fin) | Fin agent resolves billing tickets | Fin platform eng lead |
| 30 | Sendbird / Ada (pick livelier) | deployed support agents | AI platform lead |

### Tier 3 — Regulated enterprise platform-eng (10) — ICP `plat`, message A
The "18 months from now" buyer — earlier in deployment, biggest budgets. Role
queries: `"AI governance"`, `"model risk management" AND (LLM OR agent)`,
`"AI platform" AND (bank OR insurance)`.

| # | Company | Why them | Likely role |
|---|---|---|---|
| 31 | JPMorgan | deployed agent tooling; MRM culture | AI model risk / agent platform |
| 32 | Goldman Sachs | GS AI platform, trade workflows | AI platform governance |
| 33 | Capital One | strongest bank eng brand, agent posts | Head of AI platform risk |
| 34 | American Express | service automation on accounts | AI governance lead |
| 35 | Visa | agentic-commerce initiatives (public) | AI product risk |
| 36 | Mastercard | agent payments standards work | AI governance / franchise risk |
| 37 | Intuit | GenOS platform, money movement | AI platform eng lead |
| 38 | Shopify | merchant agents (Sidekick) + payments | Agent platform eng |
| 39 | Uber | support automation, refunds at scale | Platform eng, support automation |
| 40 | Booking.com | EU AI Act + service agents | AI governance / platform |

---

## 3. Objection handling (the three replies you'll get)

1. **"We already have logging/observability."**
   → *"Totally — and when a customer disputed an agent action, did the logs answer it,
   or did someone spend a week stitching app logs + a DB snapshot + memory of the
   config? That gap is exactly what I'm researching."* (Their war story IS the interview.)

2. **"We're not deploying agents on money paths yet."**
   → *"That's a data point I want — what's blocking it?"* If the answer is risk/audit
   → that's K2 signal. If "no use case" → mark `out`, wrong ICP, move on politely.

3. **"Send me a deck / what are you selling?"**
   → *"No deck — genuinely a research call. If it's useful I'll share what 20 other
   teams do about this at the end."* (The synthesis becomes your give-back asset and
   the design-partner door-opener.)

---

## 4. Operating rhythm

- **Sitting 1 (2h):** source persons for targets 1–20 on LinkedIn, log all in tracker
  `05` as `sourced`, send 20 (message A for Tier 1, B for Tier 2).
- **Sitting 2 (2h, next day):** targets 21–40, same flow.
- **Daily (15 min):** bumps per cadence; book replies same-day (use a Calendly link).
- **Every interview:** synthesis note in `docs/gtm/interviews/<date>-<company>.md`
  same day + "who else should I talk to?" → 1–2 warm adds.
- **Friday:** update K1/K2 in `docs/ops/04-kpi-dashboard.md`. Honestly.

**Success bar for the kit:** 40 sent by day 14 → ~12–20 replies → ≥10 booked.
If reply rate < 15% after the first 20, the message is wrong — rewrite the first
sentence around a sharper incident, don't change the list.
