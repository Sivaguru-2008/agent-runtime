/**
 * The genuine, un-patched wall-clock readers, captured at module load.
 *
 * `runtime/executionEngine.ts` monkey-patches the GLOBAL `Date` (and
 * `Math.random`) so that any read of wall-clock time inside an execution step
 * throws `InvariantViolation(S_UNSAFE_REPLAY)`. That guard exists to catch
 * untracked nondeterminism in *step bodies* — step code must use the injected
 * `step.clock` / seeded PRNG so replay is deterministic.
 *
 * The guard must NOT fire for the platform's own infrastructure. Logging and
 * metrics legitimately read the real clock to *timestamp observability output*;
 * those timestamps are never part of replayable state. Before this module
 * existed, Pino's internal `Date.now()` call (it timestamps every log line)
 * tripped the guard whenever any log was emitted inside a step's async context
 * — and, fatally, when the `uncaughtException` handler tried to log, it threw
 * again and crashed the whole process, masking the original error.
 *
 * Evaluation-order guarantee: `executionEngine.ts` imports this module, and ES
 * module imports are fully evaluated before the importer's body runs. The
 * monkey-patch is a statement in that body, so the references captured here are
 * always the real originals, regardless of overall import order.
 *
 * Infrastructure that must read time irrespective of the determinism guard
 * (the logger, metrics) should import from here instead of touching `Date`.
 */

/** The real Date constructor captured before executionEngine swaps the global. */
const OriginalDate = Date;

/** Real `Date.now`, immune to the execution-step determinism guard. */
export const trueDateNow: () => number = Date.now;

/** Real `new Date().toISOString()`, for infrastructure timestamps only. */
export function trueIsoNow(): string {
  return new OriginalDate(trueDateNow()).toISOString();
}
