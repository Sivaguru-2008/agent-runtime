# Sprint Next — Deterministic Runtime Replay + Multi-Agent Cognition Engine

> Chrome DevTools + Datadog + Temporal + LangSmith — for AI agents.

This sprint upgrades the platform from "live SSE + execution DAG" to a true
**runtime cognition operating system** with deterministic replay, branched
time-travel debugging, multi-agent orchestration, and a failure-intelligence
layer.

---

## 1. Architecture Upgrades

```
┌─────────────────────────────────────────────────────────────────┐
│ apps/web · Cognition Workbench                                 │
│ ┌──────────────┐ ┌───────────────┐ ┌──────────────┐ ┌───────┐  │
│ │ Cognition    │ │ Time-Travel   │ │ Memory       │ │ Fail. │  │
│ │ Graph + UI   │ │ Debugger      │ │ Influence    │ │ Intel │  │
│ └──────────────┘ └───────────────┘ └──────────────┘ └───────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │  Fetch + SSE
┌──────────────────────────▼──────────────────────────────────────┐
│ apps/api · Fastify                                              │
│ ┌────────────────────┐  ┌────────────────────┐                  │
│ │ Cognition Routes   │  │ Replay Routes      │  Sprint Next     │
│ │ /cognition/*       │  │ /replay/*          │                  │
│ └─────────┬──────────┘  └─────────┬──────────┘                  │
│           ▼                       ▼                              │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Application Layer (commands + queries)                     │  │
│ │ CognitionCommands | CognitionQueries | ReplayQueries       │  │
│ │ MemoryInfluenceQueries                                     │  │
│ └────────────┬───────────────────────────────────────────────┘  │
│              ▼                                                   │
│ ┌─────────────────────┐ ┌─────────────────┐ ┌─────────────────┐ │
│ │ Cognition           │ │ Replay Engine   │ │ Failure         │ │
│ │ Orchestrator + FSM  │ │ + Snapshots     │ │ Intelligence    │ │
│ │  - Planner          │ │ + Frame Builder │ │ Engine          │ │
│ │  - Executor         │ │ + Diff Engine   │ │  - Hallucin.    │ │
│ │  - Verifier         │ │ + Branch Reg.   │ │  - Contradict.  │ │
│ │  - Critic           │ │                 │ │  - Recursion    │ │
│ │  - Memory-Manager   │ │                 │ │  - Tool misuse  │ │
│ └─────────────────────┘ └─────────────────┘ │  - Corrupt mem  │ │
│              │                              └─────────────────┘ │
│              ▼                                                   │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Domain ports + in-memory / Postgres adapters               │  │
│ │ EventStore · CognitionRepo · SnapshotStore · LineageStore  │  │
│ │ ReplaySessionStore · BranchRegistry · FailureSignalStore   │  │
│ └────────────────────────────────────────────────────────────┘  │
│              │                                                   │
│              ▼                                                   │
│      Append-only Event Log  (already production)                │
│      EventBus (memory · Redis · Redis Streams)                  │
│      Cluster (workers · leases · checkpoints · failover)        │
└─────────────────────────────────────────────────────────────────┘
```

### Deterministic Execution Framework

- **Deterministic IDs** (`shared/determinism.ts`):
  - `deterministicId(parts)` — sha256-prefixed 32-char hex IDs from canonical inputs.
  - `fingerprint(value)` — order-independent canonical JSON hash.
  - `seededRandom(seed)` — Lehmer PRNG; identical seed → identical sequence.
- Every cognition node ID is `hash(executionId, sequence, role, inputFingerprint)`.
- Every cognition graph ID is `hash(agentId, fingerprint(task), parent, parentNode)`.
- Replays of the same event log reconstruct **bit-identical** frame fingerprints.

### Append-Only Event Log

Existing `EventStore` (in-memory + Postgres) already enforces append-only
ordering and per-aggregate sequence. Sprint Next adds 25+ new event types
(see §4) consumed by the replay engine, failure analyzers, and the SSE stream.

### Cognition State Machine

```
INIT → PLAN → EXECUTE → VERIFY ──pass──→ CRITIQUE → MEMORY_COMMIT → COMPLETE
                          │
                          └──fail──→ EXECUTE   (bounded retries)
                                      │
                                      └─ exhausted ─→ FAILED
```

Pure transition table in `runtime/cognition/cognitionStateMachine.ts`; side
effects (events, persistence) live in the orchestrator.

---

## 2. Backend Implementation

