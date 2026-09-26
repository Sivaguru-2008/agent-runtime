# Channel H protocol — independent human validation of the corpus labels

**Status: designed, instrumented, NOT COLLECTED.** No human has annotated any
item in this corpus. The study that ran is Channel M, a panel of language models
(`PREREGISTRATION.md`, `panel-manifest.json`, `RESPONSE-PROVENANCE.md`). The
paper reports it as model-panel evidence and states this limitation in the
abstract, the results and the limitations section.

This file is the complete package for running Channel H. Everything it needs is
already in this directory and frozen: the item sheet, the blinded instructions,
the instrument, the catch trials, the response schema, the ingest and the
analysis. What is missing is annotators.

---

## 1. What Channel H tests

The corpus labels operationalise **the authors' definition** of when two tool
calls denote the same act. Every headline rate is measured against those labels,
so a definition private to its authors would make the evaluation circular.

Channel H asks whether people who have never seen this project, given only the
operational definition and one pair at a time, reproduce those labels.

It does **not** test whether the fence is useful, whether the judge is accurate,
or whether the threshold is calibrated. Those are measured elsewhere and do not
depend on this study. Channel H tests one thing: whether the ground truth is
shared.

A model panel controls the same threat more weakly, because a notion of "the
same act" shared between the authors and the models would pass it and fail here.
That is exactly why Channel H is not treated as interchangeable with Channel M,
and why `annotation.js` refuses to pool response files from the two channels.

## 2. Materials (frozen, hashed, do not regenerate)

| file | what it is |
| --- | --- |
| `sheet.jsonl`, `sheet.csv` | the 154 items shown to annotators: item id, tool name, and the two calls. No labels, no category names, no attack markers. |
| `key.jsonl` | the constructed labels and categories. **Never given to an annotator.** Used only by the ingest, after responses are collected. |
| `INSTRUCTIONS.md` | the blinded instructions. Contains the operational definition and worked examples; contains no mention of duplicate suppression, of a fence, of an LLM judge, or of this paper's hypotheses. |
| `instrument.html` | a single self-contained page. No network access, no telemetry, no dependency: it can be opened from a local file. |
| `catch-trials.json` | the three attention items and their expected answers. |
| `FREEZE.json` | the freeze record: a SHA-256 per item, a file hash for `key.jsonl`, `sheet.jsonl`, `sheet.csv` and `INSTRUCTIONS.md`, the item count, the per-stratum counts and the export seed (20260818). |

Verify the materials before recruiting:

```bash
node src/experiments/annotationFreeze.js
```

This re-derives every item hash and checks each item against the corpus as it
currently stands: it fails if a sheet item changed, if a corpus pair's content
changed, or if a corpus label changed. The corpus may grow — new pairs may be
appended — but a frozen item may not move. Exit code 1 means the sheet has
drifted, and any judgement collected against a drifted sheet is void by the
preregistration's own contract.

## 3. Annotators

- **Number:** three annotators, plus one adjudicator who sees only the items the
  three do not agree on.
- **Eligibility:** adults who use software with real-world effects (payments,
  messaging, bookings, record keeping) in their ordinary work. No programming
  required; the instructions assume none.
- **Exclusions:** anyone who has read this paper, any earlier version of it, or
  the repository; anyone known to the author personally; anyone who has seen the
  labels or the categories. The adjudicator is subject to the same exclusions
  and must not be one of the three annotators.
- **Compensation:** at or above the local minimum hourly wage for the median
  completion time, paid regardless of the answers given and regardless of
  whether the annotator is later dropped for a failed catch trial. Payment is
  never conditioned on agreeing with anything.
- **Consent:** annotators are told, before they begin, what the data will be
  used for (a research paper on duplicate suppression in software agents), that
  their responses are published as anonymised CSV files with a pseudonym of
  their choosing, that response times are recorded, that the task contains
  attention checks, and that they may stop at any point. No personal data is
  collected by the instrument: it stores a name string the annotator supplies,
  and nothing else. Use a pseudonym.
