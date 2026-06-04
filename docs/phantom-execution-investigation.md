# Phantom Execution Creation & API Failures — Root-Cause Investigation

_Date: 2026-05-30 · Scope: `apps/api` (runtime) + `apps/web` (console)_

## 1. Executive summary

There was **no background, startup, polling, hydration, or websocket path that
silently creates Runs / Executions / Cognition Graphs**. Every creation call in
the codebase is gated behind an explicit user action (a button or a prompt
submission). The "phantom execution" symptom was **not** an extra object being
created — it was a **real object referencing an execution id that had no backing
row**, which then 404'd on read and rendered as a broken/phantom run plus a
generic "API failure" banner.

**Primary root cause:** the cognition orchestrator (`/cognition` → Run Studio
"+ run") derived an `executionId` for every run and stamped it onto every event
it emitted (`aggregateType: "EXECUTION"`), but **never created the corresponding
`executions` row**. Any UI surface that resolved that id via `GET
/executions/:id` (drilldown, snapshot export, dashboard detail fetch, operator
console) received a `404 NOT_FOUND`, surfaced as `INTERNAL/Unable to load
execution`. The run therefore looked like it "appeared from nowhere and failed."

A secondary defect compounded it: `REPLAY_SESSION_CREATED` was emitted as an
`EXECUTION`-aggregate event whose `aggregateId` was a **cognitionId**, not an
executionId — breaking tenant resolution and tricking the dashboard's SSE
handler into auto-selecting a non-resolvable id.

All fixes are implemented and verified (`apps/api`: 579 unit tests pass +
2 new; `apps/api` & `apps/web` typecheck clean).

---

## 2. Requirement 1 — every object-creation code path

### Run / Execution
| Path | Trigger | Creates real `executions` row? |
|---|---|---|
| `POST /agents/:id/tasks` → `AgentRuntime.runTask` (`runtime/agentRuntime.ts:161`) | **User** clicks "Run Trace" (`observability-dashboard.tsx` `runTrace`) | ✅ yes (`executions.save`) |
| `POST /executions/:id/replay` → `AgentRuntime.replayExecution` (`agentRuntime.ts:287`) | **User** clicks "Replay" | ✅ yes (child execution) |
| `POST /cognition` → `CognitionOrchestrator.run` (`runtime/cognition/orchestrator.ts:65`) | **User** clicks "+ run" (`cognition-workbench.tsx` `startCognition`) | ❌ **was missing — root cause** |
| Worker/job-queue + scheduler + recovery loop | Consume **already-created** executions | n/a (process, never originate) |

### Cognition Graph
- `CognitionOrchestrator.run` (`orchestrator.ts:153` `cognitions.save`) — only from `POST /cognition` (user "+ run") and from replay/branch (`ReplayEngine`).
- `ReplayEngine.branch` (`runtime/replay/replayEngine.ts`) — only from `POST /replay/branch` (user "branch" button).

### Planner / Executor / Verifier / Critic / Memory-Manager workflow
- Driven exclusively inside `CognitionOrchestrator.run`'s phase loop
  (`orchestrator.ts:180` `while (!isTerminal)`), via `runRole`. There is **no**
  other entry point. It only runs as part of a user-initiated cognition.

### Replay session (read-model, not an execution)
- `POST /cognition/:id/replay` → `ReplayEngine.createSession` (`replayEngine.ts:53`).
  Triggered on mount of `TimeTravelDebugger` (Scrubber tab). **Idempotent** —
  deterministic session id (`replayEngine.ts:61`); does **not** create an
  execution.

### Full analysis (read-only)
- `GET|POST /executions/:id/full-analysis` (`interfaces/http/sprintNextRoutes.ts:655`)
  is read-only (analyzers + timeline derivation). `FailureRootCausePanel` calls
  it on mount — this is analysis, **not** creation.

---

## 3. Requirement 2/3 — "only after explicit submission" + eliminate auto-creation

Audited every mount/effect/interval/SSE handler in `apps/web`:

