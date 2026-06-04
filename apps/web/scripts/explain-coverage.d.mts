// Type surface for explain-coverage.mjs so the vitest gate
// (components/explain/explain-coverage.test.ts) can import the detection core
// under `tsc --noEmit` / `next build` (the project sets allowJs: false).

export interface CoverageHit {
  /** `path/from/web/root.tsx:lineNumber` */
  loc: string;
  kind: "status" | "empty";
  /** The matched status code or empty-state phrase. */
  text: string;
  /** The trimmed source line. */
  line: string;
}

export interface MalformedIgnore {
  loc: string;
  line: string;
}

export interface CoverageResult {
  /** Absolute paths of every scanned source file. */
  files: string[];
  /** Raw status strings not routed through <StatusPill> (fail the gate). */
  statusHits: CoverageHit[];
  /** Bare empty-state strings not routed through <ExplainedEmptyState> (fail the gate). */
  emptyHits: CoverageHit[];
  /** Candidates waived by a valid explain-coverage-ignore marker (informational). */
  ignored: CoverageHit[];
  /** explain-coverage-ignore markers with an empty reason (fail the gate). */
  malformedIgnores: MalformedIgnore[];
}

export declare const WEB_ROOT: string;

/** Scan app/ and components/ and bucket coverage findings. */
export declare function collectCoverage(): CoverageResult;

/**
 * Parse the waiver reason out of a line:
 *   null  → no marker
 *   ""    → marker with an empty reason (malformed)
 *   "..." → the trimmed, non-empty reason
 */
export declare function parseIgnoreReason(line: string): string | null;
