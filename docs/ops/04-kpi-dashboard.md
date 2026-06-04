# KPI Dashboard

> The 8 numbers that decide **pivot vs. persevere** at day 90. Everything else is vanity. Update weekly on Friday. Each KPI has a target, a source, and a "what it tells you."
>
> Pre-customers, the leading indicators (conversations, activations) matter far more than the lagging ones (revenue). Don't game the easy ones.

---

## The 8 KPIs

| # | KPI | Source | Day-90 target | Why it matters |
|---|---|---|---|---|
| K1 | **Real customer conversations** (cumulative) | `05-interview-tracker.md` | ≥20 | The single most important number. Zero = the company isn't validating. |
| K2 | **% in-ICP with a specific past incident** | interview synthesis | ≥40% | Distinguishes acute present pain from latent/early. The PMF tell. |
| K3 | **Signups** (cumulative) | funnel analytics | ≥25 | Front-door demand after launch. |
| K4 | **Activation rate** (signup → first agent run) | funnel analytics | ≥40% | Does the product actually work for a stranger? |
| K5 | **Time-to-first-replay** (cold start, minutes) | P0.5 / per-partner | ≤10 min | Onboarding friction = the #1 lever on activation. |
| K6 | **Activated design partners** | `06-design-partner-tracker.md` | ≥5 | Real teams using it on real failure cases. |
| K7 | **Pricing signals** (concrete unit + number) | `04` table below | ≥3 | Is the pain worth money, and on what meter? |
| K8 | **Written willingness-to-pay** | `docs/gtm/` LOI | ≥1 | The Phase 3 gate. One real signal > ten nods. |

---

## Weekly KPI log

| Week | K1 conv. | K2 %incident | K3 signups | K4 activ.% | K5 ttfr(min) | K6 partners | K7 price sig. | K8 WTP |
|---|---|---|---|---|---|---|---|---|
| W1 | | | | | | | | |
| W2 | | | | | | | | |
| W3 | | | | | | | | |
| W4 | | | | | | | | |
| W5 | | | | | | | | |
| W6 | | | | | | | | |
| W7 | | | | | | | | |
| W8 | | | | | | | | |
| W9 | | | | | | | | |
| W10 | | | | | | | | |
| W11 | | | | | | | | |
| W12 | | | | | | | | |
| W13 | | | | | | | | |

---

## Time-to-first-replay log (K5)

> Re-measure on every cold onboarding (P0.5, each new design partner). The slowest single step is always the #1 product bug.

| Date | Who | Total (min) | Slowest step | Fix shipped? |
|---|---|---|---|---|
| | | | | |

---

## Funnel snapshot (K3/K4 — from the analytics you shipped)

> Source: `funnelRoutes.ts` / `funnel_daily` rollup. Watch for the timestamptz UTC gotcha + stale `.next` build (see memory `project_funnel-analytics-phase1`).

| Stage | Count | Step conversion |
|---|---|---|
| Visit (UTM-attributed) | | — |
| Signup | | visit→signup: |
| First agent run | | signup→run: |
| Reached replay | | run→replay: |
| Returned (day 2+) | | replay→return: |

**Biggest drop-off:** `____________________` → **fix:** `____________________`

---

## Pricing signal table (K7)

| Partner | Unit they anchored on | Number | Soft/Hard | Verbatim quote |
|---|---|---|---|---|
| | (per execution / seat / tenant) | | | |

---

## Interview ICP-conversion (K2 detail — update every 5 interviews)

| ICP hypothesis | Interviewed | Specific past incident | Converting? |
|---|---|---|---|
| Payments/financial agents | | | |
| Infra/ops agents | | | |
| Platform-eng "make agents safe" | | | |

**Leading ICP after N interviews:** `____________________`

---

## Pivot/persevere thresholds (read at day 45 and day 90)

- **Persevere signal:** K1≥10 by week 5, K2≥40%, K6 climbing, ≥1 unprompted "when can I try it?".
- **Pivot-the-wedge signal:** conversations happening (K1 healthy) but K2 low and no ICP converting → the pain is real-but-not-this-framing; change the wedge message.
- **Change-ICP signal:** one ICP hypothesis converts and two are dead → kill the dead two, go deep on the live one.
- **Market-is-early signal:** K1 healthy, K2 <20%, no past incidents, no WTP → document honestly; the validation finding is "too early," not "build more."

> Decisions are made on these numbers at P3.4, not on conviction.
