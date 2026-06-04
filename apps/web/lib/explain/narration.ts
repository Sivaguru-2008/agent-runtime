/**
 * Layer 4 — Live narration.
 *
 * Turns the raw technical signals of a run (event types, cognition node roles,
 * terminal status) into a plain-language story: "Task Received → Task Planned →
 * Task Executed → Results Verified → Quality Reviewed → Memory Updated →
 * Execution Completed". The user should never see only machine states; they
 * should see a narrative.
 *
 * The mapping is signal-driven so it works from ANY source: pass whatever
 * strings you have (event `type` values, cognition node `type`/role values),
 * and the engine decides which beats occurred.
 */

export type NarrationStatus = "done" | "active" | "pending" | "skipped" | "failed";

export interface NarrationStep {
  key: string;
  /** Human title, e.g. "Task Planned". */
  title: string;
  /** Plain-language description of what happened at this beat. */
  description: string;
  status: NarrationStatus;
}

interface BeatDef {
  key: string;
  title: string;
  description: string;
  /** Signals (event types or node roles) that mean this beat occurred. */
  signals: string[];
  /** Optional beats are marked "skipped" (not "pending") when a run finished without them. */
  optional?: boolean;
}

/**
 * The canonical run story. This doubles as the legend / "ideal run" shown when
 * Explain Mode is on and no specific run is selected.
 */
export const RUN_BEATS: BeatDef[] = [
  {
    key: "received",
    title: "Task Received",
    description: "The system accepted your request and started a durable, recorded run.",
    signals: ["TASK_SCHEDULED", "EXECUTION_STARTED", "EXECUTION_REPLAY_REQUESTED", "CREATED", "QUEUED", "INIT"],
  },
  {
    key: "planned",
    title: "Task Planned",
    description: "The planner broke the goal into a step-by-step execution strategy.",
    signals: ["PLANNER", "PLAN", "PLANNED", "EXECUTION_STEP_STARTED"],
  },
  {
    key: "recalled",
    title: "Knowledge Recalled",
    description: "Relevant memories were pulled in to inform the work.",
    signals: ["MEMORY_RETRIEVED", "RETRIEVE", "RECALL"],
    optional: true,
  },
  {
    key: "executed",
    title: "Task Executed",
    description: "The executor performed the work, calling tools and the model as needed.",
    signals: ["EXECUTOR", "EXECUTE", "TOOL_CALLED", "TOOL", "MODEL_COMPLETED", "EXECUTION_STEP_COMPLETED"],
  },
  {
    key: "verified",
    title: "Results Verified",
    description: "The verifier checked the output was correct and well-formed.",
    signals: ["VERIFIER", "VERIFY", "VERIFIED"],
    optional: true,
  },
  {
    key: "reviewed",
    title: "Quality Reviewed",
    description: "The critic searched the answer for weaknesses, gaps, and risks.",
    signals: ["CRITIC", "CRITIQUE", "REVIEW"],
    optional: true,
  },
  {
    key: "remembered",
    title: "Memory Updated",
    description: "Important findings were saved to memory for future runs.",
    signals: ["MEMORY_COMMIT", "COMMIT", "MEMORY_WRITE", "MEMORY_MANAGER"],
    optional: true,
  },
];

export interface NarrateInput {
  /** Observed signals — event types and/or cognition node roles (any case). */
  signals: Iterable<string>;
  /** Terminal state, if known. */
  outcome?: "running" | "completed" | "failed" | "cancelled" | "unknown";
}

/**
 * Build the run story. Each canonical beat is marked done/active/pending/
 * skipped based on the observed signals, and a terminal "outcome" beat is
 * appended describing how the run ended.
 */
export function narrateRun({ signals, outcome = "unknown" }: NarrateInput): NarrationStep[] {
  const seen = new Set<string>();
  for (const s of signals) {
    if (s) seen.add(String(s).toUpperCase());
  }

  const failed = outcome === "failed";
  const finished = outcome === "completed" || outcome === "failed" || outcome === "cancelled";

  // Which beats happened?
  const occurred = RUN_BEATS.map((beat) => ({
    beat,
    hit: beat.signals.some((sig) => seen.has(sig.toUpperCase())),
  }));

  // The active beat is the last one that occurred while the run is still going.
  const lastHitIndex = occurred.reduce((acc, o, i) => (o.hit ? i : acc), -1);

  const steps: NarrationStep[] = occurred.map(({ beat, hit }, i) => {
    let status: NarrationStatus;
    if (hit) {
      status = !finished && i === lastHitIndex ? "active" : "done";
    } else if (finished) {
      status = beat.optional ? "skipped" : "done"; // a finished run implicitly passed required beats
    } else {
      status = "pending";
    }
    return { key: beat.key, title: beat.title, description: beat.description, status };
  });

  // Terminal beat.
  if (outcome === "completed") {
    steps.push({
      key: "completed",
      title: "Execution Completed",
      description: "The workflow finished successfully and the result was returned.",
      status: "done",
    });
  } else if (failed) {
    steps.push({
      key: "failed",
      title: "Execution Failed",
      description: "The run stopped before completing. Open the Failure or Root Cause view to see why.",
      status: "failed",
    });
  } else if (outcome === "cancelled") {
    steps.push({
      key: "cancelled",
      title: "Execution Cancelled",
      description: "The run was stopped on purpose before completing.",
      status: "skipped",
    });
  } else {
    steps.push({
      key: "in-progress",
      title: "Execution In Progress",
      description: "The run is still going. Steps above will fill in as it proceeds.",
      status: lastHitIndex >= 0 ? "active" : "pending",
    });
  }

  return steps;
}

/** Number of beats that have actually happened (excludes the terminal beat). */
export function narrationProgress(steps: NarrationStep[]): { done: number; total: number } {
  const body = steps.filter((s) => !["completed", "failed", "cancelled", "in-progress"].includes(s.key));
  const done = body.filter((s) => s.status === "done" || s.status === "active").length;
  return { done, total: body.length };
}
