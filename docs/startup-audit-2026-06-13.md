# Startup Audit — 2026-06-13

> The complete, evidence-based picture: every verified strength, every known flaw
> (business + technical + hygiene), and the ranked fix queue. Compiled from live
> verification runs (all tests/builds executed 2026-06-12/13), `docs/ops/*`
> dashboards, session memory, and the June-2026 competitive scan.
> Companion docs: `founder-report-2026-06-12.md` (YC framing) · `unforgeable-moat.md` (strategy).

---

## 0. Executive summary

**Company:** durable execution + time-travel replay + observability runtime for AI agents,
repositioning toward the **proof layer for regulated AI agents** ("show proof — not logs").

**One-sentence verdict:** a genuinely strong, fully verified product asset wrapped in a
company that has not yet made first contact with the market — every critical flaw is a
distribution flaw, every strength is an engineering strength, and the fix list is
dominated by actions only the founder can take outside the editor.

**Scorecard (1–10):**

| Dimension | Score | Basis |
|---|---|---|
| Engineering quality | 9 | 899/899 API + 56/56 web + 73/73 SDK tests, clean builds, chaos-certified |
| Product differentiation | 8 | fence protocol + deterministic replay is a real, hard moat candidate |
| Security posture | 8 | multi-tenant RBAC, tenant guard, RLS, fail-closed auth; unaudited externally |
| Operational maturity (dev) | 8 | self-healing dev env, both port reapers, honest runbooks |
| Operational maturity (prod) | 2 | no deploy, no monitoring, no incident history — nothing is live |
| Distribution | 1 | zero everything (see §3.A) |
| Market timing | 6 | hot funded category — tailwind AND threat |
| Founder leverage | 7 | payment-risk domain wedge is real and rare; unexploited |
| **Overall company stage** | **0.5 / "Built, Unvalidated"** | Stage-4 codebase, pre-Stage-1 business |

---

## 1. Verified strengths (the "plus" column)

### 1.1 Product & architecture (all verified by tests this week)
- **Exactly-once tool side effects** — fence protocol + dedup store; the moat candidate.
  Locked by sandbox/guardrail/fence test suites.
- **Deterministic time-travel replay** — sessions, branching, frame diff, checkpoints,
  named checkpoints; replay-equivalence is what upgrades "observability" to "proof".
- **Failure intelligence** — root-cause panels, causal chains, timelines, full-analysis
  pipeline with per-stage degradation (cannot 500 the dashboard; regression-tested).
- **Self-healing runtime** — orphan recovery, poison-pill DLQ, lease reclaim with
  recovery-resume cap; chaos-certification report on record.
- **Multi-tenant security** — 6-role RBAC permission matrix, tenant guard (strict
  Postgres mode), RLS, audit logging, fail-closed auth, invite-gated signup.
- **Funnel analytics** — visit→signup→run→replay→return, cohorts, alerts, CSV export,
  daily rollups (migrations 0029–0033). Built before there is traffic to measure.
- **Explainability + onboarding layer** — explain-everything mode, guided tour, ⌘K
  glossary; a real differentiator for the "non-developer buyer" repositioning.
- **TypeScript SDK** — 73/73 tests, builds clean, `npm pack` verified (27.9 kB); one
  command from published.

### 1.2 Engineering health (all run 2026-06-12/13)
- API: typecheck ✅ · build ✅ · **899/899 unit tests** (106 files)
- Web: typecheck ✅ · `next build` ✅ (20 routes incl. /compliance) · **56/56 tests**
- CI workflow exists (`.github/workflows/ci.yml`)
- No secrets committed (only `.env.example`)
- Dev environment is self-healing: `free-api.mjs` (port 4000) + `free-web.mjs`
  (port 3000) reapers; non-fatal crash handlers; startup self-check
- This week's user-facing bugs (opaque 500, proxy 204 crash, banner flapping,
  EADDRINUSE) all root-caused, fixed, regression-tested, pushed

