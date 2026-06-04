# Content Publishing System

> Drives P2.1 (3 technical essays) and the social cadence around launch (P2.2). The corpus is mined from `docs/specs/` — unique thought-leadership distribution that is nearly free. Every piece ends with a try-it / contact CTA and a UTM link, so content is measured as **demand evidence**, not vanity.
>
> **If a piece produces zero inbound and zero engagement after distribution, do not write another in that vein.** Switch to the angle interviews/objections surfaced.

---

## The 3 launch essays (P2.1)

| # | Working title | Mined from | Angle | Status |
|---|---|---|---|---|
| E1 | How we make Stripe refunds replay-safe | specs on fencing + idempotency | concrete "here's the mechanism" | ⬜ |
| E2 | Why naive agent retries double-charge customers | specs on retry/recovery | problem-first, names the pain | ⬜ |
| E3 | Deterministic replay with chain-hash divergence | specs on replay + chainHashOf | deep-tech credibility | ⬜ |

> E2 is the best launch-lead (problem-first). Publish E2 first if sequencing for the launch.

---

## Per-essay pipeline (3h each, max)

| Step | Time | Output |
|---|---|---|
| 1. Mine the spec | 20m | bullet outline of the technical claim + 1 concrete failure scenario |
| 2. Draft | 60m | 800–1100 words, senior-eng voice, one "diagram in words" |
| 3. Tighten | 30m | cut fluff, lead with the failure, add the demo embed |
| 4. CTA + UTM | 10m | try-it + "talk to me if you run money/infra agents" + UTM link |
| 5. Publish | 20m | post to platform(s) |
| 6. Distribute | 30m | cross-post + soft-share in communities |
| 7. Log | 10m | record inbound/engagement in the tracker below |

---

## Essay structure template

```
# <Title — name the failure, not the feature>

## The failure (lead here)
<A concrete, specific scenario. "An agent issues a $150 refund, the next step
times out, the retry fires, the customer is refunded twice." Make the reader
feel the cost in the first 3 sentences.>

## Why it happens
<The root cause in plain terms. LLM agents plan steps dynamically; naive retries
re-run the plan, not the failed step.>

## The mechanism (the credibility section)
<How the runtime fixes it — event sourcing / SQL-level fencing / deterministic
replay. One "diagram in words". Real, not marketing.>

## See it
<Embed the 2:30 demo video. One sentence: "Watch a worker get killed mid-refund
and a standby skip the already-done charge.">

## Try it
<npm install line + deploy/landing link + 1-line CTA to talk if they run
money/infra agents. UTM-tagged.>
```

---

## Headline formulas (specific > clever)

- "Why <common practice> <causes the expensive failure>" → *Why naive agent retries double-charge customers*
- "How we make <scary real-world action> <safe property>" → *How we make Stripe refunds replay-safe*
- "<Technical mechanism> with <verifiable property>" → *Deterministic replay with chain-hash divergence*

---

## Distribution channels (per piece)

- Primary: your blog / dev.to / Hashnode / Substack (pick one, own the canonical URL).
- Cross-post: X thread (summarize the essay, link), LinkedIn (ICP-targeted).
- Soft-share: r/LocalLLaMA, agent-builder Discords/Slacks — share the *insight*, not a pitch.
- Reuse: pull the sharpest paragraph as a standalone X post mid-week.

---

## Content tracker (measure as demand evidence)

| Piece | Published | URL | Views | Engagement | Inbound from it | UTM signups | Verdict |
|---|---|---|---|---|---|---|---|
| E1 | | | | | | | |
| E2 | | | | | | | |
| E3 | | | | | | | |
| Social: X thread | | | | | | | |
| Social: LinkedIn | | | | | | | |

**Verdict:** `resonating (write more this angle)` / `flat (switch angle)` / `dead (stop)`.

---

## Social cadence (around launch week)

| Day | Post | Source |
|---|---|---|
| Launch | X thread + LinkedIn | `docs/gtm/launch-show-hn-and-demo.md` §2/§3 |
| +2 days | Sharpest paragraph from E2 as standalone post | E2 |
| +4 days | "Top objection we heard at launch + our answer" | `07-launch-tracker.md` objections |
| +7 days | E1 or E3 launch | this file |

---

## AI prompts for content

- **Draft:** *"From this spec excerpt, draft an 800–1100 word essay for senior backend engineers titled '<title>'. Lead with a concrete $-cost failure, explain the root cause, then the mechanism (event sourcing / SQL fencing / deterministic replay). One diagram-in-words. No marketing adjectives. End with a try-it CTA."*
- **Tighten:** *"Cut this draft 20%. Move the most visceral failure sentence to the opening line. Flag any claim not supported by the spec."*
- **Repurpose:** *"Turn this essay into a 7-tweet thread that leads with the failure and ends with the demo link. Punchy, one idea per tweet."*
- **Objection essay:** *"Here's the top objection from launch: '<objection>'. Draft a 600-word honest response essay that concedes what's true and sharpens the real delta. No defensiveness."*
