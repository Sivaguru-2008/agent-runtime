# Preregistration: Experiment 2 (Prose-Native Residual Calibration Pools)

**Date:** 2026-10-02  
**Commit Status:** Preregistered prior to generation, validation, or scoring of expansion pairs  
**Author:** The Author (TMLR double-blind submission)  
**Objective:** Expand the calibration and test evaluation corpora for prose-native tools (`send_email` and `create_ticket`) to evaluate whether they can achieve self-contained, tool-conditional certification under the conformal framework without cross-tool pooling.

---

## 1. Motivation and Hypothesis

The paper's central thesis is that the tool's declared schema, not the judge, determines what can be guaranteed about duplicate suppression. For prose-native tools, act-determining semantics reside inherently in natural-language text (`body` for `send_email`; `description` for `create_ticket`). Typing the non-prose fields shrinks the residual through the refuter, but cannot empty it.

In the original corpus, `send_email` possesses only $n=13$ residual distinct calibration pairs and `create_ticket` possesses only $n=6$. At nominal level $\alpha=0.05$ and candidate multiplicity $m=1$, the minimal calibration budget is $n \ge \lceil 1/0.05 \rceil - 1 = 19$. Consequently, tool-conditional calibration under the original data forces $\thi = +\infty$, safely switching semantic suppression off.

**Hypothesis:** Expanding each tool's residual distinct calibration pool to $n \ge 60$ pairs will enable standalone, tool-conditional calibration (certifiable up to $m=3$). Scoring these residual pools across admitted judges will measure the empirical tradeoff: whether the residual judge achieves high deduplication without exceeding $\alpha$ on prose-native acts, or whether judge noise and semantic nuance degrade performance when act-determining semantics live purely in unstructured text.

---

## 2. Target Quantities and Composition

For each tool (`send_email`, `create_ticket`):

### 2.1 Calibration Set (`cal`)
- **Residual Distinct (`DIFF`) Pairs:** Target $\ge 60$ pairs per tool.
  - Sized to certify $m=1$ ($\ge 19$), $m=2$ ($\ge 39$), and $m=3$ ($\ge 59$).
- **Duplicate (`SAME`) Pairs:** At least 30 pairs per tool to inspect calibration operating points.

### 2.2 Held-Out Test Set (`test`)
- **Residual Distinct (`DIFF`) Pairs:** Target $\ge 60$ pairs per tool to measure tool-conditional wrong suppression ($\WS$).
- **Held-Out Duplicate (`SAME`) Pairs:** Target $\ge 60$ pairs per tool to measure deduplication ($\mathrm{Dedup}$). Without held-out duplicate test pairs, usefulness (deduplication) cannot be measured.

### 2.3 Hand-Written Benchmark Arm
- At least 10 pairs per tool authored manually by the author to verify that synthetic generation artifacts or generator idiosyncrasies do not confound the result.

---

## 3. Realistic Schema Declarations and Exact Projections

To test the thesis rigorously, we evaluate prose-native actions under realistic, well-declared schemas:

1. **`send_email` (Realistic Schema):**
   - Declared fields:
     - `to`: policy `CI` (case-insensitive email token, in $\sigma$).
     - `thread_id`: policy `ID` (opaque thread identifier, in $\sigma$).
     - `subject`: policy `TEXT` (canonicalized under whitespace collapse, but **not** in $\sigma$ — free text).
     - `body`: policy `TEXT` (act-determining free text, **not** in $\sigma$).
   - **Typed Projection $\sigma$:** $\sigma(\text{input}) = (\text{canonical}(\texttt{to}), \text{canonical}(\texttt{thread\_id}))$.
   - **Mechanical Refuter Rule:** Every residual pair $(a, b)$ must satisfy $\sigma(a) = \sigma(b)$ exactly (same recipient and same thread ID), verified mechanically by `canonicalize.js` before freezing. Pairs with differing `to` or `thread_id` are refuted at L0 and never enter the residual.

2. **`create_ticket` (Realistic Schema):**
   - Declared fields:
     - `project`: policy `ID` (opaque project key, in $\sigma$).
     - `component`: policy `CI` (subsystem identifier, in $\sigma$).
     - `priority`: policy `CI` (priority tier, in $\sigma$).
     - `title`: policy `TEXT` (free text summary, **not** in $\sigma$).
     - `description`: policy `TEXT` (act-determining issue body, **not** in $\sigma$).
   - **Typed Projection $\sigma$:** $\sigma(\text{input}) = (\text{canonical}(\texttt{project}), \text{canonical}(\texttt{component}), \text{canonical}(\texttt{priority}))$.
   - **Mechanical Refuter Rule:** Every residual pair $(a, b)$ must satisfy $\sigma(a) = \sigma(b)$ exactly (same project, component, and priority), verified mechanically by `canonicalize.js` before freezing. Pairs with differing typed values are refuted at L0 and never enter the residual.