| Surface | On mount / poll / SSE | Verdict |
|---|---|---|
| `ObservabilityDashboard` | polls `overview/agents/topology` (GET); SSE read-only; `createAgent`/`runTask`/`replay` only in button callbacks | ✅ no auto-create |
| `CognitionWorkbench` | `cognitionApi.list` GET every 5 s; `startCognition` only in "+ run" onClick | ✅ no auto-create |
| `Playground` | `health()` GET every 5 s; `/agent/run` only in `onRun` button | ✅ no auto-create |
| `execution-store` | client-only state; `startExecution` only from `onRun` | ✅ no auto-create |
| `ReplayExperience` | `cognitionApi.list` GET on mount | ✅ no auto-create |
| `TimeTravelDebugger` | **`createReplaySession` POST on mount** | ⚠️ read-model only, now idempotent + correctly attributed |
| `FailureRootCausePanel` | `runFullAnalysis` POST on mount | ✅ read-only route |

**Conclusion:** no execution-creating path runs automatically. The only
mount-time POST that creates anything is `createReplaySession`, which produces a
deterministic read-model session (no execution) and whose event is now correctly
attributed (fix §5.2).

---

## 4. Requirement 6 — failure taxonomy for FAILED runs

Where a FAILED run's source is captured today, by class:

| Failure class | Origin code path | Surfaced via |
|---|---|---|
| **Runtime / orchestration** (planner validation, low-confidence halt, autonomy halt, node-resolution, tool-contract) | `orchestrator.ts` `markFailed` + `catch` → `RuntimeExecutionError` / `PlannerValidationError` etc. | now on `execution.failure.{message,code}` + `COGNITION_FAILED` event payload `reason` |
| **HTTP status** | `routes.ts` `setErrorHandler` maps `NotFound→404`, `Conflict→409`, `Backpressure→503`, `RuntimeExecutionError→500`, else `INTERNAL_ERROR` + `errorId` | `CognitionApiError.status` + `x-runtime-id` header (client `cognition-api.ts`) |
| **Provider error** | `providers/*` (openai/claude/groq/failover) | bubbles through engine → execution `failure` / DLQ `lastError` |
| **DLQ / poison pill** | `dlqRemediationService` / engine retries | `DeadLetterEntry.lastError`, `failureCount` |
| **Stack trace** | `routes.ts:145` logs `errorStack` server-side with correlation `errorId` (never returned to client by design) | server log, grep by `errorId` / `x-runtime-id` |

The previously **mislabeled** "API failure" was the `404` on `/executions/:id`
described in §1 — now eliminated at the source.

---

## 5. Exact fixes implemented

### 5.1 Orchestrator materialises + finalises the Execution row (root cause)
`apps/api/src/runtime/cognition/orchestrator.ts`
- New `persistExecutionStart()` — on cognition start, idempotently `save()` an
  `Execution {status:"RUNNING"}` for the derived `executionId` (tenant-stamped).
- New `persistExecutionTerminal()` — on completion mirror `COMPLETED`, on any
  failure mirror `FAILED` with `failure.{message,code,recoverable}` and derived
  token usage.
- Hooked at: cognition start (after `cognitions.save(graph)`), the
  `completedGraph` block, the `catch` block, and **`markFailed`** (the shared
  chokepoint for every early-exit/halt path).
- Helpers `deriveTokenUsage()` / `extractGraphErrorMessage()`.
- Guarded on `deps.executions` so unit fixtures without a repo are unaffected.

### 5.2 Correct `REPLAY_SESSION_CREATED` aggregate
`apps/api/src/runtime/replay/replayEngine.ts:79` — `aggregateId` changed from
`cognitionId` to `graph.executionId` so the EXECUTION event ties to a real
execution (tenant resolution works; dashboard cannot mis-select it).

### 5.3 Dashboard: stop generic-error + phantom selection
`apps/web/components/dashboard/observability-dashboard.tsx`
- Execution-detail fetch: swallow transient `404/NotFound` (clear stale detail,
  no global red banner); only sustained non-404 errors surface.
