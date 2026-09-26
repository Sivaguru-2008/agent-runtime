# Submission checklist — *Artificial Intelligence* (Elsevier), ISSN 0004-3702

**Article:** Effect Identity for LLM Agents: Schema-Determined Limits on
Duplicate Suppression · **Type:** Full Length Article · **Prepared:** 2026-09-18

Items marked **[AUTHOR]** cannot be settled from the repository and must be
completed by the author before upload. Everything else is verified and its
verification command is given.

---

## 1. Files to upload

| file | what it is | status |
| --- | --- | --- |
| `manuscript.pdf` | main article, 86 pp. (elsarticle `preprint,review,12pt`, line-numbered, double spaced) | built |
| `supplement.pdf` | supplementary material, 15 pp., S1–S20 with 24 tables | built |
| `highlights.txt` | 5 highlights, each ≤ 85 characters | verified |
| `COVER-LETTER.md` | cover letter to the editors | drafted; **[AUTHOR]** to confirm |
| research artifact | `research/effect-identity/` — corpus, scores, code, annotation materials, results | in repository; **[AUTHOR]** to archive and mint a DOI |
| LaTeX source | `manuscript.tex`, `sections/`, `figures/`, `supplement/`, `references.bib`, `build.mjs` | in repository |

Rebuild everything with one command:

```bash
node docs/research/aij/build.mjs
```

## 2. Manuscript formatting

| requirement | status |
| --- | --- |
| Elsevier `elsarticle` class | yes (`preprint,review,12pt`) |
| Line numbers for review | yes (`lineno`) |
| Structured title page, corresponding author, e-mail | yes |
| Affiliation with full postal address and country | **[AUTHOR] — missing.** `\affiliation` currently reads `organization={Independent Research, AgentRuntime Project}` with no address, city or country. Elsevier requires a country. |
| Abstract, single paragraph, **max 250 words** (journal rule, verified 2026-09-18) | yes, 247 words |
| Keywords (journal allows 1–10 and asks authors to avoid "and"/"of" constructions) | 7, `\sep`-separated, none containing "and" or "of" |
| Highlights, 3–5 bullets ≤ 85 characters including spaces, uploaded as a separate editable file with "highlights" in the filename | 5 bullets, longest 79 characters; `highlights.txt` |
| Numbered sections, figures, tables | 11 sections, 6 figures, 10 tables, 1 appendix |
| References in `elsarticle-num` style | yes, 58 entries |
| Main text length | ~14,300 words excluding tables, figures, appendix, declarations and references (down from 44,600 in the long-form version) |
| Typeset length | **35 pages** in the journal layout, below the 40-page threshold at which AIJ warns of review delays. Check by compiling a copy whose class options are `final,3p,times`. |
| No undefined references or citations | verified by the build |
| No overfull boxes > 20 pt, no oversized floats | verified by the build |

## 3. Declarations

Every declaration is drafted in `sections/declarations.tex` and every one is
marked **[AUTHOR TO CONFIRM]** in the source, because none can be asserted by a
tool:

| declaration | drafted content | action |
| --- | --- | --- |
| Competing interest | discloses that the author develops AgentRuntime, a project containing a content-addressed fence of the kind used as this paper's canonical-key baseline | **[AUTHOR]** confirm wording and any further interests |
| Funding | "no specific grant" | **[AUTHOR]** confirm |
| Data availability | artifact accompanies the manuscript; regenerates offline; corpus frozen because two generator models are no longer reachable | **[AUTHOR]** add public archive and DOI |
| Generative AI in manuscript preparation | discloses use of Claude (Anthropic) for drafting, code and number auditing, with the author taking responsibility; separates this from models used as research instruments | **[AUTHOR]** confirm and edit to match the final process |
| CRediT | single author, full role list | **[AUTHOR]** confirm |
| Ethics / human participants | **none required**: no human subjects took part. The human annotation channel was designed and instrumented but never collected; the model panel is not a human study. The corpus is synthetic and contains no personal data. | **[AUTHOR]** confirm no institutional determination is needed |

## 4. Originality and concurrent submission — **[AUTHOR] action required**

The repository contains build targets for other venues of the *same work*:

- `docs/research/latex/build-jmlr.mjs` and `docs/research/latex/jmlr/`
- `docs/research/latex/build-tmlr.mjs` and `docs/research/latex/tmlr/`
- `docs/research/latex/build-aij.mjs` and `docs/research/latex/aij/` — an earlier
  AIJ formatting of the 44,600-word long-form manuscript, superseded by this one
- `docs/research/Semantic-Effect-Identity-Paper.md` — the long-form manuscript
- `docs/research/Effect-Identity-Paper.docx` — a Word rendering

**Before uploading, confirm in writing that this work is not under review at
JMLR, TMLR or anywhere else, and that no version of it has been published.** If
any version was submitted elsewhere, say so in the cover letter and state its
disposition. If a preprint exists, give its DOI or arXiv id: Elsevier's preprint
policy permits it, but it must be declared and later linked to the published
article.

## 5. Reference integrity

| check | result |
| --- | --- |
| entries in `references.bib` | 58 |
| entries generated from resolved DataCite/Crossref metadata | all — `tools/make-bib.mjs` aborts on an unresolved identifier and fails on non-ASCII |
| cited but undefined | 0 |
| defined but uncited | 0 |
| undefined citations at build | 0 |
| fabricated or unverifiable references | none found |
| known metadata issues | four title truncations found during the audit, all in the *long-form* reference list; one of the four is cited here and its entry already carries the full registered title and correct author names (`tursunbadalov2026minority`) |

