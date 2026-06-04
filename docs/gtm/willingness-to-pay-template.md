# Willingness-to-Pay / Letter of Intent — Template

> For P3.2: convert the strongest pricing signal into a **written** commitment. One real signal beats ten polite nods. Anything written and named counts — an email reply, a signed paragraph, a paid-pilot agreement. Save the executed version as `docs/gtm/wtp-<company>.md` and log it in `docs/ops/04-kpi-dashboard.md` (K8).
>
> Keep it plain. No legalese. The goal is a named person putting a price in writing, not a contract.

---

## Option A — Paid pilot LOI (preferred — real money, even if small)

```
Subject: Pilot agreement — <Product> × <Company>

<Name> at <Company> agrees to a 30-day paid pilot of <Product>, starting <date>.

- Price: $<X> for the pilot period (or $<X>/mo), billed on <unit: per execution / per seat / per tenant>.
- Scope: run <Product> on <their specific real workflow — e.g. "our refund agent in staging then production">.
- Success criterion: no duplicate side effects on their real workflow across the pilot;
  <any other criterion the partner cares about>.
- Either side may cancel anytime; pilot fee for the elapsed period only.

Agreed:
<Name>, <Title>, <Company> — <date>
<Your name>, <Product> — <date>
```

## Option B — Written WTP statement (if a paid pilot is premature)

```
"Yes — if <Product> reliably prevents <their specific failure> on our <workflow>,
I'd pay $<X>/<unit> for it. The budget would come from <team/owner>."

— <Name>, <Title>, <Company>, <date> (via <email/Slack/recorded call w/ consent>)
```

## Option C — Informal but attributable (the floor)

A forwarded email or Slack message, from a named person at a named company, stating a number and a unit. Screenshot + paste the verbatim text. Note who said it and when.

---

## What makes a signal "hard" vs "soft" (log this with it)
- **Hard:** a number + a unit + a named budget owner, in writing, ideally with money attached. ✅ counts for K8.
- **Soft:** "we'd definitely pay for that" with no number, no unit, no name. ❌ does not count — it's a compliment.

## Capture block (paste into the saved file)
```
Company:                     Date:
Signal type (A / B / C):     Hard or soft:
Unit anchored on:            Number:
Budget owner:                Their workflow:
Verbatim:
Next step + date:
```

> If, after Phase 3 conversations, **no one** will commit in writing — that is the single most important finding of the 90 days. Document it honestly and take it into the day-90 review (`docs/gtm/day-90-review.md`). Do not manufacture a signal to feel better.
