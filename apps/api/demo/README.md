# Demos — the two clips you show, not tell

Two self-contained demos that run your **real** runtime code against a mocked
external world (no DB, no server, no API keys, nothing to charge). Each is built
to be recorded as a ~60-second clip and dropped into a DM or shown on a call the
moment a buyer describes the pain.

```bash
cd apps/api
npm run demo        # 1. duplicate-charge guardrail
npm run demo:loop   # 2. runaway-loop guardrail
npm run demo:all    # both, back to back (record this one)
```

---

## Clip 1 — `npm run demo` · the double charge

**The pain it answers:** *"our automated billing/refund flow charged a customer twice."*

**What it shows:** the same charge gets redelivered (crash + retry). Direct to
Stripe → customer billed twice ($1000). Through your `DedupingToolExecutor` →
the redelivered call returns the recorded result, Stripe is hit once ($500).

**Talk track (say while it runs):**
> "Same agent, same retry. Top half goes straight to the payment API and
> double-charges. Bottom half routes through us — we recognize the call already
> committed and hand back the recorded result instead of charging again. One
> wrapper. The customer is charged exactly once."

**Real vs mocked:** `DedupingToolExecutor`, `IdempotencyPolicyEnforcer`, and the
side-effect capability registry are your production code. The Stripe API is a
counter; the dedup store is in-memory (production is Postgres). Say that out loud —
it builds trust.

---

## Clip 2 — `npm run demo:loop` · the runaway loop

**The pain it answers:** *"an agent got stuck and we only noticed on the bill."*

**What it shows:** a refund agent whose gateway keeps timing out retries the
identical call and re-plans with the identical output at 2am. Without detection
it spins 60 turns until a human sees the cost spike. Your real
`ExecutionLoopDetector` trips on the same event stream at turn 3 and aborts —
saving the rest of the spend, automatically, with no one watching.

**Talk track:**
> "The agent is stuck — same failing call, same plan, over and over, re-sending
> its whole context to the model every turn. Nobody's awake. Our detector reads
> the live event stream, recognizes the loop in three turns, and kills it. It
> fires the same way on every execution in your fleet."

**Real vs mocked:** `ExecutionLoopDetector` and the `FailureSignal` it emits are
your production analyzer. The agent run is a synthetic event stream. Token→$ is a
stated, directional rate (`USD_PER_1K_TOKENS` in the file), not a guarantee — say
"directional" if asked.

---

## How to use these

1. **Record `npm run demo:all` once** as a screen capture. That single clip covers
   both pains. Trim to the two "WITHOUT vs WITH" reveals.
2. **Don't pitch — react.** When someone says "we had a duplicate charge" or "an
   agent ran away," send the relevant clip. The output *is* the argument.
3. **Don't expand these into a product.** They're closers, not a platform. The
   next thing to build is decided by what a real buyer asks for after they see one
   of these — not before.

## Verification

Both demos run clean and typecheck under the project's compiler options
(`target ES2022`, `NodeNext`, `strict`). To re-verify a demo file in isolation:

```bash
npx tsc --noEmit --target ES2022 --lib ES2022 --module NodeNext \
  --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck \
  --types node demo/double-charge.ts
```
