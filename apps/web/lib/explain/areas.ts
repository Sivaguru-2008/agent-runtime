/**
 * Concept areas — the grouping used by the Concept Glossary search.
 *
 * Every concept in the registry belongs to exactly one area so the glossary can
 * present results in sensible, navigable sections instead of one flat list. The
 * areas mirror the major surfaces of the platform.
 *
 * This map is the single source of grouping truth. The coverage test
 * (`explain/coverage.test.ts`) fails if a concept exists in the registry but is
 * not assigned an area here (or vice-versa) — so a new concept can never quietly
 * fall out of the glossary.
 */

import { CONCEPTS, getConcept } from "./registry";
import type { Concept } from "./types";

export type ConceptArea =
  | "Getting Started"
  | "Overview"
  | "Execution & Ownership"
  | "Cognition"
  | "Memory"
  | "Cluster & Workers"
  | "Failure & Diagnosis"
  | "Replay & Time Travel";

/** Display order of areas in the glossary. */
export const AREA_ORDER: ConceptArea[] = [
  "Getting Started",
  "Overview",
  "Execution & Ownership",
  "Cognition",
  "Memory",
  "Cluster & Workers",
  "Failure & Diagnosis",
  "Replay & Time Travel",
];

/** Concept id → area. Must cover every id in the registry (enforced by tests). */
export const CONCEPT_AREA: Record<string, ConceptArea> = {
  // Getting Started / discovery
  "explain-mode": "Getting Started",
  "concept-glossary": "Getting Started",
  "guided-tour": "Getting Started",
  playground: "Getting Started",
  "operator-platform": "Getting Started",
  "durable-run-studio": "Getting Started",

  // Overview / top-level metrics
  "agents-total": "Overview",
  "agents-active": "Overview",
  "executions-running": "Overview",
  "executions-failed": "Overview",
  "tokens-total": "Overview",
  "stream-status": "Overview",
  "completed-executions": "Overview",
  "queue-depth": "Overview",

  // Execution & ownership
  execution: "Execution & Ownership",
  "execution-ownership": "Execution & Ownership",

  // Cognition
  cognition: "Cognition",
  "cognition-graph": "Cognition",
  nodes: "Cognition",
  "reasoning-intensity": "Cognition",
  "decision-heatmap": "Cognition",
  "uncertainty-heatmap": "Cognition",
  "token-stream": "Cognition",

  // Memory
  memory: "Memory",
  "memory-influence": "Memory",
  "memory-drift": "Memory",
  "memory-trust": "Memory",
  "memory-commit": "Memory",
  "memory-trust-score": "Memory",
  "contamination-alerts": "Memory",
  "stale-memories": "Memory",
  "suppressed-noise": "Memory",

  // Cluster & workers
  "cluster-topology": "Cluster & Workers",
  worker: "Cluster & Workers",
  "worker-health": "Cluster & Workers",
  "worker-utilisation": "Cluster & Workers",
  heartbeat: "Cluster & Workers",
  lease: "Cluster & Workers",
  leases: "Cluster & Workers",
  "lease-ttl": "Cluster & Workers",
  "oldest-lease": "Cluster & Workers",
  dlq: "Cluster & Workers",
  "coordination-pressure": "Cluster & Workers",
  "multi-agent-topology": "Cluster & Workers",

  // Failure & diagnosis
  failure: "Failure & Diagnosis",
  "failure-clusters": "Failure & Diagnosis",
  "self-healing-diagnostics": "Failure & Diagnosis",
  diagnose: "Failure & Diagnosis",
  trace: "Failure & Diagnosis",
  "root-cause": "Failure & Diagnosis",
  "health-score": "Failure & Diagnosis",

  // Replay & time travel
  replay: "Replay & Time Travel",
  "time-travel-replay": "Replay & Time Travel",
  scrubber: "Replay & Time Travel",
  timeline: "Replay & Time Travel",
  branch: "Replay & Time Travel",
  inject: "Replay & Time Travel",
  compare: "Replay & Time Travel",
  determinism: "Replay & Time Travel",
  fingerprint: "Replay & Time Travel",
};

/** The area for a concept id, or undefined if unassigned. */
export function areaOf(conceptId: string): ConceptArea | undefined {
  return CONCEPT_AREA[conceptId];
}

export interface GlossaryEntry {
  concept: Concept;
  area: ConceptArea;
}

export interface GlossaryGroup {
  area: ConceptArea;
  entries: GlossaryEntry[];
}

/**
 * Score how well a concept matches a query. Higher is better; 0 means no match.
 * Ranks exact id/label hits above prefix hits above substring hits, and weights
 * label/short/id over the longer prose fields.
 */
function score(concept: Concept, area: ConceptArea, q: string): number {
  if (!q) return 1; // everything matches an empty query
  const needle = q.toLowerCase();
  const label = concept.label.toLowerCase();
  const id = concept.id.toLowerCase();
  const short = concept.short.toLowerCase();

  if (label === needle || id === needle) return 100;
  if (label.startsWith(needle)) return 80;
  if (id.startsWith(needle)) return 70;
  if (label.includes(needle)) return 60;
  if (id.includes(needle)) return 50;
  if (short.includes(needle)) return 40;
  if (area.toLowerCase().includes(needle)) return 30;
  if (concept.what.toLowerCase().includes(needle)) return 20;
  if (concept.whyCare.toLowerCase().includes(needle)) return 15;
  return 0;
}

/**
 * All concepts, filtered by `query` and grouped by area.
 *
 * Within a group, entries are sorted by match score then alphabetically. With
 * no query the groups follow the canonical `AREA_ORDER`; with a query the group
 * holding the strongest match leads, so the most relevant concept is always the
 * first item in the list (ties fall back to `AREA_ORDER`).
 */
export function searchConcepts(query: string): GlossaryGroup[] {
  const q = query.trim();
  const scored = new Map<ConceptArea, { entry: GlossaryEntry; score: number }[]>(
    AREA_ORDER.map((area) => [area, []])
  );

  for (const concept of Object.values(CONCEPTS)) {
    const area = CONCEPT_AREA[concept.id];
    if (!area) continue; // safety: unmapped ids simply don't appear (tests guard this)
    const s = score(concept, area, q);
    if (s <= 0) continue;
    scored.get(area)?.push({ entry: { concept, area }, score: s });
  }

  const groups: { group: GlossaryGroup; topScore: number; order: number }[] = [];
  AREA_ORDER.forEach((area, order) => {
    const rows = scored.get(area) ?? [];
    if (rows.length === 0) return;
    rows.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.entry.concept.label.localeCompare(b.entry.concept.label)));
    groups.push({ group: { area, entries: rows.map((r) => r.entry) }, topScore: rows[0].score, order });
  });

  groups.sort((a, b) => {
    // No query → preserve canonical order; with a query → most relevant group first.
    if (q && b.topScore !== a.topScore) return b.topScore - a.topScore;
    return a.order - b.order;
  });

  return groups.map((g) => g.group);
}

/** Flat list of matching concept ids in glossary display order (groups then score). */
export function searchConceptIds(query: string): string[] {
  return searchConcepts(query).flatMap((g) => g.entries.map((e) => e.concept.id));
}

/** True when every registry concept is assigned an area and vice-versa. */
export function validateAreaCoverage(): { missingArea: string[]; orphanArea: string[] } {
  const missingArea = Object.keys(CONCEPTS).filter((id) => !CONCEPT_AREA[id]);
  const orphanArea = Object.keys(CONCEPT_AREA).filter((id) => !getConcept(id));
  return { missingArea, orphanArea };
}