---

## 4. Difficulty Strata with Fixed Proportions

To ensure evaluation is challenging and prevents trivial near-zero scores, distinct (`DIFF`) pairs are sampled in pre-specified proportions across two difficulty strata:

1. **Easy Stratum (30% of DIFF pairs):**
   - Differing high-level topic or intent within the same recipient/thread or project/component (e.g., initial invoice notification vs. security policy update sharing a thread; authentication crash vs. frontend styling bug in the same component).
2. **Hard Stratum (70% of DIFF pairs — Prose-Native Analogue of D2 Legitimate Repeats):**
   - Identical typed-field projections ($\sigma$), highly overlapping context or subject, but fundamentally distinct real-world acts where suppressing the second call drops a necessary action.
   - *Email examples sharing the exact same `to` and `thread_id`:*
     - Two distinct status updates in the same ongoing incident thread (e.g., update 1: root cause identified; update 2: rollback deployed).
     - A gentle reminder vs. an entirely new action item requested in the same email thread.
     - Two distinct bug fix confirmations for consecutive patches discussed in the same client communication thread.
   - *Ticket examples sharing the exact same `project`, `component`, and `priority`:*
     - Two separate bugs in the same auth component with different reproduction steps or error logs (e.g., OAuth token expiry race condition vs. SAML assertion malformed XML).
     - Customer reporting duplicate billing issue vs. same customer reporting subscription cancellation in the same billing component.
     - Worker process out-of-memory crash vs. worker process deadlock on database connection pool.

Wrong suppression and deduplication will be reported both overall and disaggregated per stratum.

---

## 5. Model Independence and Validation Protocol

To avoid self-recognition bias and prevent shared representations of "same act":
1. **Model Commitments:**
   - **Generator:** `meta-llama/llama-3.3-70b-versatile` (or `gpt-4o-mini` if Groq Llama is unavailable).
   - **Validator:** `allam-2-7b` (independent Arabic/English multilingual foundation model from SDAIA/IBM, verified reachable and distinct from the judge families).
   - **Admitted Judges:** `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`.
   - **Neither the generator nor the validator belongs to the admitted judge families** (neither is GPT-OSS nor Qwen), preventing self-recognition bias and shared model priors.
2. **Validation and Exclusion Rule:**
   - The validator model evaluates each pair under the operational definition: *"Would silently returning the recorded response of request A in place of executing request B leave an intended action undone?"*
   - The author conducts a blinded manual inspection of all pairs.
   - **Exclusion Rule:** If the validator model and the author disagree on the label of a pair, that pair is discarded from the corpus.
   - **Reporting Agreement:** We will report the full confusion matrix, Cohen's $\kappa$, raw percent agreement between validator and author, and the total discard count.

---

## 6. Partitioning, Blinding, and Freezing

1. **Seed-Level Partitioning:**
   - Base scenarios, customer accounts, and incident entities are partitioned strictly into `cal` or `test` prior to generation. No seed or counterparty is shared across splits.
2. **Stopping Rule:**
   - No regeneration, replacement, rescoring, or re-validation is permitted after any judge score is seen. The dataset is final upon freezing.
3. **Hash Freezing:**
   - The resulting dataset (`corpus/prose_native_exp2.jsonl`) will be frozen with its SHA-256 digest committed to Git *before* running any judge scoring.

---

## 7. Analysis Plan and Statistical Power

1. **Admitted Judges:**
   - Primary: `openai/gpt-oss-120b`
   - Secondary: `openai/gpt-oss-20b`
   - Cross-family: `qwen/qwen3.8-27b`
2. **Scoring Protocol:**
   - Identical system prompt, pair formatting, temperature ($T=0$), and strict integer-percentage response parsing as established in `src/experiments/`.
3. **Significance Levels:**
   - $\alpha = 0.05$ (primary) and $\alpha = 0.01$ (tightened).
4. **Primary Metrics Reported:**
   - Per-tool certifiability ($m^* = \lfloor \alpha(n+1) \rfloor$).
   - Per-tool threshold $\thi(m)$.
   - Tool-conditional residual wrong suppression ($\WS$) and deduplication ($\mathrm{Dedup}$).
   - Disaggregated metrics for Easy vs. Hard strata.
   - Comparison: Deployed pooled calibration vs. standalone tool-conditional calibration.
5. **Statistical Power Limitation:**
   - With $N=60$ distinct test pairs, observing 0 wrong suppressions yields a 95% Wilson confidence interval upper bound of $[0.0\%, 6.0\%]$. A zero error rate therefore cannot distinguish $\WS = 0.02$ from $\WS = 0.05$, but suffices to detect substantial violations ($\WS > 0.06$). This power limitation is preregistered in advance.