Re-audit with `node tools/reference-audit.mjs <source.md> <out.json>`.

## 6. Figures and tables

| check | result |
| --- | --- |
| figures | 6: architecture, decision flow, schema refinement, main performance, multiplicity, adversarial |
| format | all vector (TikZ / pgfplots), compiled from data files generated from `results/` |
| data provenance | `tools/make-figure-data.mjs` regenerates `figures/data/*.dat` from the results files on every build |
| colour dependence | no figure depends on hue alone: line plots differ in marker *and* dash pattern; the adversarial bars differ in hue *and* fill pattern; the refinement diagram labels every region in text |
| captions self-contained | yes, each states what the panel shows and what it does not |
| tables in main text | 10 (positioning, terminology, guarantees, relations, assumptions, corpus, claims↔evidence, main performance, judges, refinement) |
| tables in supplement | 24, all generated by `tools/make-supp-tables.mjs` from the results files |

## 7. Statistical reporting

| check | result |
| --- | --- |
| every rate carries a 95% interval | Wilson intervals throughout; `checkPaper.js` verifies 401 quoted intervals in 46 files against computed rates |
| zeros distinguished | a rate that is zero by construction is marked † and explained; sampling zeros carry their Wilson upper bound |
| paired comparisons | exact McNemar over discordant items, Holm-corrected within the liveness and safety families separately |
| multiplicity | Bonferroni at α/m for the max-over-candidates statistic, with the certifiable budget stated |
| non-significant results reported as such | yes — no wrong-suppression comparison in the ablation matrix is significant, and the paper says so |
| seeds and resampling counts | recorded in `repro.config.json` and in each script |

## 8. Reproducibility

| check | result |
| --- | --- |
| reproducibility statement | `research/effect-identity/REPRODUCIBILITY.md` |
| unit tests | 61, all pass, no network |
| artifact verifier | 11 assertion classes, all hold |
| number-vs-manuscript gate | 401 intervals + 34 headline numbers + 11 stale-string patterns |
| offline reproduction | every table and figure regenerates from persisted scores without network access |
| model-dependent steps | four, all with outputs shipped and commands recorded |

## 9. Honest-reporting review (the claims a referee will test)

| what a referee may challenge | where the paper answers it |
| --- | --- |
| "Are the labels just the authors' opinion?" | §7.6 and §8.7: constructed labels, validated by a **model panel**, not by humans; the human channel is absent and its protocol ships unrun |
| "Did the preregistered test pass?" | It **triggered**. §8.7 reports the trigger, the defect behind it (93 of 154 items unscored), and the corrected analysis |
| "Is α a guarantee about my deployment?" | §6.3 and §8.2: the bound is marginal; 10.5% of seed-level splits exceed α |
| "Is this exactly-once?" | No. Scope box in §1; §3.5 separates the three guarantees; Prop. 8 states what external exactly-once needs |
| "Does it survive prompt injection?" | Only the typed class, by construction; prose-only injection succeeds 84.0% of the time and is reported as a negative result |
| "Is any of this new?" | No individual technique is; §1 and §2 say so and make no priority claim |
| "Does it generalise?" | Untested: one synthetic corpus, six tools, one provider endpoint, same-run same-tool candidates (§10) |

## 10. Pre-upload gate

Run immediately before submitting, and upload only if all four pass:

```bash
cd research/effect-identity && npm test && node src/experiments/verify.js
node docs/research/aij/build.mjs
```

Then confirm: affiliation country filled in (§2), all five declarations
confirmed (§3), concurrent-submission statement written (§4), artifact archived
with a DOI (§1), and suggested/opposed reviewers listed if the system asks for
them **[AUTHOR]**.

---

**Superseded:** `docs/research/AIJ_SUBMISSION_CHECKLIST.md` (2026-09-14) is
replaced by this file. It described theorems the paper does not contain and
stated a fence-safety claim the paper explicitly disavows.

---

## AIJ Guide for Authors check — 2026-09-26 (revision)

Read from the live guide (sciencedirect.com/journal/artificial-intelligence/publish/guide-for-authors).

| Guide requirement | Manuscript now | Status |
|---|---|---|
| Review model: single anonymised | author named on title page | complies |
| Abstract <= 250 words, stands alone, no references | 226 words, no citations | complies |
| 1-10 keywords, avoid multi-word "and/of" | 7 keywords | complies |
| Highlights: 3-5 bullets, <= 85 characters incl. spaces, separate file with "highlights" in the name | 5 bullets, 74-83 chars, `highlights.txt` | complies (upload `highlights.txt` separately) |
| Title page: full postal address of affiliation incl. country | city/state/country only | **[AUTHOR] add postal address** |
| Research data: Option C — deposit data in a repository AND cite/link the dataset in the article | GitHub URL + "Zenodo DOI upon publication" | **[AUTHOR] deposit on Zenodo before submission and add the dataset DOI as a reference** |
| Declarations tool (competing interests) must be completed in the submission system | text in manuscript | **[AUTHOR] also complete the online tool** |
| Declaration of generative AI use | present, updated for this revision | complies |
| Numbered references in order of citation | elsarticle-num | complies |
| Denote powers of e by exp | appendix now uses \exp | fixed in this revision |
| Length: no limit, but > ~40 pages "often significantly delayed" | 85 review-format pages (12pt double-spaced preprint); main text 12,122 words | note: long by the guide's standard |
| Supplementary material: caption per file, submitted with the manuscript | one PDF (18 pp.) | give it a descriptive caption on upload |

The `submission/` folder (latex-source, zip, PDFs) predates this revision and is **stale**; rebuild it from the current sources before uploading.
