# Preregistration: Experiment 4 (Hard Multi-Candidate Units, Stress Test)

**Date:** 2026-10-02
**Status:** Preregistered before any Experiment 4 unit is generated, labelled,
or scored.
**Author:** The Author (TMLR double-blind submission)

---

## 0. What this experiment is, and what it is not

This is a **stress test** of Theorem 1's multiplicity correction. Its units are
built to concentrate the candidate sets on which the uncorrected rule is most
likely to fail: several committed candidates that are siblings of the dispatch,
from the same seed act. Its rates are conditional on that construction. They
are **not prevalence estimates**, and the paper will not use them to say how
often deployments meet such candidate sets or how often the uncorrected rule
fails in practice.

Relation to existing evidence: `src/experiments/multiCandidateLive.js` scored
multi-candidate units on GPT-OSS-120B, but deliberately admitted only
candidates from a *different* seed act (two variants of one seed were not
assumed distinct). Those candidates are easy to tell apart, and the experiment
showed the correction's cost (stricter thresholds) without a case where it
helps. The only evidence that the correction helps comes from simulation and
from a saturated 8B judge. This experiment fills that gap with same-seed
candidates on admitted judges.

## 1. Question

On units whose candidates are distinct siblings of the dispatch, does the
uncorrected rule (threshold t(α), maximum over m candidates) wrongly suppress
distinct dispatches at a rate above α while the Bonferroni rule (t(α/m)) does
not? What does the correction cost on duplicate units?

## 2. Units

A unit is a dispatch x and an ordered list of m_max = 5 committed candidates.
Prefixes give nested sets m ∈ {1, 2, 3, 5}. Every candidate shares x's typed
projection σ, so the refuter passes it and it reaches the judge, as it would in
a deployment.

**Families** (one seed act → a series of sibling acts):
- `wire_money` (published declaration): an instalment or schedule series, e.g.
  instalment k of n, line items, billing cycles, against one invoice and payee.
- `send_email` (Experiment 2 realistic schema; same `to` and `thread_id`):
  successive status updates or distinct action requests in one thread.
- `create_ticket` (Experiment 2 realistic schema; same project, component, and
  priority): distinct defects in one component.

**Unit types:**
- **DIFF unit:** x is a sibling not yet committed (for example instalment 4
  when instalments 1–3 and two other siblings are committed). x is distinct
  from every candidate. Suppression is a wrong suppression.
