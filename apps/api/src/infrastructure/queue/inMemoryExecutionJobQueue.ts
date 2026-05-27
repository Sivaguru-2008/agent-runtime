/**
 * InMemoryExecutionJobQueue — single-process queue implementation.
 *
 * Used in three scenarios:
 *   1. Unit / integration tests that exercise the queue → worker pipeline
 *      without standing up Redis.
 *   2. Single-process developer runs (RUNTIME_MODE=single).
 *   3. Worker-side "combined" mode where the queue is intentionally local.
 *
 * Semantics match the production Redis implementation:
 *   - At-least-once delivery
 *   - Visibility timeout (un-acked messages re-appear after `visibilityMs`)
 *   - Delayed retries via `notBefore`
 *   - Per-jobId idempotency on enqueue
 *
 * What this implementation does NOT provide (by design — it is in-memory):
 *   - Cross-process visibility (use RedisExecutionJobQueue in production)
 *   - Durability across restart
 */

import type {
  ConsumeOptions,
  ExecutionJob,
  ExecutionJobQueue,
  QueueDepthSnapshot,
  QueuedJobMessage
} from "../../domain/jobQueue.js";

interface Entry {
  receiptId: string;
  job: ExecutionJob;
  /** Epoch ms — message is invisible until this time. */
  visibleAt: number;
  /** Epoch ms — when this message was delivered to a consumer (0 if not delivered). */
  deliveredAt: number;
  /** Worker id the message is currently leased to (empty if not delivered). */
  consumer: string;
}

export interface InMemoryQueueOptions {
  /** Visibility timeout — un-acked deliveries become re-deliverable after this. */
  visibilityMs?: number;
  /** Clock override for testing. */
  now?: () => number;
}

export class InMemoryExecutionJobQueue implements ExecutionJobQueue {
  private readonly entries: Entry[] = [];
  private readonly byJobId = new Set<string>();
  private readonly byReceiptId = new Map<string, Entry>();
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  private receiptSeq = 0;
  private readonly visibilityMs: number;
  private readonly now: () => number;
  private sweepTimer?: NodeJS.Timeout;

  constructor(opts: InMemoryQueueOptions = {}) {
    this.visibilityMs = opts.visibilityMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());

    // Periodically reawaken consumers so notBefore-delayed entries become
    // visible without requiring a fresh enqueue to wake the iterator.
    this.sweepTimer = setInterval(() => this.wakeWaiters(), 250);
    this.sweepTimer.unref?.();
  }

  async enqueue(job: ExecutionJob): Promise<void> {
    if (this.closed) throw new Error("InMemoryExecutionJobQueue: closed");
    if (this.byJobId.has(job.jobId)) return; // idempotent
    this.byJobId.add(job.jobId);

    const visibleAt = job.notBefore ? new Date(job.notBefore).getTime() : this.now();
    const entry: Entry = {
      receiptId: this.mintReceipt(),
      job,
      visibleAt,
      deliveredAt: 0,
      consumer: ""
    };
    this.entries.push(entry);
    this.byReceiptId.set(entry.receiptId, entry);
    this.wakeWaiters();
  }

  consume(opts: ConsumeOptions): AsyncIterable<QueuedJobMessage> {
    const self = this;
    const blockMs = opts.blockMs ?? 5_000;
    return {
      [Symbol.asyncIterator](): AsyncIterator<QueuedJobMessage> {
        // Per-iterator cancellation. WorkerExecutionLoop.stop() calls
        // iter.return() which flips this flag and pokes the wait list — the
        // iterator unblocks immediately rather than waiting out blockMs.
        let cancelled = false;
        return {
          async next(): Promise<IteratorResult<QueuedJobMessage>> {
            while (!self.closed && !cancelled) {
              const next = self.takeNextVisible(opts.workerId);
              if (next) return { value: next, done: false };
              const woken = await self.wait(blockMs);
              if (cancelled || self.closed) break;
              if (!woken) continue;
            }
            return { value: undefined, done: true };
          },
          async return(): Promise<IteratorResult<QueuedJobMessage>> {
            cancelled = true;
            self.wakeWaiters();
            return { value: undefined, done: true };
          }
        };
      }
    };
  }

  async ack(receiptId: string): Promise<void> {
    const entry = this.byReceiptId.get(receiptId);
    if (!entry) return;
    this.byReceiptId.delete(receiptId);
    this.byJobId.delete(entry.job.jobId);
    const idx = this.entries.indexOf(entry);
    if (idx >= 0) this.entries.splice(idx, 1);
  }

  async nack(receiptId: string, _reason: string, retryDelayMs: number): Promise<void> {
    const entry = this.byReceiptId.get(receiptId);
    if (!entry) return;
    const delay = Math.max(0, retryDelayMs);
    entry.visibleAt = this.now() + delay;
    entry.deliveredAt = 0;
    entry.consumer = "";
    this.wakeWaiters();
  }

  async depth(): Promise<QueueDepthSnapshot> {
    const now = this.now();
    let ready = 0;
    let inFlight = 0;
    let delayed = 0;
    for (const entry of this.entries) {
      if (entry.deliveredAt > 0) {
        // Stale in-flight messages whose visibility expired count as ready
        // again, matching what consume() will observe on the next take.
        if (entry.deliveredAt + this.visibilityMs <= now) {
          ready += 1;
        } else {
          inFlight += 1;
        }
      } else if (entry.visibleAt > now) {
        delayed += 1;
      } else {
        ready += 1;
      }
    }
    return { ready, inFlight, delayed };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.wakeWaiters();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private takeNextVisible(workerId: string): QueuedJobMessage | undefined {
    const now = this.now();
    for (const entry of this.entries) {
      // Available if never delivered AND visibleAt has passed,
      // OR previously delivered but visibility timeout expired (re-delivery).
      const inFlightExpired =
        entry.deliveredAt > 0 && entry.deliveredAt + this.visibilityMs <= now;
      const firstDelivery = entry.deliveredAt === 0 && entry.visibleAt <= now;
      if (!firstDelivery && !inFlightExpired) continue;
      entry.deliveredAt = now;
      entry.consumer = workerId;
      return { receiptId: entry.receiptId, job: entry.job };
    }
    return undefined;
  }

  private mintReceipt(): string {
    this.receiptSeq += 1;
    return `mem-${this.receiptSeq}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private wakeWaiters(): void {
    while (this.waiters.length) {
      const w = this.waiters.shift();
      w?.();
    }
  }

  private wait(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(wake);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(false);
      }, ms);
      timer.unref?.();
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(wake);
    });
  }
}
