# ICP — Ideal Customer Profile

> **Status: DRAFT SHELL — do not fill until ≥10 interviews are done (P1.4).** Every claim below must cite an interview file in `docs/gtm/interviews/`. If you can't cite it, you don't know it yet — go run more interviews. One page, max.
>
> Until filled, this is a hypothesis, not an ICP. The three hypotheses under test: **payments/financial agents**, **infra/ops agents**, **platform-eng who own "make our agents safe"**.

---

## The one-line ICP
`<Who has this pain acutely, today — written only after evidence. e.g. "Seed–Series-A fintech teams running LLM agents that issue refunds/payouts in production.">`

> Cite: `[<date>-<company>.md]`, `[<date>-<company>.md]`

## Who they are (firmographics + role)
- Company stage / size: `____`
- The person with the pain (title): `____`
- The person with the budget (title): `____`
- Where their agents are: `prototype / internal / live with real money` → `____`

## The acute pain (in their words)
`<The specific failure that has already bitten them, with a cost. Quote it.>`
> Cite: `[…]`

## The trigger event (what makes this top-3 priority)
`<The named event that flips this from "someday" to "this quarter" — e.g. "after we double-refunded N customers in <month>". This becomes your wedge messaging.>`
> Cite: `[…]`

## What they do instead today (your real competitor)
`<The dominant current workaround: custom retry logic / idempotency keys / Temporal / nothing. This is what you're actually replacing.>`
> Cite: `[…]`

## Where they look for a solution / what earns trust
`<Where they'd search, and what would make them trust a new vendor near their payment flow.>`
> Cite: `[…]`

## The sharpest wedge message (one sentence)
`<The single line that made in-ICP people lean in. Test it in the launch + essays.>`

---

## Explicitly OUT of ICP (note and drop)
- Teams doing chatbots / RAG with **no** real-world side effects — wrong ICP, do not pursue.
- `<others discovered during interviews>`

## Evidence summary (fill from `docs/ops/05-interview-tracker.md` rolling synthesis)
- Interviews informing this doc: `__`
- % of in-ICP with a *specific past incident*: `__%` (KPI K2)
- Converting hypothesis: `payments / infra / platform-eng`
- Confidence: `low / medium / high` — and what would raise it: `____`
