# Experiment 3: realistic payment schemas (offline)

Preregistration: `PREREG_EXP3.md` (commit 9561e9b, made before any number below
was computed). Regenerate with `node src/experiments/paymentSchemas.js`, which
writes `results/exp3_payment_schemas.json`. No model calls. A0 check: R0
reproduces the published primary residual wrong suppression (4/144).

**All headline numbers come from variant P, the label-free parser.** It derives
the typed fields from the free text without seeing labels or scores. Variant A
(act-typed) uses the SAME label. It appears only in the appendix section below,
as an upper bound on deduplication.

## Headline: `wire_money`, variant P, test split

Primary judge, GPT-OSS-120B:

| Rung | test DIFF in residual | own cal pool n | m* | own-pool dedup | pooled dedup | silent escape (pooled) | WS (wire) | D4b injection success |
|---|---|---|---|---|---|---|---|---|
| R0 published (all text) | 26/26 (100%) | 29 | 1 | 66/67 | 66/67 | 1/67 | 0/26 | 5/5 |
| R1 amount + currency + payee | 22/26 (84.6%) | 25 | 1 | 57/67 | 54/67 | 10/67 | 0/26 | 5/5 |
| R2 R1 + structured remittance | 3/26 (11.5%) | 0 | 0 | 32/67 | 53/67 | 11/67 | 0/26 | 0/5 |

All three judges:

| Judge | Rung | pooled t_hi | WS (all tools) | dedup (all tools) | wire own-pool dedup | wire pooled dedup | D4b success |
|---|---|---|---|---|---|---|---|
| GPT-OSS-120B | R0 | 0.80 | 4/232 | 266/281 (94.7%) | 66/67 | 66/67 | 5/5 |
| | R1 | 0.85 | 2/232 | 237/281 (84.3%) | 57/67 | 54/67 | 5/5 |
| | R2 | 0.85 | 2/232 | 236/281 (84.0%) | 32/67 | 53/67 | 0/5 |
| GPT-OSS-20B | R0 | 0.95 | 3/232 | 232/281 (82.6%) | 63/67 | 53/67 | 3/5 |
| | R1 | 0.95 | 3/232 | 232/281 (82.6%) | 56/67 | 53/67 | 3/5 |
| | R2 | 0.95 | 3/232 | 231/281 (82.2%) | 32/67 | 52/67 | 0/5 |
| Qwen3.6-27B | R0 | 0.95 | 2/232 | 250/281 (89.0%) | 62/67 | 62/67 | 1/5 |
| | R1 | 0.95 | 2/232 | 243/281 (86.5%) | 55/67 | 55/67 | 1/5 |
| | R2 | 0.95 | 2/232 | 242/281 (86.1%) | 32/67 | 54/67 | 0/5 |

The residual shares and the pool sizes (29, 25, 0) do not depend on the judge.

## Predictions

| | Prediction | Outcome |
|---|---|---|
| P1 | R1 does not collapse the residual (D2 and D3 stay) | Confirmed: D2 14/14 and D3 3/3 stay residual; 4/9 D1 refuted |
| P2 | R2 refutes D2, D1 and D4b; D3 without digits stays | Confirmed: D2 14/14, D1 9/9 and D4b 5/5 refuted; D3 3/3 residual |
| P3 | R2 residual ≤ 20% of R0 | Confirmed: 11.5% vs 100% |
| P4 | R2 own pool < 19 (cannot be certified at m = 1) | Confirmed: n = 0 |
| P5 | Variants P and A share the pool and WS | Confirmed for all judges and rungs |

The first run reported P2 as not confirmed because of a reporting bug: the
attack row counted every tool's 25 D4b pairs instead of `wire_money`'s 5. The
fix changed only which pairs were counted. The criterion did not change.

## What it shows

1. **Typing amount and payee alone does not collapse the payment residual.**
   Legitimate repeats (same amount, payee and invoice, but a different
   instalment, line or cycle) live in the reference text. Only after the
   remittance is structured (R2) does the residual fall from 100% to 11.5% of
   distinct pairs. The three survivors are payment distinctions with no
   identifier: "phase one" vs "phase two", "trademark filing" vs "contract
   review", "March" vs "April delivery".
2. **The calibration budget goes with the residual.** `wire_money`'s own pool
   goes from 29 to 25 to 0. Under R2 the tool cannot certify its own judge.
   With only its own pool, deduplication falls to what the certifier settles
   (32/67). The pooled deployment keeps 53/67 by borrowing other tools' pools.
3. **The R2 refuter closes the text-injection attack.** Success falls from
   5/5 to 0/5 on the primary judge, and to 0/5 on every judge.
4. **Pooled calibration couples tools.** Re-declaring `wire_money` removed easy,
   low-scoring distinct pairs from the shared pool (pool 142 → 138 → 113). That
   raised the primary judge's pooled threshold from 0.80 to 0.85, which halved
   wrong suppression on all tools (4 → 2 of 232). Of the 29 duplicates the
   primary configuration stops recovering at R1, 17 are on *other* tools and
   come from the threshold shift alone. The remaining 12 are on `wire_money`,
   mostly parser escapes (point 6). The residual that survives refinement
   scores higher, which is the refinement dilemma. The 20B and Qwen thresholds
   were already 0.95 and did not move.
5. **The judge was not failing on payments.** Wrong suppression on `wire_money`
   is 0/26 at every rung for all three judges. Typing removes the need for the
   judge rather than fixing its errors.
6. **The parser's cost is escapes, never suppressions.** The label-free parser
   refutes 14 (R1) and 17 (R2) duplicate pairs across splits: number words in
   references, a missing currency token, and paraphrased payees it cannot
   resolve. The ids are listed in the JSON. Every one is a duplicate escape,
   because the refuter can only execute.

## Appendix: variant A (act-typed), upper bound on deduplication

Variant A gives each duplicate the typed fields of the act it repeats. It
models a caller that fills typed fields correctly, and **uses the SAME label**,
so it is an upper bound and not a decision rule. Distinct pairs are identical
in both variants, so the pool, threshold and wrong suppression are unchanged
(P5).

| Judge | Rung | dedup (all tools) | wire own-pool dedup | wire pooled dedup | wire silent escape |
|---|---|---|---|---|---|
| GPT-OSS-120B | R1 | 245/281 (87.2%) | 66/67 | 62/67 | 1/67 |
| | R2 | 245/281 (87.2%) | 33/67 | 62/67 | 1/67 |
| GPT-OSS-20B | R1 | 239/281 (85.1%) | 64/67 | 60/67 | 3/67 |
| | R2 | 239/281 (85.1%) | 33/67 | 60/67 | 3/67 |
| Qwen3.6-27B | R1 | 252/281 (89.7%) | 64/67 | 64/67 | 3/67 |
| | R2 | 252/281 (89.7%) | 33/67 | 64/67 | 3/67 |

The gap between P and A on `wire_money` (for example 53/67 vs 62/67 pooled at
R2 on the primary judge) is the deduplication the parser loses to its own
escapes. Even the upper bound shows the main result: under R2 the tool's own
pool is empty, and own-pool deduplication is capped at about 49%.

## Limitations

- This re-analyses persisted scores that the author has seen in aggregate, so
  it is not blind.
- Pairs that still reach the judge keep scores computed on the free-text
  presentation. A judge shown typed inputs might score differently.
- The test split has n = 26 distinct `wire_money` pairs, so 0/26 bounds WS only
  at about 13% (Wilson).
