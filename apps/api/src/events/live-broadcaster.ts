import type { LiveEvent } from "../telemetry/live-events.js";

export type LiveEventHandler = (event: LiveEvent) => void;

/**
 * In-process pub/sub for live runtime telemetry. Every SSE client and every
 * frontend subscriber receives events filtered through this broadcaster.
 *
 * Multi-tenant isolation:
 *   history() and subscribe() accept an optional tenant filter. Without it,
 *   the broadcaster behaves as before (admin/internal use). With it, only
 *   events whose tenantId matches the filter (or pre-tenant events) are
 *   exposed.
 *
 * Cross-execution isolation (added):
 *   `resetExecution(id)` evicts every buffered event tagged with the given
 *   executionId. The LiveExecutionEngine calls this at the start of every
 *   run so a duplicate or re-used executionId cannot have its prior frames
 *   replayed to a new SSE subscriber. This is the defensive companion to
 *   the engine's record-eviction guard.
 */
export class LiveEventBroadcaster {
  private readonly handlers = new Set<LiveEventHandler>();
  private readonly buffer: LiveEvent[] = [];
  private readonly maxBuffer: number;

  constructor(maxBuffer = 500) {
    this.maxBuffer = maxBuffer;
  }

  publish(event: LiveEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Subscriber errors must never break the broadcast loop.
      }
    }
  }

  /**
   * Subscribe to live events. If `tenantId` is provided, only events tagged
   * with that tenant are delivered. Untagged events are denied under a
   * tenant filter — prevents leakage of system events to a customer
   * subscriber.
   */
  subscribe(handler: LiveEventHandler, tenantId?: string): () => void {
    const wrapped: LiveEventHandler = tenantId
      ? (event) => {
          if (event.tenantId && event.tenantId !== tenantId) return;
          if (!event.tenantId) return; // untagged → deny under tenant filter
          handler(event);
        }
      : handler;
    this.handlers.add(wrapped);
    return () => {
      this.handlers.delete(wrapped);
    };
  }

  /**
   * Recent events, oldest-first. Optional execution + tenant filters.
   */
  history(executionId?: string, tenantId?: string): LiveEvent[] {
    return this.buffer.filter((event) => {
      if (executionId && event.executionId !== executionId) return false;
      if (tenantId) {
        if (!event.tenantId) return false;
        if (event.tenantId !== tenantId) return false;
      }
      return true;
    });
  }

  /**
   * Drop every buffered event for `executionId`. Called by the execution
   * engine when an id collision is detected so the new run starts from a
   * clean replay window.
   */
  resetExecution(executionId: string): void {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i]!.executionId === executionId) {
        this.buffer.splice(i, 1);
      }
    }
  }

  reset(): void {
    this.buffer.length = 0;
  }
}
