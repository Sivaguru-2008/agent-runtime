# Claim-to-evidence audit

**Paper:** Effect Identity for LLM Agents: Schema-Determined Limits on Duplicate
Suppression · **Venue:** *Artificial Intelligence* (Elsevier), ISSN 0004-3702 ·
**Audited:** 2026-09-18 against `research/effect-identity/` at this commit.

Every row names the file the number comes from. Every interval quoted in the
manuscript and the supplement is additionally checked by the build
(`checkPaper.js`: 401 intervals across 46 files, all matched), and the headline
numbers quoted without intervals are checked by `tools/check-claims.mjs` (34
claims). This document is the human-readable counterpart of those gates: it adds
what each result **does not** establish.

Status values: **proved** (mathematics, under listed assumptions) · **measured**
(holds on this corpus, with an interval) · **partial** (supported in a narrower
sense than the words might suggest) · **not established** (stated as such in the
paper).

---

## 1. Formal results

The paper contains one theorem and eight propositions. There are no others; any
earlier document listing more (a "semantic impossibility" theorem via Rice's
theorem, a "compositional safety" theorem over *K* tool calls) describes a
manuscript that no longer exists and should not be used.

| # | Statement | Assumptions | Proof | Status | Boundary |
| --- | --- | --- | --- | --- | --- |
| Prop. 1 (equivalence) | the identity relation is an equivalence under the stated conditions | A2 | App. A | proved | structural |
| Prop. 2 (lattice) | the policy lattice structure of canonicalisation | — | App. A | proved | structural |
| Prop. 3 (residual determination) | the residual is a function of the declared schema alone; no judge moves a pair out of it | A5, A5′ | App. A | proved | says nothing about how large it is |
| Prop. 4 (decidable layers) | certifier suppressions are correct; no judge output suppresses across a declared typed difference | A2, A5, A5′ | §6.2 | proved | holds only for pairs the layers decide |
| **Thm. 1** (multiplicity-corrected bound) | P(suppress a request distinct from all *m* candidates) ≤ α | A6 (exchangeability conditional on *m*) | §6.3 | proved | **marginal** over calibration draws; not a per-deployment rate, not a judge error rate, void under injection |
| Prop. 5 (calibration budget; refinement dilemma) | t_hi finite iff m ≤ α(n+1); threshold is the ⌊(n+1)α/m⌋-th largest; refinement can only shrink the budget | — | §6.4 | proved | does **not** say the refined threshold is numerically higher |
| Prop. 6 (no zero-error threshold) | overlapping score distributions admit no threshold with zero error in both directions | — | App. A | proved | motivates layering; not an impossibility result about identity |
| Prop. 7 (fence-level at-most-once) | at most one dispatch+commit per operation across restarts | A1–A4, A7 | App. A | proved | **except the commit window**; without A7 duplicates are observable, not prevented |
| Prop. 8 (composition with a provider key) | external exactly-once **only** if the key is paraphrase-invariant *and* complete, and the provider is idempotent | A5″, A8 | §6.7 | proved | Case B: under A5′ alone σ is *not* admissible as a provider key |
| Prop. 9 (identity recognition not substitutable) | neither the log nor the provider can supply identity recognition | — | App. A | proved | locates the contribution; not a performance claim |

**Assumption audit.** A1–A8 are listed in the manuscript with, for each, what it
means, whether the implementation satisfies it, and how it can fail. The three
that carry the empirical weight: A5 (policy soundness) and A5′ (typed-field
determinacy) are properties of the declared schema and are checked on this
corpus by construction (0/232 distinct pairs certified, 0/281 duplicates
refuted); A6 (exchangeability) is *assumed*, and the paper measures what happens
when it is stressed rather than claiming it holds.

## 2. Empirical claims

| Claim | Status | Evidence (file) | What it does not establish |
| --- | --- | --- | --- |
| Deduplicates 94.7% [91.4–96.7] of paraphrased duplicates at 1.7% [0.7–4.3] wrong suppression, against 12.1% [8.8–16.4] for canonical keys (primary judge, α=0.05) | measured | `residual_calibration.json` | one corpus, six tools, synthetic; not a field deployment |
| Wrong suppression stays below α for all three judges (1.7 / 1.3 / 0.9%) while deduplication ranges 82.6–94.7% | measured | `residual_calibration.json`, `cross_family.json` | three judges from two families; not evidence about judges in general |
| The three judges' wrong suppressions fall on disjoint pairs | measured | `aij_analyses.json` (A9) | small counts (≤4 items per judge); an observation, not a mechanism |
| Uncorrected pairwise thresholding wrongly suppresses 89.0% of distinct requests at m=50; corrected rule 0.0% | measured (simulation + live) | `multi_candidate.json` | the live judge is saturated (two distinct values over 3,000 comparisons); the endpoint of the m-curve is the claim, not its shape |
| The refuter closes typed-field injection (65.0% → 0%†) | proved + measured | `attack_matrix_v1.json`; Prop. 4 | † is zero by construction, not by sampling |
| Prose-only injection succeeds 84.0% of the time against the primary judge | measured | `attack_matrix_v1.json` | a negative result about the judge, reported as such |
| Refining declarations closes the prose class but lowers deduplication to 69.0% (primary) and 12.1% (other two) | measured | `residual_calibration.json` | the refinement is an intervention on declarations, not a separate system |
| The refinement dilemma has a pool-size component and a pool-composition component | measured | `aij_analyses.json` (A5: 5,000 subsets) | decomposition on one corpus; the size counterfactual is a resampling argument |
| Realised wrong suppression varies across pools and splits: seed-level mean 2.7%, 10.5% of splits above α | measured | `seed_split.json`, `sensitivity.json` | this is the honest counterweight to Thm. 1, not a contradiction of it |
| Fence-level at-most-once holds across real process death outside the commit window (36/36 vs 0/36 syntactic) | measured | `crash_replay_v2.json` | one tool, one judge, 48 trials per arm |
| External exactly-once is **not** provided: 12/12 re-fires inside the commit window, 11 flagged | measured | `crash_replay_v2.json` | confirms the boundary the paper draws |
| Safety conclusion is robust to relabelling (1.7 / 1.9 / 2.2%); liveness is not (94.7 / 75.0 / 27.6%) | measured | `residual_calibration.json`, `human_annotation.json` | relabellings are alternative operationalisations, not independent ground truth |
| Non-LLM similarity baselines are below chance on the residual (AUC < 0.5) | measured | `non_llm_baseline.json` | shows the residual is not a surface-similarity problem |
| Cost: ~184 tokens per comparison, ~140,000 tokens per 1,000 dispatches (primary judge) | measured | `aij_analyses.json` (A8) | measured at batch size 10; higher at batch size 1 |