- SSE auto-select restricted to a `LIFECYCLE_SELECT` set
  (`EXECUTION_STARTED/COMPLETED/FAILED/REPLAY_REQUESTED`) instead of *any*
  `aggregateType==="EXECUTION"` event; malformed frames ignored.

### 5.4 Execution metadata panel (Req 4)
`apps/web/components/ui/execution-metadata-panel.tsx` (new) — reusable panel
rendering **Run ID, Execution ID, Trace ID, Cognition ID, Runtime ID** (only the
known ones), each with a **copy button**, plus a structured **failure reason**
block (message + code + recoverability).

### 5.5 Trace-ID visibility + failure surfacing (Req 5 + 7)
- **Run Studio** (`cognition-workbench.tsx`) — panel with Cognition/Execution/Run IDs + phase.
- **Run Studio / Legacy traces** (`observability-dashboard.tsx`) — panel with
  Execution/Run/Trace/Cognition IDs + status + `execution.failure`; per-run
  failure reason line in the run list (replaces bare `FAILED` badge).
- **Replay** (`replay-experience.tsx`) — "Replay Target" panel (Cognition/Execution/Run IDs).
- **Diagnose** (`execution-drilldown.tsx`) — panel with Execution/Trace IDs +
  failure reason derived from DLQ/warnings/status.
- **Failure** (`failure-diagnostics-panel.tsx`) — same, above the DLQ banner.

Trace ids are derived from `event.metadata.traceId` (dashboard) and
`diagnosis.timeline[].traceId` (operator), since the `Execution` row itself does
not carry a trace id.

### 5.6 Regression test
`apps/api/test/phantomExecution.test.ts` (new, 2 tests) — proves a `/cognition`
run yields an execution that (a) resolves via `GET /executions/:id` with a
terminal status, (b) carries a non-empty `failure.message` when FAILED, and
(c) is listed under its agent.

---

## 6. Verification
- `apps/api`: `npx tsc --noEmit` ✅ ; `npx vitest run` → **581 passed / 66 files** (incl. 4 new).
- `apps/web`: `npx tsc --noEmit` ✅ ; `npx vitest run` → **3 passed** (panel render test).

---

## 6b. Observability metadata pipeline — trace + runtime id (follow-up sprint)

Closes the two trace/runtime gaps that §7.1/§7.2 flagged. **Trace id is now
generated at cognition creation, persisted, and returned in every
cognition/replay/execution/diagnose DTO; runtime id is returned in response
bodies (not only the header) on success and failure.**

**Contracts changed (BE):**
- `domain/cognition.ts` `CognitionGraph.traceId?`, `domain/model.ts`
  `Execution.traceId?`, `domain/replay.ts` `ReplaySession.traceId?`.
- `application/queries/operatorQueries.ts` `ExecutionDiagnosis.traceId`.
- New `interfaces/http/observabilityMetadata.ts` — `runtimeIdFor(request)`
  (= `request.id`, identical to the `x-runtime-id` header) and
  `resolveTraceId(eventStore, executionId, preferred?)` (prefers the persisted
  value, falls back to scanning `event.metadata.traceId` — works on both the
  in-memory and Postgres event stores, **no schema migration**).
- Routes now return a consistent identity envelope:
  - `POST /cognition` → graph + `runtimeId` (graph already carries `traceId`).
  - `GET /cognition/:id` → `+ traceId + runtimeId`.
  - `GET /executions/:id` → `+ traceId + runtimeId` (and `execution.traceId`).
  - `POST /cognition/:id/replay`, `GET /replay/:id` → `+ traceId + runtimeId`.
  - `GET /operator/diagnose/:id` → `+ traceId + runtimeId`.

**Propagation (BE):** `orchestrator.run` stamps `graph.traceId` and the backing
`execution.traceId` from `context.traceId`; `agentRuntime.runTask` stamps
`execution.traceId`; `replayEngine.createSession` stores the session `traceId`.

