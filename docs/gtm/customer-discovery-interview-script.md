# Customer Discovery Interview Script (20 interviews)

**Goal:** Find out whether the pain ("AI agents repeating real-world side effects on failure / corrupting state / being unsafe in production") is **acute and present today** — or latent and 18 months early. This is the single most important activity in the next 90 days and has never been done.

**The Mom Test rules (non-negotiable):**
1. Talk about *their* life and past behavior, not your idea.
2. Ask about *specifics in the past*, not *opinions about the future* ("Would you use…?" answers are worthless).
3. Do NOT pitch until the very end — and only if they ask. The moment you pitch, you stop learning.
4. Dig for what they've *already done and paid for* (workarounds = proof of pain).
5. Shut up and let silence do the work.

**Who to interview (ICP hypotheses to test):**
- Teams running LLM agents that call payment/financial APIs (refunds, payouts, invoicing).
- Teams whose agents take infra/ops actions (provisioning, deploys, ticket/DB writes).
- Platform/infra engineers who own "make our agents production-safe."
- NOT: people only doing chatbots / RAG with no real-world side effects (wrong ICP — note them as out-of-scope).

**Logistics:** 25–30 min, recorded (with consent). Notes into `docs/gtm/interviews/<date>-<company>.md` using the synthesis template at the bottom.

---

## Section A — Warm-up & context (2 min)
1. Tell me about what your team is building with AI agents right now.
2. Which of those agents actually take real actions in the world (move money, change infra, write to systems of record) vs. just generate text?
3. How far along are those — prototype, internal, or live with real users/money?

> *Listen for: are they even in the ICP? If no real side effects in production or near it, you're talking to the wrong person — note it and wrap early.*

## Section B — The problem in their own words (8 min)
4. Walk me through the last time one of your agents did something in production that went wrong. What happened?
5. When an agent is partway through a multi-step task and a step fails — a timeout, a crash, a bad API response — what happens today in your system?
6. Has an agent ever repeated an action it shouldn't have — double-charged, double-sent, double-wrote? Tell me about that specific time.
7. (If yes) What did that cost you — money, customer trust, an incident, eng hours? Walk me through the cleanup.
8. (If no) What stops it from happening today? Who built that, and how much do you trust it?
9. How do you currently know *what* an agent did and *why*, after the fact? Walk me through the last time you had to debug an agent's behavior in production.
10. When you need to re-run or recover a failed agent task, how do you do it today?

> *These are the core questions. Spend the most time here. Chase every specific story with "tell me more about that time."*

## Section C — Current solutions & spend (6 min)
11. What are you using today to make agents reliable — Temporal, a queue, custom retry logic, idempotency keys, something else?
12. How well is that working? Where does it break down or annoy you?
13. Who built it and how long did it take? Is someone maintaining it now?
14. Have you ever paid for a tool to help with this, or seriously evaluated one? What happened?
15. If you do nothing about this, what's the worst case in the next 6 months? How worried are you about it on a scale where 10 = "this keeps me up at night"?

> *Listen for: existing spend, a champion who's already tried to solve it, and a real budget line. Workarounds they built = strongest proof of pain.*

## Section D — Triggers & buying (5 min)
16. What would have to happen for "make our agents production-safe" to become a top-3 priority this quarter? Has anything like that already happened?
17. Who else would be involved in deciding to adopt something like this? Whose budget?
18. Where would you even look for a solution to this — and what would make you trust a new vendor enough to put it near your payment flow?
19. What's the smallest version of this problem that, if solved, would be worth paying for?

## Section E — Close (3 min, only now)
20. *(Only if they ask "so what are you building?")* Give the 30-second version + offer the demo. Then: "Would it be useful to try it on one of your real failure cases? I'll help you set it up." → **Convert to design partner.**

Final asks (always):
- "Who else should I talk to about this?" (referral chain)
- "Can I follow up when there's something to try?" (permission to re-engage)

---

## Red flags that you're getting false positives
- "That's cool, I'd definitely use that." (compliment, not commitment — ignore)
- Lots of future-tense enthusiasm, zero past-tense action.
- They can't name a specific time it bit them and can't name what they spend on it today.
- You did most of the talking.

## Green flags (real pain)
- Unprompted war story with a dollar/incident cost.
- They've already built or bought a workaround.
- They ask "when can I try it?" before you pitch.
- They volunteer to intro you to a colleague with the same problem.
- A named trigger event ("after we double-refunded 40 customers in March…").

---

## Per-interview synthesis template (fill immediately after)

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

## Rolling synthesis (update after every 5 interviews)
- Which ICP hypothesis is converting? (payments vs. infra vs. platform-eng)
- % who have a *specific past* incident vs. only theoretical worry.
- Most common current workaround (= your real competitor).
- Most common trigger event (= your wedge messaging).
- WTP signals: how many would pay, for what unit (per execution? per seat? per tenant?).
- **Decision after 20:** double down on the converting ICP, pivot the wedge, or conclude the market is early — based on evidence, not conviction.
