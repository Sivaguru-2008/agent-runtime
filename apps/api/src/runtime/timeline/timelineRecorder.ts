/**
 * TimelineRecorder — bridges the durable EventBus into the canonical
 * execution timeline.
 *
 * Wiring:
 *   - At container start, subscribe(bus) is called.
 *   - On every published DomainEvent, the projector decides whether the
 *     event maps to a timeline record.
 *   - Mapped records are appended to the TimelineStore. Failures are
 *     logged but never re-thrown: the timeline is an observability tool,
 *     not a correctness barrier — a transient store outage must not break
 *     event distribution.
 *
 * Replay-safe ordering:
 *   The subscription delivers events in publish order. For Redis-streams
 *   bus this matches the durable sequence. For in-memory bus the publisher
 *   awaits each handler, so order is again preserved. Per-execution seq
 *   numbers are assigned by the store inside append() — the recorder does
 *   not invent them.
 */

import type pino from "pino";
import type { DomainEvent } from "../../domain/events.js";
import type { EventBus } from "../../domain/ports.js";
import type { TimelineStore } from "../../domain/executionTimeline.js";
import { projectTimelineEvent } from "./timelineProjector.js";

export class TimelineRecorder {
  private unsubscribe?: () => void;

  constructor(
    private readonly store: TimelineStore,
    private readonly logger: pino.Logger
  ) {}

  attach(bus: EventBus): void {
    if (this.unsubscribe) return;
    this.unsubscribe = bus.subscribe((event) => {
      void this.record(event);
    });
  }

  detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  /**
   * Directly record a single event. Exposed for tests and for hot paths
   * that want to call the recorder synchronously rather than through the
   * bus subscription (e.g., the StuckExecutionDetector emits warnings that
   * go straight to the timeline without round-tripping the bus).
   */
  async record(event: DomainEvent): Promise<void> {
    const draft = projectTimelineEvent(event);
    if (!draft) return;
    try {
      await this.store.append(draft);
    } catch (err) {
      // Best-effort: a timeline write failure must NEVER mask the actual
      // event delivery. Log and move on; the event remains durable in the
      // EventStore and can be re-projected later from the canonical log.
      this.logger.warn(
        {
          err,
          executionId: event.aggregateId,
          eventType: event.type,
          traceId: event.metadata?.traceId
        },
        "[timeline] append failed — record dropped; canonical EventStore still has the source event"
      );
    }
  }
}
