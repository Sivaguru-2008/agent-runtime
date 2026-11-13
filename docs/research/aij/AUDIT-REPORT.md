# Audit report — what was checked, what was wrong, what changed

**Scope:** the manuscript, the source, the corpus, the labels, the splits, the
prompts, the model configuration, the judge outputs, the logs, the figures, the
tables, the statistics, the supplementary material and the references, audited
against `research/effect-identity/` in September 2026 in preparation for
submission to *Artificial Intelligence*.

**Method:** every headline number was recomputed from the raw corpus and score
files rather than read from a results file, and the recomputation was compared
with both the results file and the manuscript. Where the three disagreed, the
raw data won. Nineteen numerical errors were found and corrected; two
undisclosed facts were found and are now disclosed; two new analyses were run to
answer questions the earlier text asserted without evidence.

---

## 1. Numerical corrections

Each row was recomputed from the underlying data. "Previously stated" is the
value in the 44,600-word long-form manuscript this paper replaces.

| # | Quantity | Previously stated | Correct value | Cause |
| --- | --- | --- | --- | --- |
| 1 | Tokens per 1,000 dispatches (primary judge) | 5,431 | ~140,000 | cost model divided one session's tokens by every pair ever scored |
| 2 | Tokens per comparison | 4,170 | 183.7 | same denominator bug |
| 3 | Judge jurisdiction (declared schema) | 73.5% / 26.5% decided | 76.2% / 23.8% | figures from a superseded 955-pair corpus |
| 4 | Judge jurisdiction (refined schema) | 56.5% | 58.9% | same |
| 5 | Conformal index at the refined pool | "equals 35" | 48 (2nd largest of n=49) | leftover from a corpus in which the pool held 35 pairs |
| 6 | Uncorrected rule's excess at m=50 | "a factor of nine" | ~18× (89.0% vs 5%) | mis-stated ratio |
| 7 | What the refinement re-declares | "one tool's schema" | every free-text field of every tool | mis-description of the intervention |
| 8 | Refinement effect on the other two judges | not reported | dedup collapses to 12.1% (canonical-only) | reported for one judge only |
| 9 | Escalation-band mechanism | saturated judges escape silently; graded ones flag | the opposite pattern; the mechanism is threshold **ties** | narrative not checked against the score grid |
| 10 | Commit-window re-fires (distinct arm) | inconsistent between sections | 12/12 inside the window, 11 flagged | two sections disagreed |
| 11 | McNemar discordant count (dedup vs canonical) | 202 | 232 | stale count |
| 12 | McNemar discordant count (cross-judge) | 42/12 | 46/12 | stale count |
| 13 | Witness-free configuration's wrong suppression | 3.0% | 3.4% | 3.0% is the same configuration under a mismatched pool |
| 14 | Per-tool calibration cost | 5 points of dedup | 27 points | reported under a mismatched calibration pool |
| 15 | Mean ensemble's prose-injection rate | 88.0% | 44.0% | same |
| 16 | Relabelling thresholds | t_hi = 0.7 and 0.96 | 0.80 and 0.95 | stale |
| 17 | Self-recognition table | every arm deduplicated completely | arms differ; still no self-recognition advantage | computed under a mismatched pool, where no difference could show |
| 18 | Rule-of-three figure at n=232 | 1.5% | 1.3% | arithmetic |
| 19 | Tools covered by the annotated extension items | "fourteen further tools" | **nine** further tools | fourteen is the total tool count in `toolsV2.js`, six of which are this paper's; found in this audit, in text written during this revision |

All nineteen are now enforced: `tools/check-claims.mjs` rejects twelve of the
stale strings outright, and `checkPaper.js` checks every quoted interval against
a computed rate (401 intervals across 46 files).

## 2. Claims weakened or withdrawn

| Claim as previously written | Now |
| --- | --- |
| The abstract claimed the safety result was stable "under a blinded panel" | The same paper reported that the panel's preregistered test had **triggered** against the safety claim. The abstract now reports the trigger, and §8.7 reports its cause. |
| The panel study was presented without provenance caveats | Two defects disclosed: 93 of 154 sheet items have no judge score and therefore cannot enter the wrong-suppression numerator while sitting in its denominator (12 of the 14 label flips are such items); and the published figures are not exactly reproducible from any committed file state. |
| A schema-ladder "replenishment" experiment was reported as evidence | Withdrawn. Its replenishment pairs came from a mutation class the judge treats as the same act, so it raised the pool's ceiling rather than its information. The design error is reported; no number from it is used. |
| Wrong-suppression advantages were implied between configurations | Withdrawn. Every such comparison rests on ≤4 discordant items and none is significant; the safety case now rests on the bound and on the injection class the refuter closes by construction. |
| "Exactly-once" appeared unqualified | Every occurrence now names its level, and the build fails on an unqualified use. |

