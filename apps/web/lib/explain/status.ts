/**
 * Layer 2 — Status translation.
 *
 * Replaces internal machine codes (LOST, BUSY, DLQ, MEMORY_COMMIT…) with plain
 * human language plus a one-line meaning and a tone for colouring. Every status
 * pill and role label on the platform reads from this single table.
 */

export type StatusTone = "success" | "warning" | "critical" | "info" | "neutral";

export interface StatusTranslation {
  /** Original machine code (kept for operators who know it). */
  code: string;
  /** Human-friendly label shown to first-time users. */
  label: string;
  /** One sentence: what this status means in practice. */
  meaning: string;
  tone: StatusTone;
}

/** Keyed by UPPERCASE code. Use `translateStatus` for safe, case-insensitive lookup. */
const TRANSLATIONS: Record<string, Omit<StatusTranslation, "code">> = {
  // ── Worker / runtime lifecycle ──────────────────────────────────────────
  READY: { label: "Ready for Work", meaning: "Healthy and available to pick up tasks.", tone: "success" },
  BUSY: { label: "Processing Tasks", meaning: "Actively running one or more tasks right now.", tone: "info" },
  RUNNING: { label: "Working", meaning: "A task is in progress.", tone: "info" },
  QUEUED: { label: "Waiting to Start", meaning: "Accepted and waiting its turn for a free worker.", tone: "warning" },
  DRAINING: { label: "Winding Down", meaning: "Finishing current work and refusing new tasks — usually planned maintenance.", tone: "warning" },
  DEGRADED: { label: "Partially Impaired", meaning: "Still running but not fully healthy; performance or reliability may suffer.", tone: "warning" },
  STOPPING: { label: "Shutting Down", meaning: "In the process of stopping.", tone: "warning" },
  STOPPED: { label: "Stopped", meaning: "Not running. Will not pick up work until restarted.", tone: "neutral" },
  REGISTERED: { label: "Joining", meaning: "Has announced itself but isn't ready for work yet.", tone: "neutral" },
  LOST: { label: "Connection Lost", meaning: "Stopped sending heartbeats — likely crashed or network-split. Its work will be reclaimed.", tone: "critical" },
  OFFLINE: { label: "Offline", meaning: "Not reachable.", tone: "critical" },
  ERROR: { label: "Errored", meaning: "Hit an error it could not recover from.", tone: "critical" },
  IDLE: { label: "Idle", meaning: "Healthy but not doing anything right now.", tone: "success" },
  CREATED: { label: "Created", meaning: "Exists but hasn't started working yet.", tone: "neutral" },

  // ── Execution outcomes ─────────────────────────────────────────────────
  COMPLETED: { label: "Completed", meaning: "Finished successfully.", tone: "success" },
  FAILED: { label: "Failed", meaning: "Stopped because of an error before completing.", tone: "critical" },
  CANCELLED: { label: "Cancelled", meaning: "Stopped on purpose before completing.", tone: "neutral" },

  // ── Lease states ─────────────────────────────────────────────────────────
  ACTIVE: { label: "Held", meaning: "A worker currently owns this task and is renewing its lock.", tone: "success" },
  RELEASED: { label: "Released", meaning: "The worker finished and gave up the lock cleanly.", tone: "neutral" },
  EXPIRED: { label: "Expired", meaning: "The lock ran out because the worker stopped renewing it.", tone: "warning" },
  RECLAIMED: { label: "Reclaimed", meaning: "The lock was taken from a failed worker and the task reassigned.", tone: "warning" },

  // ── Queues / structures ───────────────────────────────────────────────────
  DLQ: { label: "Permanently Failed Tasks", meaning: "Quarantine for tasks that failed too many times to keep retrying.", tone: "critical" },
  LEASE: { label: "Temporary Ownership Lock", meaning: "A time-limited right for one worker to run one task.", tone: "info" },
  DETERMINISM: { label: "Reproducibility Check", meaning: "Whether replaying a run reproduces it exactly.", tone: "info" },

  // ── Cognition roles ───────────────────────────────────────────────────────
  PLANNER: { label: "Task Planner", meaning: "Breaks the goal into a step-by-step plan.", tone: "info" },
  EXECUTOR: { label: "Task Performer", meaning: "Does the actual work each step requires.", tone: "info" },
  VERIFIER: { label: "Fact Checker", meaning: "Checks the work is correct and well-formed.", tone: "info" },
  CRITIC: { label: "Quality Reviewer", meaning: "Looks for weaknesses, gaps, and ways the answer could be wrong.", tone: "info" },
  MEMORY_COMMIT: { label: "Saving Learned Information", meaning: "Writes important findings into memory for future runs.", tone: "info" },
  MEMORY_RETRIEVED: { label: "Recalling Knowledge", meaning: "Pulled relevant stored memories into the run.", tone: "info" },
  TOOL_CALLED: { label: "Using a Tool", meaning: "Called an external tool (search, code, API) to get information or act.", tone: "info" },
  MODEL_COMPLETED: { label: "AI Responded", meaning: "The language model finished generating its output.", tone: "info" },

  // ── Run mode ───────────────────────────────────────────────────────────────
  "MODEL-BACKED": { label: "Real AI", meaning: "Ran through a live language-model provider.", tone: "info" },
  DETERMINISTIC: { label: "Simulated", meaning: "Ran with built-in deterministic logic instead of a live model — repeatable and free.", tone: "neutral" },

  // ── Cognition phases (run-level) ────────────────────────────────────────────
  INIT: { label: "Starting", meaning: "The run is being set up.", tone: "neutral" },
  PLAN: { label: "Planning", meaning: "Breaking the goal into a step-by-step plan.", tone: "info" },
  EXECUTE: { label: "Executing", meaning: "Doing the actual work of the task.", tone: "info" },
  VERIFY: { label: "Verifying", meaning: "Checking the work is correct.", tone: "info" },
  CRITIQUE: { label: "Reviewing", meaning: "Looking for weaknesses and gaps in the answer.", tone: "info" },
  COMPLETE: { label: "Completed", meaning: "The run finished successfully.", tone: "success" },

  // ── Cognition node states (step-level) ──────────────────────────────────────
  PENDING: { label: "Waiting", meaning: "This step is queued and hasn't started.", tone: "neutral" },
  STREAMING: { label: "Generating", meaning: "The model is actively writing output for this step.", tone: "info" },
  SKIPPED: { label: "Skipped", meaning: "This step wasn't needed and was passed over.", tone: "neutral" },
  REPLAYED: { label: "Replayed", meaning: "This step was re-created from a recorded run.", tone: "info" },

  // ── Severities ─────────────────────────────────────────────────────────────
  INFO: { label: "Info", meaning: "Informational — no action needed.", tone: "info" },
  LOW: { label: "Low", meaning: "Minor — unlikely to affect the outcome.", tone: "info" },
  MEDIUM: { label: "Medium", meaning: "Worth a look — could affect quality.", tone: "warning" },
  HIGH: { label: "High", meaning: "Important — likely affected the result.", tone: "warning" },
  WARNING: { label: "Warning", meaning: "Something to keep an eye on.", tone: "warning" },
  CRITICAL: { label: "Critical", meaning: "Needs attention now.", tone: "critical" },

  // ── Failure-signal kinds (what went wrong) ──────────────────────────────────
  HALLUCINATION: { label: "Made-Up Content", meaning: "The AI stated something it can't support — a likely fabrication.", tone: "critical" },
  CONTRADICTION: { label: "Self-Contradiction", meaning: "The AI said two things that conflict with each other.", tone: "critical" },
  RECURSION: { label: "Stuck in a Loop", meaning: "The AI repeated the same step without making progress.", tone: "warning" },
  TOOL_MISUSE: { label: "Tool Used Wrong", meaning: "A tool was called incorrectly or with bad inputs.", tone: "warning" },
  CORRUPTED_MEMORY: { label: "Corrupted Memory", meaning: "A stored memory used here was damaged or unreliable.", tone: "critical" },
  UNCERTAINTY_SPIKE: { label: "Confidence Drop", meaning: "The AI became unusually unsure at this point.", tone: "warning" },
  PLAN_DRIFT: { label: "Off-Plan", meaning: "The AI strayed from the plan it set out to follow.", tone: "warning" },

  // ── Replay anomalies ────────────────────────────────────────────────────────
  MISSING_FINGERPRINT: { label: "Unverifiable Step", meaning: "This step wasn't stamped with a reproducibility code, so its replay can't be verified.", tone: "warning" },
  DUPLICATE_FINGERPRINT: { label: "Repeated State (Loop)", meaning: "The run reached the exact same state twice — a sign it looped without progress.", tone: "critical" },
};