- **Ethics review:** the study collects no personal or sensitive data and poses
  no foreseeable risk beyond that of ordinary paid annotation work. An
  institutional determination should nevertheless be obtained where the running
  institution requires one, and its reference recorded in this file before
  collection begins.

## 4. Blinding and randomisation

Blinding is by construction; nothing depends on the annotator's discipline.

- The annotator sees one pair at a time, with only the tool name and the two
  calls. Category, stratum, label and provenance are absent from the instrument.
- The frozen sheet already randomised, once and globally under seed 20260818,
  which of the two calls is shown as A.
- `instrument.html` re-randomises **item order and side per annotator**, using a
  deterministic FNV-1a hash of the name the annotator types as the seed of a
  mulberry32 generator. Two annotators therefore never see the same
  presentation, a positional habit cannot align with the labels, and each
  annotator's own order is reproducible from their pseudonym.
- The adjudicator sees only the items routed to adjudication, with the three
  votes anonymised and unattributed (§7).
- Items are identified as `IT001`–`IT154` throughout. The mapping from item id
  to corpus pair id lives in `key.jsonl` and is never shown.

## 5. Procedure

1. The annotator reads `INSTRUCTIONS.md` in full (≈45–60 minutes for the whole
   task; one sitting, or two within 48 hours).
2. They open `instrument.html` locally and enter their pseudonym.
3. For each item they choose **SAME**, **DIFFERENT** or **UNSURE**. UNSURE is a
   first-class answer, not a failure; its rate is reported per stratum.
4. Three catch trials (`IT013`, `IT022`, `IT108`) are interleaved invisibly.
5. At the end the instrument offers a CSV download, saved as
   `responses-<pseudonym>.csv` in a directory for this channel.

**Catch-trial rule, fixed in advance:** an annotator who fails *any* catch trial
is dropped in full, and UNSURE counts as a failure. A dropped annotator is
replaced by recruiting another, never by reweighting the remainder. Every drop
is reported with the trial failed.

## 6. Response schema

One row per item, exactly as the Channel M files are shaped, so the same ingest
reads both:

| column | values | meaning |
| --- | --- | --- |
| `item` | `IT001`–`IT154` | item id from the frozen sheet |
| `label` | `SAME` \| `DIFF` \| `UNSURE` | the annotator's answer |
| `orientation` | `AB` \| `BA` | which way round this annotator saw the pair |
| `ms` | integer | milliseconds spent on the item |
| `annotator` | string | the pseudonym |

Collect into a directory of its own, for example `annotation/channel-h/`, and
commit it **before** running any analysis. The Channel M study was analysed
against live files and is not exactly reproducible as a result
(`RESPONSE-PROVENANCE.md`); do not repeat that.

## 7. Disagreement and adjudication

This is the rule `annotation.js` implements; it is not restated loosely here.

- An item is **decided by majority** when SAME or DIFF is given by strictly more
  than half of the three annotators. That majority label is the panel label.
- Everything else — a three-way split, and any item where UNSURE holds the
  majority or blocks one — **routes to the adjudicator**, never to a coin flip
  and never to the author. The adjudicator gives SAME or DIFF for that item
  under the same definition, and that answer becomes the panel label.
- An item the adjudicator leaves unanswered has **no panel label** and is
  excluded from label-dependent quantities; it is still counted in the
  adjudication rate.
- The **adjudication rate** (items routed to the adjudicator / fully annotated
  items) is reported whatever it is, as a finding in its own right: a
  construction needing frequent adjudication is a construction that does not
  capture a shared notion of "the same act".
- No item is dropped, reweighted, or resolved by author judgement.

The adjudicator's blinding is procedural, not enforced by the instrument:
`instrument.html` has no adjudicator mode, so the contested items must be
extracted from the ingest's `needAdjudication` list and presented with the three
votes anonymised and unattributed. Record how they were presented alongside the
responses.

