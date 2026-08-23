# LaTeX build — *Effect Identity for Non-Deterministic Agents*

```bash
node docs/research/latex/build.mjs && latexmk -pdf effect-identity.tex
```

## Contents

| File | |
|---|---|
| `build.mjs` | Markdown → LaTeX converter. The only place the conversion rules live. |
| `effect-identity.tex` | **generated** — do not edit; rebuild instead |
| `effect-identity.bib` | 121 entries, keys `ref1`–`ref121` matching the prose numbering |
| `effect-identity-conf.tex` | **stale.** A hand-condensed conference variant from an earlier revision of the manuscript. It predates the current section numbering, the corrected per-tool and cost figures, and §8.11, and it should be regenerated from the current source before use rather than cited. |

## Provenance

`../Semantic-Effect-Identity-Paper.md` is the single source of truth. Earlier
revisions converted it by hand, which is how the `.tex` and the Markdown came to
disagree; `build.mjs` exists so that they cannot. The preamble is the only
hand-written LaTeX in the pipeline and lives inside the script.

## What the build checks

`build.mjs` exits non-zero on any of:

- unbalanced `\begin`/`\end`, per environment name
- an odd number of unescaped `$` on any line outside `verbatim`
- residual Markdown (`**`, table pipes, `\paste{}` stubs)
- non-ASCII outside `verbatim`
- citation keys with no matching bibliography entry

It also reports how many of the 121 bibliography entries the body cites.

## Conversion rules worth knowing

- **Code spans** become `\texttt{}`. Unicode inside them is folded to inline math
  (`κ` → `$\kappa$`), which renders correctly inside `\texttt`. Currency dollars
  are neutralised first so they cannot open a math group.
- **Verbatim blocks** cannot carry math, so symbols are transliterated to ASCII
  instead (`κ` → `kappa`, `≉` → `!~=`). The architecture diagram survives this
  because its box-drawing characters map to `+`, `-`, `|`.
- **Blockquotes** opening with a bolded `Theorem` / `Definition` / `Assumption`
  become the corresponding theorem environment, with any fenced code inside them
  emitted as `verbatim` rather than run through the inline converter.
- **Escaped pipes** (`\|`) inside a Markdown table cell are cell content, not
  column separators.

## Still to do before submission

1. **Table widths.** Tables are plain `l` columns at `\small`; the wide ones
   (the design-space table in §4.3, the gap table in §2.8, the judge comparison
   in §8.8) will overflow the text block and want `tabularx` or `\resizebox`.
2. **The architecture flowchart** (§5) is a `verbatim` ASCII diagram. It
   compiles; it should be redrawn in TikZ.
3. **Proof environments.** Proofs are plain paragraphs beginning *Proof.* rather
   than `amsthm`'s `proof` environment.
4. **Never compiled.** No TeX toolchain was available in the environment that
   produced this, so every claim above comes from the static checks in
   `build.mjs`. Expect to fix things on the first real `latexmk` run.

## Bibliography caveat

Entries `ref1`–`ref17` were checked individually against arXiv (title, authors,
identifier) and their claims are characterised in §2. Entries `ref18`–`ref121`
were transcribed from arXiv metadata queries: titles and identifiers come from
those records rather than from memory, but each identifier has **not** been
individually resolved, and the body cites them for area coverage rather than for
any specific finding. Resolve them before posting — a transposed 2026 identifier
is the most likely error in this file and the first thing a reader will check.

Author lists are truncated to the form given in the source list; several read
`Surname, I. and Surname, I.` where the arXiv record carries more authors.
