# Operating Manual — 90-Day Validation Sprint

> **This manual does not change the plan.** The 90-day plan (`docs/gtm/90-day-plan.md`) is approved and frozen. This is the execution layer: it converts every roadmap item into atomic, time-boxed tasks with steps, dependencies, artifacts, and pass/fail gates.
>
> **Operator:** solo founder. **Optimize for speed, not perfection.** Every task ends in a concrete artifact (a deploy, an npm package, an interview note, a landing page, a demo video, a design partner, a pricing signal). **If a task does not produce evidence of demand or directly enable it, it is not in this manual.**

---

## 0. The one rule (read this every morning)

**No new backend correctness features for 90 days.** The V1 scope in `docs/architecture.md` is frozen. If a task makes you want to refactor the recovery loop, the cluster code, or RBAC — that reflex is the company's #1 risk. Close the editor. Go talk to a customer.

Every week must produce **evidence of market contact**: a conversation, a deploy, a signup, a published artifact. Not code.

---

## 1. How to use this manual

| File | Purpose | Cadence |
|---|---|---|
| `00-operating-manual.md` (this) | Task catalog — every roadmap item fully specified | Reference |
| `01-daily-execution-plan.md` | What to do each day, hour-blocked | Daily |
| `02-weekly-sprint-plan.md` | 13 sprints mapped to phases; Friday review ritual | Weekly |
| `03-founder-dashboard.md` | Single source of truth: status, blockers, this-week focus | Daily glance |
| `04-kpi-dashboard.md` | The 8 numbers that decide pivot/persevere | Weekly update |
| `05-interview-tracker.md` | Pipeline of 40 targets → 20 interviews → synthesis | Daily during Phase 1 |
| `06-design-partner-tracker.md` | 5 design partners: stage, blockers, activation | Phase 2–3 |
| `07-launch-tracker.md` | Launch-day checklist + post-launch metrics capture | Phase 2 |
| `08-content-publishing-system.md` | 3 essays + social: pipeline, templates, prompts | Phase 2 |
| `09-deployment-checklist.md` | Step-by-step prod deploy + verification | Phase 0, then on change |
| `10-sdk-publishing-checklist.md` | npm publish + clean-room smoke test | Phase 0 |

**Daily loop:** open `03-founder-dashboard.md` → check `01-daily-execution-plan.md` for today's block → do the work → update the dashboard + relevant tracker → log the artifact.

---

## 2. Task ID map

Canonical IDs follow the plan (`P0.1` … `P3.4`). Cross-references to the deploy/SDK runbooks (`EN-1`, `EN-2`, `OP-1`) are noted inline.

| Phase | Weeks | Tasks | Exit gate |
|---|---|---|---|
| **0 — Ship what exists** | 1 | P0.1–P0.5 | Public URL + npm package + working signup + timed smoke test |
| **1 — Market contact** | 2–5 | P1.1–P1.5 | 20 interviews synthesized + ICP doc + public landing + demo video |
| **2 — Launch & land partners** | 6–9 | P2.1–P2.4 | Launch shipped + 3 essays + 5 design partners + first funnel data |
| **3 — Validate money** | 10–13 | P3.1–P3.4 | ≥1 written willingness-to-pay + pricing decision |

---

## 3. Task catalog

Each task carries: **Steps · Hours · Dependencies · Deliverable · Success · Failure · Templates · Tools · AI prompts.**
"Failure" means *kill or escalate the task* — a tripwire, not a vibe.

---

### PHASE 0 — Ship What Already Exists (Week 1)

> Everything here is already built and sitting uncommitted. This week is pushing, not building. Target: 5 working days.

#### P0.1 — Commit & push the working tree
- **Steps:**
  1. `git status` — review the full modified/untracked set (SDK, signup, funnel, onboarding, explainability).
  2. Group into logical commits if cheap; otherwise one honest commit. Don't polish.
  3. Push the current branch; open PR to `main`; confirm CI (GitHub Actions) goes green.
  4. Merge to `main`. Confirm the laptop is no longer the only copy.
- **Hours:** 1.5
- **Dependencies:** none (do this first, today).
- **Deliverable:** all work on `main`, CI green, remote backup exists.
- **Success:** `git status` clean on `main`; CI passing; commit visible on remote.
- **Failure:** CI red for >2h on a non-environmental cause → fix the one failing thing, do not start refactoring. (Discount the known pre-existing/environmental failures — see memory `project_test-topology`.)
- **Templates:** commit message convention (footer: `Co-Authored-By: Claude`).
- **Tools:** git, GitHub, GitHub Actions.
- **AI prompts:** *"Summarize this `git diff --stat` into 3–5 logical commit groups with conventional-commit messages. Flag anything that looks like a secret or a debug artifact."*

