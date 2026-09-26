# Reproducibility package

Artifact for **"Effect Identity for LLM Agents: Schema-Determined Limits on
Duplicate Suppression"** (submitted to *Artificial Intelligence*).

Everything the paper reports is computed by the scripts below from the corpus
and judge scores shipped in this repository. The only steps that contact a
network are corpus generation, judge scoring, the multi-candidate experiment and
the crash/replay experiment; **their outputs are shipped**, so the whole paper
reproduces offline.

---

## 1. Environment

| | |
| --- | --- |
| Node.js | ≥ 20.11 (v24.13.0 used for the shipped results) |
| Runtime dependencies | none |
| Dev dependencies | none — tests use `node --test` |
| OS used | Windows 11; the code is platform-neutral (no shell-outs except the crash experiment's `child_process.fork`) |
| Documents | MiKTeX / TeX Live with `elsarticle`, `pgfplots`, `algorithm2e`, `stmaryrd`, `geometry` |
| Network | only for the four generation/scoring steps in §4 |

```bash
cd research/effect-identity
node --version      # expect >= 20.11
npm test            # 61 tests, no network, < 1 s
```

## 2. One command

From the repository root:

```bash
node docs/research/aij/build.mjs
```

This regenerates the figure data from `results/`, checks **every** interval
quoted anywhere in the manuscript, the supplement and the generated tables
against a computed rate, checks the headline numbers quoted without intervals,
rejects strings known to be stale from earlier versions, runs the artifact's
verifier, and compiles `manuscript.pdf` and `supplement.pdf`. Any mismatch stops
the build before LaTeX runs.

Expect, at the end:

```
manuscript.pdf: 85 pages; 0 undefined refs/cites; 0 overfull boxes > 20pt
supplement.pdf: 15 pages; 0 undefined refs/cites; 0 overfull boxes > 20pt
```

## 3. Offline pipeline (regenerates every number)

Run from `research/effect-identity`. Each script writes one file in `results/`;
none of them contacts a network; the whole sequence takes a few minutes.

```bash
npm test
node src/experiments/run.js                       # experiments.json — corpus tables, ablations, cost
node src/experiments/residualCalibration.js       # residual_calibration.json — every configuration
node src/experiments/baselineMatrix.js --corpus v1
node src/experiments/attackMatrix.js --corpus v1
node src/experiments/conformalAudit.js --corpus v1
node src/experiments/crossFamily.js               # cross_family.json — common-subset comparison
node src/experiments/sensitivity.js               # sensitivity.json — resampled calibration pools
node src/experiments/seedSplit.js                 # seed_split.json — seed-level resplitting
node src/experiments/schemaLadder.js              # schema_ladder.json
node src/experiments/thresholdSweep.js            # threshold_sweep.json
node src/experiments/weakJudge.js                 # weak_judge.json
node src/experiments/nonLlmBaseline.js            # non_llm_baseline.json
node src/experiments/aijAnalyses.js               # aij_analyses.json — the analyses added for this submission
node src/experiments/annotation.js --ingest \
  --responses-dir annotation/preregistered-collection --channel M
node src/experiments/report.js > results/REPORT.md
node src/experiments/verify.js
node src/experiments/checkPaper.js
```

`aijAnalyses.js` begins by re-running the residual calibration and comparing it
against `results/residual_calibration.json`; it **exits 1** if any headline rate
has drifted, so a stale results file cannot silently feed the paper.

## 4. Steps that need model access (outputs shipped)

| step | command | when it ran |
| --- | --- | --- |
| corpus generation | `node src/corpus/generate.js`, `node src/corpus/generateV2.js --generator openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.6-27b` | 2026-07 / 2026-08 |
| judge scoring | `node src/experiments/score.js --judges openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.6-27b --batch 10` | 2026-08 |
| multiple candidates | `node src/experiments/multiCandidate.js --K 50 --units-diff 40 --units-same 20 --judge llama-3.1-8b-instant` | 2026-08 |
| crash and replay | `node src/experiments/crashReplayV2.js --trials 48 --arms duplicate,distinct --judge openai/gpt-oss-120b` | 2026-08 |

All four were run against Groq's OpenAI-compatible endpoint with `GROQ_API_KEY`
set, at temperature 0 for judges and 0.9 for paraphrase generators, in batches of
ten pairs per judge call.

**Model weights behind an endpoint are not pinned.** Two generator models used
for earlier arms are no longer reachable on the key. The corpus and scores are
therefore frozen and released rather than regenerated; a re-run against an
updated endpoint is a different experiment and needs a fresh calibration, not a
comparison against these numbers.

`score.js` is resumable at batch granularity (`results/partial-<judge>.json`);
`--fresh` discards partials.

## 5. Seeds

| what | seed |
| --- | --- |
| corpus construction and splits | 20260712 |
| additive corpus growth (two categories) | 20260824 |
| annotation sheet export; crash/replay | 20260818 |
| refinement decomposition (5,000 subsets) | 20260914 |

Every resampling, permutation and bootstrap procedure uses a seeded generator
recorded in its script. `repro.config.json` holds the seeds, splits, thresholds,
model identifiers and admission parameters in one machine-readable place, and
`verify.js` checks the shipped data against it.

## 6. Where each result in the paper comes from

| paper object | script | results file |
| --- | --- | --- |
| Table 6 (corpus) | `run.js` | `experiments.json`, `corpus/pairs.jsonl` |
| Table 7 (claim ↔ evidence) | — | the table names the file for each row |
| Table 8 (main performance), Fig. 4 | `residualCalibration.js` | `residual_calibration.json` |
| Table 9 (three judges) | `residualCalibration.js`, `crossFamily.js` | `residual_calibration.json`, `cross_family.json` |
| Table 10 (refinement) | `residualCalibration.js`, `aijAnalyses.js` (A5) | `residual_calibration.json`, `aij_analyses.json` |
| Fig. 5 (multiplicity) | `multiCandidate.js` | `multi_candidate.json` |
| Fig. 6 (adversarial) | `attackMatrix.js` | `attack_matrix_v1.json` |
| ablation / baseline matrix | `baselineMatrix.js` | `baseline_matrix_v1.json` |
| conformal audit, McNemar tests | `conformalAudit.js` | `conformal_audit_v1.json` |
| resampling, seed splits | `sensitivity.js`, `seedSplit.js` | `sensitivity.json`, `seed_split.json` |
| threshold sweep, weak judge | `thresholdSweep.js`, `weakJudge.js` | `threshold_sweep.json`, `weak_judge.json` |
| non-LLM baselines | `nonLlmBaseline.js` | `non_llm_baseline.json` |
| schema ladder | `schemaLadder.js` | `schema_ladder.json` |
| crash and replay | `crashReplayV2.js` | `crash_replay_v2.json` |
| label validation (Channel M) | `annotation.js --ingest` | `human_annotation.json`, `human_annotation.published-20260825.json` |
| cost, band/ties, per-tool, admission, refinement decomposition | `aijAnalyses.js` | `aij_analyses.json` |
| supplement tables S1–S24 | `docs/research/aij/tools/make-supp-tables.mjs` | the files above |

`results/REPORT.md` is a regenerated digest of every rate with its interval and
its basis; it is the fastest way to look a number up.

## 7. Gates

Four independent checks run before any PDF is produced.

1. **`verify.js`** — eleven assertion classes over the shipped data: split
   separation, attack pairs excluded from calibration, score validity (every
   score null or an exact integer percent), no clamping, abstentions absent from
   calibration pools and never producing a suppression, admission rule satisfied
   by every judge whose rates are reported, multiplicity budget never exceeded
   without the threshold becoming `+∞`, jurisdiction-matched pools, binary
   labels, and that no manuscript file describes the model panel as a human
   study.
2. **`checkPaper.js`** — extracts every `NN.N% [lo–hi]` interval from the
   manuscript, the sections, the supplement and the generated tables, and fails
   unless each matches a computed rate. Current run: **401 intervals across 46
   files**, all matched.
3. **`tools/check-claims.mjs`** — 34 headline numbers quoted without intervals,
   11 stale-string patterns, and a detector that fails on any unqualified use of
   "exactly-once". The errata section of the supplement is the one exempted
   region, marked in the source and reported by size.
4. **`npm test`** — 61 unit tests, including a simulation asserting that the
   *uncorrected* multiplicity rule fails, so the correction cannot silently stop
   being tested, and the judge-parser contract that the 2026-07 defect violated.

## 8. What is not reproducible, and why

- **The published Channel M figures.** The panel analysis published on
  2026-08-25 was run against live response files and reports 116 fully annotated
  items; the earliest committed state yields 117. All 14 label flips and both
  re-derived rates are identical, and α moves from 0.828 to 0.829. The paper
  reports the committed state. Full account: `annotation/RESPONSE-PROVENANCE.md`.
- **Human validation.** There is none. `annotation/CHANNEL-H-PROTOCOL.md` is the
  package for running it; no human has annotated any item in this corpus.
- **Model endpoints.** See §4: weights behind an endpoint are not pinned and two
  generator models are no longer reachable.
- **Judge scores for the extension corpus.** 1,043 pairs of an extension corpus
  were scored only by models that failed admission; `corpus/scores-v2ext.jsonl`
  does not exist, and `verify.js` prints a SKIP for it. This is why the
  annotation re-derivation is reported in two forms (§6 of the Channel H
  protocol).

## 9. Superseded material, kept on purpose

`archive/v1-llama-only/` and `archive/v2-gptoss-parserdefect/` hold earlier
corpora and results. **Neither should be quoted.** The v2 archive carries the
mis-scaled judge scores produced by the parser defect described in supplement
§S3; it is kept so the defect and its exact extent stay auditable rather than
being patched away.

## 10. Data and licence

The corpus is synthetic. It was constructed for this study and contains no
personal data: names, account identifiers, amounts and references are invented.
The corpus, the scores, the annotation materials and all code in this directory
are released with the paper.