```
apps/api/src/
├── domain/
│   ├── cognition.ts            # CognitionGraph, CognitionNode, roles, uncertainty
│   ├── cognitionPorts.ts       # New repositories (cognition/replay/lineage/etc)
│   ├── replay.ts               # ReplayFrame, ReplaySession, BranchPointer
│   ├── failure.ts              # FailureSignal, FailureReport
│   └── events.ts               # Extended with 25 Sprint Next event types
├── shared/
│   └── determinism.ts          # deterministicId, fingerprint, seededRandom
├── infrastructure/persistence/
│   └── inMemoryCognitionStores.ts
├── runtime/
│   ├── cognition/
│   │   ├── roles.ts            # RoleAgent contract
│   │   ├── cognitionStateMachine.ts
│   │   ├── orchestrator.ts     # Drives the multi-agent loop
│   │   └── agents/
│   │       ├── plannerAgent.ts
│   │       ├── executorAgent.ts
│   │       ├── verifierAgent.ts
│   │       ├── criticAgent.ts
│   │       └── memoryManagerAgent.ts
│   ├── replay/
│   │   ├── frameBuilder.ts     # Event log → ReplayFrame[]
│   │   ├── diffEngine.ts       # Source vs branch frame diff
│   │   └── replayEngine.ts     # Sessions, seek, snapshot, branch
│   └── failure/
│       ├── analyzer.ts         # FailureAnalyzer interface
│       ├── failureIntelligenceEngine.ts
│       └── analyzers/
│           ├── hallucinationScorer.ts
│           ├── contradictionDetector.ts
│           ├── recursionDetector.ts
│           ├── toolMisuseDetector.ts
│           └── corruptedMemoryDetector.ts
├── application/
│   ├── commands/cognitionCommands.ts
│   └── queries/
│       ├── cognitionQueries.ts
│       ├── replayQueries.ts
│       └── memoryInfluenceQueries.ts
└── interfaces/http/
    └── sprintNextRoutes.ts     # /cognition/*, /replay/*, failure intel
```

The orchestrator emits **5 event classes per node** (started → streaming chunks
→ memory influence → completed). All events flow through the existing
`PersistedEventPublisher`, which writes to the event store **and** publishes
to the bus, so distributed workers and SSE clients see the same ordering.

### Cluster integration

Sprint Next reuses the existing distributed scheduler, worker lease manager,
and recovery flow. Future work hooks `CognitionOrchestrator.run` into the
scheduler queue so cognitions can be leased/failed-over across workers
(currently they run on the originating worker).

---

## 3. Frontend Visualization Upgrades

```
apps/web/
├── lib/
│   └── cognition-api.ts        # Sprint Next API client + types
├── hooks/
│   ├── use-replay-session.ts   # Scrubber state + auto-advance
│   └── use-cognition-graph.ts  # Graph + failure + influence loader
├── components/
│   ├── cognition/
│   │   ├── cognition-graph.tsx           # Animated role-coloured graph
│   │   ├── cognition-workbench.tsx       # Top-level layout w/ tabs
│   │   ├── token-stream-overlay.tsx      # Live SSE token stream
│   │   ├── uncertainty-heatmap.tsx       # Per-token confidence rows
│   │   ├── memory-influence-graph.tsx    # Memory × Node heatmap
│   │   └── failure-intelligence-panel.tsx
│   └── replay/
│       ├── replay-timeline-scrubber.tsx  # DevTools-style scrubber
│       ├── branch-divergence.tsx         # Diff visualizer
│       └── time-travel-debugger.tsx      # Composed time-travel UI
└── components/dashboard/
    └── observability-dashboard.tsx       # New "Cognition Workbench" tab
```

| Feature | Component |
|---|---|
| Animated cognition graph | `cognition-graph.tsx` (CSS pulse on RUNNING, role colour band) |
| Token streaming overlay | `token-stream-overlay.tsx` (SSE filtered on `COGNITION_NODE_STREAMING`) |
| Branch divergence | `branch-divergence.tsx` (per-frame delta strip + summary stats) |
| Uncertainty heatmap | `uncertainty-heatmap.tsx` (per-token colour grid) |
| Memory influence graph | `memory-influence-graph.tsx` (memory × node heatmap with anchors) |
| Replay scrubber | `replay-timeline-scrubber.tsx` (markers + range input + transport) |
| Time-travel debugger | `time-travel-debugger.tsx` (scrubber + node inspector + branch panel) |

---

## 4. Event Schemas (new)

All events inherit from `DomainEvent<TPayload>` and are written to the
append-only `EventStore` with a monotonic per-aggregate `sequence`.