#### P0.2 — Deploy the API to one public URL  *(= EN-1)*
- **Steps:** Follow `09-deployment-checklist.md` end to end (Fly.io or Render → managed Postgres → secrets → deploy → seed owner key → 5-call verify from a third machine → uptime monitor).
- **Hours:** 4 (first-time; 0.5 thereafter).
- **Dependencies:** P0.1 (code on main); a Fly.io or Render account; a Groq (or Anthropic) API key.
- **Deliverable:** a public HTTPS URL a stranger can hit; `sk_live_…` owner key in a secret manager.
- **Success:** all 5 verify calls succeed from a non-deploy machine; `/health` green on an external uptime monitor for 24h.
- **Failure:** can't get green boot in one focused session → check the 3 known gotchas (migration checksum drift, `DATABASE_SSL=require`, no Redis) in `09`; if still stuck after 2h, switch provider (Fly↔Render) rather than debugging further.
- **Templates:** `docs/deploy.md` (canonical runbook), `09-deployment-checklist.md`.
- **Tools:** Fly.io/Render, managed Postgres (Neon/Supabase/Fly PG), curl, an uptime monitor (Better Uptime / Fly metrics).
- **AI prompts:** *"Given this `fly logs` output, identify why boot failed and map it to one of the three known deploy gotchas in docs/deploy.md §5."*

#### P0.3 — Publish the TS SDK to npm  *(= EN-2)*
- **Steps:** Follow `10-sdk-publishing-checklist.md` (decide final package name → point baseUrl at the P0.2 URL → `npm publish --access public` → clean-room install smoke test).
- **Hours:** 2.
- **Dependencies:** P0.2 (need the live URL for README + smoke test); an npm account (+ org if scoped).
- **Deliverable:** a published npm package; `npm install <name>` works from a clean dir.
- **Success:** clean-room script runs an execution to a terminal state against the hosted URL.
- **Failure:** `prepublishOnly` (typecheck+test+build) fails → fix that one gate; do not expand scope. Name collision on npm → pick an unscoped fallback name and move on (decision must take <30 min).
- **Templates:** `packages/sdk/PUBLISHING.md`, `10-sdk-publishing-checklist.md`.
- **Tools:** npm, Node, the hosted URL + owner key.
- **AI prompts:** *"Check that the SDK README quickstart baseUrl and SDK_VERSION in src/config.ts match the package.json version and the deployed URL. List every place the version/URL is hardcoded."*

#### P0.4 — Turn on self-serve signup behind an invite code
- **Steps:**
  1. Set prod secrets `SIGNUP_ENABLED=true`, `SIGNUP_OPEN=false`.
  2. Redeploy; confirm `POST /signup` rejects without an invite code and accepts with one.
  3. Walk a fresh email → invite code → developer key → first agent run end to end against the deployed URL.
  4. Mint a small batch of invite codes to hand out at launch.
- **Hours:** 1.5
- **Dependencies:** P0.2.
- **Deliverable:** working invite-gated signup; a handful of invite codes ready.
- **Success:** a fresh email completes signup → gets a working key → runs one agent task on the hosted URL.
- **Failure:** signup path errors that need backend changes beyond config → log it as the #1 product bug in `03-founder-dashboard.md`, fix only the blocking line, re-test. (See memory `project_self-serve-onboarding`.)
- **Templates:** invite-code batch note (paste into `07-launch-tracker.md`).
- **Tools:** the API admin/owner key, a throwaway email.
- **AI prompts:** *"Trace the POST /signup → developer-key → first-execution path in signupRoutes.ts and tell me every env var and DB row it depends on."*

#### P0.5 — Smoke-test the happy path as a stranger
- **Steps:**
  1. On a clean machine / incognito: signup → `npm install <sdk>` → create agent → run task → see replay in the UI.
  2. **Time it with a stopwatch.** Note every point of friction verbatim.
  3. If >10 min, the slowest single step is the #1 product bug — fix only that.
