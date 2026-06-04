/**
 * Guided-tour step definitions.
 *
 * A tour is an ordered list of steps. Each step points at a real element in the
 * DOM (by its `data-tour` attribute) and names a registry `concept` — the tour
 * pulls ALL of its copy (title, one-liner, deeper explanation) from that single
 * concept entry, so the words match every tooltip, panel, and empty state. No
 * tour copy is authored here; only the choreography (which element, in what
 * order, whether to open it first).
 *
 * Two surfaces have tours: the main dashboard and the operator platform. Each
 * is keyed by a `TourSurface` and remembers "seen" independently.
 */

export type TourSurface = "dashboard" | "operator";

export interface TourStep {
  /** Value of the target element's `data-tour` attribute. */
  target: string;
  /** Registry concept id; supplies the step's copy. */
  concept: string;
  /**
   * Click the target when the step opens (used to switch tabs so the user sees
   * the surface the step is describing). Safe on tab triggers and nav buttons.
   */
  activate?: boolean;
  /** Preferred placement of the coach-mark relative to the target. */
  placement?: "top" | "bottom" | "left" | "right";
}

export interface TourDef {
  surface: TourSurface;
  /** Human label, e.g. for the replay button title. */
  label: string;
  steps: TourStep[];
}

/** localStorage key recording that a surface's tour has been seen. */
export function tourSeenKey(surface: TourSurface): string {
  return `runloop.tour.${surface}.seen`;
}

const DASHBOARD_TOUR: TourDef = {
  surface: "dashboard",
  label: "Dashboard tour",
  steps: [
    { target: "explain-toggle", concept: "explain-mode", placement: "bottom" },
    { target: "glossary-button", concept: "concept-glossary", placement: "bottom" },
    { target: "dash-tab-workbench", concept: "durable-run-studio", activate: true, placement: "bottom" },
    { target: "dash-tab-playground", concept: "playground", activate: true, placement: "bottom" },
    { target: "dash-tab-cognition", concept: "cognition", activate: true, placement: "bottom" },
    { target: "dash-tab-cluster", concept: "cluster-topology", activate: true, placement: "bottom" },
    { target: "operator-link", concept: "operator-platform", placement: "left" },
  ],
};

const OPERATOR_TOUR: TourDef = {
  surface: "operator",
  label: "Operator tour",
  steps: [
    { target: "op-explain-toggle", concept: "explain-mode", placement: "bottom" },
    { target: "op-glossary-button", concept: "concept-glossary", placement: "bottom" },
    { target: "op-tab-replay", concept: "replay", activate: true, placement: "bottom" },
    { target: "op-tab-memory-trust", concept: "memory-trust", activate: true, placement: "bottom" },
    { target: "op-tab-overview", concept: "cluster-topology", activate: true, placement: "bottom" },
    { target: "op-tab-workers", concept: "worker-health", activate: true, placement: "bottom" },
    { target: "op-tab-leases", concept: "leases", activate: true, placement: "bottom" },
    { target: "op-tab-dlq", concept: "dlq", activate: true, placement: "bottom" },
    { target: "op-tab-diagnosis", concept: "diagnose", activate: true, placement: "bottom" },
    { target: "op-tab-failure", concept: "failure", activate: true, placement: "bottom" },
    { target: "op-tab-trace", concept: "trace", activate: true, placement: "bottom" },
  ],
};

export const TOURS: Record<TourSurface, TourDef> = {
  dashboard: DASHBOARD_TOUR,
  operator: OPERATOR_TOUR,
};

export function getTour(surface: TourSurface): TourDef {
  return TOURS[surface];
}