/** Tailwind classes per tone, theme-neutral (works on both dark surfaces). */
export const TONE_CLASSES: Record<StatusTone, string> = {
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  info: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  critical: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  neutral: "border-zinc-600/50 bg-zinc-500/10 text-zinc-300",
};

/** Dot colour per tone, for compact status dots. */
export const TONE_DOT: Record<StatusTone, string> = {
  success: "bg-emerald-400",
  info: "bg-sky-400",
  warning: "bg-amber-400",
  critical: "bg-rose-400",
  neutral: "bg-zinc-400",
};

/**
 * Translate a raw status/role code into human language. Case-insensitive.
 * Unknown codes fall back to a title-cased version of the code with neutral
 * tone so the UI never shows nothing.
 */
export function translateStatus(raw?: string | null): StatusTranslation {
  if (!raw) {
    return { code: "", label: "Unknown", meaning: "No status reported.", tone: "neutral" };
  }
  const code = String(raw).trim();
  const hit = TRANSLATIONS[code.toUpperCase()] ?? TRANSLATIONS[code];
  if (hit) return { code, ...hit };
  // Fallback: prettify SNAKE_CASE / kebab-case into Title Case.
  const label = code
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { code, label, meaning: "No plain-language description is available for this status yet.", tone: "neutral" };
}

/** True when the platform has a curated translation for this code. */
export function hasTranslation(raw?: string | null): boolean {
  if (!raw) return false;
  const code = String(raw).trim();
  return Boolean(TRANSLATIONS[code.toUpperCase()] ?? TRANSLATIONS[code]);
}
