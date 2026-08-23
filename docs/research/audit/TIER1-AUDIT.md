# Internal Tier-1 readiness audit

**Manuscript:** *Effect Identity for Non-Deterministic Agents: Certifiers, Refuters, and the Calibrated Residual*
**Audit date:** 2026-08-18
**Auditor role:** lead research scientist, adversarial reading of our own work
**Scope:** the manuscript as it stands after this revision round, plus the artifact at `research/effect-identity/`

This audit is written to be useful rather than flattering. Where a section would read better as a claim than as a finding, it is written as a finding.

---

## Status of this revision round

Four weaknesses were targeted. Their honest status:

| # | Weakness | Status | Evidence |
|---|---|---|---|
| 1 | Ground truth is author-constructed, no independent validation | **NOT CLOSED — apparatus built, study PENDING** | `src/experiments/annotation.js`: 11 strata, 154 blinded items spread across tool families, 3-annotator design with a formal adjudication round, Fleiss κ + Krippendorff α + per-stratum agreement, power analysis, and re-derivation of the mechanism's rates under human labels. `results/human_annotation.json` reports `PENDING`. No number from it appears anywhere. |
| 2 | Crash/replay did not validate the deployed live-LLM configuration | **CLOSED** | §8.7 re-run against GPT-OSS-120B at the jurisdiction-matched threshold, two arms, 8 crash points, 96 trials, zero abstentions. The prediction the offline run contradicted (0/6) now holds (6/6). A distinct-act arm measures wrong suppression across process death for the first time: 0/48. |
| 3 | Benchmark small, limited tool/schema diversity | **PARTIALLY CLOSED** | Tool surface grown 6 → 14 with declared effect structures and a machine-readable manifest; 1,043 extension pairs generated but **not yet scored**. The 570-pair schema-richness ladder **is** fully scored (§8.15): T6 monotonicity confirmed as a three-point trend with a passing per-class design check, and a second, unplanned finding — the fixed-vs-replenished calibration comparison was confounded by the replenishment source's own difficulty, reported as a methodological correction rather than smoothed over. |
| 4 | Baseline and cross-model coverage | **PARTIALLY CLOSED** | Baseline matrix grown 6 → 15 configurations with paired McNemar + Holm within family (§8.13). Judge admission rule extended to catch a new failure mode. Full cross-family scoring at scale remains incomplete, and two model endpoints used in the original runs are no longer reachable. |
| 5 | Conformal claims must not be overstated | **CLOSED, and one claim tightened** | §8.14 audits the construction (15 checks), validates the correction by Monte-Carlo independent of any corpus, and **corrects an over-strong statement in §8.11**: the mean realised rate is flat in *n*, but the tail is not — it tightens from p95 13.4% to 4.2%. Roughly 1 draw in 30 still exceeds α at n=100. |

---

## A. Novelty

**Strong, and correctly bounded.** The certifier/refuter/residual decomposition, T6 (residual is schema-determined), and T7 (composition structure) are, as far as the 121-work survey reaches, not stated elsewhere. The paper is unusually careful not to claim the *problem* as novel — ACRFence and CapLease posed it first and §2.5 says so at length.

The strongest genuinely new items after this round:
- **T6.3′ (the refinement dilemma)** — refinement shrinks the calibration pool at the same rate it shrinks the residual. This is a second-order consequence that cost the authors a headline, and it is the kind of result reviewers reward.
- **The jurisdiction requirement** — calibrating on the population the deployed rule actually routes to the oracle. This is a general lesson for conformal control decisions, not a detail of this system.
- **The judge-degeneracy admission clause** (new this round) — a constant-answering judge produces a *fake-perfect* row identical in shape to an abstaining judge's, and a coverage filter admits it. We found this by running into it.

**Risk:** a reviewer may read the certifier/refuter duality as a formalisation of what engineers already do. §5.4 pre-empts this directly and the pre-emption is convincing, because T4 shows a decidable veto is the *only* route to a zero.

**Score: 8/10.**

## B. Theoretical contribution

T1, T2, T5 are standard arguments restated for a non-equality identity relation; §6.2 says so. T4 is short. T3 carries the weight and is correct: the multiplicity correction, the tie handling, the m=0 case, and the insufficient-data case are all treated, and the Monte-Carlo in §8.14 now validates it independently of any corpus.

