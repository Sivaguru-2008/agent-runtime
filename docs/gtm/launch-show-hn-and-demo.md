# Launch Kit — Show HN + Demo Post

> Ship this *after* P0 (deployed URL + published SDK + working signup). A launch with no front door wastes the one-time attention spike. Lead with the demo video everywhere.

---

## 1. Show HN post

**Title** (HN rewards plain, specific, no hype):

```
Show HN: A durable runtime that stops AI agents from double-charging Stripe
```

Alternatives:
- `Show HN: Deterministic replay and SQL-level fencing for AI agents`
- `Show HN: We make it safe for AI agents to touch money in production`

**Body:**

```
Hi HN — I built a reliability runtime for AI agents that take real-world
actions (refunds, ledger writes, infra changes).

The problem: when an agent calls Stripe and then the next step fails — DB
timeout, crash, lost network — most setups either lose the agent's state or
naively retry the whole plan and call Stripe a second time. That's a real
double refund and corrupted state.

The runtime fixes this with three things:
- Event sourcing: every execution step is an append-only event, so state is
  rebuildable, not a mutable row that races.
- SQL-level fencing: side effects are guarded by a per-step idempotency key
  inside the same transaction that validates a lease/fence token. A stale
  worker physically cannot re-run a completed Stripe call.
- Deterministic replay: rewind any failed execution from any point. A
  chain-hash divergence detector makes replays verifiable, not best-effort.

You can run an agent, kill it mid-execution, and watch a standby worker
hydrate from the last checkpoint, skip the already-completed refund (fenced),
and finish the ledger write — no double charge.

It's a single Node process + Postgres (no Redis/k8s to try it). There's a TS
SDK: `npm install <pkg>`, create an agent, run a task, inspect/replay in the UI.

Demo (2:30, the failure→recovery flow): <link>
Try it / deploy your own: <link>
Docs on the fencing + replay guarantees: <link>

I'm pre-customers and looking for teams running agents that touch money or
infra. Brutal feedback very welcome — especially "this is overkill because X"
or "Temporal already does this for me because Y". What would make you actually
adopt this?
```

**Why this framing works on HN:**
- Concrete failure ("double-charge Stripe") not abstract ("reliability").
- Names the honest competitor (Temporal) and invites the strongest objection — HN rewards that, and it surfaces your real positioning gaps for free.
- Low-friction try path (one process + Postgres, SDK install).
- Asks a real question instead of pitching.

**Launch hygiene:** Post Tue–Thu ~8–10am ET. Be at the keyboard for the first 3 hours to answer *every* comment within minutes. Do not get defensive on "Temporal does this" — answer with the specific AI-agent delta (dynamic LLM-planned steps + replay diffing + side-effect fencing).

---

## 2. X / Twitter thread

```
1/ Your AI agent issues a $150 Stripe refund. The next step — logging it to
your DB — times out. Your retry logic kicks in.

You just refunded the customer twice.

This is the silent failure mode of agents in production. Here's how we kill it 🧵

2/ The root cause: LLM agents plan steps dynamically. A naive retry re-runs the
*plan*, not just the failed step. Every external call (Stripe, ledgers, infra)
gets repeated. Money moves twice. State corrupts.

3/ Fix #1 — Event sourcing. Every step is an append-only event. We don't store
"agent state" as a mutable row that races under recovery. We replay the event
log to reconstruct exact state at any millisecond.

4/ Fix #2 — SQL-level fencing. Each side effect reserves an idempotency key in
the SAME transaction that validates the worker's fence token. A stale/zombie
worker that wakes up late is rejected at the database. No split-brain. No double
write.

5/ Fix #3 — Deterministic replay. Rewind any failed run from any point. A
chain-hash divergence detector makes the replay verifiable — you can prove no
external call was duplicated.

6/ The demo: I run an agent, kill the worker mid-execution, and a standby
hydrates from the last checkpoint, SKIPS the already-done refund (fenced 🔒),
and finishes the ledger write. Customer charged once. [video]

7/ It's one Node process + Postgres to try (no Redis/k8s). TS SDK:
npm install <pkg> → create agent → run → replay in the UI. Deploy your own: <link>

8/ I'm pre-customers, looking for teams running agents that touch money or infra.
If that's you (or you think this is overkill) — I want to talk. Reply or DM.
```

---

## 3. LinkedIn / founder post (shorter, ICP-targeted)

```
If you're putting AI agents into production workflows that touch money or
infrastructure, you've probably hit (or you're about to hit) this: an agent
completes a real action — a refund, a payment, a provisioning call — and then a
later step fails. Your retry re-runs the plan and repeats the real action.

I spent the last while building a runtime that makes this structurally
impossible: event-sourced execution, SQL-level fencing of side effects, and
deterministic replay of any failure.

I'm now looking for 5 design partners running money/infra-touching agents.
30 minutes of your real failure stories in exchange for early access and
hands-on help. Comment or DM.
```

---

## 4. Distribution checklist (launch day)
- [ ] Demo video uploaded (YouTube unlisted + direct mp4 fallback).
- [ ] Landing page live with video + "Deploy your first agent" CTA.
- [ ] SDK published and `npm install` verified from a clean machine.
- [ ] Deployed API URL healthy; signup invite codes ready to hand out.
- [ ] Show HN posted; founder online for 3h of replies.
- [ ] X thread + LinkedIn post cross-posted (stagger ~2h after HN).
- [ ] 3 relevant subreddits / Discords / Slacks identified for soft shares (r/LocalLLaMA, agent-builder communities) — share the demo, not a pitch.
- [ ] Funnel analytics confirmed recording signups + source/UTM.

## 5. What to measure
- Unique visitors → signups (activation rate) via the funnel you shipped.
- Signups → first agent run (the real activation event).
- Inbound conversations booked (the only metric that matters this week).
- Top 3 objections heard, verbatim — these rewrite your positioning.
