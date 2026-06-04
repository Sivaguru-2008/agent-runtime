import { describe, expect, it } from "vitest";
import { collectCoverage, parseIgnoreReason } from "../../scripts/explain-coverage.mjs";

/**
 * Coverage gate.
 *
 * Sibling to coverage.test.ts, but where that one locks concept/status *wiring*,
 * this one locks raw-string *coverage*: it runs the exact detection logic from
 * scripts/explain-coverage.mjs and fails the moment a new bare status code or
 * empty-state string lands in app/ or components/ without being routed through
 * the explain system (StatusPill / ExplainedEmptyState) or explicitly waived
 * with a reasoned `explain-coverage-ignore:` marker.
 *
 * The standalone `node scripts/explain-coverage.mjs --strict` invocation shares
 * this logic, so CLI and CI agree.
 */

describe("explainability coverage gate", () => {
  const result = collectCoverage();

  it("scans actual source files (sanity)", () => {
    // Guards against the scan globbing silently breaking and the gate passing
    // vacuously.
    expect(result.files.length).toBeGreaterThan(20);
  });

  it("has zero un-routed, un-ignored status strings", () => {
    const detail = result.statusHits.map((h) => `${h.loc}  →  ${h.text}`).join("\n  ");
    expect(result.statusHits, `Raw status strings not using <StatusPill>:\n  ${detail}`).toEqual([]);
  });

  it("has zero un-routed, un-ignored empty-state strings", () => {
    const detail = result.emptyHits.map((h) => `${h.loc}  →  ${h.text}`).join("\n  ");
    expect(result.emptyHits, `Bare empty-state strings not using <ExplainedEmptyState>:\n  ${detail}`).toEqual([]);
  });

  it("rejects explain-coverage-ignore markers without a reason", () => {
    const detail = result.malformedIgnores.map((h) => `${h.loc}  →  ${h.line}`).join("\n  ");
    expect(
      result.malformedIgnores,
      `explain-coverage-ignore markers missing a reason:\n  ${detail}`,
    ).toEqual([]);
  });

  it("actually exercises the waiver path (not vacuously zero)", () => {
    // The one deliberate exception — the "No dependencies (Root source)." inline
    // lineage attribute in memory-trust-panel.tsx — must still be reached and
    // waived. If this disappears, the marker mechanism has silently broken.
    const waived = result.ignored.find(
      (h) => h.kind === "empty" && h.loc.includes("memory-trust-panel.tsx"),
    );
    expect(waived, "expected the memory-trust-panel root-source line to be waived").toBeTruthy();
  });
});

describe("parseIgnoreReason (waiver enforcement)", () => {
  const TOKEN = "explain-coverage-ignore:";

  it("returns null when no marker is present", () => {
    expect(parseIgnoreReason("const x = 1; // ordinary comment")).toBeNull();
  });

  it("extracts the reason from a // line-comment marker", () => {
    expect(parseIgnoreReason(`<span/> // ${TOKEN} legit reason here`)).toBe("legit reason here");
  });

  it("extracts the reason from a {/* ... */} JSX-comment marker", () => {
    expect(parseIgnoreReason(`{/* ${TOKEN} another reason */}`)).toBe("another reason");
  });

  it("treats an empty reason as malformed (empty string, not null)", () => {
    expect(parseIgnoreReason(`// ${TOKEN}   `)).toBe("");
    expect(parseIgnoreReason(`{/* ${TOKEN} */}`)).toBe("");
  });
});