- **Hours:** 1 (+ fix time if triggered).
- **Dependencies:** P0.2, P0.3, P0.4.
- **Deliverable:** a timed time-to-first-replay number + a friction log.
- **Success:** stranger reaches a visible replay in ≤10 min.
- **Failure:** >10 min → exactly one fix to the slowest step, then re-time. Do not redesign onboarding.
- **Templates:** "Time-to-first-replay" log block in `04-kpi-dashboard.md`.
- **Tools:** second machine / incognito browser, stopwatch, screen recorder (capture the friction for free demo B-roll).
- **AI prompts:** *"Here is my verbatim friction log from a cold onboarding. Rank the issues by how much they delay time-to-first-replay and tell me the single highest-leverage fix."*

---

### PHASE 1 — Make Market Contact (Weeks 2–5)

#### P1.1 — Build the interview pipeline
- **Steps:**
  1. Source 40 target people: teams running agents that touch money/infra (fintech, payments ops, internal automation, AI-ops). Use LinkedIn, X, YC company lists, relevant Discords/Slacks, warm intros.
  2. Enter each into `05-interview-tracker.md` with name, company, ICP hypothesis (payments / infra / platform-eng), contact channel, warm-or-cold.
  3. Draft outreach (see template) personalized one line each.
- **Hours:** 6 (spread across week 2).
- **Dependencies:** none, but stronger after P0.2/P0.3 (you can offer a real demo).
- **Deliverable:** 40 named targets in the tracker, ≥15 outreach messages sent.
- **Success:** ≥40 rows; reply/booking rate trending toward 5 interviews/week.
- **Failure:** <10 replies after 30 sends → the message or the ICP is wrong; rewrite the opener using the strongest objection heard, don't keep blasting the same template.
- **Templates:** outreach DM/email (in `05-interview-tracker.md`); target-row schema.
- **Tools:** LinkedIn/X, email, a CRM-lite (the tracker md is enough), calendar booking link.
- **AI prompts:** *"Write 5 cold-outreach variants (≤4 sentences, no pitch, Mom-Test compliant) asking a payments-ops engineer for 25 min about how their agents handle mid-task failures. No 'would you use'."*

#### P1.2 — Run 20 discovery interviews  *(the most important task in 90 days)*
- **Steps:**
  1. Book ~5/week. 25–30 min, recorded with consent.
  2. Run `docs/gtm/customer-discovery-interview-script.md` — Mom Test rules, do NOT pitch.
  3. Within 10 min of each call, fill the per-interview synthesis template into `docs/gtm/interviews/<date>-<company>.md`.
  4. After every 5, update the rolling synthesis + the ICP-conversion line in `04-kpi-dashboard.md`.
- **Hours:** ~30 total (1.5h/interview incl. synthesis) over weeks 2–5.
- **Dependencies:** P1.1.
- **Deliverable:** 20 interview note files + rolling synthesis.
- **Success:** 20 done; ≥1 ICP hypothesis clearly converting; ≥40% of in-ICP interviewees name a *specific past incident* (not theoretical).
- **Failure:** two consecutive weeks at **zero** real conversations → the plan has failed for that period; stop everything else and fix pipeline. Also fail if you're doing most of the talking (green/red flags in the script).
- **Templates:** interview script + synthesis template (already in `docs/gtm/`); tracker rows in `05`.
- **Tools:** video call + recording (Zoom/Meet + Otter/Fathom), calendar, the interviews/ folder.
- **AI prompts:** *"Here's a raw interview transcript. Fill the synthesis template. Extract the strongest verbatim quote, flag whether they described a specific past incident with a cost, and classify ICP fit as in/adjacent/out with one-line justification."*

#### P1.3 — Record the 2:30 demo video
- **Steps:**
  1. Use the word-for-word script in `docs/_archive/productization_blueprint.md §8`.
  2. Set up the live failure→recovery scenario (run agent → simulate DB lock → watch fenced replay → completion). Verify it works on the deployed/local UI first.
  3. Screen-record in one or two takes. Exactly ~2:30. No fancy editing — speed over polish.
  4. Upload (YouTube unlisted + direct mp4 fallback). Drop links into `07-launch-tracker.md` and the SDK/landing pages.