## 3. Claims that are **not** established, and are said so in the paper

| Claim a reader might expect | Actual status | Where the paper says so |
| --- | --- | --- |
| The labels are validated by independent humans | **not established.** Channel H was designed and instrumented; no human annotated anything | abstract, §8.7, §10, supplement §S16, `annotation/CHANNEL-H-PROTOCOL.md` |
| The panel study's published figures are reproducible | **no.** The analysis ran against live files; the earliest committed state gives 117 items, not 116 (all 14 flips and both rates identical) | supplement §S16, `annotation/RESPONSE-PROVENANCE.md` |
| The preregistered safety test passed | **no — it triggered** (9.9% → 10.5%). The paper reports the trigger and the defect that drove it (93 of 154 items unscored) | §8.7, supplement §S16 |
| Wrong suppression in *any* deployment is below α | **no.** The bound is marginal; 10.5% of seed-level splits exceed α | §6.3 "What it does not mean", §8.2 |
| The system provides exactly-once execution | **no.** Bounded identity recognition and fence-level at-most-once; external exactly-once only by composition with a provider key | scope box in §1, §3.5, Prop. 8 |
| The escalation band catches duplicates that fail the threshold | **judge-dependent.** Empty on two of three judges; governed by threshold ties, not graded confidence | §8.8, supplement §S8 |
| Prompt injection is defeated | **only the typed class.** Prose-only injection succeeds 84.0% of the time | §8.4, §10 |
| The approach generalises to cross-run or cross-tool duplicates | **out of scope.** The candidate set is same-run, same-tool | §6 preamble, §10 |
| Any technique here is new | **no.** Canonicalisation, typed validation, LLM judging, conformal calibration and Bonferroni are all prior art; the combination and its analysis are the contribution | §1 (contributions), §2 |

## 4. Terminology gates enforced by the build

| Term | Rule | Enforced by |
| --- | --- | --- |
| "exactly-once" | never unqualified; every occurrence must name the level (fence-level at-most-once / external exactly-once by composition) | `tools/check-claims.mjs` fails on an unqualified use |
| "human validation", "human-validated" | never applied to the existing evidence | `verify.js` (assertion class 11) and a stale-string pattern |
| "first", "novel" | listed for manual review on every build; the paper makes no priority claim | `tools/check-claims.mjs` prints every occurrence |
| "guarantee" | reserved for results with a proof and listed assumptions | §6.8 separates proved from measured explicitly |
| † (dagger) rates | mean zero by construction, not by sampling | defined in §7 (metrics) and in every table caption that uses it |
| stale numbers from earlier versions | 11 patterns rejected outright; the supplement's errata section is the one exempted region, marked in the source | `tools/check-claims.mjs` |

## 5. Evidence that exists but is **not** cited in the paper

- `archive/v1-llama-only/`, `archive/v2-gptoss-parserdefect/` — superseded runs,
  kept auditable. The v2 archive carries the mis-scaled scores of the parser
  defect (supplement §S3). Nothing from either is quoted.
- `corpus/scores-v2ext-allam.jsonl` — an extension corpus scored only by a model
  that fails admission (74 of 1,043 pairs scored, 63 of them at 0.90). Used only
  to explain why that model is excluded.
- A second schema-ladder experiment that attempted to replenish each level's
  calibration pool. Its replenishment pairs came from a mutation class the judge
  treats as the same act, so it measured nothing. The design error is reported
  in supplement §S13; no number from it is used.

## 6. Superseded audit documents

`docs/research/CLAIM_EVIDENCE_AUDIT.md` and
`docs/research/AIJ_SUBMISSION_CHECKLIST.md` (2026-09-14) are **superseded and
must not be used**. They describe theorems the paper does not contain, cite a
test file that does not exist (`test/multiCandidate.test.js`), and state a
fence-safety claim ("no two semantically equivalent actions execute twice
against the external provider") that this paper explicitly disavows. This file
and `SUBMISSION-CHECKLIST.md` replace them.
