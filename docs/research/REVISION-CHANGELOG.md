# Revision changelog — evidence-gap closure round

**Date:** 2026-08-24
**Scope:** `docs/research/Semantic-Effect-Identity-Paper.md` and `research/effect-identity/`.

Build gate at completion:

| gate | result |
|---|---|
| `npm test` | **61/61 pass** |
| `src/experiments/verify.js` | **OK — 11 assertion classes hold** |
| `src/experiments/checkPaper.js` | **313 quoted intervals, 139 distinct, all matched** |
| `src/experiments/annotationFreeze.js --verify` | **ok — 154 items, 0 drifted** |

---

## Task 1 — Validate the ground truth

**Done, with one part not done and stated as such.**

| step | outcome |
|---|---|
| 1a freeze | `annotation/FREEZE.json` — 154 items, per-item SHA-256, sheet hash `66a174e1…`. Verified deterministic (re-export byte-identical). |
| 1b preregistration | `annotation/PREREGISTRATION.md`, committed **before any judgement existed** (`82274ec`). |
| 1c instrument | `annotation/instrument.html` — self-contained, one pair per screen, forced ternary, per-annotator order + side randomisation, CSV keyed by item ID, 3 mechanically-chosen catch trials. Verified end-to-end in a browser. |
| 1d collection | **3 blinded annotators + 1 blind adjudicator, all passing all 3 catch trials.** They are **models, not humans**. |
| 1e ingest | `results/human_annotation.json` → `COMPLETE`; verifier assertion strengthened. |

**The part not done.** No independent *human* annotators were available. Rather
than fabricate responses, the study ran as an explicitly-labelled **Channel M
(model panel)**; Channel H is shipped unrun. The manuscript names it a model
panel everywhere, and `verify.js` now **fails the build** if the manuscript ever
describes it as a completed human study.

**Results (§8.16, new section):**

- Krippendorff α **0.828**, Fleiss κ 0.827, pairwise Cohen's κ 0.862 / 0.812 / 0.811
- Overall construction agreement **87.9% [80.8–92.7]**; adjudication rate **0.0%**
- **D2 (`diff_text_only`) is CONTESTED at 50.0% [25.4–74.6]** — pre-declared in
  the preregistration as most likely to be. Reported, not resolved by fiat.
  `attack_text` also contested at 45.5% [21.3–72.0].
- **13 of 14 label flips fall in prose-only categories.** None in a category the
  certifier or refuter decides.
- Re-derivation: WS 9.9% → **10.5%** under panel labels; dedup 77.8% → 61.0%.
- **The preregistered decision rule triggered against the paper** and is reported
  as triggered; the abstract was amended accordingly.
- Sensitivity dropping the panelist that is also a reported judge: α **rises** to
  0.863, agreement to 91.7%.

**Files:** `annotation/{FREEZE.json,PREREGISTRATION.md,instrument.html,catch-trials.json,panel-manifest.json,responses-*.csv}`,
`src/experiments/{annotationFreeze,buildInstrument,annotationPanel}.js`,
`src/experiments/annotation.js` (freeze gate, catch-trial exclusion, channel, sensitivity),
`src/experiments/verify.js`.
**Sections:** §7.1, §7.4, **§8.16 (new)**, §1.5 gap table, abstract, §13.

---

## Task 2 — Mechanism claim, not vendor claim

**Done.**

- Qwen3.6-27B resumed from 482 → **1041/1066 (97.7%)** coverage. The 25
  abstentions are completion-budget failures, recorded `null`, never imputed.
- `residualCalibration.js` now scores **all three** admitted judges, so §8.3,
  §8.8 and §8.10 are three judges over two vendors in the **main** tables.
- Cross-family common subset **218 → 930 pairs** (443 test).
- Judge-admission rule re-run; nothing entered on abstentions.

| judge (hardened, α=0.05) | WS | dedup |
|---|---|---|
| GPT-OSS-120B | 1.7% [0.7–4.3] | 94.7% [91.4–96.7] |
| GPT-OSS-20B | 1.3% [0.4–3.7] | 82.6% [77.7–86.6] |
| **Qwen3.6-27B** | **0.9% [0.2–3.1]** | **89.0% [84.8–92.1]** |

**One headline corrected downward.** The abstract's "deduplication varies
seven-fold" was a small-pool calibration artifact of the 218-pair subset (the
saturated 20B's `t_hi` pinned at 1.0). At full coverage the spread is **twelve
points**. Corrected in the abstract, §8.8, §8.14, §13, and logged as errata E1.

**Sections:** §8.1, §8.8 (rewritten), §8.14, §9.3, §10, §11, abstract, §13.

---

## Task 3 — No half-states

**Done — by cutting, on measured evidence.**

Measured the cost of scoring the 14-tool surface: **~57s/pair** on the primary
judge (long tool manifests, reasoning model), i.e. **~15 hours for one judge**
on 1,043 pairs, with §8.1's admission rule wanting a second. Cut instead.

- §9.2 replaced with a short, honest statement of *why* a described-but-unscored
  apparatus was the wrong thing to print.
- The two apparatuses appear **once**, in §9.3, as future work.
- §1.5's "built and reported as PENDING" claim removed.

