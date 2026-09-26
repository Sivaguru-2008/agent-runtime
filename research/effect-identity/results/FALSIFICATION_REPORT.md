# Falsification Report: Semantic Effect Identity

Generated: 2026-08-28  
Method: offline reanalysis of the shipped 955-pair corpus and 3-judge scores  
No new model calls; all experiments are deterministic recomputations.

---

## Hypotheses tested

### H1: Is conformal calibration practically necessary at m=1?

**Claim under test.** The conformal calibration layer provides genuine safety
value — a threshold that a practitioner could not achieve by simpler means.

**Experiment.** Threshold sweep over τ ∈ [0.00, 1.00] at 0.01 resolution on the
jurisdiction-matched residual test split, for all three admitted judges.
Bootstrap stability analysis (500 resamples) comparing conformal vs
cross-validated fixed thresholds on α-exceedance rate.

**Results.**

| Judge | AUC-ROC | Safe τ region | Conformal τ | Conformal dedup | Best safe fixed dedup |
|---|---|---|---|---|---|
| GPT-OSS-120B | 0.995 | [0.20, 1.0] — 80% | 0.80 | 93.9% | 100.0% (τ=0.20) |
| GPT-OSS-20B | 0.971 | [0.10, 1.0] — 90% | 0.95 | 80.2% | 97.2% (τ=0.10) |
| Qwen3.6-27B | 0.991 | [0.05, 1.0] — 95% | 0.95 | 90.0% | 100.0% (τ=0.05) |

Bootstrap α-exceedance (500 resamples, residual pool):
- Conformal: 29.2% of draws exceed α=0.05 (mean WS=3.81%, p95=8.28%)
- CV-fixed: 39.6% of draws exceed α=0.05 (mean WS=4.48%, p95=8.90%)

**Finding.** All three judges separate SAME/DIFF so well (AUC > 0.97) that
80–95% of the threshold space achieves WS ≤ α on the test set. The conformal
threshold lands deep inside this safe region, systematically sacrificing
6–20 points of dedup relative to the best safe fixed threshold. Conformal
does outperform CV-fixed on α-exceedance rate (29.2% vs 39.6%), confirming
its theoretical edge — but neither achieves the nominal ≤5% because the
guarantee is marginal over single test points, not over realized rates on
test splits.

**Verdict.** H1 is **partially falsified**. The conformal guarantee is real but
its practical value at m=1 on these judges is modest: any fixed threshold
above ~0.2 achieves comparable safety. The contribution of calibration is
primarily theoretical (distribution-free finite-sample guarantee +
multiplicity correction at m>1), not practical on well-separating judges.

**Competing explanation supported.** The judges are excellent enough that
calibration is redundant for m=1 deployment. The calibration machinery
becomes essential only when: (a) the judge separates less well, or (b) m>1
and the Bonferroni correction matters.

---

### H2: Does the residual genuinely predict where errors concentrate?

**Claim under test.** Errors concentrate in the residual because the residual
is inherently harder, not just because it is defined as "what decidable
layers don't cover."

**Experiment.** Classified every error on the test set by whether it falls
inside or outside the residual, across all three judges. Checked decidable
layer soundness. Computed per-category error rates for residual vs decided
pairs.

**Results.**

| Judge | Total errors | In residual | Outside residual |
|---|---|---|---|
| GPT-OSS-120B | 4 (all WS) | 4 (100%) | 0 |
| GPT-OSS-20B | 9 (3 WS + 6 SE) | 9 (100%) | 0 |
| Qwen3.6-27B | 2 (all WS) | 2 (100%) | 0 |

Decidable layer soundness:
- L0 wrong suppressions (DIFF with l0Equal): **0**
- Witness wrong executions (SAME with !semEqual): **0**

DIFF_residual error rate: 2.8% (4/144)  
DIFF_decided error rate: 0.0% (0/88) — by construction  

