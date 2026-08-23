# Semantic Effect Identity — research artifact

Apparatus for *Semantic Effect Fencing for Paraphrased Replay in Non-Deterministic
Agents* (`docs/research/Semantic-Effect-Identity-Paper.md`).

Zero runtime dependencies, Node ≥ 20.11. Everything except judge scoring runs
offline; every table in the paper regenerates from the persisted scores.

```
src/
  canonicalize.js   L0 canonical core, operation ids, witness projections (σ, tightened σ)
  conformal.js      split-conformal calibration, INCLUDING the multiplicity
                    correction for the max-over-candidates statistic the fence
                    actually thresholds
  fence.js          Algorithm 1: L0 → witness → calibrated judge → escalation band,
                    with the eight crash hooks and the commit-window guard
  judge.js          LLM judge (STRICT score parsing) + deterministic offline scorer
  groq.js           minimal Groq client; per-model token budgets
  stats.js          Wilson intervals; the basis on which a reported zero rests
  tools.js          the six irreversible tool schemas
  corpus/           corpus generator + seeds (incl. the hand-authored arm)
  experiments/
    score.js          score every pair with each judge (resumable)
    run.js            all corpus metrics, ablations, sweeps, cost model
    multiCandidate.js the m ∈ {1,2,5,10,25,50} experiment
    crashReplay.js    three-process paraphrased crash/replay over 8 crash points
    annotation.js     human-annotation export/ingest (agreement, adjudication)
    report.js         render every rate + interval + basis into results/REPORT.md
    checkPaper.js     fail if the paper quotes an interval results/ cannot produce
```

## Reproducing

```bash
npm test                                   # unit tests, no network

node src/corpus/generate.js                # rebuild the corpus (needs GROQ_API_KEY)
node src/experiments/score.js --batch 10   # score with all three judges (resumable)
node src/experiments/run.js                # every corpus table, offline
node src/experiments/multiCandidate.js     # the multi-candidate experiment
node src/experiments/crashReplay.js --trials 48 \
     --judge openai/gpt-oss-120b --pool-generator llama-3.3-70b-versatile
```

`generate.js --offline` yields the mechanical and hand-authored categories only.
`score.js` is resumable at batch granularity (`results/partial-<judge>.json`);
`--fresh` discards partials. `run.js`, `multiCandidate.js --offline` and
`crashReplay.js --offline` need no network.

## Two things this artifact is built to prevent

**A parser that cannot report that it is broken.** The first evaluation of this
work stored 23.1% of its judge scores mis-scaled — the judge answered `0.95` on a
0–1 scale where the contract said `95` on a 0–100 scale, and the parser divided
by 100 regardless, turning confident SAME verdicts into confident DIFF scores —
while reporting a 0% failure rate, because the only thing it counted was whether
the JSON envelope arrived. `judge.js` now accepts exactly one unambiguous form,
rejects everything else, retries with an explicit correction, and records an
ABSTENTION (`null`) rather than a number when the judge will not comply.
`test/judgeParser.test.js` pins the contract.

**A bound on the wrong statistic.** The fence suppresses on
`S* = max over the candidate set`, but the earlier calibration bounded a single
pairwise comparison. With *m* candidates the fence gets *m* chances to exceed the
threshold. `conformal.js` calibrates the statistic the algorithm actually
thresholds; `test/conformal.test.js` includes a simulation asserting that the
*uncorrected* rule fails, so the correction cannot silently stop being tested.

**A number in the paper that no longer exists in the results.** Re-running an
experiment changes its rates; a manuscript does not update itself. `checkPaper.js`
extracts every `NN.N% [lo–hi]` interval from
`docs/research/Semantic-Effect-Identity-Paper.md` and exits non-zero unless each
one matches a rate computed into `results/`. Run it after any re-scoring:

```bash
node src/experiments/checkPaper.js          # verify the manuscript
node src/experiments/checkPaper.js --list   # dump every computed rate
```

It caught three stale cross-generator figures that had survived a re-score, which
is the class of error it exists for.

## Human annotation

```bash
node src/experiments/annotation.js --export --per-stratum 20
# annotators fill annotation/sheet.csv → annotation/responses-<name>.csv
node src/experiments/annotation.js --ingest
```

With no responses on disk, `--ingest` writes
`results/human_annotation.json` with `status: "PENDING"`. That file exists so the
absence of the study is machine-checkable; nothing in it is a result.

## Archived, superseded runs

`archive/v1-llama-only/` and `archive/v2-gptoss-parserdefect/` hold the corpora
and results of earlier versions. **Both are superseded and neither should be
quoted.** v2 in particular carries the mis-scaled scores described above; it is
kept so the defect and its extent stay auditable rather than patched away.
