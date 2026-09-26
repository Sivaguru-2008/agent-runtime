# Provenance of the panel response files

This note exists because the panel analysis published on 2026-08-25 is **not
exactly reproducible** from any committed state of the response files. The
discrepancy is small and its direction is known, but it was not disclosed in the
earlier version of this work, so it is recorded here in full.

The study is **Channel M**, a panel of language models. It is not a human study.
Channel H (independent human annotators) was designed and instrumented but never
collected; its protocol is `CHANNEL-H-PROTOCOL.md` in this directory.

## What was published

`results/human_annotation.published-20260825.json` is the original analysis,
recovered from git and preserved verbatim so that the comparison below can be
checked. It reports:

| quantity | published value |
| --- | --- |
| generated at | 2026-08-25T05:06:45.813Z |
| fully annotated items | 116 of 154 |
| agreement with construction | 87.9% [80.8–92.7] |
| Krippendorff's α | 0.82799 |
| Fleiss' κ | 0.82750 |
| label flips (DIFF → SAME) | 14 |
| adjudication rate | 0 of 116 |

An item is *fully annotated* when all three annotators returned a parseable
SAME/DIFFERENT/UNSURE answer for it.

## The three states of the response files

The panel ran on 2026-08-25 (`panel-manifest.json`, `ranAt`
2026-08-25T04:40:10.658Z). Responses were appended to the CSVs as they arrived,
and the analysis was run while collection was still in progress. Three states
survive.

| state | where | compound | compound-mini | qwen27b | adjudicator | fully annotated |
| --- | --- | --- | --- | --- | --- | --- |
| **preregistered** | `preregistered-collection/` (snapshot of commit `226a355`, 2026-08-25 10:40 +0530) | 127 | 142 | 154 | 144 | 117 |
| head at `0dc8464` | `response-history/0dc8464/` (2026-08-25 10:50 +0530) | 128 | 143 | 154 | 144 | 118 |
| working tree | `annotation/*.csv` (mtimes up to 2026-08-25 15:14 +0530) | 147 | 147 | 154 | 144 | 140 |

Counts are data rows per response file. No row was ever edited or removed: each
state is a prefix of the next, and the growth is late arrivals from the two
`compound` annotators.

## What the earliest committed state changes

`preregistered-collection/` is the earliest committed state and is therefore the
one the paper reports. Against the published analysis:

| quantity | published (116) | preregistered snapshot (117) |
| --- | --- | --- |
| fully annotated items | 116 | 117 |
| label flips | 14 | 14 — **the same 14 items** |
| agreement with construction | 87.9% | 88.0% |
| Krippendorff's α | 0.828 | 0.829 |
| adjudication rate | 0 | 0 |
| re-derived wrong suppression (constructed labels) | 9.9% | 9.9% |
| re-derived wrong suppression (panel labels) | 10.5% | 10.5% |

One item reached full annotation between the analysis and the commit. Both
re-derived rates and all 14 flips are unchanged, so the preregistered decision
rule fires identically on either state.

## What this does and does not mean

- **It is not a data loss.** Every response ever collected is in the repository;
  nothing was discarded or overwritten.
- **It is not a reanalysis chosen after seeing results.** The 117-item state is
  the earliest committed one, selected by that rule and not by its numbers, and
  the later states are reported alongside it as sensitivity analyses
  (supplement, Table S23).
- **It is a reproducibility defect.** The published figures were computed from
  an uncommitted intermediate state of the files, so no one — including the
  author — can regenerate the exact published numbers. The cause is that the
  analysis was run against live files instead of a frozen export.

## The rule this repository now follows

`src/experiments/annotation.js` takes `--responses-dir` and writes the directory
it read into its output (`responsesDirectory`). Every reported panel figure
names the state it came from, and the ingest refuses to pool Channel H and
Channel M files in one analysis. `verify.js` fails the build if any manuscript
file describes the panel as a human study.

The two defects this note and the supplement record — the unscored extension
items in the re-derivation, and this non-reproducibility — were found during the
2026-09 audit and are reported in the paper rather than repaired away.
