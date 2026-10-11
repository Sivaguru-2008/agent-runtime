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

---

## Amendment 3 (2026-10-03, pre-data)

**Status:** Made before any Experiment 2 data exists. At the time of this
commit, `corpus/prose_native_exp2.jsonl` does not exist and no generation,
labelling, or scoring call has been made for Experiment 2. The only model calls
made are endpoint checks with content-free prompts, recorded in
`results/exp2_endpoint_checks_20261002.txt`: three Groq calls (one per model
below) and three Gemini smoke-test calls. Where this amendment conflicts with
§5, §7, Amendment 2 §A2.2, or §A2.5, it supersedes them.

### A3.1 Generator: `gemini-3.8-flash` (supersedes §5.1 "Generator")

- **Reason (endpoint retirement).** `llama-3.3-70b-versatile` returns HTTP 404
  `model_not_found` on Groq (live call, 2026-10-02T18:16:07Z), and it is absent
  from Groq's model listing. The `gpt-4o-mini` fallback is removed because no
  credit is available for it.
- **Model.** Exact model ID string: **`gemini-3.8-flash`**, recorded
  2026-10-02. The models-list response for this model, verbatim (fields in
  order: name | displayName | version | description):

  ```
  models/gemini-3.8-flash | Gemini 3.8 Flash | 3.0 | Gemini 3.8 Flash
  ```

  The single-model GET response, verbatim excerpt:

  ```
  "name": "models/gemini-3.8-flash",
  "version": "3.0",
  "displayName": "Gemini 3.8 Flash",
  ```

  The `modelVersion` field returned on both generation calls was
  `"gemini-3.8-flash"`. The `version` field is recorded as returned. This study
  does not interpret it.
- **Selection rule.** From the models the key lists on 2026-10-02 that support
  `generateContent`, preview models, moving aliases (`*-latest`), and
  media-specialised or agent models were excluded. The newest generation among
  the rest was chosen. The only stable Pro-tier model is `gemini-2.5-pro`
  (June 2025); `gemini-3.1-pro-preview` is a preview. Choosing the newest
  generation over the older Pro tier is a judgement based on release
  generation, not on a benchmark run for this study.
- **Independence.** Gemini is neither a GPT-OSS nor a Qwen model, so the §5
  independence requirement still holds.
