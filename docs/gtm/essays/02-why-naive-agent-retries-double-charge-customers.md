# Why naive agent retries double-charge customers

*Publishable draft for P2.1 — the problem-first launch lead. Source: `docs/specs/fence-protocol.md`, `docs/specs/failure-semantics-spec.md`. ~950 words. Replace `<DEMO_URL>`, `<DEPLOY_URL>`, `<PKG>` before publishing.*

---

Every backend engineer knows the retry. A network call fails, you wrap it in a loop, you try again. It's one of the most reliable patterns in distributed systems — when the thing you're retrying is a single, idempotent step.

AI agents break that assumption in a way that's easy to miss until it costs you real money.

## The retry you wrote is retrying the wrong thing

A traditional service has a fixed call graph. You know, at code-review time, exactly which step does what. When step 3 fails, your retry re-runs step 3.

An LLM agent doesn't have a fixed call graph. It plans its steps *dynamically*, at runtime, based on the model's output. So when something fails partway through, there often isn't a clean "step 3" to retry — there's a *plan*, and the natural unit of retry becomes "re-run the agent."

Re-running the agent means re-running the LLM, which re-plans, which re-issues every action it decided to take — including the one that already succeeded. The refund that already went through. The payout that already cleared. The provisioning call that already spun up a box.

```
Attempt 1:  plan → refund $150 (OK) → write ledger (TIMEOUT) ✗
            retry fires...
Attempt 2:  plan → refund $150 (OK AGAIN) → write ledger (OK)
                          ↑
                   customer refunded twice
```

The first refund didn't fail. Only the *ledger write* failed. But the retry had no way to know the refund was already done, so it did it again.

## Why the usual defenses don't quite hold

Smart teams reach for one of these. Each helps and each has a gap that bites under agent workloads:

**"I use idempotency keys."** Good instinct — it's the right primitive. But where do you compute the key? If you derive it from the call's arguments (the common pattern), then when the LLM re-plans with a slightly different argument on retry, you compute a *new* key, the payment API sees a *new* request, and the dedupe silently fails. The protection evaporates exactly when the plan drifts — which is exactly when agents drift.

**"I use a workflow engine like Temporal."** Also good — for deterministic workflows. But Temporal's model assumes your workflow is replayable deterministic code. An LLM that re-plans non-deterministically on each attempt isn't that. You can pin the LLM output, but then you have to decide: do you re-run the side effect, or trust a recorded result? That decision is the actual hard problem, and the engine doesn't make it for you.

**"I store agent state in a row and update it."** Now you have a race: a stalled worker and its replacement both writing the same row under recovery. Last-write-wins corrupts state, and neither write knows whether the external refund happened.

The common thread: the failure isn't in any one tool. It's in the gap between "the side effect committed in the outside world" and "my system recorded that it committed." Anything that can fail in that gap can cause a duplicate.

## What actually closes the gap

Three things, together:

1. **Treat every step as an append-only event, not a mutable row.** State is *rebuilt* by replaying the event log, so two workers can't race to overwrite each other's view of what happened.

2. **Fence side effects at the database, inside the transaction.** Each external call reserves a deterministic idempotency key — keyed on `(execution_id, step_seq)`, *not* on arguments — and the success write is committed in the same atomic transaction that re-checks the worker's fence token. A stale worker that wakes up late is rejected by Postgres before it can re-run a completed call.

3. **Make replay deterministic and explicit.** When you recover or re-run, completed external calls are *reused from the event log*, never re-invoked. If something would genuinely diverge (the arguments changed, the model changed), the system forks an explicit branch instead of silently re-executing.

Put together, the recovery story becomes: a worker dies mid-refund → the lease expires → a standby hydrates from the last checkpoint → it sees the refund already succeeded and *skips* it (fenced) → it finishes the ledger write → done. Customer charged once. No human in the loop.

## The tell that you have this problem

You probably have it, latent, if:

- You have agents in (or near) production that call payment, payout, billing, or infra-mutating APIs.
- Your recovery story for "agent dies mid-task" is "we retry the task."
- You can't quickly answer, after the fact, *exactly* which external calls a given run made.

The cost shows up as a support ticket, a clawback, an incident channel at 2am — usually after the first time it happens at scale.

## See it / try it

The 2:30 demo runs the exact failure above and shows the standby worker skip the already-done refund: **<DEMO_URL>**

It's one Node process + Postgres — no Redis, no k8s — to try:

```bash
npm install <PKG>
```

Deploy your own and kill a worker mid-refund: **<DEPLOY_URL>**.

I'm talking to teams running money- or infra-touching agents about how they handle this today. If you've hit it — or built a workaround you trust — I'd genuinely like to compare notes.