**A dedicated adversarial pass over every theorem, proposition and definition** (this round) found and fixed four real gaps rather than zero, which is itself informative: it means the theory had not previously been read this critically by anyone including the authors.
- Proposition 1(3) claimed the certifier/refuter families are "closed under arbitrary unions" with a "maximal decidable element" — false in general, since decidability is not closed under infinite union. Restricted to finite unions, which is both true and the only closure fact anything else in the paper uses; the proof and two dependent paragraphs were rewritten to match.
- Corollary T6.3′ asserted "a smaller pool forces a higher threshold" as if it followed from T3; only the certifiable-`m` consequence is exact. Split into the exact claim and the empirical tendency, and sharpened using the schema-ladder's own finding (§8.15) that pool *composition*, not just size, can peg the threshold.
- "T6 says... it is the only shape the trade can take" overclaimed exhaustiveness over intervention types T6/T4 never ruled out. Narrowed to what is actually proven, deferring to §9.1's already-correct "falsifiable prediction" framing.
- Definition 1 was circular (denotation-only) while §7.4 claimed to hand annotators "the formal operational definition" that did not exist in the theory. Added the missing operational (counterfactual) criterion under Definition 1 itself.

None of the four affected an empirical number; all were prose/scope corrections caught by reading proofs against their stated conclusions rather than by running anything.

**Weaknesses a reviewer will still find:**
- T6 is close to definitional. Its content is the *consequences*, and the paper is honest about this.
- Proposition 1 is now correctly scoped but still gives no construction for the maximal decidable certifier even within the finite case; §4.1 concedes this explicitly.
- Nothing is machine-checked. §9.3 lists mechanisation as future work.

**Score: 7.5/10** — raised half a point for the rigor pass; the ceiling is still T6's near-definitional content and the absence of mechanisation, not correctness.

## C. Empirical contribution

Substantially stronger than at the start of the round.

**What is solid:** the 955-pair v1 corpus with four generator arms including a no-model arm; the crash/replay experiment as re-run (two arms, eight crash points, live judge, zero abstentions); the 15-configuration baseline matrix; the residual-conditioned calibration correction; and, new this pass, the three-level schema-richness ladder (§8.15), which turns T6 monotonicity from a single before/after into a paired three-point trend with a design-consistency check that passes.

**What is not:** the tool-surface extension (1,043 pairs, eight new tools) is generated but **not scored**, so the headline mechanism result is still a 955-pair, six-tool, two-judge, one-vendor measurement. That is the single largest remaining gap and this audit does not pretend otherwise.

**Score: 7/10** — would be 8.5 with the extension scored.

## D. Ground-truth validity

**The weakest axis, and it has not moved.** Labels remain the authors' operationalisation. The controls are real but partial: the hand-authored arm removes the machine-generation confound only; §8.12 re-derives the headline under the one contestable category relabelled and under a deliberately hostile relabelling, and finds wrong-suppression stable at 1.0% / 0.8% / 2.1% while deduplication moves 94.0% → 24.9%.

That asymmetry is the honest summary: **the safety conclusion does not depend on our definition of the same act; the liveness conclusion does.**

New this round, and uncomfortable: **86.4% of test pairs share an underlying seed act with some calibration pair** (§8.14). Exchangeability is a condition on scores, not provenance, so this is not automatically a violation — but it is newly disclosed, it was not measured before, and a split by seed act would be cleaner.

**Score: 4/10.** It rises only when annotators return.

## E. Statistical validity

**Strong.** Wilson intervals throughout; zeros-by-construction distinguished from sample zeros; exact McNemar on paired items; Holm applied *within family* rather than across a pooled set; 15 construction checks that fail the build; a Monte-Carlo that is written to fail if the correction is removed.

The α interpretation is now explicit about marginal-vs-conditional, and the earlier over-strong tail claim is corrected rather than quietly dropped.

**Residual weakness:** several load-bearing cells are small (S3 = 8 pairs, D3 = 5, D4a = 20, crash arms = 48). The paper quotes the bounds every time.

**Score: 8.5/10.**

## F. Adversarial validity

**Improved in apparatus, not yet in evidence.** Eleven attack classes are implemented and generated across eight tools — direct/indirect/conflicting/paraphrased injection, injection in a non-changing field, zero-width disguise, Unicode homoglyph, field-order and serialization, prose-only mimicry, forced execution, and a **misdeclared-policy** class that the mechanism is expected to fail by construction. The matrix reports, per class, which layer disposes of it and whether raw / calibrated / full each fail.

**But** the reported results are still the two v1 classes, because the extension is unscored. The decomposition on those two is now explicit (D4a: certifier 0%, refuter 100%, reaches judge 0%; D4b: reaches judge 100%).

**The misdeclaration class deserves emphasis:** it demonstrates that A5 is load-bearing rather than ceremonial. A field mis-declared `num` makes the certifier suppress across two different accounts unconditionally — no judge, no band, no bound. The mechanism has no defence and the paper should say so plainly.

**Score: 6/10** — apparatus 8, evidence 4.

## G. Reproducibility