### 1.3 GTM assets (built, awaiting execution)
- `/compliance` proof-layer landing page — live in app, production-build verified
- Sales demos (`npm run demo:all`) — double-charge + runaway-loop, test-locked
- Outreach kit — 40 named target companies, 3 message templates, cadence, objections
- 3 launch essays drafted; landing template; interview script; ICP/WTP/day-90 shells
- Deploy configs ready: `fly.toml`, `render.yaml`, `Dockerfile`, step-by-step checklist
- Operating system: daily/weekly plans, founder + KPI dashboards, 5 trackers

### 1.4 Strategic position
- **The wedge is rare:** founder's years in payment risk → the reconstruction +
  one-off-vs-systemic framing that generic agent-infra founders don't have.
- **The category is funded** (~$1.1B YTD Jan–May 2026, ≈20.7% of agentic deals) —
  validation that the problem is real and budgeted.
- The honest-docs culture (this audit, the dashboards, the memory system) is itself
  an asset — most founders don't have a written, dated record of their own drift.

---

## 2. All flaws — complete inventory

### A. Business flaws (existential tier)

| # | Flaw | Severity | Evidence |
|---|---|---|---|
| A1 | **Zero market contact**: 0 conversations, 0 signups, 0 partners, 0 revenue, 0 WTP | ☠ CRITICAL | KPI dashboard all-zeros; day 9/90 |
| A2 | **Nothing is public**: no deployed URL, SDK unpublished, essays unpublished, video unrecorded | ☠ CRITICAL | P0.2–P0.5 unchecked |
| A3 | **Drift pattern**: every editor-completable task done; every outside-world task at zero | HIGH | W1 row: "YES — all editor work, zero outside contact" |
| A4 | **Two-week-zero alarm**: fires ~Jun 18 if conversations stay 0 | HIGH | dashboard rule |
| A5 | **Funded competitors converting the same thesis** (Klaimee YC, Corgi, named "deterministic replay" category) | HIGH | June-2026 scan |
| A6 | **Over-build vs stage**: cluster/RBAC/enterprise built before any customer asked | MEDIUM (sunk) | architecture.md scopes V1 as 1-process/1-PG |
| A7 | **Solo-founder bandwidth**, no advisors/design partners pulling | MEDIUM | — |
| A8 | **Wedge unvalidated**: payment-risk framing has zero interview evidence yet | MEDIUM | K2 unmeasured |
| A9 | No pricing model, no billing, no WTP signal | LOW (correctly sequenced after A1) | P3.x gated |

### B. Technical flaws (genuine, all known & bounded)

| # | Flaw | Severity | Status |
|---|---|---|---|
| B1 | `next start` broken on Windows (@xyflow vendor chunk) | MEDIUM | documented; Linux prod unaffected; dev uses `next dev` |
| B2 | Shared-`.next` corruption if `next build` runs while dev server is live → all pages 500 + ChunkLoadError | MEDIUM (operational trap) | hit twice on 2026-06-12; rule documented in memory; no guard yet |
| B3 | Fence-enforcer defect surfaced by `replayChaos` scenario 2 (fresh fence rejected by `CentralizedReplayEnforcer.validateFence`) | MEDIUM | pre-existing, known; replay chaos suite documents it |
| B4 | Flaky tests: `sloGovernor` (timing), `cluster.test` lease-expiry (~1/4 ordering), `outboxHardening` integration (~1/3 claim-timing race) | LOW | documented, root causes understood, discounted in audits |
| B5 | Chaos integration suite fails on Windows+Docker (pool never reconnects after `container.restart()`) | LOW (environmental) | passes on Linux CI-class hosts |
| B6 | In-memory job queue/event bus in single-process mode — no horizontal scale | BY DESIGN (V1) | matches architecture.md V1 scope |
| B7 | Operator "Failures: 43" metric counts historical/LOST-worker pollution — confusing UX, not a correctness bug | LOW | scoping documented; worker reaper added previously |
| B8 | Next.js 15.5.18 flagged "(outdated)" by its own dev overlay | LOW | upgrade is routine, not urgent |

### C. Hygiene flaws (small, real, fix-in-minutes)

