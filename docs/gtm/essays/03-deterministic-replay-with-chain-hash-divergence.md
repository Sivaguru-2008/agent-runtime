# Deterministic replay with chain-hash divergence

*Publishable draft for P2.1 — the deep-tech credibility piece. Source: `docs/specs/replay-equivalent-execution.md`. ~1,000 words. Replace `<DEMO_URL>`, `<DEPLOY_URL>`, `<PKG>` before publishing.*

---

"Replay" is one of those words that sounds simple and hides a pile of decisions. Most agent tools that claim it mean "we'll re-run your prompt and hope for the best." That's not replay — that's a coin flip with extra steps, because LLMs are non-deterministic at the API.

Here's how we define replay precisely enough to be *verifiable*, and how a chain hash lets you prove a replay didn't secretly duplicate a side effect.

## Replay-equivalence, defined at the event boundary

We don't try to snapshot your agent's source code, its RAM, or the LLM's internal state. We record the **boundaries** the agent crosses — every place non-determinism enters the system — and define equivalence there:

> A replay of execution `E` is **replay-equivalent** if, for every event whose causal ancestors are fully recorded in `E`, the event's payload is byte-identical to its counterpart in `E`.

Equivalence is at the event boundary — not at the wall clock, not at the RNG, not at the LLM-token level. There are exactly four boundaries the SDK forces non-determinism through:

| Source | API | Event recorded |
|---|---|---|
| LLM call | `runtime.llm(prompt, opts)` | `MODEL_CALL` (full request + response) |
| Tool call | `@tool` function | `TOOL_CALL_*` (via the fence protocol) |
| Clock | `runtime.now()` | `CLOCK_READ` (frozen timestamp) |
| RNG | `runtime.rng()` | `RNG_READ` (frozen value) |

Use `Date.now()`, `Math.random()`, or `openai.completions.create()` directly and you've bypassed a boundary — replay breaks, and we surface that as `REPLAY_DETERMINISM_VIOLATED` rather than pretending it worked. (There's an opt-in lint rule that flags bare globals in agent code.)

## What replay reuses vs. re-runs

The guarantee that matters for safety: **a recorded `MODEL_CALL` or a `SUCCEEDED` `TOOL_CALL` is never re-invoked on replay.** Its recorded `output` is handed back to your code as if the call had just happened.

That's the difference between replay and re-execution. Re-execution calls Stripe again. Replay returns the recorded refund result and moves on. The LLM is non-deterministic, so we don't re-derive its output — we *reuse* it. The clock and RNG are frozen to their recorded values. Your code between boundaries is assumed to be a pure function of its inputs.

Two more properties fall out of this:
- **Idempotent under repeat.** Replaying the same execution twice with the same edits produces two byte-identical event streams (different `branch_id`, identical payloads).
- **Stable causal ordering.** Events replay in the same `(step_seq, subseq)` order as the original.

## The chain hash: making divergence detectable

Reusing recorded events is only safe if you can *prove* the replay actually followed the recorded path and didn't quietly fork. That's what the chain hash is for.

Each event's hash folds in its payload **and its predecessor's hash** — a hash chain, the same idea that makes a blockchain tamper-evident:

```
h(0) = H(payload_0)
h(n) = H(payload_n ‖ h(n-1))
```

Because every link depends on every prior link, the head hash is a fingerprint of the entire prefix. To check that a replay is equivalent to the original up to step *N*, you don't diff *N* payloads field by field — you compare two hashes. If `h_replay(N) == h_original(N)`, the entire prefix is byte-identical, transitively. If they differ, you know **exactly** which step first diverged: it's the lowest *N* where the chains disagree.

This turns "is this replay faithful?" from a fuzzy, best-effort comparison into a single equality check with a precise divergence index.

## No silent divergence — ever

The rule the whole system is built around: a replay is **either** strict-equivalent to the recorded prefix **or** it explicitly forks a new branch. There is no third option where it quietly re-executes something.

| Trigger | Behavior |
|---|---|
| No edits, all events present | Strict equivalence. New `branch_id`, identical payloads. |
| No edits, original was incomplete | Reuse the recorded prefix, then resume live from the last event onto a new branch. |
| You edit step N | Reuse 0..N-1, apply the edit at N, run live from N. Branch parent = N. |
| A tool's `args_hash` mismatches on replay | Throw `ReplayDivergence(stepSeq, before, after)`. You choose to fork or abort — never silent re-run. |
| Recorded model differs from current model | Mandatory branch, change marked in the diff. |
| A recorded `CLOCK_READ` would now be in the future | Mandatory branch — clock-relative decisions are genuinely different now. |

The chain hash is what makes the first two rows *checkable* and the rest *precise*. When a replay diverges, you get the exact step index, the before/after, and a branch — not a corrupted re-run you discover three incidents later.

## Why this is worth the discipline

For an agent that touches money or infrastructure, "we re-ran it and it seemed fine" is not an answer you can give an auditor, a customer, or yourself at 2am. With chain-hashed, event-boundary replay you can state, and *show*:

- Exactly which external calls a run made, in order.
- That a recovery reused completed calls instead of repeating them.
- That a replay was byte-equivalent to the original up to the point you intentionally changed — proven by a hash, not a hope.

It's the same instinct as a verifiable build: the value isn't just that it works, it's that you can *prove* it did.

## See it / try it

The 2:30 demo kills a worker mid-execution and shows the replay reuse the recorded refund (fenced) while a chain-hash check confirms the prefix matched: **<DEMO_URL>**

One Node process + Postgres to run it yourself:

```bash
npm install <PKG>
```

Deploy your own and inspect the replay in the UI: **<DEPLOY_URL>**.

I'm pre-customers, looking for teams who care about *proving* their agents are safe, not just asserting it. If replay determinism is something you've had to reason about, I'd love to talk.