**Strong.** Zero dependencies; every table regenerable offline from persisted scores; `checkPaper.js` fails the build if the manuscript quotes an interval the results cannot produce; `repro.config.json` records seeds, splits, prompts, policies, thresholds, CI method and model versions; `verify.js` enforces 11 assertion classes.

**Genuine threat, newly named:** the oracle is a third-party endpoint. Two models used in the original runs (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`) are **no longer reachable on this key**, so §8.6 and two v1 generator arms are not re-runnable as specified. This is disclosed in §9.2.

**Score: 8/10.**

## H. Baseline adequacy

Fifteen configurations, paired tests, per-jurisdiction calibration. Two findings are uncomfortable and are reported as such:

- **B6 (refuter + judge) is identical to B8 (full) on every test item** — the certifier contributes nothing to the outcome on this corpus. Its value is the *basis* of its zeros, not the rate.
- **No wrong-suppression comparison is significant after Holm.** We therefore claim no benign WS advantage for the full system over any comparator, and rest the safety case on the D4a class and on the bound itself.

A reviewer may still ask for a learned-similarity baseline (a cross-encoder fine-tuned for paraphrase). We do not have one, and it is the most reasonable "missing baseline" objection.

**Score: 7/10.**

## I. Generalization

Six tools scored, fourteen declared. One loose-schema tool carries most of the difficulty. No production traffic. The crash experiment is one act pair. §9.1's recipe-transfer claim is explicitly marked a conjecture.

**Score: 5/10.**

## J. Claims supported by the evidence

1. Content-addressed fencing fails under paraphrase — 13.5% dedup on corpus, **0/48** under crash/replay.
2. The layered fence deduplicates 94.0% [90.4–96.3] at 1.0% [0.3–3.5] WS on the v1 corpus.
3. The refuter closes the declared-field injection class **by construction** (D4a: 0/20 vs a raw judge's 65%).
4. Prose-only distinctions fail badly under injection (D4b: 84.0% on the primary judge) and are closed by schema tightening, not by judge choice.
5. Calibrating a pairwise score and deploying a maximum voids the bound — 65.0% WS at m=50 uncorrected vs 0% corrected; Monte-Carlo: 89.0% vs 0.0%.
6. The calibration pool must match the deployed rule's jurisdiction — 4.2%/5.0% vs 1.7%/2.5% residual-conditioned WS.
7. **New:** the fence achieves at-most-once across paraphrased replay outside the commit window — 36/36, and 6/6 at `after_local_commit`.
8. **New:** no missed legitimate effect across process death — 0/48 on the distinct arm.
9. **New:** the commit window is open and observable — 0/12 correct, 11/12 flagged, on the arm that reaches it.
10. Safety transfers across judges while liveness does not — WS 0.0/0.0/2.1% vs dedup 12.2–91.1% on the 218-pair common subset.
11. **New:** T6 monotonicity holds as a three-point trend, not just a single before/after — residual and judge jurisdiction shrink 100.0% → 41.2% → 19.6% across three schema levels on one paired act family, with the refuter's per-class behaviour matching the design's own prediction at every level.

## K. Claims NOT supported, and not made

- Universal semantic equivalence.
- Zero wrong-suppression from any scorer-dependent layer (T4 forbids it).
- External exactly-once. Guarantee (C) is the provider's; the crash harness deliberately presents no idempotency key.
- At-most-once *inside* the commit window — measured failing, 12/12.
- Any rate below the sample's interval: 48 trials admit 7.4%; 20 attack pairs admit 16.1%.
- **Any human-validated ground truth.** PENDING.
- **Any result from the tool-surface extension or the attack matrix at scale.** Generated, not scored. (The schema-richness ladder *is* scored — see J above — and is the one exception to this line.)
- Production-scale reliability; fleet behaviour; cross-vendor generality at full coverage.
- That more calibration data improves accuracy — it buys multiplicity budget and a tighter tail.

## L. Remaining reviewer attack points, ranked

1. **"Your ground truth is your own definition."** Unanswerable until annotators return. The harness exists; the study does not.
2. **"Your benchmark is 955 pairs and six tools."** The extension is built and unscored — which is worse than not having built it, in the sense that a reviewer will ask why it is not reported.
3. **"Two judges, one vendor, at full coverage."** Partially answered on 218 pairs; the endpoints have since moved.
4. **"86.4% seed overlap between calibration and test."** Newly self-disclosed. Defensible but a reviewer will press it.
5. **"The certifier does nothing."** True on this corpus; we now say so.
6. **"No wrong-suppression comparison is significant."** True; we now say so and rest the case elsewhere.
7. **"Where is the learned-similarity baseline?"** Absent.
8. **"m = 1 in the deployed configuration."** The regime the correction matters for is not the regime measured; §8.6 and §8.14 address it, on a saturated judge and in simulation respectively.

---

## Scores

| Axis | Score |
|---|---:|
| Novelty | 8 / 10 |
| Theory | 7 / 10 |
| Experiments | 7 / 10 |
| Statistics | 8.5 / 10 |
| Reproducibility | 8 / 10 |
| Writing | 8.5 / 10 |
| **Overall** | **7 / 10** |

**Reading of the overall score.** This is a strong paper with an unusually honest evaluation and one structural hole. It is competitive at a good systems or ML-safety venue now. It is *not yet* a safe accept at a top-tier venue, and the reason is single and specific: the central object — the SAME/DIFF ground truth — has never been checked by anyone outside the author team, and the benchmark that would demonstrate generality has been built but not measured. Closing either raises the overall by roughly a point; closing both makes the empirical section commensurate with the theory, which is currently the stronger half.

---

## Predicted reviewer criticisms, and the strongest rebuttal to each

### Reviewer #1 — the empiricist
> *"955 pairs, six tools, two judges from one vendor, labels written by the authors. The theory is interesting but the evaluation cannot support claims about a mechanism."*

**Rebuttal.** The paper's central empirical claim is an *asymmetry*, not a rate, and asymmetries survive weak samples better than point estimates do. Deduplication moves seven-fold across judges and four-fold across defensible relabellings; wrong-suppression stays inside the declared level under every perturbation applied — three ground truths, three judges, two vendors, and now a crash/replay experiment with a distinct-act arm. Every rate carries a Wilson interval and the small cells are flagged where they occur.

**Where the rebuttal fails, and we should concede it:** it does not answer the labelling objection, only the sample-size one. The correct concession is that the liveness numbers are corpus-specific and the paper says so; the safety claim is a statement about a decision rule, and the corpus is evidence that the rule behaves as derived rather than the basis of the guarantee.

### Reviewer #2 — the statistician
> *"A conformal bound on a max statistic with a Bonferroni correction is standard. The interesting question is whether exchangeability holds at deployment, and you cannot check it. Also, α is marginal over calibration draws and your own data shows draws exceeding it."*

**Rebuttal.** Both points are correct and both are in the paper rather than extracted from it. We state that A6 is the load-bearing assumption, that no offline check can establish it, and that §8.4 is the case where it visibly fails — reporting the calibrated layer performing *worse* than the raw judge under injection, which is the expected behaviour and an argument against our own mechanism if read carelessly. §8.14 measures the marginal-vs-conditional gap directly: at n=100 roughly one draw in thirty exceeds α, and a deployment does not get to redraw. We also corrected our own earlier over-statement that the gap does not narrow with more data.

**The genuinely new contribution to defend:** the object being calibrated. Calibrating a pairwise score and deploying a maximum voids the bound, and the literature has not treated this because it calibrates prediction sets rather than control decisions. The 89.0%-vs-0.0% Monte-Carlo is the cleanest evidence and depends on no corpus.

### Reviewer #3 — the security reader
> *"Your adversarial evaluation is 45 pairs in two classes on one tool family, and your headline defence is 'compare the typed fields'. Under injection your calibrated layer is worse than an uncalibrated one. What exactly is being defended?"*

**Rebuttal.** The defence is a *placement*, not a detector. The witness runs before the judge, so no judge output — however manipulated — participates in a decision across a declared difference; that is why D4a is zero by construction rather than by measurement, and why the identical judge consulted directly fails 65% of the same attacks. T4 explains why this is the only available route to a zero: no threshold rule on overlapping distributions reaches zero error, so a decidable veto is not one option among several.

We concede the rest without argument. The calibrated layer *is* worse than the raw judge under injection (70% vs 65%) because calibration bounds an error on the benign distribution and offers nothing under deliberate shift — we report it rather than omit it. Prose-only distinctions fail 84% of the time and the witness contributes nothing there by construction. Eleven further attack classes are implemented, including one the mechanism cannot defend against at all (a misdeclared field policy, which makes the certifier suppress two distinct accounts unconditionally), and they are **not yet scored** — which a reviewer is entitled to hold against us.

---

## What would most improve the paper, in order

1. **Run the annotation study.** 154 items, 3 annotators, ~495 judgements. It is the only intervention that changes axis D, and axis D is the lowest.
2. **Score the tool-surface extension.** Built and generated; the schema ladder (originally listed here too) is now scored and reported in §8.15. What remains open from that experiment is not "run it" but "re-run the replenishment condition with a replenishment source whose difficulty is checked against the natural residual first" — the ladder found a design flaw in its own second question, not just a missing measurement.
3. **Split calibration and test by seed act**, and report the headline both ways.
4. **Add a learned-similarity baseline** so "a fine-tuned cross-encoder would do this" has an answer.
