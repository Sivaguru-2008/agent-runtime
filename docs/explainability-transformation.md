# Platform-Wide Explainability Transformation

> Goal: a first-time user with **zero** knowledge of AI agents, distributed
> systems, orchestration, cognition graphs, memory, workers, leases, replay,
> determinism, or observability can open any page, hover any label, click any
> metric, read any graph, or inspect any failure and immediately understand
> **what happened, why, whether it's healthy, whether action is needed, and what
> to do**.

This document is the map. The actual content lives in code (see
[Single source of truth](#single-source-of-truth)) so it can never drift from
the UI.

---

## 1. Architecture — one knowledge base, five reusable layers

The transformation is deliberately **not** 50 bespoke tooltips. It is a single
authored knowledge base feeding a handful of reusable components. Add an entry
once; it appears in tooltips, side panels, graph legends, empty states, and
"why" popovers everywhere it's referenced.

### Single source of truth

| File | Responsibility |
|------|----------------|
| [`lib/explain/types.ts`](../apps/web/lib/explain/types.ts) | The `Concept` type — fields for all five layers. |
| [`lib/explain/registry.ts`](../apps/web/lib/explain/registry.ts) | **The knowledge base.** Every explained concept, authored once. This file *is* deliverables #2 (missing explanations), #3 (tooltip text) and #4 (side-panel content). |
| [`lib/explain/status.ts`](../apps/web/lib/explain/status.ts) | **Layer 2** — every status/role code → human label + meaning + tone. |
| [`lib/explain/narration.ts`](../apps/web/lib/explain/narration.ts) | **Layer 4** — the run-story engine (signals → narrated beats). |

### Reusable components

| Component | Layer | What it does |
|-----------|-------|--------------|
| [`ExplainLabel`](../apps/web/components/explain/explain-label.tsx) | 1 + 3 entry | Wrap any label. Hover → micro explanation; click → full panel. |
| [`StatusPill`](../apps/web/components/explain/status-pill.tsx) | 2 | Drop-in: renders the **translated** status with a tone dot + hover meaning. |
| [`ExplainPanel`](../apps/web/components/explain/explain-panel.tsx) | 3 | The click-to-learn side panel. Mounted once at the app root. |
| [`RunNarration`](../apps/web/components/explain/run-narration.tsx) | 4 | Renders a run as a numbered, plain-language story. |
| [`WhyChip`](../apps/web/components/explain/why-chip.tsx) | 5 | A "Why?" button that expands an inline answer card. |
| [`GraphGuide`](../apps/web/components/explain/graph-guide.tsx) | Visual | Under any chart: what you're looking at · good · bad · **live interpretation** · recommendation. |
| [`ExplainedEmptyState`](../apps/web/components/explain/empty-state.tsx) | Empty | Replaces "No data" with explanatory copy from the registry. |
| [`ExplainModeProvider` / `ExplainModeToggle`](../apps/web/components/explain/explain-mode.tsx) | Global | The "Explain Everything" switch + context (persisted to `localStorage`). |

All of the above are re-exported from
[`components/explain/index.ts`](../apps/web/components/explain/index.ts).

---

## 2. The five layers (as specified)

### Layer 1 — Micro explanation (hover)
Hovering any `ExplainLabel` shows: **what this is · why it matters · healthy
range · example**, plus "Click for the full explanation →".
Source: `Concept.short / what / whyCare / healthy / example`.

### Layer 2 — Status translation
`READY → Ready for Work`, `BUSY → Processing Tasks`, `LOST → Connection Lost`,
`LEASE → Temporary Ownership Lock`, `DLQ → Permanently Failed Tasks`,
`DETERMINISM → Reproducibility Check`, `MEMORY_COMMIT → Saving Learned
Information`, `CRITIC → Quality Reviewer`, `VERIFIER → Fact Checker`,
`EXECUTOR → Task Performer`, `PLANNER → Task Planner` — and ~30 more
(worker/runtime/execution/lease states, severities, replay anomalies, run mode).
Unknown codes fall back to a Title-Cased label with a neutral tone, so the UI
never shows a raw machine code with no explanation.

### Layer 3 — Click to learn (side panel)
Every `ExplainLabel` click opens a panel with: **definition · how calculated ·
where data comes from · what affects it · healthy/warning/critical ranges · how
to fix · examples · "why did this happen?" · FAQ**. (Sections render only when
the concept supplies them.)

### Layer 4 — Live narration
`RunNarration` turns a run into the canonical story:
`Task Received → Task Planned → (Knowledge Recalled) → Task Executed → Results
Verified → Quality Reviewed → Memory Updated → Execution Completed`. Each beat is
marked done / active / pending / skipped from the run's signals (cognition node
roles + phases), and the terminal beat reflects the real outcome (completed /
failed / cancelled / in-progress). Wired into the **Run Studio** graph tab.

### Layer 5 — Why panel
`WhyChip` answers "Why did this happen?" — *why retried, why failed, why entered
DLQ, why memory changed, why a worker was selected, why a lease was reclaimed,
why replay differed, why a bottleneck was detected*. Wired into DLQ, Leases (per
retried lease → "Why is this on attempt #N?"), and every operator tab whose
concept defines `whyQuestions`.

---

## 3. Complete UI inventory (deliverable #1)

Legend: ✅ wired · concept id in `code`. As of the 100%-coverage pass, **every
row is ✅** — there are no remaining registry-ready-but-unwired elements.

### Surface A — Observability Dashboard (`/`)

| Element | Concept | Layers wired |
|---------|---------|--------------|
| Metric: Agents | `agents-total` | ✅ 1, 3 |
| Metric: Active | `agents-active` | ✅ 1, 3 |
| Metric: Running | `executions-running` | ✅ 1, 3 |
| Metric: Failures | `executions-failed` | ✅ 1, 3 (+ how-to-fix) |
| Metric: Tokens | `tokens-total` | ✅ 1, 3 |
| Metric: Stream | `stream-status` | ✅ 1, 3 |
| Global "Explain Everything" toggle | — | ✅ |
| **Durable Run Studio** header | `durable-run-studio` | ✅ 1, 3 |
| Run Studio story | (narration) | ✅ 4 |
| Decision Heatmap | `decision-heatmap` | ✅ 1, 3, guide, empty |
| Memory Drift | `memory-drift` | ✅ 1, 3, **live guide**, empty, why |
| Coordination Pressure | `coordination-pressure` | ✅ 1, 3, **live guide**, empty, why |
| Failure Clusters | `failure-clusters` | ✅ 1, 3, empty |
| Uncertainty Heatmap | `uncertainty-heatmap` | ✅ 1, 3, empty |
| Cognitive Memory Influence | `memory-influence` | ✅ 1, 3, empty |
| Token Streams | `token-stream` | ✅ 1, 3 |
| Multi-Agent Topology | `multi-agent-topology` | ✅ 1, 3; node `StatusPill` |
| Cognition Graph (Execution DAG) | `cognition-graph` | ✅ 1, 3; phase + severity `StatusPill` |
| Self-Healing Diagnostics | `self-healing-diagnostics`, `health-score` | ✅ 1, 3, **live health guide**, translated failure kinds, empty |
| Failure Analysis (warnings) | `self-healing-diagnostics` | ✅ 1, 3, empty |
| Agent rail (agents/runs) | `agents-total`, `execution` | ✅ `StatusPill` + explanatory empties |
| Reasoning Intensity | `reasoning-intensity` | ✅ (registry; surfaced via Decision Heatmap) |

### Surface B — Operator Platform (`/operator`)

Every tab gets a plain-language header (title + `short`, hover/click for full
panel, `WhyChip` when the concept has "why" questions):

| Tab | Concept | Notable in-panel wiring |
|-----|---------|-------------------------|
| Replay | `replay` | per-panel explainers (below) |
| **Memory** | `memory-trust` | ✅ header; 4 trust-metric labels (`memory-trust-score`, `contamination-alerts`, `stale-memories`, `suppressed-noise`); alert-severity `StatusPill`; explanatory empty |
| **Overview** | `cluster-topology` | ✅ header; all 12 KPIs explainable (`queue-depth`, `completed-executions`, `oldest-lease`, heartbeat, dlq, leases, …) |
| **Workers** | `worker-health` | ✅ guide; per-worker `StatusPill`; `Utilisation` + `Heartbeat` labels; explanatory empty |
| **Leases** | `leases` | ✅ `StatusPill` for exec status; `remaining` label; per-retry **WhyChip**; `WhyChip(lease)`; explanatory empty |
| **DLQ** | `dlq` | ✅ header + `WhyChip` + explanatory empty |
| **Diagnose** | `diagnose` | ✅ header; exec-status + checkpoint-phase + lease-status translated; empties |
| **Failure** | `failure` | ✅ header + why; status translated; explanatory empties |
| **Trace** | `trace` | ✅ header + explanatory empty |
| Cluster Topology (dashboard) | `worker-health`, `execution-ownership` | ✅ titles; worker `StatusPill`; explanatory empties |

Replay sub-panels (each gets an explainable sub-header):
`timeline · scrubber · nodes · root-cause · console · determinism`. The Console
sub-header also surfaces `branch`, `inject`, `compare` as individual
`ExplainLabel`s. **Determinism** additionally shows a **live GraphGuide** driven
by the actual score and a redesigned empty state. Across the replay panels the
node **roles and statuses are translated** (PLANNER → "Task Planner", COMPLETE →
"Completed", etc.) and every "No data" branch is an `ExplainedEmptyState`
(Timeline frames, Scrubber cursor, Root-Cause chain, Branches, Compare).

### Status / role vocabulary translated (Layer 2)
`READY BUSY RUNNING QUEUED DRAINING DEGRADED STOPPING STOPPED REGISTERED LOST
OFFLINE ERROR IDLE CREATED COMPLETED FAILED CANCELLED ACTIVE RELEASED EXPIRED
RECLAIMED DLQ LEASE DETERMINISM PLANNER EXECUTOR VERIFIER CRITIC MEMORY_COMMIT
MEMORY_RETRIEVED TOOL_CALLED MODEL_COMPLETED MODEL-BACKED DETERMINISTIC INFO
WARNING CRITICAL MISSING_FINGERPRINT DUPLICATE_FINGERPRINT`.

---

## 4. Empty-state redesigns (deliverable #6)

Bare strings replaced with explanatory copy, e.g.:

- "No memory influence recorded" →
  *"No memory was used during this execution. The agents completed the task
  without referencing stored knowledge."*
- "No heatmap data" →
  *"No uncertainty signals were generated. This usually indicates straightforward
  execution with high confidence."*

Redesigned: memory influence, uncertainty/decision heatmap, memory drift,
coordination pressure, failure clusters, worker health, leases, DLQ,
determinism. Each authored as `emptyTitle` / `emptyBody` in the registry and
rendered via `ExplainedEmptyState`, which also offers a "What is X?" link into
the full panel.

---

## 5. Explain Mode architecture (deliverable #7)

`ExplainModeProvider` (mounted in [`app/layout.tsx`](../apps/web/app/layout.tsx))
provides:

- `enabled` — the global switch, persisted to `localStorage` (`runloop.explainMode`).
- `openConcept(id)` / `closeConcept()` — any component opens the shared
  `ExplainPanel` from anywhere.

**When ON:** labels show a visible dotted underline + info dot; `GraphGuide`
expands inline on every chart (interpretation always visible); empty states and
translations are everywhere. **When OFF:** the *same* information is still one
hover or click away — Explain Mode makes it ambient rather than on-demand. The
context ships a working **default** (off, no-op openers) so components render
fine outside the provider (used by the SSR render tests).

---

## 6. Accessibility support (deliverable #8)

- **Keyboard:** `ExplainLabel` and `StatusPill` are real `<button>`/focusable
  elements; tooltips open on focus (Radix), the side panel closes on **Escape**
  and via a labelled close button, the toggle is a `role="switch"` with
  `aria-checked`.
- **Screen readers:** the panel is `role="dialog" aria-modal aria-labelledby`;
  every interactive explainer has an `aria-label` (e.g. `Explain: Memory Drift`);
  decorative dots/icons are `aria-hidden`.
- **Focus visibility:** `focus-visible:ring` on all explain controls.
- **No colour-only meaning:** tone is always paired with a text label and an
  icon/dot, and the side panel spells out healthy/warning/critical in words.

## 7. Mobile support (deliverable #9)

- The side panel is a **full-width sheet** on small screens (`w-full`) and a
  fixed `30rem` panel from `sm:` up — verified live at 375 px.
- `GraphGuide` good/bad grid collapses to one column on narrow widths.
- Tooltips use Radix collision padding so they never overflow the viewport.
- Touch: tap a label = open panel; tap "Why?" = expand answer (no hover needed).

## 8. Screenshots (deliverable #10)

Captured live against the running app + API.

**Initial pass:**
1. **Dashboard** with the "Explain Everything" toggle + explainable metric strip.
2. **Layer 3 side panel** for *Failures* (What / Why / Why-care / Data source /
   Healthy·Warning·Critical / How-to-fix / Example) with Explain Mode ON.
3. **Operator → Workers** — tab explainer, expanded GraphGuide, `READY → "Ready
   for Work"` translation, info-dot labels.
4. **Mobile (375 px)** — the explanation panel as a full-width sheet.

**100%-coverage pass (newly-wired screens):**
5. **Operator → Overview** — all **12 KPIs** now explainable (Running, Queue
   Depth, Completed, Failed, Ready, Busy, Lost, Heartbeat Age, Active Leases,
   Oldest Lease, DLQ Volume, Tokens Used) plus the "Cluster Topology" / "System
   Health" explainers.
6. **Run Studio → graph tab** — the **Live Narration** ("What's happening, in
   plain language": Task Received → … → Execution Completed, with "Knowledge
   Recalled" marked *not needed*) above the **Cognition Graph** with its `COMPLETE
   → "Completed"` phase pill.
7. **Replay → Nodes** — node roles/statuses translated in place: **Task Planner,
   Task Performer, Fact Checker, Quality Reviewer, Memory Manager**, each
   **Completed**.

---

## 9. Verification

- `npm run typecheck` (apps/web) — **clean**.
- `npm test` (apps/web) — **33 passing** across 4 files:
  - [`components/explain/explain.test.tsx`](../apps/web/components/explain/explain.test.tsx) — registry integrity, status translation, narration, SSR rendering (no provider needed; SSR-safe defaults).
  - [`components/explain/explain-interaction.test.tsx`](../apps/web/components/explain/explain-interaction.test.tsx) — **real interaction test (jsdom + @testing-library/react)**: the toggle flips `aria-checked`, persists to `localStorage`, and changes the label affordance; a persisted ON preference is restored on mount; clicking a label opens the side panel; **Escape** and the close button dismiss it.
  - plus the two pre-existing suites.
- `next build` — **succeeds**, lint clean, all routes prerender.
- New devDependencies for the interaction test: `jsdom`, `@testing-library/react`,
  `@testing-library/dom`, `@testing-library/user-event`.

> Note: `next start` (production server) fails in this Windows workspace with a
> pre-existing `Cannot find module './vendor-chunks/@xyflow.js'` error unrelated
> to this change; the screenshots above were taken against `next dev`.

---

## 10. Extending it

To explain a new element: add one `Concept` to `registry.ts`, then wrap its
label with `<ExplainLabel concept="your-id">…</ExplainLabel>` (and/or add a
`GraphGuide` / `ExplainedEmptyState` / `WhyChip`). New status codes: add a row to
`status.ts`. New run beats: add to `RUN_BEATS` in `narration.ts`.

Coverage is now complete: every visible label, status, metric, graph, and empty
state across both surfaces routes through the explain system. To keep it that
way, prefer `StatusPill` over raw status strings and `ExplainedEmptyState` over
bare "No data" text in any new component.
