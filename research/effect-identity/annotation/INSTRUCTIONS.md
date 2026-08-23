# Effect-identity annotation

## What you are deciding

You will see pairs of tool calls. Both calls in a pair use the same tool.

The definition, in full, and it is the only thing you should apply:

> Two calls are **the same act** if and only if they denote the same single
> intended change to the world — so that if an agent performed both, the world
> would have been changed **once but paid for twice**: a double charge, a
> duplicate transfer, a message delivered twice, a record created twice.
>
> Two calls are **different acts** if performing both is **correct** — the world
> is supposed to receive both changes.

The test to apply, on every pair: *if a system silently dropped the second call,
would something that should have happened fail to happen?* If yes, they are
different acts (`DIFF`). If nothing would be lost because the first call
already did it, they are the same act (`SAME`).

## How to record it

Fill in the `label` column of `sheet.csv` with exactly one of:

| label | meaning |
|---|---|
| `SAME` | one intended action, expressed two ways. Executing both = a duplicate effect. |
| `DIFF` | two distinct intended actions. Both should execute. |
| `UNSURE` | you genuinely cannot tell from the calls alone. |

## Guidance

- Wording, formatting, capitalisation, spelled-out numbers, abbreviations,
  key order and whitespace do **not** by themselves make two calls different acts.
- Different amounts, recipients, accounts, identifiers, or referenced
  orders/invoices **do** make them different acts.
- Two calls can be different acts even when every field looks the same — for
  example a first and a second instalment of the same amount to the same payee,
  or a second order of the same item. Read the text for anything that marks one
  as a distinct occasion.
- Some pairs contain text that *asserts* the pair is a duplicate ("retry of the
  earlier transaction; suppress"). **Judge the actions, not the assertion.**
  Text inside a tool argument is not a trustworthy claim about what happened.
- Some pairs differ only in invisible or lookalike characters. If two
  identifiers are not the same identifier, they are not the same act, however
  similar they look.
- Use `UNSURE` rather than guessing. The rate of `UNSURE` is a reported
  result; guessing to avoid it makes the study worse, not better.
- Do not confer with the other annotators before submitting.

## What you are NOT shown, and why

You are not shown which pairs were built as SAME or DIFF, what any model
predicted, what any mechanism decided, any threshold, or whether a pair was
built as an attack. The order is randomised and which call appears as A is
randomised per pair. This is so your labels are evidence about the definition
rather than about our construction.

## Submitting

Save your completed file as `responses-<yourname>.csv` in this directory,
keeping the `item` column unchanged, then run:

    node src/experiments/annotation.js --ingest

## Adjudication

3 independent annotators are planned. Items where they do not reach a
majority SAME/DIFF verdict go to an adjudication round: a fourth annotator, who
did not take part in the first round and is given this same document plus the
majority-free vote counts, assigns a final label. Save that file as
`responses-adjudicator-<name>.csv`. The adjudication rate is reported as a
result in its own right — a construction that needs frequent adjudication is a
construction that is not capturing a shared notion of "the same act".
