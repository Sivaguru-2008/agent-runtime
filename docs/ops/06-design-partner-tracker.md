# Design Partner Tracking System

> Drives P2.3 (convert interviews + launch inbound → 5 design partners) and feeds P3.1/P3.2 (pricing + WTP). A design partner is **not** a "yes" — it's a team that has run your product on **one real failure case** and given feedback.
>
> Artifact per partner: an activation event (first real run) + a feedback log + (ideally) a pricing signal.

---

## What counts as a design partner (the bar)

| Level | Definition | Counts toward the 5? |
|---|---|---|
| Lead | Said "I'd try it" / asked "when can I try?" | No |
| Onboarded | Has an invite code + account on the hosted URL | No |
| **Activated** | Ran ≥1 real agent task on **their own** workflow | **Yes** ✅ |
| Engaged | Activated + gave structured feedback + ongoing thread | Yes ✅✅ |
| Paying-intent | Engaged + gave a pricing signal (K7) | Yes ✅✅✅ |

**Target: 5 Activated.** A "yes" that doesn't activate within 2 weeks → mark `lost`, it was politeness.

---

## Partner tracker

> Stage: `lead → onboarded → activated → engaged → paying-intent` (or `lost`).
> Source: `interview / launch / referral / inbound`.

| # | Name | Company | ICP | Source | Stage | Invite code | Activation date | Real use case | Blocker | Next step | Pricing signal |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | lead | | | | | | |
| 2 | | | | | | | | | | | |
| 3 | | | | | | | | | | | |
| 4 | | | | | | | | | | | |
| 5 | | | | | | | | | | | |
| 6 | (overflow) | | | | | | | | | | |
| 7 | | | | | | | | | | | |
| 8 | | | | | | | | | | | |

**Counts:** leads `__` · onboarded `__` · **activated `__/5`** · engaged `__` · paying-intent `__`

---

## Onboarding checklist (per partner — get them to Activated fast)

- [ ] Hand them an invite code (from P0.4 batch).
- [ ] Confirmed signup → developer key works for them.
- [ ] `npm install <sdk>` succeeded on their machine.
- [ ] Helped them wire it to **one real failure case** they described in the interview.
- [ ] They watched a replay of their own execution.
- [ ] Time-to-first-replay measured (log in `04-kpi-dashboard.md` K5).
- [ ] Booked a 30-min feedback call after first run.

> If they stall at any step, that step is the #1 product bug (P2.4). Fix only that.

---

## Per-partner feedback log

Paste a dated block per partner after each touchpoint:

```
## <Company> — <date> — <touchpoint>
Use case they ran:
Did it work? (what broke / what delighted):
Time-to-first-replay:
Strongest quote:
Feature they asked for (and did a real user trip on it?):
Pricing reaction (if any):
Next step + owner + date:
```

> **Do not build requested features unless a real user tripped on it** (the one rule). Log the request; only act on observed drop-offs (P2.4).

---

## Design-partner offer (lightweight, informal)

```
Free early access + hands-on help getting it running, in exchange for:
- using it on one real failure case in your workflow, and
- 30 minutes of honest feedback after your first run.
No contract, cancel anytime. I'll personally help you set it up this week.
```

---

## Conversion playbook

1. **From interviews:** anyone who hit a green flag (war story, asked to try, gave a referral) → offer the partner deal at the script's final ask.
2. **From launch:** inbound DMs/comments saying "this is my problem" → DM the offer + invite code same day.
3. **Speed wins:** the gap between "yes" and "activated" is where partners die. Onboard within 48h of yes.
4. **Feed P3.1:** once Engaged, probe pricing (per execution / seat / tenant). Log to K7.

**Phase 2 exit needs 5 Activated. Phase 3 needs ≥3 of them to give pricing signals and ≥1 to commit in writing.**
