# Semantic Effect Identity — research artifact

Apparatus for *Effect Identity for LLM Agents: Schema-Determined Limits on
Duplicate Suppression* (`docs/research/aij/`), and for the earlier long-form
version (`docs/research/Semantic-Effect-Identity-Paper.md`).

**Start with [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)**: it lists the
environment, the one-command build, the offline pipeline, the seeds, which
result in the paper comes from which script, the four gates, and what is *not*
reproducible and why.

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
extracts every `NN.N% [lo–hi]` interval from the manuscript and exits non-zero
unless each one matches a rate computed into `results/`. Run it after any
re-scoring:

```bash
node src/experiments/checkPaper.js                    # the long-form Markdown
node src/experiments/checkPaper.js --manuscript a,b   # any .tex/.md files
node src/experiments/checkPaper.js --list             # dump every computed rate
```

`docs/research/aij/build.mjs` runs it across the AIJ manuscript, its sections,
the supplement and the generated supplement tables — 401 intervals in 46 files —
before LaTeX is allowed to run.

It caught three stale cross-generator figures that had survived a re-score, which
is the class of error it exists for.

## Label validation — two channels, never pooled

The corpus labels are constructed by the authors, so a separate study asks
whether anyone else reproduces them. It has two channels.

**Channel M — a blinded panel of language models. This is what ran.**

```bash
node src/experiments/annotation.js --ingest \
  --responses-dir annotation/preregistered-collection --channel M
```

It is **not a human study** and is never reported as one; `verify.js` fails the
build if a manuscript file says otherwise. Its preregistration is
`annotation/PREREGISTRATION.md`, and two disclosed defects — unscored extension
items in the re-derivation, and the published figures not being exactly
reproducible from any committed file state — are documented in
`annotation/RESPONSE-PROVENANCE.md` and in supplement §S16.

**Channel H — independent human annotators. NOT COLLECTED.**

No human has annotated any item in this corpus. The complete package for running
it — eligibility, consent, blinding, randomisation, catch trials, response
schema, adjudication rule, preregistered analysis and what 154 items can and
cannot establish — is `annotation/CHANNEL-H-PROTOCOL.md`. The sheet, instrument
and instructions are frozen and hashed; check them with:

```bash
node src/experiments/annotationFreeze.js
```

## Archived, superseded runs

`archive/v1-llama-only/` and `archive/v2-gptoss-parserdefect/` hold the corpora
and results of earlier versions. **Both are superseded and neither should be
quoted.** v2 in particular carries the mis-scaled scores described above; it is
kept so the defect and its extent stay auditable rather than patched away.
