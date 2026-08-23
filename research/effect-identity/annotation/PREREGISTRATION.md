# Preregistration — independent validation of the corpus ground truth

**Registered:** 2026-08-23
**Frozen sheet:** `annotation/FREEZE.json`, sheet hash
`66a174e1392093c14e911d6130b235b3d4af3b8116c0a81ef27830174a249a9c`, 154 items.
**Status at registration:** zero judgements collected. `results/human_annotation.json`
reads `PENDING`, and `annotation/` contains no `responses-*.csv`.

This document is written *before* any judgement is collected and is not edited
afterwards. Anything decided after the first response arrives is reported as
exploratory, in its own subsection, and labelled as such.

---

## 1. The threat being tested

Every SAME/DIFF label in the corpus is **by construction**: a SAME pair is same
because a generator was instructed to preserve the act and a validator checked
the pinned numerics; a DIFF pair is different because a declared field was
mutated or a distinguishing token inserted. That makes the labels reproducible
and controlled, and it makes them an operationalisation of *the authors' own
definition of "the same action"* — which is the object the paper studies.

If an independent reader, given only the operational definition and none of the
mechanism, systematically disagrees with the construction, then §8 has been
measuring the authors' assumptions and the interval reporting does not repair
it. This study exists to find that out.

It does **not** test whether the mechanism is accurate. It tests whether the
*labels the mechanism is scored against* are shared rather than idiosyncratic.

## 2. What is frozen

The 154-item stratified sheet exported by `annotation.js --export` at seed
`20260818`, hashed per item in `annotation/FREEZE.json`. The corpus grows later
in this revision (S3 and D3 are enlarged for power, §8.3); the freeze contract
is therefore **not** "the corpus file never changes" but "no item in this sheet
changed", enforced by `annotationFreeze.js --verify` and asserted by the build
verifier. Any judgement collected against a sheet that fails `--verify` is void.

Eleven strata, 15 items each except `misdeclared` (4 available):

| stratum | constructed | n | why it is in the budget |
|---|---|---:|---|
| `same_mechanical` | SAME | 15 | control — should be uncontroversial |
| `same_paraphrase` | SAME | 15 | the main liveness population |
| `same_loose_value` | SAME | 15 | **the paper's motivating example** |
| `same_adversarial` | SAME | 15 | generator told to maximise surface difference |
| `diff_near_miss` | DIFF | 15 | the main safety population |
| `diff_text_only` | DIFF | 15 | **the contested category** — our errors concentrate here |
| `diff_semantic` | DIFF | 15 | hand-written same-surface, different-intent |
| `attack_field` | DIFF | 15 | injection across a declared difference |
| `attack_text` | DIFF | 15 | injection where only prose distinguishes |
| `attack_encoding` | DIFF | 15 | encoding attacks a reader may see differently from a parser |
| `misdeclared` | DIFF | 4 | schema is broken here by design |

## 3. Panel, and the honest name for it