- **Hours:** 4.
- **Dependencies:** P0.2 (working deployed UI) or a reliable local instance; the demo scenario must reproduce the fenced-replay flow.
- **Deliverable:** a public 2:30 demo video (the "Stripe is never double-charged" flow).
- **Success:** video clearly shows refund → DB failure → fenced skip on replay → completion, narrated, ≤2:45.
- **Failure:** the demo scenario doesn't reproduce reliably → that is a real product gap; note it, but find the one config that makes the fenced-replay flow deterministic rather than re-architecting. (See memory `project_explainability-system` for the event narration that sells this.)
- **Templates:** demo script §8; YouTube description + thumbnail copy.
- **Tools:** screen recorder (OBS/Loom), YouTube, the running app, mic.
- **AI prompts:** *"Tighten this 2:30 demo narration to land the 'no double charge' aha by 1:45, in spoken-not-written cadence. Mark exact on-screen cues for each line."*

#### P1.4 — Write the ICP doc (one page)
- **Steps:** After ~10 interviews, write one page: who has this pain *acutely today*, what triggers it, what they currently do instead, where they look for solutions. Pull every claim from interview notes.
- **Hours:** 2.
- **Dependencies:** P1.2 (≥10 interviews).
- **Deliverable:** `docs/gtm/icp.md` — one page, evidence-cited.
- **Success:** every sentence backed by ≥1 interview quote; names a primary ICP + trigger event + current workaround (your real competitor).
- **Failure:** can't write it from evidence (only opinions) → you haven't dug for past behavior; the script is being run wrong. Fix interviewing before writing.
- **Templates:** ICP one-pager skeleton (who / trigger / current workaround / where they look / wedge message).
- **Tools:** the interviews/ folder.
- **AI prompts:** *"Synthesize these 10 interview notes into a one-page ICP. Output: primary ICP, the trigger event that makes this top-3 priority, the dominant current workaround, and the single sharpest wedge message. Cite the interview file for each claim."*

#### P1.5 — Make the repo + landing page public
- **Steps:**
  1. One-page landing site: demo video embed + "Deploy your first agent" CTA + `npm install <pkg>` + link to docs. Use the copy in `productization_blueprint.md §7`.
  2. Wire the CTA to signup; confirm funnel analytics records visits + source/UTM (you shipped this in P0.1 — see memory `project_funnel-analytics-phase1`).
  3. Decide repo public/private (public = distribution; fine given V1 scope). Publish a clean README front door.
  4. Deploy the page (Vercel/Netlify/GitHub Pages). Note URL in `07`.
- **Hours:** 5.
- **Dependencies:** P1.3 (video), P0.3 (SDK install line), P0.2 (signup target).
- **Deliverable:** a live public landing page with video + CTA, instrumented by the funnel.
- **Success:** page live; a stranger can go visit → signup; funnel logs the visit with UTM/source.
- **Failure:** funnel not recording source → fix the tracking before launch (a launch with no attribution wastes the data); known gotcha: stale `.next` build + timestamptz UTC (memory `project_funnel-analytics-phase1`).
- **Templates:** landing copy §7; CTA + UTM scheme; `next dev` for screenshots (memory `project_web-next-start-broken`).
- **Tools:** apps/web, Vercel/Netlify, the funnel analytics dashboard.
- **AI prompts:** *"Turn the §7 landing copy into a single-page hero + how-it-works + CTA. Keep the 'we make it safe to fail in production' line. Output minimal HTML/JSX matching apps/web conventions."*

---

### PHASE 2 — Launch & Land Partners (Weeks 6–9)

#### P2.1 — Publish 3 technical essays
- **Steps:** Mine `docs/specs/` for 3 essays: (1) "How we make Stripe refunds replay-safe", (2) "Why naive agent retries double-charge customers", (3) "Deterministic replay with chain-hash divergence". Run each through `08-content-publishing-system.md` (draft → tighten → publish → distribute → log).
- **Hours:** ~9 (3h/essay).
- **Dependencies:** P1.3 (embed the demo); ideally some interview language to make it resonate.
- **Deliverable:** 3 published essays (blog/dev.to/Substack), each linking the demo + landing.
- **Success:** all 3 live; each ends with a clear try/contact CTA; each drives ≥1 inbound or signup (tracked via UTM).
- **Failure:** an essay generates zero inbound and zero engagement after distribution → don't write a 4th in that vein; the angle isn't resonating, switch to the objection/wedge that interviews surfaced.
- **Templates:** essay outline + headline formulas + CTA block (in `08`).
- **Tools:** publishing platform, the specs/ docs, the demo video, UTM links.
- **AI prompts:** *"From this spec excerpt, draft a 900-word technical essay for senior backend engineers titled 'Why naive agent retries double-charge customers'. Concrete, no marketing fluff, one diagram-in-words, ends with a try-it CTA."*