## 8. Analysis

Already implemented; no analysis code is written after seeing the responses.

```bash
node src/experiments/annotation.js --ingest \
  --responses-dir annotation/channel-h --channel H
node src/experiments/report.js > results/REPORT.md
```

The ingest writes `results/human_annotation_channelH.json` and refuses to run
if the directory mixes Channel H and Channel M files. It computes, over the
fully annotated items:

- per-stratum agreement with the construction, with Wilson intervals;
- Fleiss' κ and Krippendorff's α across the three annotators;
- pairwise Cohen's κ;
- the adjudication rate and the UNSURE rate;
- every label flip (constructed → adjudicated), by item and category;
- both headline rates re-derived on the annotated subset under constructed and
  under adjudicated labels, each in two forms: *as executed* (including items
  with no judge score, which abstain and escalate) and *scored only*.

The two forms exist because of a defect found in the Channel M analysis: 93 of
the 154 sheet items come from an extension corpus whose judge scores were never
persisted, so in the *as executed* form they enter the wrong-suppression
denominator without being able to enter its numerator. Report both.

## 9. Decision rules, fixed in advance

These are `PREREGISTRATION.md` §6, restated here so that Channel H is bound by
them without reinterpretation.

- **Primary endpoint.** Wrong suppression is re-derived over the annotated
  subset twice — under constructed labels and under the panel's labels — with
  the threshold taken from the untouched full calibration split, so relabelling
  the measured subset cannot leak into its own threshold. If the point estimate
  under the panel's labels exceeds **both** the constructed estimate **and**
  α = 0.05, the safety claim is reported as **not surviving independent
  relabelling** and the abstract is amended. It is not explained away. (In
  Channel M this rule fired: 9.9% → 10.5%. The paper reports the trigger, and
  the supplement reports the defect that drove it.)
- **Secondary endpoint.** Any stratum whose agreement Wilson *upper* bound falls
  below 0.80 is a **contested stratum**: it is named, its disagreeing items are
  enumerated, and every claim resting on it is demoted.
- `diff_text_only` is pre-declared as the stratum most likely to be contested.
  In Channel M it was (50.0% [25.4–74.6]), together with `attack_text` (45.5%
  [21.3–72.0]). If Channel H contests it too, that is a finding, not a defect of
  the annotators.
- Reported regardless of outcome: the full per-stratum table with intervals,
  every label flip, the adjudication and UNSURE rates, both re-derived rates
  side by side, the channel and panel composition, and any dropped annotator
  with the trial they failed.

## 10. What 154 items can and cannot establish

The sheet is stratified, not proportional, so small strata are small on purpose.
Its resolution is fixed by that choice:

| result | 95% Wilson bound |
| --- | --- |
| 154 of 154 agree | agreement ≥ 97.6% |
| 15 of 15 in a stratum agree (design size) | that stratum ≥ 79.6% |
| 12 of 12 in a stratum agree (size realised in Channel M) | that stratum ≥ 75.8% |
| 0 of 12 wrong suppressions on the annotated subset | ≤ 24.2% |

So a *flawless* Channel H result would still not establish per-stratum agreement
above 80% for the strata of size 8–14, and would not bound a rate below a few
percent on the annotated subset. Channel H validates that the definition is
shared; it cannot re-measure the headline rates at the precision of the full
corpus. Anyone needing per-stratum agreement bounded above 0.80 needs roughly
25 items per stratum (≈ 275 items), and bounding a wrong-suppression rate below
7% on the annotated subset needs ≈ 50 held-out distinct items.

## 11. Reporting requirement

If Channel H is collected, the paper must state the channel, the panel
composition, the collection dates and the exact response-file state analysed,
exactly as it does for Channel M. Until then the paper says, in the abstract and
in the limitations, that the labels are author-constructed and validated by a
model panel rather than by human annotators. `verify.js` fails the build if any
manuscript file describes the existing evidence as human validation.