**Three independent annotators plus one blind adjudicator**, none of which has
been exposed to the mechanism, the thresholds, the constructed labels, the
model predictions, or this manuscript. Each receives only the operational
definition (Definition 1, restated without the paper's notation) and the pair.

Two collection channels are prepared, and they are **not interchangeable**:

- **Channel H (human).** A self-contained HTML instrument
  (`annotation/instrument.html`), one pair per screen, forced ternary response,
  A/B side and item order randomised per annotator, CSV export keyed by item ID.
  This is the stronger channel.
- **Channel M (model panel).** The same frozen items, the same instruction
  document, the same forced ternary, delivered to independent models that are
  not the deployed judge under its deployed prompt.

Whichever channel supplies the responses is **named in the result**, and the
claim licensed by each is stated here in advance, before we know which one we
have:

| channel | what a high agreement licenses | what it does not |
|---|---|---|
| H | the construction matches independent *human* readers of the definition | nothing about model agreement |
| M | the construction is not an artefact of the authors — an independent reader applying only the definition reproduces it | **not** a human validation, and correlated model priors remain a live confound |

Channel M is reported as a *model panel*, never as a human study, and never as
a substitute for one. If only M is collected, §7.4 says so in those words and
the human control is recorded as **not collected** in the limitations, not as
forthcoming.

**Panel composition rule (fixed now).** A model may serve on the panel only if
it is **not** the primary judge (`openai/gpt-oss-120b`) whose scores the
re-derivation in §6 below uses. Any panelist that appears elsewhere in the paper
as a *reported judge* is named as such in the result, and the two agreement
statistics — with and without that panelist — are both reported. The adjudicator
must not be one of the three annotators.

## 4. Catch trials

Three catch items are embedded in every annotator's stream, drawn from strata
where the construction is uncontested:

- **2 x obvious SAME** from `same_mechanical` (key reorder / whitespace only).
- **1 x obvious DIFF** from `diff_near_miss` (a declared numeric field differs).

Catch items are ordinary sheet items flagged in the key, not synthetic
additions, so they cost no extra budget and cannot be spotted by formatting.

**Exclusion rule, fixed in advance:** an annotator who answers **any** catch
trial incorrectly is dropped in full — every response of theirs is excluded from
every statistic, not just the catch items. `UNSURE` on a catch trial counts as a
failure. Drops are reported with the count and the failed item.

## 5. Primary analysis (already coded in `annotation.js --ingest`)

All of the following are computed by the existing ingestion path. Nothing below
is added after seeing responses.

1. **Per-stratum construction agreement** — the fraction of decided items whose
   final label equals the constructed label, **with a Wilson 95% interval per
   stratum**. Reported for all eleven strata separately; a pooled figure is
   reported alongside but is not the primary quantity, because the strata are
   deliberately not sampled in proportion to the corpus.
2. **Krippendorff's alpha** overall and per stratum, on the ternary
   SAME/DIFF/UNSURE scale, nominal metric. Chosen over kappa as primary because
   it tolerates the ragged/missing responses real submissions produce.
3. **Fleiss' kappa** overall, on the same ternary scale.
4. **Pairwise Cohen's kappa** for every annotator pair.
5. **Adjudication rate**, reported *as a finding*. A construction that needs
   frequent adjudication is a construction that is not capturing a shared
   notion of "the same act". Ties and UNSURE-dominated items route to the
   adjudicator; never to a coin flip.
6. **Re-derivation of the headline rates.** The money result. Wrong-suppression
   and deduplication are recomputed over the annotated subset **twice** — once
   under the constructed labels, once under the adjudicated labels — with the
   threshold taken from the **untouched full calibration split**, so that
   relabelling the subset being measured cannot leak into its own threshold.
   Both are reported with Wilson intervals. The comparison of the two is the
   study's primary output.

**Resolution stated in advance.** At n = 154, an observed 100% agreement carries
a 95% Wilson lower bound of **97.6%**, and a 15-item stratum at 100% carries a
lower bound of **79.6%**. The study therefore cannot establish per-stratum
agreement above roughly 80% even on a flawless result, and we will not claim
more than that interval permits.

## 6. Decision rules, fixed in advance

- **Primary endpoint:** the re-derived wrong-suppression rate under adjudicated
  labels on the annotated subset, against the same rate under constructed
  labels. If the adjudicated WS point estimate exceeds the constructed WS point
  estimate **and** the declared alpha = 0.05, the safety claim is reported as
  **not surviving independent relabelling** and the abstract is amended.
- **Secondary endpoint:** per-stratum agreement. Any stratum whose agreement
  Wilson **upper** bound falls below 0.80 is reported as a **contested
  stratum**, named in §8, and every claim resting on it is demoted.
- **D2 (`diff_text_only`) is pre-declared as the stratum most likely to be
  contested.** If it is contested, that is **reported as a finding in §8**, with
  the disagreeing items enumerated. It is not dropped, not re-weighted, and not
  resolved by author fiat.
- **UNSURE** is a first-class response. Its rate is reported per stratum. A high
  UNSURE rate on a stratum is evidence against the construction being shared,
  and is reported as such rather than being collapsed into the majority.
- No stratum, item, or annotator is dropped for any reason not stated in §4.

## 7. What will be reported regardless of outcome

- The full per-stratum table with intervals, including strata that disagree.
- Every label flip (constructed to adjudicated), by item and category.
- The adjudication rate and the UNSURE rate.
- Both re-derived headline rates, side by side.
- The channel (H or M) and the exact panel composition.
- Any dropped annotator and the catch trial they failed.

## 8. What this study cannot do

It cannot validate 955 pairs; it validates 154. It cannot establish per-stratum
agreement above ~80% (§5). It cannot detect a bias shared between the authors
and the panel — for Channel M in particular, a construction that reflects a
common model prior about "the same action" would be *confirmed* by this study
and still be idiosyncratic relative to human practice. That limitation is
stated in the manuscript wherever the result is cited, and is the reason
Channel H is described as the stronger channel and is shipped ready to run.
