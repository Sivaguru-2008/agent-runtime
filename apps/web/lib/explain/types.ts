/**
 * Explainability knowledge base — shared types.
 *
 * The Explainability Transformation is built on a single principle: every
 * visible concept on the platform has ONE canonical explanation, authored once
 * in the registry and surfaced everywhere through reusable components.
 *
 * A `Concept` carries content for all five explainability layers:
 *   Layer 1 — Micro explanation  → `short`, `what`, `why`, `whyCare`, `example`
 *   Layer 2 — Status translation → see `lib/explain/status.ts`
 *   Layer 3 — Click-to-learn     → `howCalculated`, `dataSource`, `affectedBy`,
 *                                   `healthy`/`warning`/`critical`, `howToFix`, `faq`
 *   Layer 4 — Live narration     → see `lib/explain/narration.ts`
 *   Layer 5 — Why panel          → `whyQuestions`
 *   Graphs  — Visual guide       → `good`, `bad`, `interpret`
 *   Empty   — Empty-state copy   → `emptyTitle`, `emptyBody`
 */

export type Health = "healthy" | "warning" | "critical" | "neutral";

export interface FaqItem {
  q: string;
  a: string;
}

/** A live interpretation derived from a metric's current value. */
export interface Interpretation {
  level: Health;
  /** Plain-language reading of the current value. */
  reading: string;
  /** What this implies for the run / cluster. */
  impact?: string;
  /** What the operator should do, if anything. */
  recommendation?: string;
}

export interface Concept {
  /** Stable kebab-case id used to reference this concept from any component. */
  id: string;
  /** Human-friendly title. */
  label: string;

  // ── Layer 1: micro explanation (hover) ──────────────────────────────────
  /** One sentence: what this is. Always shown first. */
  short: string;
  /** Fuller "what this is" paragraph. */
  what: string;
  /** Why this exists / why the platform tracks it. */
  why: string;
  /** Why a non-technical user should care. */
  whyCare: string;
  /** A concrete, plain-language example. */
  example?: string;

  // ── Layer 3: click-to-learn (full panel) ────────────────────────────────
  howCalculated?: string;
  dataSource?: string;
  affectedBy?: string[];
  /** Healthy range / state, in plain words (e.g. "0–20%"). */
  healthy?: string;
  /** Warning range / state. */
  warning?: string;
  /** Critical range / state. */
  critical?: string;
  howToFix?: string[];
  faq?: FaqItem[];

  // ── Graph visual guide ──────────────────────────────────────────────────
  /** What "good" looks like on the chart. */
  good?: string;
  /** What "bad" looks like on the chart. */
  bad?: string;
  /** Optional unit suffix for displayed values (e.g. "%", "ms"). */
  unit?: string;
  /**
   * Turn a current numeric value into a live interpretation for the graph
   * guide (current reading + impact + recommendation).
   */
  interpret?: (value: number) => Interpretation;

  // ── Layer 5: why panel ──────────────────────────────────────────────────
  /** Common "Why did X happen?" questions answered for this concept. */
  whyQuestions?: FaqItem[];

  // ── Empty-state redesign ────────────────────────────────────────────────
  emptyTitle?: string;
  emptyBody?: string;
}