#### P2.2 — Ship the launch post
- **Steps:** Run `07-launch-tracker.md` launch-day checklist. Show HN + X thread + LinkedIn (drafts in `docs/gtm/launch-show-hn-and-demo.md`). Lead with the demo video. Be at keyboard 3h for replies.
- **Hours:** 6 (launch day) + 3 monitoring.
- **Dependencies:** P0.2–P0.5, P1.3, P1.5 (the launch checklist's preconditions: deployed URL, published SDK, working signup, video, landing page).
- **Deliverable:** a live Show HN post + X thread + LinkedIn post; captured inbound.
- **Success:** launch shipped with all 8 distribution-checklist items green; inbound conversations booked; top-3 verbatim objections captured.
- **Failure:** launching before P0/P1 preconditions are green → **abort the launch**, do not waste the one-time attention spike. (Hard gate.)
- **Templates:** Show HN body, X thread, LinkedIn post, distribution checklist (all in `docs/gtm/launch-show-hn-and-demo.md` + `07`).
- **Tools:** HN, X, LinkedIn, the funnel dashboard, the invite codes from P0.4.
- **AI prompts:** *"Here are 5 HN comments objecting 'Temporal already does this'. Draft non-defensive replies that name the specific AI-agent delta (dynamic LLM-planned steps + replay diffing + side-effect fencing)."*

#### P2.3 — Convert interviews → 5 design partners
- **Steps:**
  1. From interview green-flags + launch inbound, identify candidates (asked "when can I try it?", named a real incident).
  2. For each: get the deployed product in hand, hand an invite code, help them run one real failure case (close on the script's final ask).
  3. Track each in `06-design-partner-tracker.md` (stage, blocker, activation event, next step).
- **Hours:** ~12 (hands-on onboarding across weeks 6–9).
- **Dependencies:** P0.2–P0.4, P1.2 (candidate pool).
- **Deliverable:** ≥5 design partners with the product in hand and ≥1 real execution run each.
- **Success:** ≥5 partners reach the activation event (first real agent run on their own case).
- **Failure:** candidates say yes but never activate → onboarding friction (revisit P0.5 time-to-first-replay) or weak pain (wrong ICP); a "yes" with no activation in 2 weeks is not a design partner — mark it lost.
- **Templates:** design-partner agreement (lightweight, informal), onboarding checklist (in `06`).
- **Tools:** invite codes, the funnel (per-partner activation), a shared Slack/email thread per partner.
- **AI prompts:** *"Draft a 1-paragraph informal design-partner offer: free early access + hands-on help in exchange for using it on one real failure case + 30 min of feedback. No legalese."*

#### P2.4 — Watch the funnel
- **Steps:** Use the funnel analytics you shipped (`funnelRoutes.ts`, migrations 0029–0032) to find where the first 5 users drop off (visit → signup → first run → replay → return). Fix only the steps the first 5 actually trip on.
- **Hours:** 4 (analysis) + targeted fixes.
- **Dependencies:** P1.5, P2.3 (real users flowing).
- **Deliverable:** a funnel snapshot + the single biggest drop-off identified + one fix shipped.
- **Success:** you can name activation rate (visit→signup), signup→first-run rate, and the #1 drop-off, with numbers.
- **Failure:** tempted to build new analytics or new UI polish beyond what the first 5 trip on → stop (violates the one rule). Fix only observed drop-offs.
- **Templates:** funnel snapshot block in `04-kpi-dashboard.md`.
- **Tools:** the funnel dashboard / `funnel_daily` rollup, the observability queries.
- **AI prompts:** *"Given these funnel-stage counts for the first cohort, compute step conversion, identify the largest drop, and list the 3 likeliest causes ranked by fix cost."*

---

### PHASE 3 — Validate Money (Weeks 10–13)

#### P3.1 — Validate pricing in conversations
- **Steps:** With design partners, probe willingness-to-pay against the natural meter (usage-based on executions/replays — quotas already metered in code). Ask what they'd pay and per what unit (per execution / per seat / per tenant). Capture verbatim.
- **Hours:** 4 (across partner conversations).
- **Dependencies:** P2.3 (partners using it).
- **Deliverable:** a pricing-signal log: per partner, a number + a unit + a quote.
- **Success:** ≥3 partners give a concrete number-and-unit (not "depends").
- **Failure:** only polite non-answers → pain isn't acute enough to price; that's a real signal — feed it into the day-90 decision, don't force a price.
- **Templates:** pricing-signal table in `04-kpi-dashboard.md` (partner / unit / $ / verbatim).
- **Tools:** partner threads, the metered quota data as a grounding reference.
- **AI prompts:** *"Turn these 4 pricing conversations into a table: who, what unit they anchored on, what number, and the strongest verbatim WTP quote. Flag soft (polite) vs hard (committed) signals."*

#### P3.2 — Get 1 written willingness-to-pay  *(the Phase 3 gate)*
- **Steps:** Convert the strongest pricing signal into a *written* commitment: an LOI, a paid pilot agreement, or a clear written "yes, I'd pay $X/mo". One real signal beats ten nods.
- **Hours:** 3.
- **Dependencies:** P3.1.
- **Deliverable:** ≥1 written WTP artifact (email/LOI/pilot terms) saved in `docs/gtm/`.
- **Success:** a named person/company puts a price in writing.
- **Failure:** no one will commit in writing after Phase 3 conversations → this is the most important finding of the 90 days. Document it honestly and take it to P3.4 — do not fabricate momentum.
- **Templates:** one-paragraph LOI / paid-pilot terms.
- **Tools:** email, a simple e-sign or even a confirming reply.
- **AI prompts:** *"Draft a 1-paragraph paid-pilot LOI: 30-day pilot, $X/mo, success criteria = no duplicate side-effects on their real workflow, cancel anytime. Plain language, signable by reply."*

#### P3.3 — Wire real billing (only after P3.2)
- **Steps:** Only once P3.2 is real: integrate Stripe metered billing on the execution/replay meter. `mockPaymentProvider` stays until then.
- **Hours:** 8.
- **Dependencies:** **P3.2 must be satisfied first** (hard gate).
- **Deliverable:** a working metered Stripe charge against the agreed unit, for the paying partner.
- **Success:** the paying partner is billed once, correctly, on the agreed meter.
- **Failure:** building billing before P3.2 → stop (you'd be building for zero paying users). If P3.2 never landed, this task does not run.
- **Templates:** Stripe metered-billing config note.
- **Tools:** Stripe, the existing quota/metering code, `mockPaymentProvider` as the swap-out point.
- **AI prompts:** *"Map the existing execution/replay quota metering to Stripe metered billing usage records. List the integration points and the smallest change to swap mockPaymentProvider for real Stripe."*

#### P3.4 — Day-90 review
- **Steps:** Re-score PMF with real data: interviews, activations, funnel, pricing signals, WTP. Decide on evidence (not conviction): **double down / pivot the wedge / change ICP**. Write a one-page decision memo.
- **Hours:** 4.
- **Dependencies:** all of Phase 1–3.
- **Deliverable:** `docs/gtm/day-90-review.md` — the decision + the evidence behind it.
- **Success:** a clear next-90-days direction backed by the KPI dashboard numbers.
- **Failure:** can't decide because the evidence is thin → that itself means the validation work wasn't done; the honest output is "insufficient market contact," which routes back to P1.2.
- **Templates:** decision-memo skeleton (what we learned / what converted / decision / next 3 bets).
- **Tools:** `04-kpi-dashboard.md`, all trackers.
- **AI prompts:** *"Given this KPI dashboard and interview synthesis, argue both the 'double down' and 'pivot the wedge' cases in 5 bullets each, then state which the evidence supports and why."*

---

## 4. Explicitly NOT doing (delete on sight)

These produce no evidence of demand and are **removed** from the manual:
- More RBAC / cluster / SLO governance / chaos hardening (overbuilt vs zero users).
- A second SDK language (Python waits until TS SDK has real installs).
- Multi-region, Redis, worker-split (architecture defers these).
- UI polish beyond fixing what the first 5 users trip on.
- Any "let me just refactor X first" task. If it doesn't end in an interview, a deploy, a signup, a published artifact, or a pricing signal — it is not work this quarter.

---

## 5. Friday ritual (every week, one line each)

1. How many real customer conversations happened this week?
2. What did a user *do* with the product this week?
3. What evidence did I generate that someone wants this?

**If #1 is "zero" two weeks running, the plan has failed and you've drifted back into the codebase.** Stop and fix pipeline.
