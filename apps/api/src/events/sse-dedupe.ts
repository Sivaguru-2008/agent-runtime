/**
 * Sprint Hardening 3 — SSE correctness.
 *
 * Replaces the previous `if (seq <= cursor) drop` watermark. The watermark
 * lost frames whose sequence arrived later than a larger one, which can
 * happen whenever two writers append concurrently and `publish()` on the
 * shared bus interleaves out of sequence order.
 *
 * `RecentSequenceTracker` instead remembers the last N emitted sequences
 * (default 1024) in a fixed-capacity ring buffer with O(1) duplicate
 * detection. Out-of-order arrivals are emitted normally as long as the
 * sequence has not already been delivered in the recent window.
 *
 * Memory is strictly bounded: `Set<number>.size === buffer.length` at all
 * times, capped at `capacity`. Eviction is FIFO over insertion order.
 *
 * The tracker also records counters for structured logging:
 *   - emitted:    total observe() calls that returned true
 *   - duplicates: observe() calls suppressed because the sequence was still
 *                 in the window
 *   - outOfOrder: observe() calls accepted with sequence < highWaterMark
 *   - evicted:    sequences pushed out of the window by newer ones
 */

export interface RecentSequenceTrackerSnapshot {
  /** Configured ring-buffer capacity. */
  capacity: number;
  /** Current number of sequences retained in the window. */
  size: number;
  /** Total accepted (newly observed) sequences. */
  emitted: number;
  /** Duplicate observations suppressed. */
  duplicates: number;
  /** Sequences accepted out of monotonic order. */
  outOfOrder: number;
  /** Sequences evicted from the window because newer ones arrived. */
  evicted: number;
  /** Largest sequence accepted so far. */
  highWaterMark: number;
}

export class RecentSequenceTracker {
  private readonly capacity: number;
  private readonly buffer: number[];
  private readonly seen = new Set<number>();
  private head = 0;
  private filled = 0;
  private highWaterMark = 0;
  private emitted = 0;
  private duplicates = 0;
  private outOfOrder = 0;
  private evicted = 0;

  constructor(capacity = 1024) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(
        `RecentSequenceTracker capacity must be a positive integer, got ${String(capacity)}`
      );
    }
    this.capacity = capacity;
    this.buffer = new Array<number>(capacity);
  }

  /**
   * Record `sequence`. Returns true if it is newly observed and the caller
   * should emit; false if it has already been emitted within the window.
   *
   * Sequences <= 0 (or non-finite) bypass dedupe — they signal events that
   * have no canonical ordering yet (e.g., before persistence assigned one).
   */
  observe(sequence: number): boolean {
    if (!Number.isFinite(sequence) || sequence <= 0) {
      this.emitted += 1;
      return true;
    }
    if (this.seen.has(sequence)) {
      this.duplicates += 1;
      return false;
    }
    if (sequence < this.highWaterMark) {
      this.outOfOrder += 1;
    } else {
      this.highWaterMark = sequence;
    }
    if (this.filled === this.capacity) {
      const old = this.buffer[this.head];
      this.seen.delete(old);
      this.evicted += 1;
    } else {
      this.filled += 1;
    }
    this.buffer[this.head] = sequence;
    this.head = (this.head + 1) % this.capacity;
    this.seen.add(sequence);
    this.emitted += 1;
    return true;
  }

  has(sequence: number): boolean {
    return this.seen.has(sequence);
  }

  snapshot(): RecentSequenceTrackerSnapshot {
    return {
      capacity: this.capacity,
      size: this.filled,
      emitted: this.emitted,
      duplicates: this.duplicates,
      outOfOrder: this.outOfOrder,
      evicted: this.evicted,
      highWaterMark: this.highWaterMark
    };
  }
}
