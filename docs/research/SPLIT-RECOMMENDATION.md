# Split recommendation — "Effect Identity for Non-Deterministic Agents"

**Status: a recommendation, not an action.** Nothing has been split. This memo
exists so the decision is made deliberately, with a concrete outline and a word
count for each half, rather than by a reviewer noticing the problem first.

**Date:** 2026-08-24
**Current manuscript:** 48,193 words, 121 references, 14 sections + appendix.

---

## 1. The problem, measured

| section | words | belongs to |
|---|---:|---|
| Abstract | 415 | both |
| 1. Introduction | 3,010 | both |
| 2. Related Work | 4,182 | split (theory ~40% / systems ~60%) |
| 3. Problem Formulation | 1,514 | theory |
| 4. Effect-Identity Framework | 3,042 | **theory** |
| 5. Proposed Fence | 1,753 | **systems** |
| 6. Theoretical Analysis | 5,215 | **theory** |
| 7. Experimental Methodology | 2,741 | **systems** |
| 8. Results | **16,689** | **systems** |
| 9. Discussion | 2,701 | split |
| 10. Threats to validity | 770 | systems |
| 11. Limitations and non-claims | 843 | split |
| 12. Reproducibility and artifact | 1,044 | systems |
| 13. Conclusion | 926 | both |
| 14. Errata | 800 | systems |
| References | 2,295 | split |

**§8 alone is 16,689 words — 35% of the paper, and larger than a typical
conference paper in its entirety.** §4 + §6 together are 8,257 words and are a
self-contained theory contribution that never once needs a Groq API key.

The diagnosis is not "too long". It is that the two halves have **different
units of contribution, different reviewers, and different failure modes**:

- The theory half is falsified by a counterexample to T4/T6/T7. Corpus size is
  irrelevant to it.
- The systems half is falsified by a judge, a corpus, or a split. The theorems
  are background for it.

A reviewer competent to referee one is, in the general case, not the reviewer
you want for the other — and right now each half is being asked to carry the
other's page budget.

---

## 2. Paper A (theory) — *"Effect Identity: Certifiers, Refuters, and the Calibrated Residual"*

**Target length: ~9,000–11,000 words.** Venue shape: a PL/distributed-systems
theory venue, or the theory track of a systems venue.

### Outline

1. **Introduction** (~1,800). The identity question behind every duplicate-
   suppression mechanism; the paraphrased-retry failure as *motivation only*,
   one worked example, no rates.
2. **Related work as a design space** (~1,700). §2.7–2.8's four-axis framing
   and the G1–G4 gap table. Drop the per-system systems detail.
3. **Problem formulation** (~1,500). §3 essentially unchanged.
4. **The framework** (~3,000). §4 unchanged: the effect algebra, certifier/
   refuter duality (Def. 4–5), the residual (Def. 6), Proposition 1, the design
   space, the hazard taxonomy.
5. **Results** (~3,500). T4 (impossibility), **T6 (residual determination)** and
   its corollary T6.3′ (the refinement dilemma), **T7 (composition structure)**,
   T2, T5. T1 and T3 appear as *statements* with proofs deferred to Paper B,
   since both are about a specific mechanism.
6. **What the theory predicts, and one measurement per prediction** (~800).
   This is the crucial section and the reason the split is safe. Three numbers,
   no tables: schema refinement closes an injection class *by construction*
   while costing deduplication (T6.3′); wrong-suppression bounded and
   deduplication unbounded across three judges (T4 + T7); and disagreement
   among independent readers concentrating in the residual (T6 — §8.16's
   13-of-14 result, which is the theory's most surprising confirmation and
   costs one paragraph to state).
7. **Conclusion** (~500).

### What Paper A must NOT do
Report an evaluation. Every rate it cites is a forward reference to Paper B
with a one-line apparatus note. If Paper A cannot survive on T4/T6/T7, adding
corpus numbers will not save it.

---

## 3. Paper B (systems/eval) — *"A Layered Semantic Fence for Paraphrased Replay of Irreversible Tool Calls"*

**Target length: ~11,000–13,000 words.** Venue shape: a systems or applied-ML
venue with an artifact track.

