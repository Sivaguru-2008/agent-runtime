# Preregistration: Experiment 2 (Prose-Native Residual Calibration Pools)

**Date:** 2026-10-02  
**Commit Status:** Preregistered prior to generation, validation, or scoring of expansion pairs  
**Author:** Anonymous (TMLR double-blind submission)  
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
- At least 10 pairs per tool authored manually by human developers to verify that synthetic generation artifacts or generator idiosyncrasies do not confound the result.

---

## 3. Schemas Tested: Realistic Typing vs. Loose Declarations

To test the thesis rigorously, we evaluate prose-native actions under realistic, well-declared schemas:
1. **`send_email` (Realistic Schema):**
   - Declared typed fields: `to` (policy `CI`), `subject` (policy `TEXT` / canonicalised), `thread_id` (policy `ID`).
   - Act-determining prose: `body` (policy `TEXT`).
   - Residual pairs share identical `to`, `subject`, and `thread_id`, surviving the refuter into the residual.
2. **`create_ticket` (Realistic Schema):**
   - Declared typed fields: `project` (policy `ID`), `component` (policy `CI`), `priority` (policy `CI`).
   - Act-determining prose: `title` (policy `TEXT`), `description` (policy `TEXT`).
   - Residual pairs share identical `project`, `component`, and `priority`, surviving the refuter into the residual.

This directly verifies the thesis: even when schema declarations are rigorous and realistic, the residual survives because the core act lives in prose.

---

## 4. Difficulty Strata with Fixed Proportions

To ensure evaluation is challenging and prevents trivial near-zero scores, distinct (`DIFF`) pairs are sampled in pre-specified proportions across two difficulty strata:

1. **Easy Stratum (30% of DIFF pairs):**
   - Differing high-level topic or intent (e.g., alert on service downtime vs. routine billing invoice update; payment gateway timeout vs. CSS rendering glitch).
2. **Hard Stratum (70% of DIFF pairs — Prose-Native Analogue of D2 Legitimate Repeats):**
   - Shared recipient/component, highly overlapping subject/title, related context, but fundamentally distinct real-world acts where suppressing the second call drops a necessary action.
   - *Email examples:*
     - Weekly status report for Week 41 vs. Week 42 (subtle metrics changes).
     - Initial urgent incident notification vs. follow-up escalation with specific remediation steps.
     - Two distinct payment receipt confirmations for consecutive invoices sent to the same client.
   - *Ticket examples:*
     - Two separate bugs in the same auth component with different reproduction steps or stack traces.
     - Customer reporting duplicate billing issue vs. same customer reporting refund dispute.
     - Server memory leak in worker process vs. worker process crash due to network timeout.

Wrong suppression and deduplication will be reported both overall and disaggregated per stratum.

---

## 5. Model Independence and Validation Protocol

To avoid self-recognition bias and prevent shared representations of "same act":
1. **Generator Model:**
   - Candidate pairs are generated by `claude-3-5-sonnet` (Anthropic) or `deepseek-v3` / `llama-3.3-70b-versatile` (Meta).
2. **Validator Model:**
   - An independent validator model from an entirely distinct family: `qwen-2.5-72b-instruct` or `gemini-1.5-pro`.
   - **Neither the generator nor the validator is one of the three admitted judges** (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.6-27b`).
3. **Validation and Exclusion Rule:**
   - The validator model evaluates each pair under the operational definition: *"Would silently returning the recorded response of request A in place of executing request B leave an intended action undone?"*
   - The author conducts a blinded manual inspection of all pairs.
   - **Exclusion Rule:** If the validator model and the author disagree on the label of a pair, that pair is discarded from the corpus. The total number of discarded pairs and the discordance rate will be explicitly reported.

---

## 6. Partitioning, Blinding, and Freezing

1. **Seed-Level Partitioning:**
   - Base scenarios, customer accounts, and incident entities are partitioned strictly into `cal` or `test` prior to generation. No seed or counterparty is shared across splits.
2. **Hash Freezing:**
   - The resulting dataset (`corpus/prose_native_exp2.jsonl`) will be frozen with its SHA-256 digest committed to Git *before* running any judge scoring.

---

## 7. Analysis Plan

1. **Admitted Judges:**
   - Primary: `openai/gpt-oss-120b`
   - Secondary: `openai/gpt-oss-20b`
   - Cross-family: `qwen/qwen3.6-27b`
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
5. **Commitment to Empirical Outcomes:**
   - If standalone prose-native tools achieve high deduplication with bounded wrong suppression ($\le \alpha$), this confirms that conformal calibration succeeds on prose-native tasks when the budget is satisfied.
   - If the hard stratum induces high false suppression, or if conservative thresholds ($\thi=1.00$) suppress deduplication, this result will be reported fully as evidence for the central thesis: schema typing, not stochastic judging, determines achievable guarantees.
