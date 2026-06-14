# agent-runtime

**The unified runtime intelligence layer.** One pipeline that sits between any
LLM and the real world and, on *every* prompt:

> **predicts** failures before they happen · **watches** every token as it
> streams · **validates** every tool result · **fences** every irreversible
> effect · **explains** failures with a causal chain · **intervenes** in real
> time · **learns** from every run · **evaluates** the final answer.

It does not monitor. It does not alert. It does not log. It **prevents**.

Built on [`agent-fence`](../agent-fence) (the exactly-once side-effect fence) and
Groq + Llama 3.3 70B, with a single SQLite database where all eight stages write,
connected by one `runId`.

---

## The pipeline

Every prompt goes through all eight stages, in order — no exceptions, no
shortcuts:

| # | Stage | What it does | Code |
|---|-------|--------------|------|
| 1 | **Pre-flight** | Second LLM call predicts exactly what will go wrong; auto-applies the fence config; gates dangerous runs for a human | [`stages/preflight.ts`](src/stages/preflight.ts) |
| 2 | **Stream analyzer** | Reads every streamed token; pattern-matches HALLUCINATION_FORMING, SILENT_FAILURE, LOOP_STARTING, INTENT_DRIFT, CONTEXT_COLLAPSE, OVERCONFIDENCE | [`stages/streamAnalyzer.ts`](src/stages/streamAnalyzer.ts) |
| 3 | **Step validator** | After every tool call: claim-vs-result, data-quality score, silent-failure + duplicate detection | [`stages/stepValidator.ts`](src/stages/stepValidator.ts) |
| 4 | **Fence enforcement** | Every IRREVERSIBLE tool goes through the real `agent-fence`; nothing bypasses it | [`stages/fenceEnforcement.ts`](src/stages/fenceEnforcement.ts) |
| 5 | **Causal attribution** | On any failure, builds the exact chain from real token/step evidence: root cause → forward chain → where it was preventable | [`stages/causalAttribution.ts`](src/stages/causalAttribution.ts) |
| 6 | **Intervention** | Real-time WARN / REDIRECT / ABORT / FENCE / HUMAN decisions; can stop generation mid-stream | [`stages/intervention.ts`](src/stages/intervention.ts) |
| 7 | **Pattern learner** | Records every run; rebuilds the cross-run model (fault rates, fence help, prediction accuracy) — the data moat | [`stages/patternLearner.ts`](src/stages/patternLearner.ts) |
| 8 | **Quality evaluator** | Ruthless second LLM judges whether the user got exactly what they asked for; prevention facts come from the real ledger | [`stages/qualityEvaluator.ts`](src/stages/qualityEvaluator.ts) |

The orchestrator that wires them together is [`runtime.ts`](src/runtime.ts); the
unified report is [`panel.ts`](src/panel.ts).

## Run it

```bash
# live Groq (reads GROQ_API_KEY from apps/api/.env), all 10 demo prompts:
npm --prefix agent-runtime run demo

# deterministic offline agent — same real pipeline, tools, fence, and DB, no network:
npm --prefix agent-runtime run demo -- --replay

# a single ad-hoc prompt:
npm --prefix agent-runtime run demo -- --prompt "charge customer cust_9 $20 after checking the refund policy"
```

Each prompt prints its answer, the **AGENT INTELLIGENCE REPORT**, and — at the
end — the success-criteria scorecard computed from the real run data.

## Verify

```bash
npm --prefix agent-runtime run typecheck   # tsc, no errors
npm --prefix agent-runtime run test        # 29 tests (unit per stage + full-pipeline integration)
npm --prefix agent-runtime run build       # emits dist/
```

The integration test ([`test/pipeline.test.ts`](test/pipeline.test.ts)) runs all
ten prompts through the real pipeline with the deterministic agent and asserts
every success criterion holds end-to-end by `runId`.

## Data architecture

One SQLite database (built-in `node:sqlite`, no native build). Every stage
writes; everything is joined by `runId`:

```
runs · preflight_analyses · stream_signals · step_validations · fence_events ·
interventions · causal_chains · final_evaluations · run_faults ·
pattern_aggregates · preflight_scores · fence_committed_effects · fence_intents
```

The `agent-fence` committed-effects log lives in the *same* database (see
[`db/fenceStore.ts`](src/db/fenceStore.ts)), so a tool call and the fence
decision that governed it are one join apart.

## Success criteria (verified on real runs)

After 10 real prompts:

1. ✅ Pre-flight predicted at least one failure correctly
2. ✅ Stream analyzer caught a hallucination forming
3. ✅ A silent failure was caught at a tool boundary
4. ✅ A causal chain was built from real token evidence
5. ✅ An intervention prevented damage
6. ✅ The pattern table has real data from real runs
7. ✅ Every event is traceable end-to-end by `runId`
8. ✅ The panel shows a complete report next to every response

> No synthetic data: the tools, fence, analyzers, and database are all real. The
> only swappable part is the LLM seam (`GroqClient` for live runs,
> `MockAgentClient` for deterministic offline runs).
