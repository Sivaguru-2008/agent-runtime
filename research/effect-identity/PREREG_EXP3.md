# Preregistration: Experiment 3 (Realistic Payment Schemas, Offline)

**Date:** 2026-10-02
**Status:** Committed before any Experiment 3 number is computed. The typing
procedure (`src/corpus/paymentTyping.js`) and its unit tests are committed in
the same commit; the analysis script is written afterwards and may not change
the typing procedure.
**Author:** The Author (TMLR double-blind submission)

---

## 0. What this experiment is, and what it is not

This is a **re-analysis of persisted data**, not a fresh test. It reads
`corpus/pairs.jsonl` (1,066 pairs) and `corpus/scores.jsonl` and makes **no
model calls**. The author has previously seen aggregate results on these scores
(the headline rows, the tightened-projection rows, the schema ladder), so the
analysis is not blind. What this document fixes in advance is (i) the schema
declarations, (ii) the typing procedure, (iii) the metrics, and (iv) the
predictions. To write the typing procedure the author inspected the *inputs* of
the `wire_money` pairs (field values, not judge scores); that inspection is
disclosed here.

Relation to existing evidence:
- `transfer_funds` is **already typed** in the corpus (`from_account`,
  `to_account` as `ID`; `amount` as `NUM`; `currency` as `CI`; `note` as
  `TEXT`). It is reported unchanged as the "already typed" payment reference
  point. No re-declaration is needed or made.
- The schema ladder (`src/corpus/schemaLevels.js`, `results/schema_ladder.json`)
  already measures typing on a **separate, purpose-built** payment corpus. This
  experiment measures typing on the **main corpus's** `wire_money` tool, so the
  headline per-tool numbers and the typed-payment numbers come from one corpus
  and can share one figure. It is complementary, not new in kind.
- The tightened projection (numbers lifted out of prose into σ) is a generic,
  tool-agnostic stand-in. This experiment uses explicit, payment-specific
  declarations instead.

## 1. Question

When the loosely declared payment tool `wire_money` is re-declared with the
fields a real payment API carries, how much of its residual (the pairs that
neither the certifier nor the refuter settles and that therefore need the
judge) survives, and what happens to the calibration pool that the judge is
certified on?

## 2. Schema rungs for `wire_money`

| Rung | Declared fields (policy) | In σ |
|---|---|---|
| R0 (published) | `amount_text` TEXT, `beneficiary_text` TEXT, `reference` TEXT | nothing |
| R1 typed amount + payee | `amount` NUM, `currency` CI, `beneficiary_id` ID, `reference` TEXT | amount, currency, beneficiary_id |
| R2 R1 + structured remittance | R1 + `document_ref` ID, `schedule_line` CI | R1 + document_ref, schedule_line |

R1 is the "typed amount and beneficiary" declaration. R2 adds structured
remittance information of the kind ISO 20022 `RmtInf/Strd` carries (a referred
document number) plus a payment-schedule line designator, as accounts-payable
systems commonly do. `reference` stays as free text at every rung: the agent
still sends a memo.

## 3. Typing procedure (fixed; `src/corpus/paymentTyping.js`)

Typed values are derived from each free-text input by a deterministic parser
(**variant P**) that never sees labels or scores:

- `amount`: `extractNumbers(amount_text)` (the existing extractor in
  `src/judge.js`, unchanged). Exactly one distinct number → that number;
  otherwise `null`.
- `currency`: `USD` if the text contains `$`, `usd`, `dollar`, `bucks`, or
  `us dollars`; otherwise `null`.
- `beneficiary_id`: lowercase; `&` → `and`; strip punctuation; drop the filler
  words {payment, payments, funds, to, for, company, transfer} and the legal
  suffixes {llc, ltd, limited, inc, co, corp, corporation, group, plc}; sort the
  remaining tokens. If the key equals the key of a registered payee (the payee
  registry is the set of beneficiaries of the `a` inputs, which models a saved-
  payee list), the payee's registry id; otherwise `unresolved:<key>`.
- `document_ref` (R2): split `reference` on " — "; in the head, take the
  whitespace tokens that contain a digit, strip surrounding punctuation other
  than `-`, uppercase, sort, join with a space. No such token → `null`.
