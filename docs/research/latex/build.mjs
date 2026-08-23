#!/usr/bin/env node
/**
 * Markdown -> LaTeX build for "Effect Identity for Non-Deterministic Agents".
 *
 * The Markdown manuscript is the single source of truth. This script converts
 * it mechanically so the two cannot drift; the preamble below is the only
 * hand-written LaTeX in the pipeline.
 *
 *   node docs/research/latex/build.mjs
 *
 * Emits effect-identity.tex beside this script and prints a validation report
 * (balanced environments, unescaped specials, residual Markdown, citation
 * coverage). Exits non-zero if any check fails.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "..", "Semantic-Effect-Identity-Paper.md");
const OUT = resolve(here, "effect-identity.tex");
const BIB = resolve(here, "effect-identity.bib");

// ── character map ───────────────────────────────────────────────────────────
// Applied to prose only; verbatim blocks are passed through untouched.
const UNI = [
  ["\u00a7", "\\S"], ["\u2014", "---"], ["\u2013", "--"],
  ["\u2018", "`"], ["\u2019", "'"], ["\u201c", "``"], ["\u201d", "''"],
  ["\u2026", "\\ldots{}"], ["\u2020", "$\\dagger$"], ["\u00d7", "$\\times$"],
  ["\u00b7", "$\\cdot$"], ["\u00b1", "$\\pm$"], ["\u00f7", "$\\div$"],
  ["\u03b1", "$\\alpha$"], ["\u03b2", "$\\beta$"], ["\u03b3", "$\\gamma$"],
  ["\u03ba", "$\\kappa$"], ["\u03c3", "$\\sigma$"], ["\u03c0", "$\\pi$"],
  ["\u03c4", "$\\tau$"], ["\u03a9", "$\\Omega$"], ["\u03ba", "$\\kappa$"],
  ["\u2248", "$\\approx$"], ["\u2249", "$\\not\\approx$"], ["\u2261", "$\\equiv$"],
  ["\u2260", "$\\neq$"], ["\u2264", "$\\leq$"], ["\u2265", "$\\geq$"],
  ["\u2192", "$\\to$"], ["\u21d2", "$\\Rightarrow$"], ["\u27fa", "$\\iff$"],
  ["\u21d4", "$\\Leftrightarrow$"], ["\u2208", "$\\in$"], ["\u2209", "$\\notin$"],
  ["\u222a", "$\\cup$"], ["\u2229", "$\\cap$"], ["\u2286", "$\\subseteq$"],
  ["\u2205", "$\\emptyset$"], ["\u221e", "$\\infty$"], ["\u2203", "$\\exists$"],
  ["\u2200", "$\\forall$"], ["\u2211", "$\\sum$"], ["\u2308", "$\\lceil$"],
  ["\u2309", "$\\rceil$"], ["\u230a", "$\\lfloor$"], ["\u230b", "$\\rfloor$"],
  ["\u2016", "$\\|$"], ["\u27e6", "$\\llbracket$"], ["\u27e7", "$\\rrbracket$"],
  ["\u2218", "$\\circ$"], ["\u2032", "$'$"], ["\u2033", "$''$"],
  ["\u03c7", "$\\chi$"], ["\u03bc", "$\\mu$"], ["\u03b4", "$\\delta$"], ["\u03bb", "$\\lambda$"],
  ["\u2227", "$\\wedge$"], ["\u2228", "$\\vee$"], ["\u00ac", "$\\neg$"],
  ["\u220e", "$\\blacksquare$"], ["\u2194", "$\\leftrightarrow$"], ["\u2212", "$-$"],
  ["\u2080", "$_0$"], ["\u2081", "$_1$"], ["\u2082", "$_2$"], ["\u2083", "$_3$"],
  ["\u2074", "$^4$"], ["\u2075", "$^5$"], ["\u00b2", "$^2$"], ["\u00b3", "$^3$"],
  ["\u2500", "-"], ["\u2502", "|"], ["\u250c", "+"], ["\u2510", "+"],
  ["\u2514", "+"], ["\u2518", "+"], ["\u251c", "+"], ["\u2524", "+"],
  ["\u252c", "+"], ["\u2534", "+"], ["\u253c", "+"], ["\u25bc", "v"],
  ["\u2013", "--"], ["\u00e9", "\\'e"], ["\u00ef", "\\\"i"], ["\u00ea", "\\^e"],
  ["\u00e8", "\\`e"], ["\u00fc", "\\\"u"], ["\u00f6", "\\\"o"], ["\u00e4", "\\\"a"],
  ["\u00e7", "\\c{c}"], ["\u00f1", "\\~n"], ["\u00e1", "\\'a"], ["\u00ed", "\\'i"],
  ["\u00f3", "\\'o"], ["\u00fa", "\\'u"], ["\u00e5", "\\aa{}"], ["\u00f8", "\\o{}"],
];

const asciiFold = (s) => {
  for (const [from, to] of UNI) s = s.split(from).join(to);
  return s;
};

/**
 * Verbatim blocks cannot carry math, so symbols are transliterated to readable
 * ASCII instead. Applied to displayed pseudocode and the architecture diagram.
 */
