#!/usr/bin/env node
/**
 * Lint-style coverage report for the explainability system.
 *
 * Unlike `coverage.test.ts` (which HARD-FAILS on broken concept references),
 * this LISTS UI strings that look like status codes or empty-state copy but are
 * NOT yet routed through the explain components (StatusPill / ExplainedEmptyState).
 *
 *   node scripts/explain-coverage.mjs            # report, exit 0
 *   node scripts/explain-coverage.mjs --strict   # exit 1 if anything is found
 *
 * A genuinely-unroutable line can be waived with an inline (or immediately
 * adjacent) marker, the same way a `routed` component short-circuits a line:
 *
 *   <span ...>No dependencies.</span> // explain-coverage-ignore: <why this is fine>
 *
 * The reason is mandatory: a marker with an empty reason is itself reported and
 * fails `--strict`, so waivers can never be added silently.
 *
 * The detection core (`collectCoverage`) is imported by
 * components/explain/explain-coverage.test.ts so the exact same logic gates CI.
 * Heuristics are deliberately conservative; review each hit by hand.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["app", "components"].map((d) => path.join(WEB_ROOT, d));

// Known internal status / role codes that should be displayed via <StatusPill>.
const STATUS_VOCAB = [
  "READY", "BUSY", "RUNNING", "QUEUED", "DRAINING", "DEGRADED", "STOPPING", "STOPPED",
  "REGISTERED", "LOST", "OFFLINE", "ERROR", "IDLE", "CREATED", "COMPLETED", "FAILED",
  "CANCELLED", "ACTIVE", "RELEASED", "EXPIRED", "RECLAIMED", "DLQ", "PENDING", "STREAMING",
  "SKIPPED", "REPLAYED",
];
const STATUS_RE = new RegExp(`>\\s*(${STATUS_VOCAB.join("|")})\\s*<`);

// Visible text that reads like a bare empty state (e.g. "No prompt mutations").
// Allows `{interpolations}` inside; only angle brackets / newlines end it.
const EMPTY_RE = />\s*(No [^<>\n]{2,70}|Nothing[^<>\n]{0,60}|Empty[^<>\n]{0,40})\s*</;

// Lines already routed through the explain system are never candidates.
const ROUTED_RE = /StatusPill|ExplainedEmptyState|ExplainLabel/;

// Per-line waiver marker. Works inside `//` line comments and `{/* ... */}`
// JSX comments alike — detection is purely textual.
const IGNORE_TOKEN = "explain-coverage-ignore:";

/**
 * Parse the waiver reason out of a single line.
 *   null  → no marker on this line
 *   ""    → marker present but the reason is empty/whitespace (malformed)
 *   "..." → the trimmed, non-empty reason text
 */
export function parseIgnoreReason(line) {
  const idx = line.indexOf(IGNORE_TOKEN);
  if (idx === -1) return null;
  // Drop a trailing comment terminator so both `*/` (block) and `*/}` (JSX
  // `{/* ... */}`) markers parse down to just the reason text.
  return line.slice(idx + IGNORE_TOKEN.length).replace(/\*\/\s*\}?\s*$/, "").trim();
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function relLoc(file, i) {
  return `${path.relative(WEB_ROOT, file).replace(/\\/g, "/")}:${i + 1}`;
}

/**
 * Scan app/ and components/ and bucket the findings:
 *   statusHits / emptyHits — un-ignored candidates (these fail the gate)
 *   ignored                — candidates waived by a valid adjacent marker (info)
 *   malformedIgnores       — markers with an empty reason (these fail the gate)
 */
export function collectCoverage() {
  const files = SCAN_DIRS.flatMap(walk);
  const statusHits = [];
  const emptyHits = [];
  const ignored = [];
  const malformedIgnores = [];

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);

    // A line is waived if it — or an immediately adjacent line — carries a
    // marker with a non-empty reason.
    const hasValidIgnore = (i) =>
      [i - 1, i, i + 1].some((j) => {
        if (j < 0 || j >= lines.length) return false;
        const reason = parseIgnoreReason(lines[j]);
        return typeof reason === "string" && reason.length > 0;
      });

    lines.forEach((line, i) => {
      const loc = relLoc(file, i);

      // Enforce non-empty reasons everywhere, independent of whether the marker
      // happens to sit next to a flagged line.
      if (parseIgnoreReason(line) === "") {
        malformedIgnores.push({ loc, line: line.trim() });
      }

      if (ROUTED_RE.test(line)) return; // already routed through the explain system

      const sm = line.match(STATUS_RE);
      if (sm) {
        const hit = { loc, kind: "status", text: sm[1], line: line.trim() };
        (hasValidIgnore(i) ? ignored : statusHits).push(hit);
      }
      const em = line.match(EMPTY_RE);
      if (em) {
        const hit = { loc, kind: "empty", text: em[1].trim(), line: line.trim() };
        (hasValidIgnore(i) ? ignored : emptyHits).push(hit);
      }
    });
  }

  return { files, statusHits, emptyHits, ignored, malformedIgnores };
}

function section(title, hits) {
  console.log(`\n${title}: ${hits.length}`);
  if (hits.length === 0) {
    console.log("  ✓ none found");
    return;
  }
  for (const h of hits) console.log(`  ${h.loc}  →  ${h.text}`);
}

function runReport() {
  const strict = process.argv.includes("--strict");
  const { files, statusHits, emptyHits, ignored, malformedIgnores } = collectCoverage();

  console.log("Explainability coverage report (advisory)");
  console.log("=========================================");
  console.log(`Scanned ${files.length} source files under app/ and components/.`);
  section("Raw status strings not using <StatusPill>", statusHits);
  section("Bare empty-state strings not using <ExplainedEmptyState>", emptyHits);

  if (ignored.length > 0) {
    console.log(`\nWaived by explain-coverage-ignore markers: ${ignored.length}`);
    for (const h of ignored) console.log(`  ${h.loc}  →  ${h.text}`);
  }

  if (malformedIgnores.length > 0) {
    console.log(`\n✗ explain-coverage-ignore markers missing a reason: ${malformedIgnores.length}`);
    for (const h of malformedIgnores) console.log(`  ${h.loc}  →  ${h.line}`);
  }

  const total = statusHits.length + emptyHits.length;
  console.log(`\nTotal candidates: ${total}`);

  if (strict && (total > 0 || malformedIgnores.length > 0)) {
    console.log("Exiting non-zero (--strict).");
    process.exit(1);
  }
  process.exit(0);
}

// Only emit the report when invoked directly (`node scripts/explain-coverage.mjs`),
// not when imported by the vitest gate.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runReport();
}