- `schedule_line` (R2): the text after the first " — " (whitespace-collapsed,
  lower-cased); none → `null`.

`null` compares equal only to `null`. Parser errors therefore act in one
direction only: a parse that differs across a duplicate pair makes the refuter
EXECUTE (a duplicate escape); a parse that collapses two distinct values leaves
the pair in the residual for the judge, exactly as at R0. The refuter can never
cause a suppression.

**Variant A (act-typed)** models a caller that fills typed fields correctly for
the act it performs (the realistic case: a typed API cannot be sent "one
thousand two hundred dollars"). Typed fields of every `a` input and of the `b`
input of every DIFF pair come from variant P (these are template-format
inputs). For SAME pairs, typed(b) := typed(a). **This uses the SAME label**, and
is disclosed as such: it is the upper bound on deduplication, not a decision
rule. DIFF projections are identical in P and A by construction, so the
calibration pool and wrong suppression are predicted identical across variants
(checked as an assertion, §5).

Scores: every pair that reaches the judge keeps its **persisted** score, which
was computed on the free-text presentation. A judge shown typed inputs might
score differently; that is a limitation of the no-new-calls design and is
reported.

## 4. Configuration and metrics

- Corpus: `corpus/pairs.jsonl`; scores: `corpus/scores.jsonl`.
- Judges: `openai_gpt_oss_120b` (primary), `openai_gpt_oss_20b`,
  `qwen_qwen3_6_27b`.
- Decision rule: the deployed configuration (`DEFAULT_CONFIG` in
  `src/evaluate.js`: certifier, refuter, calibrated judge, escalation band,
  m = 1), α = 0.05, γ = 0.05. Only `wire_money`'s declaration changes; the other
  five tools keep their published declarations.
- A0 check: R0 must reproduce the published primary-judge residual wrong
  suppression (4 of 144). If it does not, the analysis stops.

Reported for each rung × variant × judge:
1. Per tool: share of cal and test DIFF pairs in the residual; share of test
   SAME pairs in the residual; certifier / refuter / judge jurisdiction split.
2. Per tool: tool-conditional calibration pool size n, certifiable
   m* = ⌊α(n+1)⌋, the tool-conditional threshold, and tool-conditional WS and
   deduplication on that tool's test pairs.
3. Pooled (deployed) calibration: pool size, threshold, whole-split and
   residual WS, deduplication, overall and for `wire_money`.
4. The `wire_money` D4b text-injection attack row (failure rate, stopped-by).
5. Per-category decisions for `wire_money` test pairs (D1, D2, D3; S1–S4).
6. Parser audit: every SAME pair the P variant refutes, listed by id.

## 5. Predictions (written before computing)

- **P1.** R1 does not collapse the `wire_money` residual: D2 legitimate repeats
  (same amount, payee, and invoice; different instalment/line/cycle), D3
  semantic differences, and D1 near misses that differ only in the reference
  stay in the residual. Only D1 amount near misses move to the refuter.
- **P2.** R2 moves D2 repeats, reference-number D1 near misses, and all five D4b
  injection attacks to the refuter. D3 pairs whose distinguishing content has no
  digits (for example "phase one" vs "phase two", "trademark filing" vs
  "contract review", "March delivery" vs "April delivery") stay in the residual:
  some payment distinctions are prose even under a structured schema.
- **P3 (primary hypothesis).** Under R2, the `wire_money` residual share of test
  DIFF pairs is at most 20% of its R0 value.
- **P4.** The tool-conditional `wire_money` calibration pool shrinks with the
  residual; under R2 it falls below 19 residual DIFF pairs, so tool-conditional
  calibration at α = 0.05 is uncertifiable even at m = 1 and the judge must be
  switched off or pooled — the refinement dilemma on the main corpus.
- **P5.** Variant A and variant P have identical calibration pools and identical
  WS (assertion); A has deduplication at least as high as P.
- No directional prediction is made for pooled WS or deduplication.

Every prediction is reported as confirmed or not, whichever way it comes out.

## 6. Outputs

- `results/exp3_payment_schemas.json` (all numbers above).
- `node src/experiments/paymentSchemas.js` regenerates it; no network access.
