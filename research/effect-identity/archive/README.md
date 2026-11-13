# Archived, superseded runs

These directories are kept so that the defects described in the paper remain auditable. **None of them should be read as current results.**

## `v1-llama-only/`
The first corpus (n=72 held-out DIFF pairs) and its Llama-3.3-70B scoring. Superseded on two counts: the DIFF sample was too small for the safety claim it carried (an observed 0% wrong-suppression admits a 95% Wilson upper bound of 5.1%, wider than the α = 0.05 it purported to certify), and it shares the parser defect below.

## `v2-gptoss-parserdefect/`
The 780-pair corpus scored by GPT-OSS-120B. **Superseded because of a scoring-harness defect**, not because of a design change.

The judge was instructed to return an integer in `[0,100]`; the parser accepted any finite number and divided it by 100. A reply of `0.95` — a probability rather than a percentage — was therefore stored as `0.0095`, turning a confident SAME verdict into a confident DIFF score. The reply is valid JSON, so it never triggered a retry and never counted as a failure; the harness reported a 0% failure rate for a corpus in which 23.1% of scores were inverted.

The corruption is identifiable without re-running anything: **any stored score that is not a multiple of 0.01 is mis-scaled.** 180 of 780 scores qualify. Their implied original probabilities span the full range (0.01, 0.02, 0.03, 0.04, 0.05, 0.1, 0.6, 0.7, 0.8, 0.85, 0.9, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99), so the judge was answering on a `[0,1]` scale generally and not only when confident. An earlier write-up claimed the affected values were "precisely `{0.95, 0.97, 0.98, 0.99}/100`" — that characterisation was wrong, which is exactly why these files are shipped rather than summarised.

Direction of the bias: of the 180, **91 were implied same-act verdicts (≥ 0.5)** recorded as near-zero (78 on truly-SAME pairs, 13 on truly-DIFF); the remaining 89 were already distinct-act verdicts, where rescaling usually changes no decision. So the defect **understated** deduplication, **understated** wrong-suppression, and corrupted the score distribution that calibration consumes — both thresholds were computed over an artefactual low-score cluster.

Reproduce the whole claim with:

```
node --input-type=module -e "import {readFileSync} from 'node:fs';const rows=readFileSync('archive/v2-gptoss-parserdefect/corpus/scores.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);const v=rows.map(r=>r.judges?.openai_gpt_oss_120b).filter(x=>typeof x==='number');const bad=v.filter(x=>Math.abs(x*100-Math.round(x*100))>1e-9);console.log(bad.length+'/'+v.length)"
```

Every judge-dependent number from this run is withdrawn. The current corpus is re-scored under a strict parser (`src/judge.js`) that rejects non-integers rather than rescaling them, rejects out-of-range values rather than clamping them, and records abstentions as `null` rather than imputing 0.5. See §6.2 of the paper and the change log in `docs/research/Revision-Audit.md`.

## Why these are kept rather than deleted
A reader who wants to check the claim "23.1% of scores were mis-scaled" can verify it directly against `v2-gptoss-parserdefect/corpus/scores.jsonl`. Shipping a silently patched file instead would make the defect unfalsifiable, which is the failure mode the disclosure exists to avoid.