**Contracts changed (FE):** `types/observability.ts` (`Execution.traceId`,
`ExecutionDetails.{traceId,runtimeId}`), `lib/cognition-api.ts`
(`CognitionGraph.traceId`, `CognitionGraphView.{traceId,runtimeId}`,
`ReplaySession.{traceId,runtimeId}`), `services/operator-api.ts`
(`ExecutionDiagnosis.{traceId,runtimeId}`).

**Panels:** all five surfaces (Run Studio, Replay, Diagnose, Failure, Dashboard)
now pass server-provided `traceId` + `runtimeId` to `ExecutionMetadataPanel`,
with the prior client-side event-scan kept only as a fallback.

**Tests added:** `apps/api/test/phantomExecution.test.ts` (+2) — cognition →
execution returns `traceId`+`runtimeId`; replay create/fetch returns
`traceId`+`runtimeId`. `apps/web/components/ui/execution-metadata-panel.test.tsx`
(new, 3) — panel renders all five identifiers + copy buttons + failure reason;
omits unknown ids; renders empty when given nothing. New `apps/web/vitest.config.ts`
(react-dom/server render, zero new runtime deps; `vitest` is hoisted at the
monorepo root).

**Backward compatibility:** every new field is additive and optional on the
domain types (back-compat with replay/test fixtures and the Postgres executions
table which has no `trace_id` column — the route resolves trace id from events in
that case). FE consumers treat them as present-when-available.

---

## 6c. Prompt-driven Run Studio + universal-FAILED root cause (follow-up sprint)

Driven by the live screenshots: opening Run Studio populated every id and the
runloop list was entirely **FAILED**, with runs appearing without the operator
ever typing a prompt.

### Issue A — runs created without a prompt
`apps/web/components/cognition/cognition-workbench.tsx`
- `"+ run"` called `startCognition` with a **hard-coded** goal/prompt
  (`"Investigate recent runtime anomalies…"`), so a click created a full
  cognition (and all five ids) with no operator input.
- The list effect also **auto-selected `list[0]`** on mount, so the metadata
  panel lit up as if a run had just been created for you.

**Fix:** Run Studio is now prompt-driven like the Playground. A prompt textarea
(⌘/Ctrl+Enter to run) gates a **Run** button; a run is created **only** on
explicit submission, using the typed prompt as the cognition goal + task.
Auto-select on mount was removed — opening the tab creates/selects nothing. The
list refresh remains read-only.

### Issue B — every run ended FAILED (root cause, not a symptom)
`apps/api/src/runtime/cognition/agents/verifierAgent.ts`
- The verifier emitted `selfReport: 1 - score` (and `1 - avgScore`). `selfReport`
  is consumed by `calculateConfidenceScore` as the node's **confidence**
  (`report*100`). So a **passing** verification (`score≈1.0`) reported
  `selfReport≈0.0` → confidence score **0** → `makeOrchestrationDecision(0)`
  returns `executionAutonomy:"HALTED"` (`<15`) → the orchestrator's halt path
  called `markFailed` → **every successful run was force-FAILED** at the VERIFY
  node (all nodes show "done", yet the cognition is FAILED — exactly the
  screenshot).
- **Fix:** `selfReport: score` / `selfReport: avgScore` (confidence, not its
  inverse). `uncertainty.overall` stays `1 - score` (that one is genuinely
  uncertainty). Planner already used `selfReport: confidence`; critic/memory
  emit healthy uncertainty (0.15 / 0.05) — verifier was the lone inversion.

**Verification of B:** `apps/api/test/phantomExecution.test.ts` now asserts the
clean run reaches `COMPLETED` / `phase === "COMPLETE"` (previously the assertion
accepted FAILED). Full API suite still **581 passed**.

---

## 6d. Real-data timelines, E2E coverage & phase coloring (follow-up sprint)

Driven by "the Sequence Frame Track looks the same for every id."