Per-category residual error rates:
- D3_semantic_diff: 6.7% (highest — semantically distinct but share declared fields)
- D1_near_miss: 2.6%
- D2_legit_repeat: 1.3%

**Finding.** Error concentration in the residual is **real** but **partially
tautological**. The decidable layers are sound (A5/A5' hold on this corpus),
so errors literally cannot occur outside the residual — saying they
"concentrate" there is a consequence of the design, not an empirical
discovery. The non-trivial content is that error *rates vary within* the
residual by category: D3 is hardest (6.7%), while S2/S3/S4 are easiest
(0.0%). The blinded panel's finding (13/14 disagreements in the residual,
§8.16) adds genuinely independent evidence.

**Verdict.** H2 **survives** falsification. The concentration is real. The
non-tautological contribution is T6's implication that *only schema changes
can reduce the residual* — which is substantive because it tells
practitioners where to invest.

---

### H3: Do schema interventions genuinely dominate oracle interventions?

**Claim under test.** "Oracle quality trades one error direction against the
other; schema quality removes both." (Abstract, §9.1, §13 conclusion.)
Specifically: "the single schema change improved all of them at once."

**Experiment.** Computed WS, dedup, silent escape, flagged escape, and
friction for schema interventions (none→declared→tight) and oracle
interventions (three judges, four fixed thresholds, lexical scorer), all on
the same test split.

**Results.**

Schema interventions (all full five-metric comparison):

| Witness | WS | Dedup | Silent esc | Flagged esc | Friction |
|---|---|---|---|---|---|
| none | 3.4% | 100.0% | 0.0% | 0.0% | 95.3% |
| declared | 1.7% | 94.7% | 0.0% | 5.3% | 59.1% |
| tight | 0.0% | 69.0% | 0.0% | 31.0% | 23.7% |

Declared → Tight transition:
- WS: 1.7% → 0.0% **IMPROVED**
- Dedup: 94.7% → 69.0% **WORSENED**
- Silent escape: 0.0% → 0.0% SAME
- Flagged escape: 5.3% → 31.0% **WORSENED**
- Friction: 59.1% → 23.7% **IMPROVED**

2 improved, 2 worsened, 1 unchanged. **Not "all of them at once."**

Oracle interventions (against declared-witness baseline):
- Every oracle change ALSO trades: improving WS worsens dedup and vice versa.
- No oracle change dominates (improves both WS and dedup).
- No schema change dominates either.

**Finding.** The paper's claim that "the single schema change improved all of
them at once" is **contradicted by the data**. Schema changes trade WS/friction
against dedup/flagged-escape, just as oracle changes trade WS against dedup.
The paper's theory section (T6.3') correctly states this: "Refinement
strictly dominates on the decided fragment and strictly degrades the
undecided one." The overclaim is in the abstract, §9.1, and conclusion.

The schema change's unique contribution is that it closes adversarial
vulnerability (D4a) **by construction** — this is genuinely valuable and
not replicated by any oracle change. But this is a different claim from
"removes both error directions."

A defensible restatement: schema changes improve the two safety-critical
metrics (wrong suppression and silent escape) while worsening the
recoverable ones (dedup, flagged escape). This preserves the safety
asymmetry the paper is built on, without overstating.

**Verdict.** H3 is **falsified as stated**. The "dominance" framing in the
abstract and conclusion is an overstatement. The corrected claim — that
schema changes improve safety-critical metrics while oracle changes trade
them — is supportable and still valuable.

---

## Theorem counterexample attempts

### T1 (At-most-once commitment)

**Attack:** Relax A7 (serialization) — two concurrent executions miss L0 simultaneously.  
**Outcome:** Paper already acknowledges this in §6.4 Remark: COMMIT_CONFLICT is recorded but the
effect fires twice. No *new* counterexample found within the stated assumptions. T1 is valid under A1–A4+A7.

### T2 (L0 soundness)

