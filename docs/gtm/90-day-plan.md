# 90-Day Plan — Stop Building, Start Validating

**Premise:** The product is ~80% built and 0% validated. The bottleneck is distribution + customer contact, not engineering. This plan contains almost no backend work by design. If a task makes you want to refactor the recovery loop instead, that reflex is the company's #1 risk.

**The one rule for 90 days:** No new backend correctness features. The V1 scope in `docs/architecture.md` is frozen. Every week must produce evidence of *market contact* (a conversation, a deploy, a signup, a published artifact), not code.

**Success definition at day 90:**
- API deployed at a public URL, SDK published to npm.
- 20 customer-discovery interviews completed and synthesized.
- Demo video public; ≥1 launch post shipped.
- ≥5 design partners with the deployed product in hand.
- ≥1 written statement of willingness-to-pay (even informal).

---

## Phase 0 — Ship What Already Exists (Week 1)

> Everything below is already built and sitting **uncommitted** in the working tree. This week is about pushing, not building.

- [ ] **P0.1 — Commit & push the working tree.** SDK (`packages/sdk/`), signup (`signupRoutes.ts`, migration 0028), funnel analytics (migrations 0029–0032, `funnelRoutes.ts`), onboarding (`apps/web/components/onboarding/`), explainability (`apps/web/components/explain/`). Get it into git + CI today. *Risk retired: laptop failure = company deletion.*
- [ ] **P0.2 — Deploy the API to one public URL.** Fly.io or Render, single managed Postgres (Neon/Supabase). The architecture (`§7`) already supports single-container deploy. Target: a URL a stranger can hit.
- [ ] **P0.3 — Publish the TS SDK to npm.** `packages/sdk/PUBLISHING.md` is already written. Pick the final package name, `npm publish`. The PLG loop cannot start until this is live.
- [ ] **P0.4 — Turn on self-serve signup behind an invite code.** `SIGNUP_ENABLED=true`, `SIGNUP_OPEN=false`. Confirm a fresh email → working developer key → first agent run works end-to-end against the deployed URL.
- [ ] **P0.5 — Smoke-test the happy path as a stranger.** New machine / incognito: signup → `npm install <sdk>` → create agent → run task → see replay. Time it. If it's > 10 minutes, that's the #1 product bug.

## Phase 1 — Make Market Contact (Weeks 2–5)

- [ ] **P1.1 — Build the interview pipeline.** List 40 target people (teams running agents that touch money/infra: fintech, payments ops, internal automation, AI-ops). Use `docs/gtm/customer-discovery-interview-script.md`.
- [ ] **P1.2 — Run 20 discovery interviews.** ~5/week. Goal: validate the pain is *acute and present*, not latent. Do NOT pitch — listen. Record/notes into `docs/gtm/interviews/`.
- [ ] **P1.3 — Record the 2:30 demo.** Script already exists in `docs/_archive/productization_blueprint.md §8`. Screen-record the live failure→recovery flow ("Stripe is never double-charged").
- [ ] **P1.4 — Write the ICP doc.** After ~10 interviews, write down: who has this pain acutely *today*, what triggers it, what they currently do instead. One page. This artifact does not exist yet and is overdue.
- [ ] **P1.5 — Make the repo + a landing page public.** Even a one-page site with the demo video and a "Deploy your first agent" CTA. The product currently has no front door.

## Phase 2 — Launch & Land Partners (Weeks 6–9)

- [ ] **P2.1 — Publish 3 technical essays** mined from `docs/specs/` ("How we make Stripe refunds replay-safe", "Why naive agent retries double-charge customers", "Deterministic replay with chain-hash divergence"). This corpus is unique thought-leadership distribution and nearly free.
- [ ] **P2.2 — Ship the launch post** (Show HN + X/LinkedIn). Draft in `docs/gtm/launch-show-hn-and-demo.md`. Lead with the demo video. Measure inbound.
- [ ] **P2.3 — Convert interviews → 5 design partners.** Get the deployed product into 5 teams' hands. Instrument with the funnel analytics you shipped in P0.1.
- [ ] **P2.4 — Watch the funnel.** First real activation/retention data in company history. Find where the first 5 users drop off; fix only those things.

## Phase 3 — Validate Money (Weeks 10–13)

- [ ] **P3.1 — Validate pricing in conversations.** Usage-based on executions/replays is the natural meter (quotas already metered in code). Ask design partners what they'd pay and at what unit.
- [ ] **P3.2 — Get 1 written willingness-to-pay** (LOI, paid pilot, or "yes I'd pay $X/mo"). One real signal beats ten polite nods.
- [ ] **P3.3 — Wire real billing only after P3.2.** Stripe metered billing. Not before — `mockPaymentProvider` is fine until someone wants to pay.
- [ ] **P3.4 — Day-90 review.** Re-score PMF with real data. Decide: double down, pivot the wedge, or change ICP — based on evidence, not conviction.

---

## Explicitly NOT doing in 90 days
- No more RBAC / cluster / SLO governance / chaos hardening (already overbuilt vs. zero users).
- No second SDK language (Python waits until TS SDK has real installs).
- No multi-region, no Redis, no worker-split (architecture `§8` defers these).
- No new UI polish beyond fixing what the first 5 users trip on.

## Weekly cadence
Every Friday, answer in one line each:
1. How many real customer conversations happened this week?
2. What did a user *do* with the product this week?
3. What evidence did I generate that someone wants this?

If the honest answer to #1 is "zero" for two weeks running, the plan has failed and you've drifted back into the codebase.