- **SAME unit:** x is a paraphrased retry of exactly one candidate j (position
  drawn uniformly); the others are its siblings. Suppression is correct when
  the maximising candidate is j. Suppression via another candidate is a
  **response-attribution error** (the fence returns another act's response).

**Counts:** 40 DIFF units and 20 SAME units per family, so 120 DIFF and 60 SAME
in total. Seed acts are disjoint from the main corpus and from Experiment 2.

## 3. Generation and labels

- Generator: `meta-llama/llama-3.3-70b-versatile` (not an admitted-judge family),
  as in Experiment 2. Sibling acts are generated from a seed specification that
  fixes what distinguishes them. Paraphrased retries are generated from the
  committed candidate.
- Labels are **by construction** (which candidate, if any, x repeats). The
  author inspects every unit blind to model output and discards any unit whose
  constructed label they dispute.
- **Human labels.** The two Experiment 1/2 annotators label a seeded random
  sample of units (seed **20261003**): **15 DIFF and 5 SAME per family, 60 units
  in total**. Each annotator sees x and the candidate list and answers: "Which
  candidate, if any, does this request repeat? Would silently returning that
  candidate's recorded response leave an intended action undone?" They see no
  label, family stratum, or model output. Sampling, the exclusion rule (a
  sampled unit on which both annotators agree with each other and disagree with
  the constructed label is discarded) and reporting (κ; agreement with the
  constructed label, with Wilson intervals, as the estimate of label quality
  for all units) mirror Experiment 2 Amendment 2 §A2.5. Units outside the
  sample carry only the constructed, author-checked label.
- Session: a block of the combined Experiment 1/2 session if the units are
  frozen in time, otherwise a second session with the same annotators.

## 4. Freezing and stopping

- Units are frozen in `corpus/multi-candidate-hard-units.json`, with the
  SHA-256 committed before any judge call, and after the human sample and
  exclusions.
- No regeneration, replacement, or relabelling after any score is seen.

## 5. Scoring and thresholds

- Judges: `openai/gpt-oss-120b` (primary); `openai/gpt-oss-20b` and
  `qwen/qwen3.6-27b` (secondary, if rate limits allow; reported separately).
  Same prompt, pair formatting, temperature 0, and parsing as the existing
  scorer. Each (x, candidate) comparison is scored once.
- Thresholds (primary analysis): the deployed, jurisdiction-matched pooled
  calibration pool of the main corpus (primary judge n = 142), with the
  uncorrected t(α) and the Bonferroni t(α/m), α = 0.05. At n = 142 the budget
  certifies m ≤ 7, so every m tested is within budget.
- Secondary: the Experiment 2 tool-conditional pools for `send_email` and
  `create_ticket`, if Experiment 2 has been scored by then; otherwise omitted.

## 6. Metrics and tests

For each m ∈ {1, 2, 3, 5}, rule ∈ {uncorrected, Bonferroni}, and judge, overall
and per family:
- wrong suppression on DIFF units (Wilson 95%);
- deduplication, silent escape, and flagged escape on SAME units;
- response-attribution error on SAME units (ties at the maximum reported both
  ways).

**Primary test:** on DIFF units at m = 5, primary judge, an exact one-sided
McNemar test of uncorrected vs Bonferroni wrong suppression (paired by unit),
level 0.05.

## 7. Predictions and commitments

- **H1.** At m = 5 the uncorrected rule's wrong suppression on DIFF units is
  higher than the Bonferroni rule's (primary test significant).
- **H2.** The Bonferroni rule's wrong suppression at m = 5 is within α: the
  Wilson upper bound is reported against α, with the n = 120 power limit stated
  (0 errors → 3.1% upper bound).
- **H3.** The correction costs deduplication on SAME units; the size is
  reported, with no directional threshold.
- If the judge separates siblings so well that neither rule suppresses any DIFF
  unit, the result is reported as "no benefit of the correction on this judge
  under this construction", and the paper's claim stays the simulation-based
  one. If the Bonferroni rule also exceeds α, that is reported as a failure of
  the guarantee under same-seed candidates, alongside the exchangeability
  assumption it breaks (candidates in a unit are not independent draws from
  the calibration population).

## 8. Outputs

- `results/multi_candidate_hard.json`, regenerated offline from the frozen
  units and persisted scores.

---

## Amendment 1 (2026-10-03, pre-data)

**Status:** Made before any Experiment 4 unit is generated, labelled, or scored.
It applies the model substitutions of `PREREG_EXP2.md` Amendment 3 for the same
reasons (endpoint retirement; evidence in
`results/exp2_endpoint_checks_20261002.txt`). Where it conflicts with §3 or §5,
it supersedes them.

- **Generator** (supersedes §3): `gemini-3.8-flash`, temperature 1.0, default
  thinking, with no fallback, as in Experiment 2 §A3.1 (the verbatim `version`
  field, "3.0", is recorded there). It replaces `llama-3.3-70b-versatile`
  (HTTP 404 `model_not_found`, 2026-10-02).
- **Secondary judge** (supersedes §5): `qwen/qwen3.8-27b`, which replaces
  `qwen/qwen3.6-27b` (HTTP 404, 2026-10-02). It is used only if it passes the
  main-corpus admission check of Experiment 2 §A3.3. It is never pooled with,
  or reported as, Qwen3.6-27B.
- **Blind author check** (supersedes §3 "author inspects every unit"). The
  author checks each unit with the Experiment 2 §A3.2 labelling tool, or its
  unit form. It shows only the dispatch x and the candidate tool calls, with
  candidate order reshuffled per unit, and units in an order fixed by a seeded
  shuffle (seed 20261006). The constructed label, family stratum, seed act,
  and generation prompt are hidden, and the tool enforces this in the same way
  (separate key file, append-only labels, no revision). The author answers the
  §3 question for each unit. Units whose answer differs from the constructed
  label are discarded and reported. No model validator is used. The human
  sample in §3 then audits the remaining units.
- **Primary thresholds from the same scoring run** (supersedes §5
  "Thresholds"). For each judge, the calibration pool is the main corpus's
  jurisdiction-matched residual calibration pairs (DIFF for t_hi, SAME for the
  escalation floor) **re-scored in the same run as the Experiment 4 units**:
  one scorer invocation per judge, with the same prompt, model, and parameters,
  and pool and unit comparisons interleaved in one seeded random order (seed
  20261007). The uncorrected t(α) and the Bonferroni t(α/m) are both computed
  from this pool. Its size is reported, and m is tested only up to the budget
  it certifies (at n = 142, m ≤ 7). Thresholds from the persisted main-corpus
  scores are reported as secondary, with the scoring-context caveat of
  Experiment 2 §A3.4.
