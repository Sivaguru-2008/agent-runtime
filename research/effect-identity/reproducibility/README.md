# Turnkey Reproducibility Package: Effect Identity for LLM Agents

> **Secondary document.** The canonical reproduction instructions are
> [`research/effect-identity/REPRODUCIBILITY.md`](../REPRODUCIBILITY.md), which is
> kept in step with the build and states which result comes from which script,
> which steps need model access, and what is *not* reproducible. This file is a
> longer walkthrough written on 2026-09-14; where the two disagree, the
> canonical one is right.

This directory provides the complete, self-contained, offline reproduction instructions for the paper:

> **"Effect Identity for LLM Agents: Schema-Determined Limits on Duplicate Suppression"**  
> *Elsevier Artificial Intelligence Journal (AIJ), ISSN 0004-3702*

---

## 1. System Requirements & Environment

- **Operating System:** Linux, macOS, or Windows (PowerShell or Bash)
- **Runtime:** Node.js `>= 20.11.0` (ES modules enabled natively via `"type": "module"`)
- **External Dependencies:** **Zero (`0`) npm dependencies**. Standard Node.js core libraries (`node:fs`, `node:path`, `node:url`, `node:crypto`, `node:test`) only.
- **Hardware:** Any modern multi-core CPU (x86_64 or Apple Silicon ARM64), $\ge 4\text{ GB}$ RAM, $\ge 500\text{ MB}$ free disk space.
- **API Keys:** **None required for full offline reproduction**. All model outputs, scores, crash-replay logs, and frozen evaluation sheets are packaged and persisted.

---

## 2. Directory Structure

```text
research/effect-identity/
├── corpus/
│   ├── pairs.jsonl                   # Primary 1,066-pair evaluation corpus (v1 + growth)
│   ├── pairs-v2ext.jsonl             # Extension corpus, 1,043 pairs over 9 further tools
│   ├── scores.jsonl                  # Offline cached judge scores across 4 LLM families
│   ├── multi-candidate-scores.json   # Multi-candidate history scores (m = 1..50)
│   └── growth-manifest.json          # Stratified additive growth manifest
├── src/
│   ├── canonicalize.js               # Layer 0: Syntactic normalizer & field policies
│   ├── conformal.js                  # Layer 1: Conformal risk calibrator & order statistics
│   ├── fence.js                      # Layer 2: Three-layer fence runtime & audit logger
│   ├── evaluate.js                   # Benchmark runner, witness evaluation & metrics
│   ├── judge.js                      # Strict score parser & JSON output contract
│   ├── stats.js                      # Wilson CIs, Cohen/Fleiss kappa, Krippendorff alpha
│   ├── tools.js & toolsV2.js         # Tool schemas, effect policies & witness specs
│   └── experiments/
│       ├── run.js                    # Main offline experiment pipeline
│       ├── verify.js                 # 11 formal assertion classes audit
│       ├── checkPaper.js             # Numerical audit: 327 quoted intervals vs computed
│       ├── annotationFreeze.js       # Frozen human/panel evaluation sheet verification
│       ├── crashReplay.js            # Multi-process crash/recovery experiment
│       └── score.js                  # Online scoring harness (optional, requires API)
├── results/
│   ├── REPORT.md                     # Comprehensive generated results digest
│   ├── baseline_matrix_v1.json       # Baseline evaluations across B0–B4 & fence configs
│   ├── attack_matrix_v1.json         # Adversarial prompt injection results
│   ├── crash_replay_v2.json          # Crash-replay trial logs across 8 injection points
│   └── human_annotation.json        # Channel M model-panel evaluation results
├── human_validation_package/         # Turnkey Channel H human study apparatus
│   ├── instrument.html               # Browser annotation tool (zero dependencies)
│   ├── PROTOCOL.md & INSTRUCTIONS.md # Preregistered protocol & annotator instructions
│   ├── tasks.jsonl & tasks.csv       # 154 blinded, frozen items
│   ├── key.jsonl                     # Sealed ground truth key
│   └── analyze_human_study.js        # Standalone human study statistical audit tool
└── repro.config.json                 # Machine-readable ground-truth configuration
```

---

## 3. One-Line Reproduction Commands

Navigate to the `research/effect-identity/` directory:

```bash
cd research/effect-identity
```

