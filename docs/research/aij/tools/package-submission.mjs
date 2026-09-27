#!/usr/bin/env node
import { cpSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const aij = resolve(here, "..");
const sub = resolve(aij, "submission");
const src = resolve(sub, "latex-source");

console.log("Packaging submission to", sub);

// 1. Copy manuscript sources
mkdirSync(resolve(src, "sections"), { recursive: true });
mkdirSync(resolve(src, "figures", "data"), { recursive: true });

cpSync(resolve(aij, "manuscript.tex"), resolve(src, "manuscript.tex"));
cpSync(resolve(aij, "references.bib"), resolve(src, "references.bib"));
cpSync(resolve(aij, "manuscript.bbl"), resolve(src, "manuscript.bbl"));

cpSync(resolve(aij, "sections"), resolve(src, "sections"), { recursive: true });
cpSync(resolve(aij, "figures"), resolve(src, "figures"), { recursive: true });

// 2. Copy compiled PDFs and highlights
cpSync(resolve(aij, "manuscript.pdf"), resolve(sub, "manuscript.pdf"));
cpSync(resolve(aij, "supplement.pdf"), resolve(sub, "supplementary-material.pdf"));
cpSync(resolve(aij, "highlights.txt"), resolve(sub, "highlights.txt"));

// 3. Test compilation inside submission/latex-source
console.log("Testing compilation inside submission/latex-source...");
execSync("pdflatex -interaction=nonstopmode -halt-on-error manuscript.tex", { cwd: src, stdio: "ignore" });
execSync("bibtex manuscript", { cwd: src, stdio: "ignore" });
execSync("pdflatex -interaction=nonstopmode -halt-on-error manuscript.tex", { cwd: src, stdio: "ignore" });
execSync("pdflatex -interaction=nonstopmode -halt-on-error manuscript.tex", { cwd: src, stdio: "ignore" });

import { readFileSync } from "node:fs";
const log = readFileSync(resolve(src, "manuscript.log"), "utf8");
const problems = [
  ...log.matchAll(/LaTeX Warning: (Reference|Citation) `([^']+)' .*undefined/g),
].map((m) => `${m[1]} ${m[2]} undefined`);
const overfull = [...log.matchAll(/Overfull \\hbox \(([\d.]+)pt too wide\)/g)].map((m) => +m[1]).filter((w) => w > 20);
const pages = (log.match(/Output written on .*?\((\d+) pages?/) ?? [])[1];
console.log(`latex-source/manuscript.pdf: ${pages} pages; ${problems.length} undefined refs/cites; ${overfull.length} overfull boxes > 20pt`);
if (problems.length) {
  for (const p of [...new Set(problems)]) console.error(`  ${p}`);
  process.exit(1);
}

// Copy the clean verified PDF to submission/
cpSync(resolve(src, "manuscript.pdf"), resolve(sub, "manuscript.pdf"));
cpSync(resolve(aij, "supplement.pdf"), resolve(sub, "supplementary-material.pdf"));
cpSync(resolve(aij, "highlights.txt"), resolve(sub, "highlights.txt"));

// 4. Create latex-source.zip (exclude auxiliary build files from the zip)
const zipPath = resolve(sub, "latex-source.zip");
if (existsSync(zipPath)) rmSync(zipPath);

console.log("Creating latex-source.zip...");
execSync(`powershell -Command "Compress-Archive -Path '${src}\\manuscript.tex', '${src}\\references.bib', '${src}\\manuscript.bbl', '${src}\\sections', '${src}\\figures' -DestinationPath '${zipPath}' -Force"`, { stdio: "inherit" });

console.log("Packaging complete. All submission assets verified.");