- **Parameters.** Temperature 1.0 (the model's listed default) and default
  thinking. The generation prompts are committed in the generation script
  before its first generation call.
- **No fallback generator.** If `gemini-3.8-flash` becomes unavailable during
  generation, generation stops. Any substitution needs a further amendment
  before generation resumes, and pairs from each model are reported
  separately.

### A3.2 No model validator; blind author labels audited by humans (supersedes §5.1 "Validator" and §5.2)

- **Reason (documented model failure).** As a judge on the main corpus,
  `allam-2-7b` scored 0 of 1,066 pairs and failed all three clauses of the
  admission rule (coverage, resolution, signal; Table `tab:s4a`). A model that
  cannot produce a usable score on this task is not a credible label
  validator.
- **Labels are author-assigned.** There is no model validator, and the §5.2
  validator–author disagreement rule and validator-agreement reporting are
  withdrawn.
- **Blind labelling, enforced by the tool.** The author labels every pair with
  a labelling tool committed before labelling begins. The tool:
  - reads a labelling file holding only an opaque pair id and the two tool
    calls (tool name and arguments). The intended label, stratum, split, seed
    act, and generation prompt are in a separate file that the tool never
    opens;
  - presents pairs one at a time, in an order fixed by a seeded shuffle (seed
    20261004), with the two calls in random A/B order;
  - shows nothing else: no model output, no score, and no running tally by
    stratum;
  - writes each label with a timestamp to an append-only file and does not
    allow a label to be revised after the next pair is shown.

  Labels are joined to the intended labels only after every pair is labelled.
  A pair whose author label differs from its intended label keeps the author
  label, and every such disagreement is reported. The author wrote the
  generation specification and knows the strata in general; the blinding is per
  pair.
- **Audit.** The §A2.5 human sample (24 hard DIFF, 6 easy DIFF, and 10 SAME per
  tool, seed 20261002) audits the author labels. It is drawn after author
  labelling and stratified by intended stratum. Its drop rule applies
  unchanged: a sampled pair on which both annotators agree with each other and
  disagree with the author label is discarded before freezing. In §A2.5,
  "validator–author label" now reads "author label". Pairs outside the sample
  carry the author label only. The sample's agreement rate is reported as the
  estimate of corpus label quality.

### A3.3 Cross-family judge: `qwen/qwen3.8-27b` (reverses §A2.2)

- **Reason (endpoint retirement).** `qwen/qwen3.6-27b`, the model behind every
  existing Qwen result, returns HTTP 404 `model_not_found` (live call,
  2026-10-02T18:16:08Z). `qwen/qwen3.8-27b` answers (HTTP 200,
  2026-10-02T18:16:08Z) and is the only Qwen model Groq lists. §A2.2 was written
  without a live call; its "typing error" claim was wrong, and the ID in §5.1
  and §7.1 was the available model.
- **Not yet admitted.** `qwen/qwen3.8-27b` is a different model from the
  admitted Qwen3.6-27B. Before any Experiment 2 scoring, it is scored on the
  main corpus (1,066 pairs, the existing scorer and prompt) and must pass the
  `tab:s4a` admission rule (coverage ≥ 80%, at least two distinct score values,
  AUC ≥ 0.60). If it fails, it is reported as a non-admitted judge and excluded
  from the Experiment 2 primary analysis. It is never pooled with, or reported
  as, Qwen3.6-27B.
- The GPT-OSS judges (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`) are listed by
  the Groq models endpoint on 2026-10-02 and are unchanged.

### A3.4 Primary calibration: per tool, same scoring run (supersedes §7.4 "Comparison")

- **Primary.** For every judge and each tool (`send_email`, `create_ticket`),
  the threshold is calibrated on that tool's own Experiment 2 calibration split
  (residual DIFF pairs, n ≥ 60, so m* = 3 at α = 0.05; the SAME calibration
  pairs set the escalation floor). The calibration and test splits are scored
  in **the same scoring run**: one invocation of the scorer per judge, with the
  same prompt, model, and parameters, and calibration and test comparisons
  interleaved in one seeded random order (seed 20261005). Every primary metric
  (WS, deduplication, per-stratum rates, certifiability) uses these
  thresholds.
- **Secondary.** Pooled calibration with the main corpus's residual pool
  (persisted scores; for `qwen/qwen3.8-27b`, the scores from its admission run)
  is reported for comparison, with a scoring-context caveat. Those calibration
  scores come from an earlier run than the Experiment 2 test scores. The
  scoring-context stability experiment (Section `sec:res-stability`) found
  that re-scoring identical pairs at temperature 0 changes most scores and
  moves residual wrong suppression between 4, 6, and 8 of 144. Exchangeability
  across runs is therefore not assumed, and the secondary result is not used
  for any guarantee.

---

## Amendment 4 (2026-10-11, Pre-Scoring): Generator Transition to `qwen/qwen3.8-27b`

### A4.1 Generator Model: `qwen/qwen3.8-27b` (supersedes §A3.1)

- **Reason (daily quota exhaustion).** Generating the required candidate pool (approx. 180 calls total across seeds and variant expansions) exceeded the Gemini free-tier project allowance (capped at 20 requests/day for `gemini-3.8-flash`, returning HTTP 429 with ~14-hour retry delays).
- **Model.** Exact model ID string: **`qwen/qwen3.8-27b`** via Groq API.
- **Independence & Self-Recognition Check.**
  - The primary judge (`openai/gpt-oss-120b`) and secondary judge (`openai/gpt-oss-20b`) are developed by OpenAI (GPT-OSS architecture), which is an entirely independent model family from Alibaba Tongyi Qwen. There is **zero shared model family or self-recognition bias** on the primary or secondary judges.
  - For the cross-family judge (`qwen/qwen3.8-27b`), because generator and judge share the model family, self-recognition effects are explicitly evaluated as a preregistered secondary analysis (comparing Qwen-judged deduplication and wrong suppression against GPT-OSS).
- **Prompts & Validation.** Prompts, schemas, mechanical refuter checks ($\sigma$), canonical equivalence filters, and blind labelling procedures remain verbatim as frozen in Amendment 3. All generated pairs are validated mechanically and blind-labelled before any judge scoring.

