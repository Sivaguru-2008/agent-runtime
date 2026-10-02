# Experiment 3 — realistic payment schemas (offline)

Preregistration: `PREREG_EXP3.md` (commit 9561e9b, made before any number below
was computed). Regenerate with `node src/experiments/paymentSchemas.js` →
`results/exp3_payment_schemas.json`. No model calls. A0: R0 reproduces the
published primary residual wrong suppression (4/144).

## `wire_money`, primary judge (GPT-OSS-120B), test split

| Rung / variant | test DIFF in residual | own cal pool n | m* | own-pool dedup | pooled dedup | pooled WS (wire) | D4b injection success |
|---|---|---|---|---|---|---|---|
| R0 published (all text) | 26/26 (100%) | 29 | 1 | 66/67 | 66/67 | 0/26 | 5/5 |
| R1 amount+payee, act-typed | 22/26 (84.6%) | 25 | 1 | 66/67 | 62/67 | 0/26 | 5/5 |
| R2 + remittance, act-typed | 3/26 (11.5%) | 0 | 0 | 33/67 | 62/67 | 0/26 | 0/5 |
| R2 + remittance, parsed | 3/26 (11.5%) | 0 | 0 | 32/67 | 53/67 | 0/26 | 0/5 |

## Predictions

| | Prediction | Outcome |
|---|---|---|
| P1 | R1 does not collapse the residual (D2, D3 stay) | Confirmed: D2 14/14, D3 3/3 residual; 4/9 D1 refuted |
| P2 | R2 refutes D2, D1, D4b; digit-less D3 stays | Confirmed: D2 14/14, D1 9/9, D4b 5/5 refuted; D3 3/3 residual |
| P3 | R2 residual ≤ 20% of R0 | Confirmed: 11.5% vs 100% |
| P4 | R2 own pool < 19 (uncertifiable at m = 1) | Confirmed: n = 0 |
| P5 | Variants P and A share pool and WS | Confirmed for all judges and rungs |

The first run reported P2 as not confirmed because of a reporting bug: the
attack row counted every tool's 25 D4b pairs instead of `wire_money`'s 5. The
fix changed only which pairs are counted. The criterion is unchanged.

## What it shows

1. **Typing amount and payee alone does not collapse the payment residual.**
   Legitimate repeats (same amount, payee, and invoice, but a different
   instalment, line, or cycle) live in the reference text. Only after the
   remittance is structured (R2) does the residual fall from 100% to 11.5% of
   distinct pairs. The three survivors are payment distinctions with no
   identifier ("phase one" vs "phase two", "trademark filing" vs "contract
   review", "March" vs "April delivery").
2. **The calibration budget goes with the residual.** `wire_money`'s own pool
   goes 29 → 25 → 0. Under R2 the tool cannot certify its own judge. With only
   its own pool, deduplication falls to the certifier's share (about 49%). The
   pooled deployment keeps about 92% only by borrowing other tools' pools.
3. **The R2 refuter closes the text-injection attack**, 5/5 → 0/5. At R0 and R1
   all five succeed on the primary judge.
4. **Pooled calibration couples tools.** Re-declaring `wire_money` removed
   easy, low-scoring distinct pairs from the shared pool. That raised the
   primary judge's pooled threshold from 0.80 to 0.85, which halved pooled WS
   (4 → 2 of 232) and cut pooled deduplication (94.7% → 87.2%) on *other*
   tools. The residual that survives refinement scores higher (it is harder),
   which matches the refinement dilemma. The 20B and Qwen judges were already
   at 0.95 and did not move.
5. Wrong suppression on `wire_money` is 0/26 at every rung for all three
   judges. The judge was not failing on payments. Typing removes the need for
   it rather than fixing an error.

## Limitations

- This re-analyses persisted scores the author has already seen in aggregate,
  so it is not blind.
- Pairs that still reach the judge keep scores computed on the free-text
  presentation. A judge shown typed inputs might score differently.
- Variant A uses the SAME label. It bounds deduplication and is not a decision
  rule. Variant P (no labels) refutes 14 (R1) or 17 (R2) duplicates: number
  words, a missing currency token, and paraphrased payees. These are escapes,
  never suppressions. The ids are listed in the JSON.
- The test split has n = 26 distinct `wire_money` pairs, so 0/26 bounds WS only
  at about 13% (Wilson).