| Event Type | Payload | Emitted by |
|---|---|---|
| `COGNITION_STARTED` | `{ graph }` | Orchestrator |
| `COGNITION_PHASE_CHANGED` | `{ cognitionId, from, to }` | Orchestrator |
| `COGNITION_NODE_STARTED` | `{ node }` | Orchestrator |
| `COGNITION_NODE_STREAMING` | `{ nodeId, cognitionId, chunk }` | Orchestrator |
| `COGNITION_NODE_COMPLETED` | `{ node, uncertainty }` | Orchestrator |
| `COGNITION_NODE_FAILED` | `{ node, error }` | Orchestrator |
| `COGNITION_HANDOFF` | `{ cognitionId, handoff, toRole }` | Orchestrator |
| `COGNITION_COMPLETED` | `{ graph }` | Orchestrator |
| `COGNITION_FAILED` | `{ graph }` | Orchestrator |
| `MEMORY_INFLUENCE_RECORDED` | `{ cognitionId, nodeId, influence[] }` | Orchestrator |
| `REPLAY_SESSION_CREATED` | `{ sessionId, cognitionId, executionId }` | ReplayEngine |
| `REPLAY_SNAPSHOT_WRITTEN` | `{ snapshot }` | ReplayEngine |
| `REPLAY_FRAME_EMITTED` | `{ sessionId, frame }` | ReplayEngine (when streaming) |
| `REPLAY_BRANCH_CREATED` | `{ pointer, reason? }` | ReplayEngine |
| `REPLAY_DIVERGENCE_DETECTED` | `{ source, branch, divergenceFrameIndex }` | ReplayEngine (diff) |
| `FAILURE_SIGNAL_RAISED` | `{ signal }` | FailureIntelligenceEngine |
| `HALLUCINATION_DETECTED` | `{ signal }` | HallucinationScorer |
| `CONTRADICTION_DETECTED` | `{ signal }` | ContradictionDetector |
| `RECURSION_DETECTED` | `{ signal }` | RecursionDetector |
| `TOOL_MISUSE_DETECTED` | `{ signal }` | ToolMisuseDetector |
| `CORRUPTED_MEMORY_DETECTED` | `{ signal }` | CorruptedMemoryDetector |
| `UNCERTAINTY_SPIKE` | `{ signal }` | (reserved) |

---