6. **Commitment to Empirical Outcomes:**
   - If standalone prose-native tools achieve high deduplication with bounded wrong suppression ($\le \alpha$), this confirms that conformal calibration succeeds on prose-native tasks when the budget is satisfied.
   - If the hard stratum induces high false suppression, or if conservative thresholds ($\thi=1.00$) suppress deduplication, this result will be reported fully as evidence for the central thesis: schema typing, not stochastic judging, determines achievable guarantees.

---

## Amendment 2 (2026-10-02, pre-data)

**Status:** Made before any Experiment 2 pair has been generated, validated, or
scored (`corpus/prose_native_exp2.jsonl` does not exist at the time of this
commit). Where this amendment conflicts with the sections above, it supersedes
them. Nothing else changes.

### A2.1 Larger held-out distinct test set (supersedes §2.2 DIFF target and §7.5)

- **Test DIFF pairs:** at least **140 per tool** (was 60), in the §4 proportions:
  at least 98 hard and at least 42 easy.
- Calibration DIFF (≥ 60 per tool), calibration SAME (≥ 30), and test SAME
  (≥ 60) are unchanged.
- **Reason:** at n = 60, zero wrong suppressions bounds WS only at 6.0%
  (95% Wilson), which does not exclude a violation of α = 0.05. The revised
  power statement:

  | test DIFF n | 0 errors | 1 error | 2 errors | 3 errors |
  |---|---|---|---|---|
  | 60 (original) | 6.0% | 8.9% | 11.4% | 13.7% |
  | 140 (amended) | 2.7% | 3.9% | 5.1% | 6.1% |

  At n = 140, up to one error per tool shows WS below α = 0.05. Two or more
  errors cannot separate WS from α, and that is reported as such.
- The same per-stratum Wilson intervals are reported for the hard stratum alone
  (n ≥ 98: 0 errors → 3.8%).

### A2.2 Judge identifier correction (supersedes §5.1 and §7.1)

The cross-family judge is `qwen/qwen3.6-27b` (result key `qwen_qwen3_6_27b`),
the model used for every existing result. "`qwen/qwen3.8-27b`" above was a
typing error. No model has been called for Experiment 2.

### A2.3 Wording correction (§3)

Pairs whose typed projections differ are settled by the **refuter** (the
distinctness witness σ), not "at L0". L0 is the certifier (canonical equality).
The mechanical rule itself is unchanged.

### A2.4 Hard-stratum integrity (adds to §4 and §6)

- Hardness is defined by the generation specification in §4 plus the mechanical
  σ-equality check alone. Pairs are never moved between strata, softened, or
  regenerated because of how easy or hard they look to the author or the
  validator. The author's blinded inspection (§5.2) rules on the label only.
- After scoring, the distribution of every admitted judge's scores on hard-
  stratum DIFF pairs is reported (median, 90th percentile, share above the
  calibrated threshold), so a reader can see whether the stratum was hard in
  effect. If the median hard-DIFF score is below 0.10 for every judge, the
  paper says that the stratum did not test the judge, rather than presenting a
  pass as evidence.

### A2.5 Human validation of labels (adds to §5)

- **Sample.** After generation and after the §5.2 validator–author exclusion,
  and before any judge scores a pair, a stratified random sample is drawn per
  tool from the validated pool by a seeded generator:

  | stratum | per tool | both tools |
  |---|---|---|
  | hard DIFF | 24 | 48 |
  | easy DIFF | 6 | 12 |
  | SAME | 10 | 20 |
  | **total** | **40** | **80** |

  Seed: **20261002**. Within each stratum, pairs are drawn uniformly without
  replacement from the calibration and test splits together. The drawn ids and
  the seed are committed before the annotation session.
- **Annotators.** Two human annotators who are not the author and had no part in
  generation label the sample independently. They see the two inputs and the
  §5.2 operational question and nothing else: no label, stratum, split, or model
  output.
- **Combined with Experiment 1.** The same two annotators label the
  Experiment 1 sheet (`human_validation_package/`, frozen under its own
  preregistration) and this sample in **one session**. Each experiment is a
  separate block with its own instructions. Items are randomly ordered within
  each block, and no item appears in both. The Experiment 4 sample
  (`PREREG_EXP4.md`) is a third block of the same session if its units are
  frozen by then. Otherwise the same two annotators label it in a second
  session.
- **Exclusion rule (in addition to §5.2).** A sampled pair on which both
  annotators agree with each other and disagree with the validator–author label
  is discarded before freezing. Every such discard is reported.
- **Scope of the human check.** Pairs outside the sample carry only the
  validator–author label. The author is the only human who has judged them. The
  sample's agreement rate with the validator–author label, overall and per
  stratum with Wilson intervals, is reported as **the estimate of label quality
  for the whole corpus**. It is not presented as a check of every pair.
- **Reported.** Human–human Cohen's κ and raw agreement; each annotator's
  agreement with the validator–author label, overall and per stratum; and the
  discard count.
- **Ordering.** Freezing waits until both annotators have completed the sample.
  No pair is scored before human labels exist on the sample.