| # | Flaw | Severity | Found |
|---|---|---|---|
| C1 | **No LICENSE file in repo** — SDK declares MIT but repo carries no license text; weakens npm publish + any OSS credibility | MEDIUM | this audit |
| C2 | **Git identity is a placeholder** (`sivaguru@example.com`) — commits don't link to the founder's GitHub account; contribution graph empty | LOW | this audit |
| C3 | `REPLACE_FOUNDER_EMAIL` token still in `/compliance` CTA — demo-booking button is dead until filled | MEDIUM | known, founder-only |
| C4 | `FOUNDER_EMAILS` unset → founder dashboard (`/admin/founder/*`) inaccessible even with auth on (`founderCount: 0` in boot log) | LOW | boot log 2026-06-13 |
| C5 | Essays/landing tokens unfilled (`docs/gtm/essays`, landing template) | LOW | tracker |

---

## 3. What to fix — the ranked queue

### Tier 1 — This week, founder-only (no code; these ARE the company right now)
1. **`npm login` → `cd packages/sdk` → `npm publish`** (~10 min; pre-verified green).
2. **Fill `REPLACE_FOUNDER_EMAIL`** in `apps/web/app/compliance/page.tsx` (C3) — one string.
3. **Deploy** via `docs/ops/09-deployment-checklist.md` Path A (Fly.io) — configs exist; ~2–4 h.
4. **Send outreach sitting 1** (20 messages) from `docs/gtm/outreach-kit.md` — beats the
   Jun-18 two-week-zero alarm (A1–A4).
5. Record the 2:30 demo video off the existing script (unblocks essays + launch).

### Tier 2 — Quick hygiene (assistant-executable, <1 h total)
6. **Add `LICENSE` (MIT) at repo root** + reference from SDK (C1).
7. **Set real git identity** (`git config user.name/email`) so future commits attribute (C2).
8. **Guard the `.next` trap (B2):** add a `prebuild` check in apps/web that refuses to run
   `next build` while port 3000 is listening (mirrors the reaper philosophy: make the
   footgun impossible, not documented).
9. Document `FOUNDER_EMAILS` requirement in the deploy checklist prod-env section (C4).

### Tier 3 — Fix when touched (bounded, not urgent)
10. Fence-enforcer defect (B3) — fix when replay-under-chaos becomes a sold feature;
    it is the "proof layer" pitch's own edge case, so schedule before first design-partner
    POC on replay.
11. De-flake the three known tests (B4) — when CI noise starts masking real failures.
12. Failures-metric scoping UX (B7) — when the first design partner asks "why 43?".
13. Next.js upgrade (B8) — batch with the next dependency pass.

### Tier 4 — FROZEN (do not touch until a named buyer asks)
- Cluster/distributed mode, enterprise RBAC extensions, speculative subsystems
  (causal DAG, hash chain, counterfactuals, risk scores, insurance products),
  `next start`-on-Windows (B1), horizontal queue drivers (B6).
- **Unfreeze trigger:** a design partner or paying customer names the need in writing.

---

## 4. What NOT to fix (anti-flaws)

- **The 43-failures number being "scary"** — it's honest data; fix the scoping label, not the number.
- **Auth disabled in dev** — correct posture; prod refuses to boot without it.
- **In-memory drivers in dev** — correct V1 scope.
- **More test coverage** — at 899 green tests, marginal tests cost more than they protect
  *at this stage*; coverage grows when features grow.
- **Any refactor justified by "cleanliness"** — the operating manual's One Rule stands:
  no new backend correctness work for 90 days without a user attached.

---

## 5. The single paragraph that matters

The audit finds a company whose every engineering metric is green and every market metric
is zero. The product can prove what an AI agent did; the company cannot yet prove a single
human wants that. The fix queue is therefore inverted from a normal startup's: Tier 1 is
all founder-calendar items (publish, deploy, email, send), and the code's remaining flaws
are bounded, documented, and deliberately deferred. The next artifact that changes this
company's trajectory is not a commit — it is the first reply from one of the 40 names in
the outreach kit.

*Next audit: day 45 (≈ 2026-07-19), against the pivot/persevere thresholds in
`docs/ops/04-kpi-dashboard.md`.*