const VERB = [
  ["α", "alpha"], ["β", "beta"], ["γ", "gamma"], ["κ", "kappa"], ["σ", "sigma"],
  ["π", "pi"], ["τ", "tau"], ["Ω", "Omega"], ["≈", "~="], ["≉", "!~="],
  ["≡", "=="], ["≠", "!="], ["≤", "<="], ["≥", ">="], ["→", "->"],
  ["⇒", "=>"], ["⟺", "<=>"], ["⇔", "<=>"], ["↔", "<->"], ["∈", " in "],
  ["∉", " notin "], ["∪", " U "], ["∩", " ^ "], ["⊆", " subset= "],
  ["∅", "{}"], ["∞", "INF"], ["∃", "exists"], ["∀", "forall"], ["∑", "sum"],
  ["∧", " and "], ["∨", " or "], ["¬", "not "], ["∎", "[]"],
  ["⌈", "ceil("], ["⌉", ")"], ["⌊", "floor("], ["⌋", ")"], ["‖", "||"],
  ["⟦", "[["], ["⟧", "]]"], ["∘", "o"], ["×", "x"], ["·", "."], ["±", "+/-"],
  ["−", "-"], ["₀", "0"], ["₁", "1"], ["₂", "2"], ["₃", "3"],
  ["²", "^2"], ["³", "^3"], ["⁴", "^4"], ["⁵", "^5"],
  ["—", "--"], ["–", "-"], ["…", "..."], ["†", "+"], ["§", "S"],
  ["‘", "'"], ["’", "'"], ["“", '"'], ["”", '"'], ["′", "'"], ["″", "''"],
  ["─", "-"], ["│", "|"], ["┌", "+"], ["┐", "+"], ["└", "+"], ["┘", "+"],
  ["├", "+"], ["┤", "+"], ["┬", "+"], ["┴", "+"], ["┼", "+"], ["▼", "v"],
];
const verbFold = (s) => {
  for (const [from, to] of VERB) s = s.split(from).join(to);
  return s;
};

