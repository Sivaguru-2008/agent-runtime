# How we make Stripe refunds replay-safe

*Publishable draft for P2.1. Source: `docs/specs/fence-protocol.md`. ~1,050 words. Replace `<DEMO_URL>`, `<DEPLOY_URL>`, `<PKG>` before publishing.*

---

An AI agent issues a $150 Stripe refund. The next step — writing that refund to your ledger — hits a database timeout. Your retry logic kicks in and re-runs the agent's plan. The agent calls Stripe again.

You just refunded the customer twice.

This isn't a hypothetical. It's the default failure mode of any agent that takes a real-world action and then does something else that can fail. The money already moved. The retry doesn't know that. And because LLM agents plan their steps *dynamically*, a naive retry doesn't re-run the failed step — it re-runs the whole plan, side effects and all.

Here's the mechanism we use to make that structurally impossible, even when a worker crashes mid-refund.

## The only correct primitive: a deterministic idempotency key

A database transaction can't un-charge Stripe. The refund happened outside your transactional boundary, and no amount of rolling back local state will claw it back. So the lock-based instinct — "hold a lock while I call Stripe" — doesn't help: if the process dies holding the lock, you're stuck, and if the lock expires mid-call, you're back to double-charging.

The only thing that actually works is to thread a **deterministic idempotency key** through every external call, so the *remote service* dedupes the duplicate for you. Stripe, Plaid, and most modern payment APIs accept an `Idempotency-Key` header: send the same key twice and the second call returns the cached result of the first instead of charging again.

The hard part isn't sending the key. It's **computing the same key on every retry, from any worker, after any crash** — and making sure only one worker is logically responsible for the call at a time.

## The key formula that matters

A subtle mistake sinks most homegrown versions of this: deriving the key from the call's arguments.

```
idempotency_key = sha256(execution_id + ":" + step_seq)
```

Note what's *not* in there: the arguments. We deliberately key on the execution and the step's position in the plan — both stable across retries — not on the args. If you fold the arguments into the key (a common pattern), then the moment the LLM re-plans with a slightly different argument on retry, you compute a *new* key, Stripe sees a *new* request, and the dedupe silently fails. The double charge comes back precisely when you thought you were protected.

We detect argument drift separately, with an `args_hash`, and treat it as an explicit divergence rather than letting it quietly mint a new key.

## Reserve before you call, commit only if you still own the lease

Every tool call goes through three phases, and the external call is the *only* step that isn't inside a transaction:

1. **TX1 — Reserve.** Inside a Postgres transaction, we check that this worker still holds the active lease (its fencing token matches the row in `execution_leases`), then insert a `RESERVED` row for `(execution_id, step_seq)` with the idempotency key and args hash. If a `SUCCEEDED` row already exists, we return its cached output and never call Stripe at all.

2. **The external call.** We invoke the tool, passing the idempotency key down as `Idempotency-Key`. This is the one un-transactional step.

3. **TX2 — Commit, fenced.** Before recording the outcome, we re-read the lease *inside the same transaction* as the write. If our fencing token no longer matches — meaning a standby worker took over while our call was in flight — we abort and drop our result on the floor. We do **not** mark the step succeeded.

That last point is the whole game. A stale worker physically cannot write "succeeded" for a step, because the success write and the ownership check are the same atomic operation.

## What happens when it actually crashes

The protocol is defined by its crash cases, not its happy path:

- **Stripe returned 200, then the commit transaction failed (DB blip).** The row stays `RESERVED`. The lease eventually expires. A new owner retries with the *same* idempotency key — Stripe returns the cached refund, no second charge — and commits `SUCCEEDED`.
- **The process dies between Stripe returning and the commit.** Identical to the above. The `RESERVED` row plus the deterministic key *is* the recovery anchor.
- **The lease expires *during* a long Stripe call.** The original worker (token `N`) finishes, opens its commit transaction, and finds the lease now at `N+1`. Mismatch → it aborts. The new owner sees `RESERVED`, retries with the same key, Stripe dedupes.
- **Two workers race to retry.** Only one holds the active lease — Postgres row-locks `execution_leases`. The other is rejected before it can touch the external world.

In every branch, Stripe is called at most once *non-deduplicated*. That's the invariant we test under randomized crash schedules, not just assert in a comment.

## The honest part: we can't save you from a lying tool

This is in our SDK docs, not buried:

- A tool that *claims* it's idempotent but secretly mutates state under retries is a bug we can't catch.
- Stripe's idempotency-key cache has a 24h TTL. Replays beyond that window can re-charge — so the runtime exposes a `replayDeadline` per execution and refuses to replay payment-touching steps after it elapses.
- This is single-Postgres fencing. Multi-region quorum is out of scope for V1.

We'd rather tell you the edges than oversell the guarantee. Every external tool you register declares its idempotency grade — key-aware, safe-to-retry, or fence-only — and the fence-only grade shows up in the dashboard with a yellow shield, because the honesty is a feature.

## See it

In the 2:30 demo, I run an agent, kill the worker mid-refund, and watch a standby hydrate from the last checkpoint, *skip* the already-completed Stripe call (fenced), and finish the ledger write. The customer is charged once. → **<DEMO_URL>**

## Try it

One Node process + Postgres, no Redis or k8s to get started:

```bash
npm install <PKG>
```

Create an agent, run a task that touches money, kill it mid-flight, and replay it. Deploy your own: **<DEPLOY_URL>**.

I'm pre-customers and looking for teams running agents that touch money or infra. If that's you — or you think this is overkill because your idempotency keys already handle it — I want to hear it.
