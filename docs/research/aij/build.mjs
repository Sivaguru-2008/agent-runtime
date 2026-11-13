#!/usr/bin/env node
/**
 * Build the AIJ submission.
 *
 *   node docs/research/aij/build.mjs            figure data, all checks, compile both PDFs
 *   node docs/research/aij/build.mjs --check    figure data and checks only
 *
 * Order matters: figure data is regenerated from research/effect-identity/results/
 * first, then every quoted interval (checkPaper.js) and every headline number and
 * stale string (tools/check-claims.mjs) is checked, and only then is LaTeX run. A
 * failed check stops the build, so a PDF never ships with a number that the
 * results do not contain.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const artifact = resolve(here, "..", "..", "..", "research", "effect-identity");

function run(cmd, args, { cwd = here, allowFail = false, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (!quiet && r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0 && !allowFail) {
    if (quiet && r.stdout) process.stdout.write(r.stdout.slice(-4000));
    process.stderr.write(r.stderr ?? "");
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
  }
  return r;
}

// Recursive: the supplement's generated tables live in supplement/tables/, and
// they quote intervals too, so they must reach the checkers like any other file.
const walkTex = (rel) => (existsSync(resolve(here, rel))
  ? readdirSync(resolve(here, rel), { withFileTypes: true }).flatMap((e) =>
    (e.isDirectory() ? walkTex(`${rel}/${e.name}`) : e.name.endsWith(".tex") ? [`${rel}/${e.name}`] : []))
  : []);
const texFiles = () => ["manuscript.tex", "supplement.tex",
  ...walkTex("sections"), ...walkTex("supplement"), ...walkTex("figures")]
  .filter((f) => f.endsWith(".tex") && existsSync(resolve(here, f)));

console.log("── 1. figure data from results/");
run("node", [resolve(here, "tools", "make-figure-data.mjs")]);
run("node", [resolve(here, "tools", "make-supp-tables.mjs")], { quiet: true });
// Branch aij-revision-mclive: the multi-candidate experiment's result slots.
// Fails (and so fails the build) until results/multi_candidate_live.json exists.
run("node", [resolve(here, "tools", "make-mclive-slots.mjs")]);

console.log("── 2. quoted intervals (checkPaper.js)");
run("node", [resolve(artifact, "src", "experiments", "checkPaper.js"), "--manuscript", texFiles().map((f) => resolve(here, f)).join(",")]);

console.log("── 3. headline numbers, stale strings, qualified guarantees (check-claims.mjs)");
run("node", [resolve(here, "tools", "check-claims.mjs")]);

console.log("── 4. artifact verifier (verify.js)");
run("node", [resolve(artifact, "src", "experiments", "verify.js")], { cwd: artifact });

if (process.argv.includes("--check")) { console.log("checks passed (--check: not compiling)"); process.exit(0); }

console.log("── 5. LaTeX");
for (const doc of ["manuscript", "supplement"]) {
  if (!existsSync(resolve(here, `${doc}.tex`))) continue;
  const tex = ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", `${doc}.tex`];
  run("pdflatex", tex, { quiet: true });
  run("bibtex", [doc], { quiet: true, allowFail: doc === "supplement" });
  run("pdflatex", tex, { quiet: true });
  run("pdflatex", tex, { quiet: true });
  const log = readFileSync(resolve(here, `${doc}.log`), "utf8");
  const problems = [
    ...log.matchAll(/LaTeX Warning: (Reference|Citation) `([^']+)' .*undefined/g),
  ].map((m) => `${m[1]} ${m[2]} undefined`);
  const overfull = [...log.matchAll(/Overfull \\hbox \(([\d.]+)pt too wide\)/g)].map((m) => +m[1]).filter((w) => w > 20);
  const pages = (log.match(/Output written on .*?\((\d+) pages?/) ?? [])[1];
  console.log(`${doc}.pdf: ${pages} pages; ${problems.length} undefined refs/cites; ${overfull.length} overfull boxes > 20pt`);
  if (problems.length) { for (const p of [...new Set(problems)]) console.error(`  ${p}`); process.exit(1); }
}
console.log("build complete");
