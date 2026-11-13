# Channel H — targeted follow-up (for the person running the study)

**This is not the preregistered 154-item study.** It is a small, targeted human
check of the two strata the model panel contested: legitimate repeats (D2,
artifact key `diff_text_only`) and prose-only injection (artifact key
`attack_text`). If it is reported, it is reported as a targeted follow-up, and
the preregistered Channel H study remains uncollected.

Nothing in this folder carries a label, a stratum, a category or a hint.
The key stays in `annotation/key.jsonl` and is never given to anyone.

## Contents

| file | what it is |
| --- | --- |
| `instrument.html` | the **preregistered** instrument (`annotation/preregistered-collection/instrument.html`) with its item list reduced to the 33 packet items. One pair per screen; order and left/right side are re-randomised per annotator from their pseudonym. Opens from a local file, no network. |
| `INSTRUCTIONS.md` | the **frozen** instructions (hash-checked against `annotation/FREEZE.json`). Give this to annotators, unedited. |
| `sheet.jsonl`, `sheet.csv` | the 33 frozen items, verbatim from the frozen sheet (no labels). For your records; annotators use the instrument. |
| `PACKET.json` | item list per stratum, catch-trial ids, per-item frozen hashes, file hashes, and the rules below. |
| `adjudication-template.csv` | header row for the adjudicator's file. |
| `responses/` | put the returned CSV files here. |

Items: 15 legitimate-repeat items, 15 prose-only-injection items, and the three
preregistered catch trials (IT013, IT022, IT108), interleaved invisibly. The
frozen instructions say the task takes 45–60 minutes; that refers to the full
sheet. **Tell annotators this version has 33 pairs and takes about 10–15 minutes.**
Do not edit `INSTRUCTIONS.md` to say so; its hash is part of the freeze.

**Why the preregistered copies:** `annotation/INSTRUCTIONS.md` and the in-page
text of `annotation/instrument.html` were edited after the freeze and no longer
match `FREEZE.json` (the edited instrument, for example, tells annotators to
"prefer SAME or DIFFERENT", where the preregistered one says to use Unsure rather
than guess). The packet is built from `annotation/preregistered-collection/`,
which does match. `node src/experiments/channelHTargeted.js --build` refuses to
build if it does not.

## People

- **3 annotators + 1 adjudicator.** Eligibility, exclusions, consent and payment
  exactly as `annotation/CHANNEL-H-PROTOCOL.md` §3: adults who use software with
  real-world effects; not anyone who has read the paper or the repository, not
  anyone known to you personally; paid at or above local minimum wage for the
  median time, regardless of answers or exclusion; pseudonyms only.
- The adjudicator must not be one of the three annotators.
- Obtain an ethics determination if your setting requires one and record its
  reference in `PACKET.json` before collecting.

## Procedure

1. Verify the packet has not drifted:
   `node src/experiments/channelHTargeted.js --build` (rebuilds and re-checks every hash; the output must be identical).
2. Send each annotator `instrument.html` and `INSTRUCTIONS.md`. They type a
   pseudonym, answer all 33 pairs (SAME / DIFFERENT / UNSURE), and download
   `responses-<pseudonym>.csv`. Collect the three files into `responses/`.
3. **Commit the three files before running any analysis** (the Channel M study
   was analysed against live files and is not exactly reproducible; do not repeat that).
4. Run `node src/experiments/channelHTargeted.js --analyze`. It prints the items
   that need adjudication (anything without a strict majority of SAME or DIFF).
   Present only those items to the adjudicator, with the three votes anonymised
   and unattributed, and record how you presented them. Save the adjudicator's
   answers as `responses/responses-adjudicator-<pseudonym>.csv` with the header
   in `adjudication-template.csv`, commit, and run `--analyze` again.
5. If an annotator fails any catch trial (UNSURE counts as a failure), they are
   dropped in full: recruit a replacement and repeat step 2 for them only.

## What the analysis reports (rules fixed in advance)

`results/channel_h_targeted.json`, via the ordinary ingest
(`annotation.js --ingest --channel H`, raw output kept alongside as
`channel_h_targeted.ingest.json`):

- per stratum: agreement of the adjudicated label with the construction, with a
  Wilson 95% interval; the UNSURE rate; the adjudication rate; Krippendorff's α;
  every disagreeing item;
- **contested** iff the Wilson upper bound is below 0.80 (PREREGISTRATION.md §6).
  With 15 items, a stratum is contested at **8 or fewer** agreeing items of 15,
  and not contested at 9 or more; 15 of 15 gives a lower bound of 79.6%;
- the model panel's agreement on the same stratum, side by side, never pooled;
- dropped annotators and the trial they failed.

`--self-test` exercises this path end to end on synthetic files in a temporary
directory and writes nothing to `results/`.

## After the results exist

Only then may anything be written into the paper. The manuscript currently says
(method, results and limitations sections) that no human labels were collected; that stays true
of the preregistered study whatever this follow-up finds.