**Attack:** Find an L0 suppression that wrongly suppresses a distinct pair.  
**Outcome:** 0 L0 wrong-suppressions on 206 held-out distinct test pairs (95% upper bound 1.8%).
A5 holds empirically on this corpus. T2 survives.

### T3 (Conformal wrong-suppression bound)

**Attack:** Violate A6 (exchangeability) by drawing calibration and test from different distributions.

Three attacks succeed:

| Attack | Cal pool | Test pool | WS | Exceeds α? |
|---|---|---|---:|---:|
| Cross-tool | charge_card (n=38, τ=0.2) | all others (n=91) | 6.6% | YES |
| Cross-category | D1_near_miss (n=37, τ=0.8) | D3_semantic_diff (n=30) | 6.7% | YES |
| Temporal (easy→hard) | easy scores (n=142, τ=0.8) | hardest-half DIFF (n=72) | 5.6% | YES |

**Verdict.** T3 is **mathematically valid** under A6. The counterexamples confirm that A6 *must*
be enforced in practice — jurisdiction-matched calibration is not optional. A practitioner who
calibrates on the wrong tool (charge_card's easy distinct pairs) or wrong category (near-miss
vs semantic-diff) breaks the guarantee. The paper's §6.6 discusses this; these experiments
quantify exactly how much damage mismatched calibration does.

### T4 (Impossibility of simultaneous zero error)

**Attack:** Check whether overlap actually exists on each tool, or only in aggregate.

Aggregate: overlap confirmed. Max DIFF score = 0.90, min SAME score = 0.40. 6 DIFF pairs
in SAME territory (4.2%), 87 SAME pairs in DIFF territory (35.2%). Best single threshold
τ=0.30 gives WS=4.2% and escape=0.0% — cannot zero both.

Per-tool: **4 of 6 tools have clean separation gaps:**

| Tool | Gap | T4 applies? |
|---|---|---|
| wire_money | [0.10, 0.75] | NO |
| charge_card | [0.30, 0.40] | NO |
| send_email | [0.15, 0.60] | NO |
| create_ticket | [0.10, 0.80] | NO |
| post_refund | overlap | YES |
| transfer_funds | overlap | YES |

**Verdict.** T4 is **mathematically airtight** but **empirically relevant for only 2 of 6 tools**.
The layered architecture (decidable + calibrated) is necessary for post_refund and transfer_funds;
for the other 4 tools, a single well-chosen threshold suffices. This does not invalidate T4
(which is a population-level statement about overlapping distributions) but significantly narrows
its practical import on this corpus.

### T5 (External exactly-once by composition)

**Attack:** Check whether any tool's semantic projection σ_t is complete for effect identity.

| Tool | DIFF pairs with semEqual=true | σ_t complete? |
|---|---:|---|
| charge_card | 101 | NO |
| wire_money | 60 | NO |
| post_refund | 53 | NO |
| transfer_funds | 53 | NO |
| send_email | 26 | NO |
| create_ticket | 18 | NO |

All 150 D2 (legitimate repeat) pairs and all 25 D4b (text injection) pairs have semEqual=true —
both categories represent distinct acts with identical declared fields.

**Verdict.** T5 Case A (complete projection → external exactly-once) **cannot apply to any tool
in this corpus**. Every tool has distinct acts that share a semantic projection. T5 Case B
(window stays open for paraphrased retries) is the only applicable result. This is a genuine
limitation: the irreducible window of §6.4 remains open for all 6 tools.

### T6 (Residual determination)

**Tautology test:** All 4 test-set errors (at conformal τ) fall in the residual; 0 errors in the
decided layer. This is **by construction** (decidable layers are sound under A5/A5', so errors
*cannot* occur outside the residual). T6 is definitionally true.

**Non-tautological content — T6.1 confirmed:** Different judges err on **completely different pairs**:
- 120B: D1_near_miss_228, D2_legit_repeat_440, D3_semantic_diff_g017, D3_semantic_diff_g042
- 20B: D2_legit_repeat_350, D2_legit_repeat_374, D2_legit_repeat_452
- 27B: D2_legit_repeat_363, D2_legit_repeat_411

