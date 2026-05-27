/**
 * Deterministic clocks for integration tests.
 *
 * The runtime exposes `Clock`, `ReplayClock`, `FrozenClock` in src/shared/clock.ts;
 * this module re-exports them plus a `ManualClock` shape used by the cluster
 * recovery tests. We don't duplicate the production clocks — we wrap them.
 */
import type { Clock } from "../../../src/shared/clock.js";
import { FrozenClock, ReplayClock } from "../../../src/shared/clock.js";

export { FrozenClock, ReplayClock };

/**
 * Test-time clock with explicit `advance(ms)`. Used in lease/recovery tests
 * where wall time would force the suite to actually sleep.
 */
export class ManualClock implements Clock {
  constructor(public current: Date = new Date("2026-01-01T00:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  /** Snapshot the current logical instant for use in lease.acquire / reclaim. */
  snapshot(): Date {
    return this.now();
  }
}