## 3. New evidence produced during the audit

Two questions the earlier text answered by assertion are now answered by
experiment, in `src/experiments/aijAnalyses.js` (thirteen analysis blocks, A0–A13):

- **The refinement dilemma, decomposed.** Refinement shrinks the calibration
  pool *and* changes its composition. A0–A5 separate the two by drawing 5,000
  random subsets of the declared pool at the refined pool's size and recomputing
  the threshold on each, which isolates the size component; the residual gap is
  the composition component. This is a new result and it is what makes
  Proposition 5's "does not say the threshold is numerically higher" empirically
  meaningful.
- **The escalation band is governed by ties, not confidence.** Judge scores are
  integer percentages and the suppression inequality is strict, so a duplicate
  scoring exactly at the threshold is never suppressed. 40 of the 20B judge's 43
  banded duplicates, 10 of 15 silent escapes on the primary judge and all 24 on
  Qwen are such ties. This reverses the earlier narrative.

Also added: per-tool separation, per-tool calibration under the matched pool,
ensembles and a deterministic lexical scorer, error overlap across judges,
per-category decisions, crash-layer attribution, the admission audit with AUC,
cross-generator self-recognition, an exact permutation test for abstention
homogeneity, and the corrected cost model.

## 4. Process defects found and fixed in the artifact

| Defect | Fix |
| --- | --- |
| Cost model divided a session's tokens by every pair ever scored | `run.js` now divides by the pairs scored in that session |
| `report.js` read corpus composition from a stale `corpus/meta.json` | now computed from `corpus/pairs.jsonl` |
| The panel analysis read live response files | `annotation.js` takes `--responses-dir` and records the directory it read; the preregistered state is snapshotted at `annotation/preregistered-collection/` |
| Channel H and Channel M responses could be pooled silently | the ingest refuses, and `--channel H` writes to its own output file |
| `checkPaper.js` could only check the long-form Markdown | `--manuscript a,b` accepts any files, with LaTeX normalisation |
| The supplement's generated tables were outside every gate | `build.mjs`, `check-claims.mjs` and `verify.js` now walk `supplement/` recursively — the interval count rose from 129 to **401** |
| `verify.js` guarded only the Markdown manuscript against "human-validated" | it now guards the AIJ manuscript, every section and the supplement |
| The published panel analysis existed only in git history | recovered to `results/human_annotation.published-20260825.json` and preserved verbatim |
| An earlier pass left an audit document and a submission checklist describing theorems the paper does not contain, citing a test file that does not exist, and asserting a fence-safety claim the paper disavows | moved to `docs/research/superseded/` with a README stating each defect; replaced by `CLAIM-EVIDENCE-AUDIT.md` and `SUBMISSION-CHECKLIST.md` |
| Two duplicate packages (`reproducibility/`, `human_validation_package/`) competed with the canonical documents and carried a stale tool count and a second, non-preregistered analysis script | both marked secondary, pointed at the canonical documents, and their stale figures corrected |

## 5. What is still missing

| Gap | Consequence | Where it is stated |
| --- | --- | --- |
| **No human validation.** Channel H was never collected | the strongest available claim is that a model panel reproduces the labels on 154 items; a bias shared between the authors and the models would pass | abstract, §8.7, §10, supplement §S16 |
| The published panel figures are not exactly reproducible | the paper reports the earliest committed state (117 items) instead; all flips and both rates are identical | supplement §S16 |
| Judge scores for the 1,043-pair extension corpus were never persisted | the panel re-derivation must be read in two forms; 93 of 154 annotated items are affected | §8.7, supplement §S16 |
| One corpus, six tools, synthetic, one provider endpoint | external validity is untested; model weights behind the endpoint are not pinned | §10 |
| Cross-run and cross-tool duplicates are out of scope | the candidate set is same-run, same-tool by construction | §6 preamble, §10 |
| Prose-only injection succeeds 84.0% of the time | the mechanism does not defend text-only distinctions unless the schema is refined, which costs deduplication | §8.4, §10 |

## 6. Verification status

```
npm test                     61 tests, 61 pass
verify.js                    11 assertion classes, all hold
checkPaper.js                401 quoted intervals in 46 files, all matched
tools/check-claims.mjs       34 headline numbers present; 11 stale patterns absent;
                             no unqualified "exactly-once"
build                        manuscript.pdf 85 pages, supplement.pdf 15 pages,
                             0 undefined refs/cites, 0 overfull boxes > 20pt
```