Zero overlap in error sets across all three judges. Each judge redistributes error within
the residual to different pairs, exactly as T6.1 predicts.

**Verdict.** T6 is **definitionally true** and therefore unfalsifiable. Its value is in the
*consequences*: T6.1 (error redistribution, empirically confirmed) and T6.3' (refinement
dilemma, empirically confirmed in §8.9/§8.15). The prescriptive content ("schema-first,
model-second") is genuine.

### T7 (Composition structure)

T7 composes T1–T6. No independent counterexample is possible: if T1–T6 hold, T7 follows.
The most actionable finding from T7 is that (A) identity recognition is the only irreplaceable
guarantee, which is consistent with the T5 finding that no tool achieves Case A.

---

## Summary of corrections warranted

1. **Abstract and conclusion**: Replace "schema quality removes both" with a
   precise statement: schema quality improves the safety-critical direction
   (WS, silent escape) while trading the recoverable one (dedup → flagged
   escape). This preserves the asymmetry insight without overclaiming.

2. **§9.1**: Replace "the single schema change improved all of them at once"
   with the actual finding: the schema change improved WS and friction,
   worsened dedup and flagged escape, and left silent escape unchanged. Note
   that the worsened metrics are recoverable (flagged escape is observable),
   while the improved ones are safety-critical.

3. **§13 conclusion**: Same correction. Replace "improving all of them at
   once" with a precise statement.

4. **New section or note in §8**: Document the threshold sweep finding that
   80–95% of the threshold space is safe on all three judges. This is
   important context for how much practical work the calibration layer does
   at m=1. The theoretical value (finite-sample guarantee, multiplicity
   correction) should be distinguished from the practical outcome on
   well-separating judges.

5. **T6.2 (Corollary)**: Currently says "reducing wrong suppression, wrong
   execution, oracle cost and adversarial exposure simultaneously." If
   "wrong execution" means only silent escape, this is technically correct.
   But the phrase is easy to over-read as including dedup loss. Suggest
   adding a parenthetical clarifying that dedup (flagged escape) is the
   cost.

6. **T4 practical scope**: The paper presents T4 as the reason the layered
   architecture is necessary. In fact, 4 of 6 tools have clean score
   separation (no overlap) on the primary judge — T4 only bites on 2 tools.
   A note in §6.7 or §8 should state this finding: the layered architecture
   is necessary for the hardest tools, not universally.

7. **T5 Case A applicability**: No tool in the corpus satisfies Case A's
   completeness requirement. All 6 tools have DIFF pairs sharing a semantic
   projection (D2 and D4b categories). The paper's discussion in §6.8
   already handles this well, but the conclusion should not imply that
   Case A is readily achievable.

---

## Competing explanations for major findings

For each major finding, at least one alternative explanation that, if true, would
reduce or eliminate the finding's significance.

### F1: 94.0% dedup at 1.0% WS

**Paper's explanation:** The layered architecture (certifier + refuter + calibrated judge)
correctly decomposes the problem, achieving high dedup with bounded safety error.

**Competing:** The corpus is too easy. 80–95% of the threshold space achieves WS ≤ α
(§8.17), so almost any reasonable threshold would work. The 94.0% reflects the judge's
intrinsic quality, not the architecture. A simpler system — raw judge score with a
hand-tuned threshold — would achieve comparable results.

**Assessment:** Partially valid. The H1 falsification showed that calibration provides
modest practical value at m=1. However, the architecture still provides the ZERO wrong-
suppressions from L0 (13.5% of pairs) and the ZERO wrong-executions from the witness —
both of which are certifier/refuter contributions, not judge contributions. The
architecture's value is not in the calibrated layer alone.

### F2: Error asymmetry (WS stable under perturbation, dedup varies)

**Paper's explanation:** The conformal bound guarantees WS ≤ α while dedup is unbounded;
the asymmetry is structural.

**Competing:** Any conservative threshold creates this pattern. If you pick a threshold
that's safe by a large margin (which the conformal procedure does — τ=0.80 when the safe
region starts at 0.20), you get stable WS and variable dedup. The asymmetry is a
consequence of over-conservatism, not of the theory.