**Done-condition:** zero hits for `awaiting`, `not yet scored`,
`built and reported as` anywhere in the manuscript; zero status-`PENDING` in
§7/§8/§9.2. The 5 remaining `PENDING` tokens are the **fence's durable log
state** from Algorithm 1 (§5.5, §6.4 remark, §8.7, §11 P3) — protocol
vocabulary, deliberately not renamed to satisfy a grep.

---

## Task 4 — Kill the tiny load-bearing cells

**Done.** Growth is **additive**: 111 new pairs, **0 existing pairs modified**,
which is why the frozen annotation sheet still verifies against the grown corpus.

| cell | before | after | test-split effect |
|---|---|---|---|
| **S3** (motivating example) | 15 (8 test) | **75 (38 test)** | 100% suppression; lower Wilson bound **67.6% → 90.8%** |
| **D3** | 10 (5 test) | **61 (31 test)** | WS **0.0% [0.0–43.4] → 6.5% [1.8–20.7]** |

**The bigger D3 cell found a real error the small one hid.** It is the only
category whose point estimate sits above the declared α, and it sits exactly
where the theory says it should — pure residual.

**A live defect found and fixed.** §8.3's per-category table was printed under
the **jurisdiction-mismatched** pool while headed "hardened, α=0.05". Its SAME
rows summed to 100% against a headline of 94.0%. Corrected: S2 100.0→92.9%,
S4 100.0→92.7%, D2 5.3→1.3%. The dependent claim "wrong suppression concentrates
in D2" is withdrawn — it concentrates in **D3**. Logged as errata E2, E3.

**Files:** `src/corpus/{growthSeeds,grow}.js`, `corpus/growth-manifest.json`,
`corpus/pairs.jsonl`, `corpus/scores.jsonl`, `repro.config.json`.
**Sections:** §7.1, §8.3 (table + per-category + all three cell claims), §8.9.

---

## Task 5 — Close the seed-act leakage threat

**Done, and it moved — reported, not buried.**

`src/experiments/seedSplit.js` partitions the **219 distinct seed acts** first
and lets every pair follow its seed: leakage **0.0% by construction** (was
82.8%). Because whole seeds move together, 200 draws are reported rather than one.

| judge | pair-split WS | seed-split WS (mean) | p95 | draws exceeding α |
|---|---|---|---|---|
| GPT-OSS-120B | 1.7% | **2.7%** | 5.2% | **10.5%** |
| GPT-OSS-20B | 1.3% | **2.2%** | 4.2% | 1.0% |
| Qwen3.6-27B | 0.9% | **1.8%** | 5.7% | **11.0%** |

Wrong-suppression rises on **every** judge (≈1.5–2×): the shipped pair-level
split was mildly **optimistic** about the safety-critical rate. Deduplication is
unaffected. §8.14 now tells a practitioner to take **2.7% mean / 5.2% p95**, not
1.7%. Logged as errata E11.

**Files:** `src/experiments/seedSplit.js`, `results/seed_split.json`,
`src/experiments/checkPaper.js` (new result sources).
**Sections:** §8.14.

---

## Task 6 — Scope and framing

**Done.**

- **Abstract: 1,085 → 399 words**, results-first. States what is proved and what
  is measured; the argument-with-itself is gone.
- **Guarantees (A)/(B)/(C) stated in a box at the top of §1**, 893 words into the
  document — well inside page 2.
- **Self-litigation moved out** of the abstract and conclusion into
  **§14, "Errata from prior revisions"** — 11 entries (E1–E11), each with what
  changed, why, and where. The honesty is preserved and contained.
- **`docs/research/SPLIT-RECOMMENDATION.md`** — a memo, not an action. Full
  outline and word count for a ~9–11k theory paper and a ~11–13k systems paper,
  a table showing how §8 gets from 16,689 to ~4,500 words, and an explicit case
  *against* splitting now (three cross-cutting results, chiefly §8.16, are
  materially weaker in either half than in one). **Recommendation: split after
  the human channel and a third vendor land, not before.**

---

## Claims adjusted downward

Recorded here as well as in §14, because these are the entries a reader should
see first:

1. **"Deduplication varies seven-fold"** → twelve points (E1).
2. **"Wrong suppression concentrates in D2"** → withdrawn; it concentrates in D3 (E3).
3. **D3 wrong-suppression 0.0%** → **6.5% [1.8–20.7]** on the enlarged cell (E4).
4. **Per-tool calibration costs 19 points of dedup** → 5 points (E5).
5. **Safety claim under independent relabelling** → the preregistered test
   declares it **not to survive** on the annotated subset (§8.16).
6. **Wrong-suppression under the strictest split** → 1.7% → **2.7% mean**, α
   exceeded on 10.5% of seed-level splits (E11).
7. **Human validation** → not collected; instrument shipped unrun.

## Not done

- **Independent human annotation (Channel H).** No annotators available. The
  instrument is built and verified; the claim is stated as uncollected, and a
  build assertion prevents the model panel being described as a human study.
- **A third judge vendor.** The Llama arm never cleared 6.3% coverage before the
  endpoint was withdrawn. §9.3 now names *this* as the open gap, in place of the
  full-coverage cross-family comparison that Task 2 closed.
- **The 14-tool surface and 11-class attack matrix.** Cut, not scored; cost
  measured at ~15 hours per judge (Task 3).