### Issue C — fabricated timeline narrative (identical for every run)
The Timeline tab painted a fixed Stripe-refund / Postgres-ledger story over every
cognition, regardless of the actual prompt:
- `execution-timeline-viewer.tsx`: `translateEvent` returned hardcoded
  "Refund API / Stripe 200 OK / Postgres timeout at 10.0.0.4" text; an
  `renderStorytellingOverlay` of fixed Stripe/Postgres cards; and a wholly
  invented `AttemptComparisonPanel` ("$150 refund", "REPLAY DETERMINISM: 100%
  CANONICAL").
- `timeline/live-timeline.tsx`: the same ledger/Stripe fiction in its
  `EXECUTION_STATE` descriptions.

**Fix:** rewrote both to derive text from the **real** event type + the frame's
own label (humanized type, real failure/recovery/completion/tool/model
families); deleted ~247 lines of fabricated panels. Frame titles/descriptions
now differ per run because they come from that run's events. The underlying
frame track, health curve and summary stats were already real (per-cognition
`materializeFrames`) — only the narrative layer was fake.

### Phase-based frame coloring
A healthy run carries no failure roles, so every tile was the same grey. Clean
frames are now tinted by the **producing agent phase** (PLANNER→sky,
EXECUTOR→emerald, VERIFIER→amber, CRITIC→fuchsia, MEMORY→cyan; failures still
use the causal palette). The role is read from the frame label the backend
already emits (`"COMPLETED · PLANNER #1"`) — no backend change. Runs now show
their real PLAN→EXECUTE→VERIFY→CRITIQUE→MEMORY structure.

### End-to-end coverage (the gap that let the bugs through)
`apps/api/test/e2eRunLifecycle.test.ts` (new, 4 tests) drives the full HTTP path:
prompt → cognition **COMPLETES** → `/executions/:id` resolves with terminal
status + matching trace/runtime → failure-timeline returns **real per-run
frames** (well-formed event types, valid causal roles) → a clean run carries **no
HIGH/CRITICAL** signals + healthy score → full-analysis + cognition view are
consistent. Plus determinism (same seed → same id + frame count), distinct
prompts → distinct runs/executions/traces, and the runTask path materialising a
resolvable trace-stamped execution. These assertions would have caught both the
verifier inversion and the phantom-execution defect.

**Verification:** `apps/api` `tsc` ✅ · `vitest run` **585 passed / 67 files**
(+4 E2E). `apps/web` `tsc` ✅ · `vitest run` 3 passed. No residual
stripe/refund/ledger/Postgres fiction in `components/replay` or
`components/timeline`.

---

## 6e. Real-LLM cognition (config-gated) + replay-panel audit (follow-up sprint)

### Model-backed planner & verifier
Run Studio's planner/executor/verifier were synthetic while only the Playground
used a real model. Now:
- `PlannerAgent` and `VerifierAgent` take an **optional `ModelProvider`**. When
  wired, the planner prompts the model for a real decomposition and the verifier
  asks the model to adjudicate the executor output; both **fall back to the
  existing deterministic heuristic** on any provider error or unparseable output.
- `runtimeContainer.ts` passes the provider to planner/verifier **only when
  `MODEL_PROVIDER !== "deterministic"`** (`cognitionModelProvider`). The default
  and every test use `deterministic`, so planner/verifier run the unchanged
  heuristic — byte-for-byte replay and all existing tests preserved. With
  groq/openai/claude/failover wired, cognition becomes genuinely real.
- Files: `agents/plannerAgent.ts`, `agents/verifierAgent.ts`, `runtimeContainer.ts`.
- Tests: `test/modelBackedRoles.test.ts` (new, 8) — model-backed plan/verdict,
  provider-throws fallback, unparseable-output fallback, no-provider determinism,
  and a guard that a passing heuristic verify still reports HIGH confidence (the
  inversion never returns). The E2E suite continues to assert a run **COMPLETES**
  under the deterministic provider.

### Replay-panel audit
Swept the remaining replay panels for hardcoded/placeholder data:
- `replay-determinism-panel.tsx` — score is computed from **real frame
  fingerprints** (not fabricated), but was **never wired to frames** in
  `replay-experience.tsx` (always showed "No replay frames"). Fixed: the Replay
  Experience now loads real frames via `cognitionApi.listFrames(cognitionId)` and
  feeds the panel.
- `cognition-node-explorer.tsx` — data-driven (`cognitionApi.get` +
  `getNodeDetails`); no change.
- `operator-replay-console.tsx` — data-driven (`operatorApi.diagnose` / pause /
  resume / inject + `cognitionApi.branchFromNode` / `diff`); the only "placeholder"
  strings are legitimate form-input placeholders; no change.

**Verification:** `apps/api` `tsc` ✅ · `vitest run` **593 passed / 68 files**
(+8). `apps/web` `tsc` ✅ · `vitest run` 3 passed.

---

## 7. Remaining risks / follow-ups

1. **Runtime ID semantics = per-request correlation id** (`request.id`), matching
   the existing `x-runtime-id` header. It changes per request, so a polling
   surface shows a fresh value each fetch. If a *stable per-process* runtime id
   is preferred, swap `runtimeIdFor` to return `config.WORKER_ID` (or a boot id)
   and set the header to match — one-line change, isolated to
   `observabilityMetadata.ts` + `app.ts`.
2. **No `trace_id` column on the Postgres `executions`/`cognition_graphs`
   tables.** Trace id round-trips in memory mode and is resolved from the event
   log under Postgres, so reads are correct; but a dedicated column + index would
   avoid the per-read event scan at high volume. Additive migration when needed.
3. **Token usage on cognition executions is approximate** (counts streamed token
   chunks; no prompt/completion split). Fine for display; not billing-grade.
4. **`createReplaySession` still POSTs on Scrubber-tab mount.** It is idempotent
   and creates no execution, but if strict "zero writes on mount" is desired,
   gate it behind an explicit "Start replay session" click.
5. **Sub-cognition / branch executions:** `persistExecutionStart` now also backs
   any cognition `run()` whose execution row is absent; branch/replay flows that
   go through `ReplayEngine` are unchanged. Worth an integration pass if branch
   executions are later expected in `/executions/:id`.
6. Pre-existing environmental test failures (Postgres container-restart chaos,
   outbox DLQ timing flake) are unrelated and were not touched — see
   `project_test-topology` memory.

---

## 7. Follow-up sprint — model-backing, panel sweep, trace_id persistence

### 7.1 Verifier confidence inversion (universal-FAILED bug)
`apps/api/src/runtime/cognition/agents/verifierAgent.ts` — verifier emitted
`selfReport: 1 - score`. `calculateConfidenceScore` reads `selfReport` as the
node's confidence, so a **passing** verification (score≈1.0) scored 0/100 →
`makeOrchestrationDecision(0)` → `HALTED (<15)` → `markFailed`. **Every clean
run was force-FAILED.** Fixed by setting `selfReport = score` (and `avgScore`
in the multi-verifier branch). Pinned by `e2eRunLifecycle.test.ts` (asserts
`graph.phase === "COMPLETE"`).

### 7.2 Prompt-driven UI (no auto-creation)
- `cognition-workbench.tsx` Run Studio button removed its hardcoded prompt
  "Investigate recent runtime anomalies…"; now consumes the shared Playground
  prompt; no longer auto-selects first cognition on list refresh.
- `observability-dashboard.tsx` Run Trace owns a single `sharedPrompt` (lifted
  to dashboard); Playground edits it, Run Studio + Run Trace consume it. There
  is exactly one prompt box in the whole console (Playground).

### 7.3 Replay timeline fiction removal
- `execution-timeline-viewer.tsx` — deleted 247 lines of hardcoded Stripe-
  refund / Postgres-ledger narrative (`renderStorytellingOverlay`,
  `AttemptComparisonPanel`, `DiffStep`). `translateEvent` now derives titles +
  descriptions from real `eventType`/`label` per frame.
- `live-timeline.tsx` — same kind of fiction removed from the Playground
  EXECUTION_STATE descriptions; honest text from real event fields only.
- Added phase-based tinting for CLEAN frames in the Sequence Frame Track
  (PLANNER/EXECUTOR/VERIFIER/CRITIC/MEMORY) so distinct runs are visually
  distinguishable instead of uniform grey.

### 7.4 E2E run-lifecycle suite (`apps/api/test/e2eRunLifecycle.test.ts`)
4 tests pinning the full path the unit tests never exercised:
1. user prompt → cognition reaches `COMPLETE` (regression guard for §7.1) →
   `GET /executions/:id` resolves to `COMPLETED` with matching `traceId` and
   non-empty `runtimeId` → `failure-timeline` has real per-run frames with no
   HIGH/CRITICAL signals → `full-analysis` returns a well-formed report;
2. determinism: same `seed` → same cognition id + frame count;
3. distinct prompts → distinct ids + trace ids + execution rows;
4. `runTask` (Run Trace path) → execution resolves with `runtimeId`.

### 7.5 Model-backed planner + verifier (gated)
`apps/api/src/runtime/cognition/agents/{planner,verifier}Agent.ts` — constructor
accepts an optional `ModelProvider`. When wired, prompts the model for a
real plan / verdict and uses the result; on provider failure or unparseable
output, falls back to the existing deterministic heuristic. Marker
`output.modelBacked === true` on each node when the model path was used.

`apps/api/src/application/runtimeContainer.ts` — passes the provider into both
roles **only when `MODEL_PROVIDER !== "deterministic"`**. Default + every
existing test path therefore stays byte-for-byte deterministic (replay,
fingerprints, and unit fixtures unchanged).

Tests: `modelBackedRoles.test.ts` (8) — heuristic-determinism, model-backed
PASS/FAIL, throw-fallback, unparseable-output fallback;
`modelBackedCognition.test.ts` (1 integration) — full orchestrator drive with
stub provider reaches `COMPLETE` with `modelBacked: true` on PLANNER node.

### 7.6 UI: cognition-mode badge
`apps/web/components/ui/execution-metadata-panel.tsx` — new `mode` prop
(`MODEL-BACKED` violet / `DETERMINISTIC` zinc). `cognition-workbench.tsx`
derives the mode from `view.graph.nodes.some(n => n.output.modelBacked)` and
passes it; `replay-experience.tsx` passes the mode through as well. Operators
can tell at a glance whether a run was real or heuristic.

### 7.7 Trace-id columns + migration
`apps/api/db/migrations/0023_trace_id_columns.sql` — adds nullable `trace_id`
to `executions` and `cognition_graphs` plus partial indices
(`idx_executions_trace`, `idx_cognition_graphs_trace`).
`postgresExecutionRepository.ts` + `postgresCognitionRepository.ts` — insert
+ `coalesce(excluded.trace_id, …)` on conflict so the original trace id is
never blanked by a later un-traced update; all SELECTs include the new column;
row mappers return `traceId`. Backwards compatible: column is nullable; the
event-metadata fallback path in `observabilityMetadata.ts` continues to work
on rows written before the migration. No backfill required.

### 7.8 Verification (this sprint)
- `apps/api`: `npx tsc --noEmit` ✅ ; `npx vitest run` → **594 passed / 69
  files** (was 581 / 66; added phantom, E2E, model-backed-roles,
  model-backed-cognition).
- `apps/web`: `npx tsc --noEmit` ✅ ; `npx vitest run` → 3 passed.

### 7.9 Remaining risks
1. **Real-LLM run determinism.** With a real provider wired, cognition ids
   remain deterministic (planner output isn't hashed into the id) but per-run
   token streams and node outputs vary. Replay-byte-identity is preserved only
   in `MODEL_PROVIDER=deterministic`; that's the trade — surfaced in the UI by
   the mode badge.
2. **trace_id integration test under Postgres.** Wired through the in-memory
   suite + verified via `tsc`; a docker-gated test asserting persistence under
   real Postgres is the next addition.
3. **Sub-cognition / branch tracing.** Branches go through `ReplayEngine` and
   inherit the parent's executionId — they will share the parent's trace id by
   construction, which is correct but worth pinning in a test before someone
   changes the branch path.