**Assessment:** Partially valid. The conformal threshold IS conservative (H1). But the
asymmetry also appears under seed-level splitting (§8.14, E11), under relabelling
(§8.12), and across judges — all perturbations that don't change the threshold. The
asymmetry is real; the conservatism amplifies it but doesn't create it.

### F3: Certifier/refuter decomposition is general

**Paper's explanation:** Any procedure deciding effect identity decomposes into a
certifier (decidable proof of sameness), refuter (decidable proof of difference), and
residual. This is a structural result (T2/T4/T6).

**Competing:** This is just the decidable/undecidable distinction from computability
theory, applied to a specific domain. Every classifier has a "sure" region and an
"unsure" region. Naming these "certifier/refuter/residual" adds terminology, not insight.

**Assessment:** The naming IS just a relabelling of a standard structure. What IS novel
is the specific *content* of each layer for effect identity:
- L0 (canonical form) is specific to the domain and non-trivial to design soundly
- The witness (semantic projection) is specific to tool-call schemas
- The residual determination theorem (T6) is genuinely useful for engineering guidance

The decomposition is standard; the instantiation for effect identity is the contribution.

### F4: Schema-first, model-second

**Paper's explanation:** T6 proves that schema changes are the only way to shrink the
residual, while model changes only redistribute error within it.

**Competing:** This is just "type your inputs." Any system that makes its inputs more
structured makes decisions easier. The insight is obvious and does not need a theorem.

**Assessment:** The observation IS obvious. What the paper adds is:
1. Quantification: how much does each schema change buy (§8.9, §8.15)?
2. The refinement dilemma (T6.3'): tighter schema helps on decided pairs but HURTS on
   undecided ones by shrinking the calibration pool. This is non-obvious.
3. The specific trade-offs (H3): schema changes improve safety-critical metrics but
   worsen recoverable ones.

The qualitative insight is obvious; the quantitative structure and trade-off analysis
are not.

### F5: T6 residual determination

**Paper's explanation:** The residual is determined by the schema alone, giving a
framework for engineering investment decisions.

**Competing:** T6 is true by definition — the residual IS defined as what the schema
doesn't decide. Calling this a "theorem" dignifies a tautology.

**Assessment:** Valid critique. T6 is definitionally true. However:
- T6.1 (error redistribution) is empirically confirmed: different judges err on
  completely different pairs (zero overlap in error sets across 3 judges)
- T6.3' (refinement dilemma) is non-trivially consequential and was discovered by
  taking the definition seriously
- The paper found two results (§8.3 miscalibrated pool, §8.9 dedup collapse) by
  treating the residual as an object. The definition's value is instrumental.

T6 is tautological. Its consequences are not.

### F6: Conformal calibration is necessary

**Paper's explanation:** The conformal bound (T3) provides a distribution-free,
finite-sample guarantee on wrong-suppression.

**Competing:** The judges separate so well (AUC > 0.97) that calibration is redundant.
Any threshold in the vast safe region works. The conformal machinery is unnecessary
overhead for well-separating judges.

**Assessment:** H1 established this for m=1. Calibration becomes essential at m>1
(Bonferroni correction) and with weaker judges. On this corpus with these judges,
the competing explanation is correct.

### F7: Zero L0 errors

**Paper's explanation:** L0 is sound by construction under A5; the zero is a proof,
not a measurement.

**Competing:** L0 handles only the trivially easy cases (key reorder, whitespace,
number format). Its zero is expected for any reasonable canonicalization. The 13.5%
coverage is modest — it only catches mechanical reformats.

**Assessment:** Both are true simultaneously. L0's zero IS expected (the cases are
easy), but L0's contribution is that it handles them with guaranteed correctness,
freeing the semantic layer from having to be correct on 13.5% of traffic. The
value is architectural (guaranteed base) not empirical (surprising accuracy).

