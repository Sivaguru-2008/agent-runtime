export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Logical (replay) clock — separates the *wallclock* (when something actually
 * happened) from the *logical* timestamp (a deterministic, monotonic counter)
 * that drives replay-equivalence.
 *
 * Two events with the same logical timestamp are considered concurrent.
 * Replay frame fingerprints use logical time so the same event log always
 * yields identical fingerprints regardless of when it is replayed.
 */
export interface LogicalClock {
  now(): Date;
  logicalNow(): number;
}

/**
 * ReplayClock — wraps a Clock with a monotonic logical counter.
 *
 * `now()` returns the wallclock from the underlying source. `logicalNow()`
 * returns a counter that strictly increases on every call. Use the logical
 * value when you need replay determinism; use `now()` for human-facing
 * timestamps that just need to be roughly accurate.
 */
export class ReplayClock implements LogicalClock {
  private logical = 0;
  constructor(private readonly source: Clock = new SystemClock(), startAt = 0) {
    this.logical = startAt;
  }
  now(): Date {
    return this.source.now();
  }
  logicalNow(): number {
    return ++this.logical;
  }
  /** Reset for replay — start logical time at the original frame boundary. */
  resetLogical(at: number): void {
    this.logical = at;
  }
}

/**
 * FrozenClock — for replay-mode workloads. `now()` always returns the same
 * fixed instant, and `logicalNow()` advances by exactly one per call.
 *
 * Used during deterministic replay so any side-effect path that consults
 * `clock.now()` (timestamping a node, deriving a snapshot capture time, etc.)
 * gets a stable value, not whatever the wall clock happens to read.
 */
export class FrozenClock implements LogicalClock {
  private logical: number;
  constructor(private readonly frozenAt: Date, startAt = 0) {
    this.logical = startAt;
  }
  now(): Date {
    return this.frozenAt;
  }
  logicalNow(): number {
    return ++this.logical;
  }
}

export function toIso(date: Date): string {
  return date.toISOString();
}