/** Escape TeX specials outside math and outside \texttt spans. */
const escapeSpecials = (s) =>
  s.replace(/([&%#_])/g, "\\$1").replace(/\^/g, "\\textasciicircum{}").replace(/~/g, "\\textasciitilde{}");

/**
 * Inline conversion. Order matters: code spans are lifted out first so their
 * contents are never touched by emphasis or escaping rules, then restored.
 */
/**
 * Convert one code span to \texttt{}. Unicode is folded first (which may emit
 * `$...$` math, legal and correctly rendered inside \texttt), then the specials
 * that would otherwise be typeset as markup are escaped. Literal currency
 * dollars are neutralised before folding so they cannot open a math group.
 */
function codeSpan(code) {
  let s = code.replace(/\\\$/g, "\u0001").replace(/\$(?=[\d\s({])/g, "\u0001");
  s = asciiFold(s);
  s = s.replace(/([&%#_])/g, "\\$1").replace(/\^/g, "\\textasciicircum{}").replace(/~/g, "\\textasciitilde{}");
  return `\\texttt{${s.replace(/\u0001/g, "\\$")}}`;
}

function inline(text) {
  const held = [];
  const hold = (tex) => `\u0000${held.push(tex) - 1}\u0000`;

  // Code spans first: their contents must survive every later rule, and lifting
  // math first would consume `$` characters and break backtick pairing.
  text = text.replace(/`([^`]+)`/g, (_, code) => hold(codeSpan(code)));
  // Math the source already wrote as $...$
  text = text.replace(/\$([^$]+)\$/g, (_, m) => hold(`$${m}$`));
  // Markdown-escaped currency
  text = text.replace(/\\\$/g, () => hold("\\$"));
  // Bracketed numeric citations
  text = text.replace(/\[((?:\d+\s*,\s*)*\d+)\]/g, (_, nums) =>
    hold(`\\cite{${nums.split(",").map((n) => "ref" + n.trim()).join(",")}}`));

  text = asciiFold(text);
  text = escapeSpecials(text);

  // Non-greedy so bold spans may contain italics.
  text = text.replace(/\*\*([\s\S]+?)\*\*/g, "\\textbf{$1}");
  text = text.replace(/(^|[^*\\])\*([^*\n]+)\*/g, "$1\\emph{$2}");

  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => held[+i]);
}

// ── block parsing ───────────────────────────────────────────────────────────
const src = readFileSync(SRC, "utf8").split("\n");

/** Split the document into the front matter and the body (from "## Abstract"). */
const absAt = src.findIndex((l) => l.trim() === "## Abstract");
const refsAt = src.findIndex((l) => l.trim() === "## References");
const appAt = src.findIndex((l) => l.startsWith("## Appendix A"));

const body = src.slice(absAt, refsAt).concat(src.slice(appAt));

const out = [];
let i = 0;

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSepRow = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);

function emitTable(rows) {
  // `\|` is an escaped pipe inside a cell, not a column separator.
  const cells = rows.map((r) =>
    r.trim().replace(/\\\|/g, "").replace(/^\|/, "").replace(/\|$/, "")
      .split("|").map((c) => c.trim().replace(//g, "|")));
  const head = cells[0];
  const rest = cells.slice(2); // skip the alignment row
  const n = head.length;
  const spec = "l".repeat(n);
  out.push("\\begin{table}[htbp]");
  out.push("\\centering\\small");
  out.push(`\\begin{tabular}{${spec}}`);
  out.push("\\toprule");
  out.push(head.map(inline).join(" & ") + " \\\\");
  out.push("\\midrule");
  for (const row of rest) {
    const padded = row.slice(0, n);
    while (padded.length < n) padded.push("");
    out.push(padded.map(inline).join(" & ") + " \\\\");
  }
  out.push("\\bottomrule");
  out.push("\\end{tabular}");
  out.push("\\end{table}");
  out.push("");
}

/**
 * Emit the body of a theorem-like block, honouring fenced code inside it:
 * several statements (Definition 6, T3's calibration rule) carry displayed
 * pseudocode that must not be run through the inline converter.
 */
function emitBody(text) {
  const chunks = text.split(/^```.*$/m);
  chunks.forEach((chunk, k) => {
    if (k % 2 === 1) {
      out.push("\\begin{verbatim}");
      for (const l of chunk.split("\n")) if (l.trim() || out[out.length - 1] !== "") out.push(verbFold(l));
      out.push("\\end{verbatim}");
      return;
    }
    for (const para of chunk.split(/\n\s*\n/)) {
      const p = para.trim();
      if (p) out.push(inline(p.replace(/\n/g, " ")));
    }
  });
}

/** A blockquote, typeset as a named theorem environment when it opens with one. */
function emitQuote(lines) {
  const text = lines.map((l) => l.replace(/^>\s?/, "")).join("\n").trim();
  const m = text.match(/^\*\*([^*]+)\*\*\.?\s*/);
  const head = m ? m[1] : null;
  const rest = m ? text.slice(m[0].length) : text;
  const env = head && /^(Theorem|Corollary|Proposition)/i.test(head) ? "namedthm"
    : head && /^Definition/i.test(head) ? "nameddef"
    : head && /^Assumption/i.test(head) ? "assumption"
    : null;
  if (!env) {
    out.push("\\begin{quote}");
    emitBody(text);
    out.push("\\end{quote}");
  } else {
    out.push(`\\begin{${env}}[${inline(head)}]`);
    emitBody(rest);
    out.push(`\\end{${env}}`);
  }
  out.push("");
}

let listOpen = null;
const closeList = () => { if (listOpen) { out.push(`\\end{${listOpen}}`); listOpen = null; out.push(""); } };

while (i < body.length) {
  const line = body[i];

  if (line.trim() === "## Abstract") {
    out.push("\\begin{abstract}");
    i++;
    const buf = [];
    while (i < body.length && !/^##\s/.test(body[i]) && !/^\*\*Keywords/.test(body[i])) { buf.push(body[i]); i++; }
    for (const para of buf.join("\n").split(/\n\s*\n/)) {
      if (para.trim()) out.push(inline(para.trim().replace(/\n/g, " ")));
    }
    out.push("\\end{abstract}");
    out.push("");
    continue;
  }

  if (/^\*\*Keywords/.test(line)) {
    closeList();
    out.push("\\medskip\\noindent " + inline(line.trim()));
    out.push("");
    i++;
    continue;
  }

  // headings
  let h;
  if ((h = line.match(/^##\s+(?:\d+\.\s*)?(.+)$/))) {
    closeList();
    const title = h[1].replace(/^Appendix A\s*[-\u2014]\s*/, "");
    if (/^Appendix A/.test(line)) { out.push("\\appendix"); out.push(`\\section{${inline(title)}}`); }
    else out.push(`\\section{${inline(title)}}`);
    out.push("");
    i++;
    continue;
  }
  if ((h = line.match(/^###\s+(?:[\d.]+\s+)?(.+)$/))) {
    closeList();
    out.push(`\\subsection{${inline(h[1])}}`);
    out.push("");
    i++;
    continue;
  }

  // fenced code
  if (/^```/.test(line)) {
    closeList();
    i++;
    out.push("\\begin{verbatim}");
    while (i < body.length && !/^```/.test(body[i])) {
      out.push(verbFold(body[i]).replace(/\t/g, "    "));
      i++;
    }
    i++;
    out.push("\\end{verbatim}");
    out.push("");
    continue;
  }

  // tables
  if (isTableRow(line) && i + 1 < body.length && isSepRow(body[i + 1])) {
    closeList();
    const rows = [];
    while (i < body.length && isTableRow(body[i])) { rows.push(body[i]); i++; }
    emitTable(rows);
    continue;
  }

  // blockquotes
  if (/^>/.test(line)) {
    closeList();
    const q = [];
    while (i < body.length && (/^>/.test(body[i]) || (q.length && body[i].trim() === "" && /^>/.test(body[i + 1] ?? "")))) {
      q.push(body[i]); i++;
    }
    emitQuote(q);
    continue;
  }

  // horizontal rule
  if (/^---+\s*$/.test(line)) { closeList(); i++; continue; }

  // lists
  let li;
  if ((li = line.match(/^(\s*)-\s+(.*)$/))) {
    if (listOpen !== "itemize") { closeList(); out.push("\\begin{itemize}[leftmargin=*]"); listOpen = "itemize"; }
    let item = li[2];
    while (i + 1 < body.length && body[i + 1].trim() && !/^\s*[-\d]/.test(body[i + 1]) && !/^[#>|`]/.test(body[i + 1])) {
      item += " " + body[++i].trim();
    }
    out.push(`  \\item ${inline(item)}`);
    i++;
    continue;
  }
  if ((li = line.match(/^(\s*)\d+\.\s+(.*)$/))) {
    if (listOpen !== "enumerate") { closeList(); out.push("\\begin{enumerate}[leftmargin=*]"); listOpen = "enumerate"; }
    let item = li[2];
    while (i + 1 < body.length && body[i + 1].trim() && !/^\s*[-\d]/.test(body[i + 1]) && !/^[#>|`]/.test(body[i + 1])) {
      item += " " + body[++i].trim();
    }
    out.push(`  \\item ${inline(item)}`);
    i++;
    continue;
  }

  // A blank line inside a list is a paragraph break between items, not the end
  // of the list: look ahead before closing.
  if (line.trim() === "") {
    if (listOpen) {
      let j = i;
      while (j < body.length && body[j].trim() === "") j++;
      const next = body[j] ?? "";
      const stillList = listOpen === "itemize" ? /^\s*-\s+/.test(next) : /^\s*\d+\.\s+/.test(next);
      if (!stillList) closeList();
    }
    out.push("");
    i++;
    continue;
  }

  // paragraph
  let para = line;
  i++;
  while (i < body.length && body[i].trim() && !/^[#>|`\-]/.test(body[i]) && !/^\d+\.\s/.test(body[i]) && !/^---/.test(body[i])) {
    para += " " + body[i]; i++;
  }
  out.push(inline(para.trim()));
  out.push("");
}
closeList();

// ── assemble ────────────────────────────────────────────────────────────────
const preamble = `\\documentclass[11pt]{article}

%% GENERATED FILE -- do not edit.
%% Source: docs/research/Semantic-Effect-Identity-Paper.md
%% Rebuild: node docs/research/latex/build.mjs
%% Compile: latexmk -pdf effect-identity.tex

\\usepackage[a4paper,margin=1in]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage[expansion=false]{microtype}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{stmaryrd}
\\usepackage{booktabs}
\\usepackage{array}
\\usepackage{longtable}
\\usepackage{graphicx}
\\usepackage{xcolor}
\\usepackage{enumitem}
\\usepackage{textcomp}
\\usepackage[numbers,sort&compress]{natbib}
\\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}

\\theoremstyle{plain}
\\newtheorem*{namedthm}{Theorem}
\\theoremstyle{definition}
\\newtheorem*{nameddef}{Definition}
\\newtheorem*{assumption}{Assumption}
\\theoremstyle{remark}
\\newtheorem*{remark}{Remark}

\\title{Effect Identity for Non-Deterministic Agents:\\\\
Certifiers, Refuters, and the Calibrated Residual}
\\author{Sivaguru R. M.\\\\
\\small Independent Research \\textperiodcentered{} AgentRuntime Project\\\\
\\small \\texttt{sivagurumurugan1@gmail.com}}
\\date{August 2026}

\\begin{document}
\\maketitle
`;

const postamble = `
\\bibliographystyle{plainnat}
\\bibliography{effect-identity}

\\end{document}
`;

let tex = preamble + out.join("\n").replace(/\n{3,}/g, "\n\n") + postamble;
writeFileSync(OUT, tex, "utf8");

// ── validation ──────────────────────────────────────────────────────────────
const problems = [];
const verbatimStripped = tex.replace(/\\begin\{verbatim\}[\s\S]*?\\end\{verbatim\}/g, "");

const begins = [...tex.matchAll(/\\begin\{(\w+\*?)\}/g)].map((m) => m[1]);
const ends = [...tex.matchAll(/\\end\{(\w+\*?)\}/g)].map((m) => m[1]);
if (begins.length !== ends.length) problems.push(`unbalanced environments: ${begins.length} begin / ${ends.length} end`);
const tally = {};
for (const b of begins) tally[b] = (tally[b] ?? 0) + 1;
for (const e of ends) tally[e] = (tally[e] ?? 0) - 1;
for (const [k, v] of Object.entries(tally)) if (v !== 0) problems.push(`environment ${k} off by ${v}`);

for (const [n, line] of verbatimStripped.split("\n").entries()) {
  const dollars = (line.match(/(?<!\\)\$/g) ?? []).length;
  if (dollars % 2) problems.push(`odd $ count on line ${n + 1}: ${line.slice(0, 90)}`);
}

const residue = [
  [/\*\*/g, "bold markers"],
  [/^\s*\|/m, "markdown table pipe"],
  [/\\paste\{/g, "paste stub"],
];
for (const [re, name] of residue) if (re.test(verbatimStripped)) problems.push(`residual Markdown: ${name}`);

const nonAscii = verbatimStripped.match(/[^\x00-\x7F]/g);
if (nonAscii) problems.push(`non-ASCII outside verbatim: ${[...new Set(nonAscii)].join(" ")}`);

const bib = readFileSync(BIB, "utf8");
const bibKeys = new Set([...bib.matchAll(/@\w+\{(ref\d+)\s*,/g)].map((m) => m[1]));
const cited = new Set([...tex.matchAll(/\\cite\{([^}]+)\}/g)].flatMap((m) => m[1].split(",")));
const dangling = [...cited].filter((k) => !bibKeys.has(k));
if (dangling.length) problems.push(`dangling citations: ${dangling.join(", ")}`);
const uncited = [...bibKeys].filter((k) => !cited.has(k));

console.log(`wrote ${OUT}`);
console.log(`  ${tex.split("\n").length} lines, ${begins.length} environments, ${cited.size}/${bibKeys.size} bib keys cited`);
if (uncited.length) console.log(`  note: ${uncited.length} bibliography entries not cited in the body`);
if (problems.length) {
  console.error("\nVALIDATION FAILURES:");
  for (const p of problems.slice(0, 25)) console.error("  - " + p);
  if (problems.length > 25) console.error(`  ... and ${problems.length - 25} more`);
  process.exit(1);
}
console.log("  validation: all checks passed");
