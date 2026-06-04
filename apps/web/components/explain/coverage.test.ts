import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONCEPTS, getConcept } from "@/lib/explain/registry";
import { hasTranslation } from "@/lib/explain/status";
import { validateAreaCoverage } from "@/lib/explain/areas";

/**
 * Coverage lock.
 *
 * The explainability system only works if every concept id referenced in the UI
 * actually exists in the registry, and every registry concept is reachable from
 * the glossary. These tests fail loudly the moment that drifts:
 *
 *   1. Every `concept="…"` / `concept: "…"` literal (ExplainLabel,
 *      ExplainedEmptyState, GraphGuide, WhyChip, the operator TABS, the tour
 *      steps) must resolve to a real concept.
 *   2. Every literal `<StatusPill status="…">` must have a status translation.
 *   3. Every concept must be assigned a glossary area (and no area entry may
 *      point at a concept that no longer exists).
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN_DIRS = ["app", "components", "lib"].map((d) => path.join(WEB_ROOT, d));

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const SOURCE_FILES = SCAN_DIRS.flatMap(walk);

/** A literal `concept="x"`, `concept='x'`, or `concept: "x"` reference. */
const CONCEPT_REF = /\bconcept\s*[=:]\s*["']([\w-]+)["']/g;
/** A literal `<StatusPill ... status="x">` reference. */
const STATUSPILL_REF = /<StatusPill\b[^>]*?\bstatus\s*=\s*["']([\w-]+)["']/gs;

function rel(file: string): string {
  return path.relative(WEB_ROOT, file).replace(/\\/g, "/");
}

describe("explainability coverage lock", () => {
  it("scans actual source files (sanity)", () => {
    // If this ever drops to ~0 the scan globbing has broken and the other tests
    // would pass vacuously.
    expect(SOURCE_FILES.length).toBeGreaterThan(20);
  });

  it("references only concept ids that exist in the registry", () => {
    const violations: string[] = [];
    for (const file of SOURCE_FILES) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(CONCEPT_REF)) {
        const id = match[1];
        if (!getConcept(id)) {
          violations.push(`${rel(file)} → concept "${id}" is not in the registry`);
        }
      }
    }
    expect(violations, `Unknown concept ids referenced:\n  ${violations.join("\n  ")}`).toEqual([]);
  });

  it("uses only StatusPill status codes that have a translation", () => {
    const violations: string[] = [];
    for (const file of SOURCE_FILES) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(STATUSPILL_REF)) {
        const code = match[1];
        if (!hasTranslation(code)) {
          violations.push(`${rel(file)} → StatusPill status "${code}" has no translation`);
        }
      }
    }
    expect(violations, `Untranslated StatusPill status literals:\n  ${violations.join("\n  ")}`).toEqual([]);
  });

  it("assigns every registry concept to a glossary area, with no orphans", () => {
    const { missingArea, orphanArea } = validateAreaCoverage();
    expect(missingArea, `Concepts missing a glossary area: ${missingArea.join(", ")}`).toEqual([]);
    expect(orphanArea, `Area entries pointing at unknown concepts: ${orphanArea.join(", ")}`).toEqual([]);
  });

  it("keeps the registry non-trivial (guards an empty import)", () => {
    expect(Object.keys(CONCEPTS).length).toBeGreaterThan(40);
  });
});