## 5. Runtime APIs

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/cognition` | Start a new cognition (Planner → … → Memory-Manager). |
| `GET` | `/cognition` | List recent cognitions. |
| `GET` | `/cognition/:id` | Full graph view + lineage + branches + failure signals + uncertainty. |
| `GET` | `/cognition/:id/lineage` | Node-by-node lineage records. |
| `GET` | `/cognition/:id/memory-influence` | Memory influence heatmap (memory × node × weight). |
| `GET` | `/cognition/:id/failure-report` | Aggregated FailureReport with `healthScore`. |
| `POST` | `/executions/:id/analyze-failures` | Re-run all analyzers ad hoc. |
| `GET` | `/cognition/:id/replay/frames` | Materialized replay frames. |
| `POST` | `/cognition/:id/replay` | Create a replay session. |
| `GET` | `/replay/:sessionId` | Session + graph at cursor + snapshots. |
| `POST` | `/replay/:sessionId/seek` | Move the cursor to `{frameIndex}`. |
| `POST` | `/replay/:sessionId/play` | Set playback speed. |
| `POST` | `/replay/:sessionId/snapshot` | Persist a snapshot at the current cursor. |
| `POST` | `/replay/branch` | Fork a new cognition at a node. |
| `GET` | `/replay/branches` | All branch pointers. |
| `GET` | `/replay/diff?source=…&branch=…` | Frame-level diff between two cognitions. |
| `GET` | `/failure-signals/recent` | Recent FailureSignals across the cluster. |

---

## 6. Replay Engine

`runtime/replay/replayEngine.ts` is **pure with respect to the event log**:

1. `createSession(cognitionId)` — loads events, builds frames via `FrameBuilder`,
   persists a `ReplaySession`.
2. `seek(sessionId, frameIndex)` — clamps the cursor, pauses playback.
3. `writeSnapshot(cognitionId, frameIndex)` — captures the materialized graph at
   that frame to `SnapshotStore`. Nearest-snapshot lookup uses these for fast
   seeks in large timelines.
4. `branch(request)` — copies all ancestor nodes through the source node into a
   **new** cognition graph with a deterministic ID, records a `BranchPointer`,
   and emits `REPLAY_BRANCH_CREATED`.
5. `diffCognitions(a, b)` — runs `ReplayDiffEngine` over both frame timelines
   and returns per-frame `IDENTICAL | DIVERGED | BRANCH_ONLY | SOURCE_ONLY`
   classifications plus the **first divergence frame**.

### Snapshot serialization

Snapshots carry the full `CognitionGraph` at the chosen frame. With the
Postgres adapter, they round-trip as JSONB. With the in-memory adapter they
stay in process. The format is stable enough to ship over a websocket / SSE
without further transformation.

---

## 7. Failure Intelligence

`runtime/failure/failureIntelligenceEngine.ts` runs five analyzers over the
event log + cognition graph and produces:

```ts
interface FailureReport {
  cognitionId?: string;
  executionId: string;
  totalSignals: number;
  bySeverity: Record<"INFO"|"LOW"|"MEDIUM"|"HIGH"|"CRITICAL", number>;
  byKind: Record<FailureSignalKind, number>;
  topSignals: FailureSignal[];
  healthScore: number; // 0..100, 100 = clean
}
```

Each signal carries `score ∈ [0,1]` and `severity`. The aggregate health
score subtracts severity-weighted penalties from 100. Front-end surfaces
this verbatim in the Failure Intelligence panel.

| Analyzer | Heuristic |
|---|---|
| HallucinationScorer | High uncertainty + claim density + no memory grounding |
| ContradictionDetector | Verdict-like fields flipping across nodes |
| RecursionDetector | Same `(role, inputFingerprint)` repeated ≥ 3× |
| ToolMisuseDetector | Empty inputs or repeated identical tool calls |
| CorruptedMemoryDetector | Same memoryId implicated in ≥ 2 failed nodes |

All analyzers are **pure functions** so they run identically on live event
streams and on replayed timelines.

---

## 8. Production-Ready Folder Structure (final state)

```
apps/api/src/
├── domain/                  # Pure types + ports — zero infrastructure deps
├── application/             # Commands + queries — orchestrates domain ops
│   ├── commands/
│   └── queries/
├── runtime/                 # Process-internal engines
│   ├── cognition/           # Multi-agent state machine + role agents
│   ├── replay/              # Frames, diffs, snapshots, branching
│   ├── failure/             # Analyzers + intelligence engine
│   ├── executionEngine.ts   # Legacy single-pass execution
│   └── agentRuntime.ts
├── infrastructure/
│   ├── events/              # Buses (memory, Redis, Streams), factory, publisher
│   ├── persistence/         # In-memory + Postgres adapters
│   ├── cluster/             # Worker/lease/checkpoint stores
│   └── telemetry/
├── interfaces/http/         # Fastify routes
├── shared/                  # clock, id, errors, config, determinism
└── server.ts

apps/web/
├── app/                     # Next.js app router
├── components/
│   ├── cognition/           # Sprint Next: graph, overlays, workbench
│   ├── replay/              # Sprint Next: scrubber, branches, time-travel
│   ├── dashboard/           # Existing dashboard + new tab
│   ├── graph/ playground/ timeline/ ui/
├── hooks/                   # use-replay-session, use-cognition-graph
├── lib/                     # api.ts, cognition-api.ts, utils
├── types/
└── styles/
```

---

## 9. Tests

`apps/api/test/cognition.test.ts` exercises the full Sprint Next path:

1. Start a cognition → verify it terminates and contains a `PLANNER` first node.
2. Start the same cognition twice → assert identical deterministic IDs.
3. List replay frames → all have content fingerprints.
4. Create a replay session, seek, snapshot.
5. Branch from an intermediate node.
6. Pull the failure report (healthScore 0..100).
7. Pull the memory-influence heatmap.

Full suite: **12 passing tests** (3 existing + 1 new file = 4 files).

---

## 10. Where to extend next

- **Scheduler integration** — wire `CognitionOrchestrator.run` through the
  distributed scheduler so cognitions lease workers and survive failover.
- **Real model providers** — swap `DeterministicModelProvider` for the
  existing `OllamaProvider` inside the `ExecutorAgent` when not in replay mode.
- **Streaming the replay timeline** — replace the polling scrubber with an
  SSE-driven cursor for sub-100ms latency.
- **Persistent cognition store** — add a Postgres adapter mirroring
  `InMemoryCognitionRepository` (schema already matches the existing
  event-store JSONB convention).
- **Hallucination calibration** — collect labelled outputs and fit the
  hallucination scorer's weights via offline analysis on the event log.