### Gate 1: Run Full Unit Test Suite (61 Tests)
Validates L0 canonicalization, L1 conformal quantile calculations, L2 escalation logging, Bonferroni multiplicity corrections, strict parser rejections, and crash recovery hooks:

```bash
npm test
```
*Expected Output:* `pass 61, fail 0, duration < 600 ms`.

---

### Gate 2: Verify Formal Assertion Classes (11 Classes)
Checks that all theoretical theorems, empirical error bounds, and configuration invariants match `repro.config.json`:

```bash
node src/experiments/verify.js
```
*Expected Output:* `OK — every assertion in repro.config.json holds (11 assertion classes).`

---

### Gate 3: Audit Paper Statistical Consistency (327 Quoted Intervals)
Scans manuscript markdown and LaTeX source files, extracts every reported point estimate and confidence interval, and recomputes them from raw corpus scores:

```bash
node src/experiments/checkPaper.js
```
*Expected Output:*
```text
checked 327 quoted intervals (125 distinct) against 5743 computed rates
all quoted intervals matched a computed rate
```

---

### Gate 4: Verify Evaluation Sheet Hash & Zero Drift
Confirms that the 154 items in the frozen evaluation sheet have not experienced data drift or mutation against the growing corpus:

```bash
node src/experiments/annotationFreeze.js --verify
```
*Expected Output:*
```json
{
  "ok": true,
  "nItems": 154,
  "sheetHash": "66a174e1392093c14e911d6130b235b3d4af3b8116c0a81ef27830174a249a9c",
  "drifted": [],
  "missingFromCorpus": []
}
```

---

### Combined Master Audit Command
Run all four verification gates in a single shell invocation:

**PowerShell (Windows):**
```powershell
powershell -Command "npm test; node src/experiments/verify.js; node src/experiments/checkPaper.js; node src/experiments/annotationFreeze.js --verify"
```

**Bash (Linux / macOS):**
```bash
npm test && node src/experiments/verify.js && node src/experiments/checkPaper.js && node src/experiments/annotationFreeze.js --verify
```

---

## 4. Regenerating Experimental Result Files

To recompute all baseline tables, ablation matrices, multi-candidate scaling curves, and sensitivity digests offline:

```bash
node src/experiments/run.js
```
This updates:
- `results/REPORT.md`
- `results/baseline_matrix_v1.json`
- `results/attack_matrix_v1.json`
- `results/cross_family.json`
- `results/schema_ladder.json`
- `results/sensitivity.json`

---

## 5. Running the Channel H Human Validation Audit

To audit human study responses collected via `human_validation_package/instrument.html`:

```bash
cd human_validation_package
node analyze_human_study.js --submissions ./submissions --key key.jsonl
```

- When no submissions are present in `./submissions`, the tool cleanly reports `PENDING` without inventing results.
- When CSV submissions (`responses-<id>.csv`) are present, it automatically:
  1. Audits catch trials (`IT013`, `IT022`, `IT108`) and drops raters failing obvious controls.
  2. Computes Krippendorff's $\alpha$, Fleiss' $\kappa$, and pairwise Cohen's $\kappa$.
  3. Computes agreement with construction and identifies contested strata ($< 80\%$ upper bound).
  4. Adjudicates split votes and re-derives $WS$ and $Dedup$.

---

## 6. LaTeX Compilation for Elsevier AIJ

To compile the submission-ready Elsevier `elsarticle` LaTeX manuscript:

```bash
node docs/research/latex/build-aij.mjs
```

This compiles the canonical source into `docs/research/latex/aij/effect-identity-aij.tex` and `docs/research/latex/aij/effect-identity-aij.bib` (2,165 lines, 158 environments, 121/121 cited references, zero warnings).

To produce the PDF (requires standard TeX Live / MacTeX):
```bash
cd docs/research/latex/aij
pdflatex effect-identity-aij
bibtex effect-identity-aij
pdflatex effect-identity-aij
pdflatex effect-identity-aij
```

---

## 7. Determinism & Random Seeds

- **Corpus v1 Seed:** `20260712`
- **Corpus v2ext Seed:** `20260818`
- **Growth Manifest Seed:** `20260824`
- **Annotation Sample Seed:** `20260818`
- **Judge Sampling:** Temperature $0$ for deterministic greedy decoding.
- **Pseudo-Random Generator:** 32-bit Linear Congruential Generator ($a = 1664525, c = 1013904223, m = 2^{32}$) for cross-platform bit-identical floating-point values in $[0, 1)$.
