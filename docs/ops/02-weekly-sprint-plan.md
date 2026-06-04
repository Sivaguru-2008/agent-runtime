# Weekly Sprint Plan

> 13 one-week sprints mapped to the 4 phases. Each sprint has **one headline outcome** (the thing that, if it slips, the sprint failed) and a definition of done. Solo founder: one sprint = one week.
>
> Run the **Friday review ritual** at the end of every sprint. A sprint with no shipped artifact is a failed sprint regardless of effort.

---

## Sprint board legend
- **Headline outcome** — the single artifact the sprint is judged on.
- **DoD** — definition of done (binary; no partial credit).
- **Tasks** — catalog IDs from `00-operating-manual.md`.
- **Carry rule** — if the headline slips, it carries to next sprint and bumps everything down; do not start the next phase until the phase exit gate is green.

---

## PHASE 0 — Ship What Exists

### Sprint 1 (Week 1) — Get it live
- **Headline outcome:** A stranger can sign up at a public URL, `npm install` the SDK, and reach a replay in ≤10 min.
- **Tasks:** P0.1 → P0.2 → P0.3 → P0.4 → P0.5 (in order; each unblocks the next).
- **DoD:** code on `main` + CI green · public HTTPS URL with 24h-green health · npm package installs clean · invite-gated signup works end-to-end · time-to-first-replay recorded.
- **Exit gate for Phase 0:** all five DoD items true. **Do not start Sprint 2 otherwise.**

---

## PHASE 1 — Make Market Contact

### Sprint 2 (Week 2) — Pipeline + demo
- **Headline outcome:** 40 named targets in the tracker + the 2:30 demo video published.
- **Tasks:** P1.1 (pipeline), P1.3 (demo), start P1.2 (first 3–5 interviews).
- **DoD:** ≥40 rows in `05-interview-tracker.md`, ≥15 outreach sent, demo video public, ≥3 interviews done.

### Sprint 3 (Week 3) — Interviews + landing draft
- **Headline outcome:** 8 cumulative interviews + landing page in draft.
- **Tasks:** P1.2 (5 more interviews), P1.5 (build landing).
- **DoD:** 8+ interviews synthesized, landing page deployable in preview, funnel logging confirmed.

### Sprint 4 (Week 4) — Interviews + ICP
- **Headline outcome:** 14 cumulative interviews + ICP one-pager written.
- **Tasks:** P1.2 (5 more), P1.4 (ICP doc), update rolling synthesis.
- **DoD:** 14+ interviews, `docs/gtm/icp.md` evidence-cited, ICP-conversion line updated in KPI dashboard.

### Sprint 5 (Week 5) — Close the loop
- **Headline outcome:** 20 interviews done + landing page live + Phase 1 synthesis complete.
- **Tasks:** P1.2 (final 6), P1.5 (landing live).
- **DoD:** 20 interviews, rolling synthesis answers all 6 questions, public landing page with video + CTA + working funnel.
- **Exit gate for Phase 1:** 20 interviews synthesized + ICP doc + public landing + public demo video. Pivot-check: is ≥1 ICP hypothesis converting? If no ICP shows acute present pain → escalate to a wedge re-think before Phase 2 (do not launch into a vacuum).

---

## PHASE 2 — Launch & Land Partners

### Sprint 6 (Week 6) — Essay 1 + launch prep
- **Headline outcome:** Essay 1 published + launch assets finalized.
- **Tasks:** P2.1 (essay 1), prep P2.2 (verify the 8-item distribution checklist preconditions).
- **DoD:** essay 1 live with UTM + CTA, all launch preconditions green except the post itself.

### Sprint 7 (Week 7) — LAUNCH
- **Headline outcome:** Launch shipped (Show HN + X + LinkedIn), inbound captured.
- **Tasks:** P2.2 (launch), P2.1 (essay 2).
- **DoD:** all 8 distribution-checklist items green, 3h keyboard coverage done, top-3 objections logged verbatim, inbound conversations booked.
- **Hard gate:** do **not** launch unless Phase 0 + P1.3 + P1.5 are green. A launch with no front door wastes the spike.

### Sprint 8 (Week 8) — Partner conversion
- **Headline outcome:** 3 design partners with product in hand.
- **Tasks:** P2.3 (convert), P2.1 (essay 3).
- **DoD:** 3 partners onboarded + invite codes issued + ≥1 run each, essay 3 live.

### Sprint 9 (Week 9) — 5 partners + funnel
- **Headline outcome:** 5 activated design partners + the #1 funnel drop-off fixed.
- **Tasks:** P2.3 (to 5), P2.4 (funnel).
- **DoD:** 5 partners reached activation event, funnel snapshot recorded, one drop-off fix shipped.
- **Exit gate for Phase 2:** launch shipped + 3 essays + 5 activated partners + first real funnel data.

---

## PHASE 3 — Validate Money

### Sprint 10 (Week 10) — Pricing signals
- **Headline outcome:** Concrete pricing signal (unit + number) from ≥3 partners.
- **Tasks:** P3.1.
- **DoD:** pricing-signal table filled for ≥3 partners with verbatim quotes.

### Sprint 11 (Week 11) — Written WTP
- **Headline outcome:** ≥1 written willingness-to-pay.
- **Tasks:** P3.2.
- **DoD:** a saved LOI / paid-pilot terms / written "$X/mo yes" from a named party.
- **Gate:** P3.3 does not start until this is real.

### Sprint 12 (Week 12) — Billing (conditional)
- **Headline outcome:** If P3.2 landed → first metered Stripe charge. Else → more pricing pressure + document the no-WTP finding.
- **Tasks:** P3.3 (conditional).
- **DoD (if billing):** paying partner billed once, correctly, on agreed meter.

### Sprint 13 (Week 13) — Day-90 review
- **Headline outcome:** Evidence-based decision memo: double down / pivot wedge / change ICP.
- **Tasks:** P3.4.
- **DoD:** `docs/gtm/day-90-review.md` written, PMF re-scored against the KPI dashboard, next-90-days direction stated.

---

## Friday review ritual (close every sprint)

Answer in one line each, paste into `03-founder-dashboard.md` weekly log:
1. **Conversations:** How many real customer conversations this week?
2. **Usage:** What did a user *do* with the product this week?
3. **Evidence:** What evidence did I generate that someone wants this?
4. **Sprint verdict:** Did the headline outcome ship? (Y/N — N means it carries.)
5. **Drift check:** Did I write backend code that no user asked for? (Y = warning.)

**Two consecutive Fridays of "zero conversations" → the plan has failed for that stretch. Drop the current sprint and spend the next week entirely on pipeline (P1.1-style outreach).**