### F8: 4 of 6 tools have clean score separation

**Paper's explanation:** The decidable layers are needed because the judge alone
can't achieve simultaneous zero error (T4).

**Competing:** On most tools, a single threshold suffices. The layered architecture
is over-engineering for the common case and only needed for 2 of 6 tools.

**Assessment:** Partially valid. The current corpus's tool-level separation is
good enough that T4 doesn't bite on most tools. But:
- The 2 tools where it bites (post_refund, transfer_funds) are the ones with the
  most complex residual structure
- Adding more tools or harder cases would likely shift the balance
- The clean separation depends on this specific judge; a weaker judge would have
  more overlap

The architecture is conservative but correctly so — it handles the worst case,
and the worst case exists.

---

## What the paper ACTUALLY contributes

After falsification, the surviving contributions are:

### 1. The decomposition framework (certifier/refuter/residual)
**Status:** Survives, but with reduced novelty.
The framework is an instantiation of the decidable/undecidable split for effect identity.
Its value is not in the decomposition itself (standard) but in the specific constructions:
L0 canonicalization, semantic projection as witness, and residual as unit of analysis.

### 2. Residual determination and its consequences
**Status:** T6 is tautological; T6.1 and T6.3' are the real contributions.
- T6.1 (model scaling is redistribution) is empirically confirmed with zero error overlap
  across 3 judges — the strongest empirical finding in the paper.
- T6.3' (refinement dilemma) is a genuine, non-obvious structural insight: the
  intervention the theory recommends also degrades the layer it doesn't replace.

### 3. The asymmetry: bounded safety, unbounded liveness
**Status:** Survives, but partially explained by conservatism.
The asymmetry IS structural (T3 bounds one direction, nothing bounds the other), and
it holds under perturbation. But the conformal procedure amplifies it by choosing a
conservative threshold. The correct framing: the architecture guarantees safety at the
cost of liveness, and the cost is visible and variable.

### 4. Jurisdiction-matched calibration
**Status:** The strongest methodological contribution.
The finding that calibration pools must be drawn from the rule's own jurisdiction
(the residual under the deployed configuration) is non-obvious, was discovered
empirically (§8.3), and has practical consequences: miscalibrated pools violate
the bound in the unsafe direction. Three counterexample attacks confirm this.

### 5. The loss asymmetry of schema vs oracle changes
**Status:** Corrected from "dominance" to "trade." Still valuable.
Schema changes improve safety-critical metrics while trading recoverable ones.
Oracle changes trade safety-critical ones. The corrected claim is weaker but
still actionable: invest in schema when safety matters most.

### 6. T5's composition structure
**Status:** Sound but limited applicability.
Case A (external exactly-once) requires a complete projection, which no tool
in the corpus achieves. Case B (window stays open) is the universal result.
The main takeaway: identity recognition is the only irreplaceable guarantee.

### What does NOT survive
- "Schema quality removes both" — falsified (H3, E12)
- Practical necessity of conformal calibration at m=1 — partially falsified (H1)
- T4's universal necessity — empirically limited to 2 of 6 tools
- The claim that the decomposition is novel — it's a domain-specific instantiation
  of a standard structure

---

## Remaining limitations and open questions

### Limitations this research could not address