### Outline

1. **Introduction** (~1,500). The double-wire failure, concretely. States the
   theory's three definitions in half a page and cites Paper A for why they are
   forced.
2. **Related work: mechanisms** (~2,500). Durable execution, content-addressed
   fencing, idempotency keys, Atomix, verified tool calls, ACRFence, CapLease.
3. **The fence** (~1,800). §5 unchanged: L0/L1/L2, the distinctness witness,
   Algorithm 1.
4. **Correctness of the instantiation** (~1,500). T1 (at-most-once under A7),
   T3 (the multiplicity-corrected bound on the deployed statistic), and the
   T5 case split. Proofs, not framework.
5. **Methodology** (~2,700). §7 unchanged — corpus, strict parser, judges,
   admission rule, baselines, and §7.4's preregistered annotation design.
6. **Results** (~4,500 — **down from 16,689**). See §4 below.
7. **Threats, limitations, errata, artifact** (~2,000).

### How §8 gets from 16,689 to ~4,500

This is the real work of the split, and it is mostly deletion of *narration*
rather than of *evidence*:

| keep in body | move to appendix | cut |
|---|---|---|
| §8.1 admission (compressed) | full parser-outcome table | — |
| §8.2–8.3 headline + per-category | α-sweep detail | — |
| §8.4 attacks | per-config attack matrix | — |
| §8.7 crash/replay | per-crash-point tables | — |
| §8.8 cross-family | common-subset table | — |
| §8.16 annotation panel | per-stratum table | — |
| §8.14 audit + seed-split | Monte-Carlo tables | — |
| — | §8.5, §8.6, §8.9–8.13, §8.15 | — |

Nothing above is *dropped as evidence* — §8.5, §8.6, §8.9–§8.13 and §8.15 move
to a clearly-labelled appendix or to the artifact's `results/REPORT.md`, which
already regenerates them. The `checkPaper.js` gate keeps working either way,
since it checks quoted intervals against computed rates wherever they are
quoted.

---

## 4. Recommendation, and the honest case against it

**Recommend: split, but not yet.**

The case *for* splitting is above and I think it is correct on the merits.

The case *against* splitting **now** is specific and I would not want it lost:

1. **The strongest single result in this revision is cross-cutting.** §8.16's
   finding — that 13 of 14 independent-reader disagreements fall in the
   residual — is *simultaneously* the best empirical support for T6 and a fact
   about the corpus. Split, it becomes a forward reference in one paper and an
   orphaned observation in the other. It is materially weaker in both than it
   is in one.
2. **T6.3′ (the refinement dilemma) is the same shape.** It is a corollary of
   the theory that was *discovered by the evaluation*, and it cost a headline.
   That narrative only exists when both halves are in one document.
3. **The errata section (§14) is load-bearing and belongs to the whole.** Six of
   its eleven entries are corrections the theory forced on the evaluation.
   Split, §14 goes to Paper B and Paper A loses the evidence that its theory
   does real work.

**Therefore: split after one more round of evidence, not before.** Specifically,
after (a) the human annotation channel is collected, and (b) a third judge
vendor is reached. Both are named gaps in §9.3 today. Once those land, Paper B
is a complete evaluation on its own terms and Paper A can cite it rather than
carry it.

**If a venue's page limit forces the decision sooner**, split as outlined and
accept the cost in item 1 — but in that case, put §8.16 in **Paper A**, not
Paper B, and let Paper B forward-reference it. It is evidence about the
residual, which is Paper A's object, and it is the one section whose home is
genuinely ambiguous.

---

## 5. What was done instead, in this revision

Rather than split, this revision reduced the cost of not splitting:

- The abstract states results and is **399 words** (was 1,085).
- Guarantees **(A)/(B)/(C)** are stated in a box in §1, **before page 2**, so a
  reader knows the scope without reaching §6.1.
- Self-litigation of prior errors was removed from the abstract and the
  conclusion and gathered into **§14, Errata from prior revisions** — the
  honesty is preserved and contained.
- §9.2's described-but-unscored apparatus was cut to a single future-work line.

These are palliative. They do not change the fact that §8 is 35% of the paper.