1. **No new model calls.** All experiments are deterministic recomputations from
   persisted scores. The refinement dilemma (T6.3') independent test requires
   new scored pairs on a modified schema — impossible without API access. The
   §8.15 experiment was confounded by which attribute stays in prose.

2. **Single corpus.** All findings are on one 955-pair corpus over 6 tools.
   Generalization to tools with different schema structures, more complex
   interactions, or different judge families is unknown.

3. **No human ground truth.** The blinded panel (§8.16) uses models, not humans.
   Human inter-annotator agreement on effect identity is specified, instrumented,
   and uncollected (§7.4). The paper's strongest remaining gap.

4. **No deployment data.** All results are offline. Real deployment would introduce
   temporal dependence (A6 violation risk), varying m, and distribution shift.
   The three A6-violation counterexamples (T3 attack) show these are not
   hypothetical concerns.

5. **Judge stationarity assumed.** The judges are treated as fixed. In practice,
   model updates change score distributions, potentially invalidating calibration.

### Open questions this research raised

1. **Is the refinement dilemma a sample-size artifact or intrinsic?** T6.3' says
   refinement shrinks the calibration pool. But does the *composition* of the
   shrunken pool also get harder (the surviving pairs are the hardest ones)?
   §8.15 couldn't separate the two mechanisms; the experiment was confounded.

2. **At what m does Bonferroni correction become practically necessary?** The
   current corpus tests m ≤ 10 (§8.6). In a real deployment with long-running
   agents, m could be much larger. The transition from "calibration is
   redundant" to "calibration is essential" is unexplored.

3. **Can a judge's score separation be improved to the point where T4 stops
   biting?** 4 of 6 tools already have clean separation. Is this achievable for
   all tools with a better judge, or are some tools inherently overlapping?

4. **What is the minimal schema that achieves Case A (T5 complete projection)?**
   No tool in the corpus achieves it. Is this because the corpus tools are
   under-specified, or because real tools inherently have D2-type legitimate
   repeats that no schema can distinguish?

5. **Does the error-redistribution finding (T6.1 — zero overlap across judges)
   hold with larger error sets?** The current finding is based on 4, 3, and 2
   errors respectively. With more errors, overlap might appear.

---

## Record of what was discovered

### Discoveries that changed the paper

1. **"Schema quality removes both" is false** (H3/E12). The abstract, T6.1, §9.1,
   and §13 overclaimed. Schema changes trade safety-critical improvements
   against recoverable degradation. Five edits applied.

2. **Conformal calibration is practically redundant at m=1** (H1). 80–95% of the
   threshold space is safe. Conformal advantage over cross-validated fixed
   thresholds is 6.6–10.4 percentage points on α-exceedance rate — real but
   modest. New §8.17 added with bootstrap table.

3. **T4 is empirically relevant for only 2 of 6 tools.** Per-tool score separation
   analysis shows clean gaps on 4 tools. T4 note added to §6.7.

### Discoveries that confirmed the paper

4. **Error concentration in the residual is real** (H2) — 100% across all judges,
   decidable layer soundness confirmed. But partially tautological by design.

5. **Error redistribution across judges is confirmed** (T6.1) — zero overlap in
   error sets across 3 judges, each failing on completely different pairs.

6. **All theorems T1–T7 survive within their stated assumptions.** No
   counterexample found under the stated assumptions. Three A6-violation
   attacks confirm T3's requirement is necessary, not just stated.

### Discoveries about the paper's meta-level

7. **The paper's strongest contribution is not where it thinks it is.** The paper
   emphasizes the decomposition (certifier/refuter/residual) and the calibration
   machinery. The falsification suggests the strongest contributions are:
   - Jurisdiction-matched calibration (non-obvious, practically consequential)
   - The refinement dilemma T6.3' (non-obvious, structural)
   - T6.1 error redistribution (empirically confirmed, zero overlap)
   - The loss asymmetry between schema and oracle interventions (corrected
     from "dominance" to "trade" — weaker but still actionable)

8. **The paper's weakest contributions are honestly labeled.** The definitional
   nature of T6, the limited applicability of T5 Case A, and the
   conservatism of the conformal procedure are all discussed in the paper.
   The errata section catches overclaims. This is above-average self-criticism
   for a research paper.
