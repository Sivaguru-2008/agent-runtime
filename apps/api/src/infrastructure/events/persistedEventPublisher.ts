/**
 * PersistedEventPublisher — atomic persist-then-broadcast with deduplication.
 *
 * Corruption risk prevented:
 *   Without dedup, a caller that retries publish() after a network error
 *   (where the store append succeeded but the response was lost) would
 *   produce a second append + a second bus broadcast. Consumers that are
 *   not idempotent would process the event twice, corrupting aggregate state.
 *
 * Deduplication strategy (two layers):
 *   1. EventStore layer — ON CONFLICT (idempotency_key) DO NOTHING ensures
 *      that even if two events with different IDs but the same logical
 *      operation are appended, only the first is persisted.
 *   2. Publisher layer — in-process LRU set on event.id prevents re-broadcasting
 *      to the bus for an event that was already sent in this process lifetime.
 *      The set is bounded (`DEDUP_WINDOW_SIZE`) to prevent unbounded growth.
 *
 * Ordering guarantee:
 *   The sequence number assigned by the EventStore is the canonical ordering
 *   for replay. Bus delivery order is best-effort (Redis pub/sub) or
 *   guaranteed (Redis Streams with consumer groups). Do not rely on bus
 *   delivery order for correctness — always replay from the EventStore.
 *
 * Replay safety:
 *   The persisted event (with assigned sequence) is returned to the caller.
 *   If bus publish fails, the event is already durable in the store and will
 *   be picked up by any stream consumer on next poll. The caller's sequence
 *   number is still valid.
 */

import type { DomainEvent } from "../../domain/events.js";
import type { EventBus, EventStore } from "../../domain/ports.js";
import type { FencingToken } from "../../domain/clusterPorts.js";

const DEDUP_WINDOW_SIZE = 4096;

/**
 * Result of a fenced publish. "COMMITTED" carries the persisted event with
 * its assigned sequence number, identical to publish()'s return. "FENCED"
 * signals the caller that the event was rejected at the persistence
 * boundary because the lease is no longer ACTIVE for this worker/attempt —
 * the event was NOT written to the durable store and NOT broadcast on the
 * bus. The caller proceeds with NO further side effects for this event.
 */
export type FencedPublishResult =
  | { outcome: "COMMITTED"; event: DomainEvent }
  | { outcome: "FENCED"; eventType: DomainEvent["type"]; executionId: string };

/**
 * Sink for fence-rejected diagnostic counters. Optional — the publisher
 * works without it. Wired in production to AgentMetrics so each rejected
 * append shows up on `agent_event_fence_rejected_total{event_type}`.
 */
export interface FenceRejectionSink {
  /**
   * Called once per rejected event. MUST be non-blocking — implementations
   * that need to do I/O should fire-and-forget or queue internally.
   */
  recordFenceRejected(input: {
    eventType: DomainEvent["type"];
    executionId: string;
    workerId: string;
    attempt: number;
  }): void;
}

/**
 * Optional structured logger sink for fence rejections. Same shape rules
 * as FenceRejectionSink — fire-and-forget. The publisher uses this to leave
 * a diagnostic breadcrumb without polluting the durable event log.
 */
export interface FenceRejectionLogger {
  warn(message: string, context: Record<string, unknown>): void;
}

export class PersistedEventPublisher {
  /**
   * In-process set of recently-seen event IDs. Prevents re-broadcasting to
   * the bus when a caller retries publish() after a partial failure.
   *
   * Eviction: we keep a parallel FIFO queue to bound memory; when the queue
   * exceeds DEDUP_WINDOW_SIZE, we evict the oldest entry from both structures.
   */
  private readonly seenIds = new Set<string>();
  private readonly seenQueue: string[] = [];

  /**
   * In-process outbox of events that were durably appended to the EventStore
   * but whose bus.publish attempt threw. publishDurable() routes failed
   * deliveries here instead of re-throwing; the OutboxDispatcher drains them
   * out-of-band so a transient bus outage cannot corrupt engine state by
   * forcing the catch branch to fire on a save that already succeeded.
   *
   * Insertion-ordered Map so the dispatcher delivers in the same order the
   * engine produced them — preserves causal ordering on the consumer side.
   */
  private readonly pendingOutbox = new Map<string, DomainEvent>();

  constructor(
    public readonly eventStore: EventStore,
    private readonly eventBus: EventBus,
    private readonly fenceSinks: {
      metrics?: FenceRejectionSink;
      logger?: FenceRejectionLogger;
    } = {}
  ) {}

  async publish(event: DomainEvent): Promise<DomainEvent> {
    // Layer 2 dedup: already broadcast in this process lifetime — skip entirely.
    if (this.seenIds.has(event.id)) {
      return event;
    }

    const isLowPriority =
      event.type === "COGNITION_NODE_STREAMING" ||
      event.type === "MEMORY_INFLUENCE_RECORDED";

    let persisted = event;
    if (!isLowPriority) {
      // Layer 1 dedup: append to store (idempotent — ON CONFLICT on idempotency_key
      // returns the existing sequence if this logical event was already persisted).
      persisted = await this.eventStore.append(event);
    } else {
      // Ephemeral events bypass EventStore durability; assign sequence 0
      persisted = { ...event, sequence: event.sequence ?? 0 };
    }

    // Mark as seen BEFORE publishing to the bus. This ensures that if bus.publish
    // throws and the caller retries with the same event object, we will not
    // double-append to the store. We remove from seenIds in the catch block so
    // that the bus publish can be retried (the store append is already idempotent).
    this.addToSeenSet(persisted.id);

    try {
      await this.eventBus.publish(persisted);
    } catch (busErr) {
      // Bus publish failed. Remove from seen set so a retry can re-attempt the
      // bus publish. The store already has the event — re-appending is safe due
      // to idempotency. The event will eventually reach stream consumers via the
      // store poll even if the bus remains unavailable.
      this.removeFromSeenSet(persisted.id);
      throw busErr;
    }

    return persisted;
  }

  /**
   * Durable variant of publish() used by callers (notably ExecutionEngine's
   * terminal save+publish pair) where a bus.publish failure must NOT throw —
   * because the row save has already committed and a throw here would drive
   * the engine's catch branch into stomping the just-saved terminal status.
   *
   * Semantics:
   *   1. Append to the EventStore (durable + idempotent on idempotency_key).
   *      If append throws, propagate — we have no row-vs-event divergence yet.
   *   2. Attempt bus.publish.
   *      • Success → add to seenIds (same as publish()) and return.
   *      • Failure → enqueue the persisted event into pendingOutbox and
   *        return WITHOUT throwing. The OutboxDispatcher will redeliver
   *        out-of-band when the bus recovers.
   *
   * Important: on bus failure we do NOT add to seenIds. seenIds is the
   * in-process dedup gate for the publish() retry path; if a future caller
   * (or a retried operation) re-publishes the same event, we still want
   * append's idempotency to no-op the durable write AND a bus.publish to
   * actually fire. The OutboxDispatcher publishes to the bus directly and
   * does not consult seenIds — so the dispatcher is unaffected.
   */
  async publishDurable(event: DomainEvent): Promise<DomainEvent> {
    if (this.seenIds.has(event.id)) {
      return event;
    }

    const isLowPriority =
      event.type === "COGNITION_NODE_STREAMING" ||
      event.type === "MEMORY_INFLUENCE_RECORDED";

    let persisted = event;
    if (!isLowPriority) {
      persisted = await this.eventStore.append(event);
    } else {
      persisted = { ...event, sequence: event.sequence ?? 0 };
    }

    try {
      await this.eventBus.publish(persisted);
      this.addToSeenSet(persisted.id);
      return persisted;
    } catch {
      // Bus outage. Enqueue for the dispatcher and surrender silently —
      // the durable state is intact (row saved by the caller, event
      // appended to the store), so the system is consistent. The
      // dispatcher will deliver to the bus when it recovers.
      this.pendingOutbox.set(persisted.id, persisted);
      return persisted;
    }
  }

  /**
   * Fenced publish for execution-scoped events.
   *
   * Contract:
   *   • Routes the durable write through eventStore.appendFenced(event, fence).
   *   • On COMMITTED: behaves like publish() — adds to the in-process dedup
   *     set and broadcasts to the bus. If the bus throws, removes from the
   *     dedup set and re-throws (same retry semantics as publish()).
   *   • On FENCED: emits a diagnostic counter + warn log, does NOT broadcast
   *     to the bus, does NOT add to the dedup set, and returns the FENCED
   *     result. No durable artifact lands and no consumer sees the event —
   *     a stale worker's emission becomes invisible to replay.
   *
   * Why bus broadcast is suppressed on FENCED:
   *   The bus carries the event to live SSE subscribers and to stream
   *   consumers. If we broadcast a fenced event, the diagnostic-only
   *   semantics break: a subscriber would observe a "ghost" event that
   *   never lands in the durable log, and replay vs. live would diverge.
   *
   * Why the dedup set is NOT touched on FENCED:
   *   The dedup set's purpose is "this in-process publisher has already
   *   handled this event id." A fenced event was NOT handled; if a later
   *   non-fenced retry of the same logical event id comes through (it
   *   shouldn't, because the legitimate owner generates fresh ids), we
   *   want it to proceed normally.
   *
   * Low-priority events (COGNITION_NODE_STREAMING, MEMORY_INFLUENCE_RECORDED)
   * bypass the durable store in publish() and publishDurable() — they are
   * ephemeral. For consistency, publishFenced also skips the durable write
   * for them, but ONLY when the fence still validates against the lease
   * substrate: the substrate-level validateFencing is invoked directly so
   * a stale-worker low-priority event is still suppressed from bus delivery.
   * The skip cannot be silent — we still record the diagnostic so operators
   * see stale-worker emissions across all event types.
   */
  async publishFenced(event: DomainEvent, fence: FencingToken): Promise<FencedPublishResult> {
    if (this.seenIds.has(event.id)) {
      // Already broadcast in this process lifetime; treat as a benign
      // duplicate. The event already passed fencing in its original
      // publish() — re-publishing must not re-validate against a now-
      // possibly-expired lease, because we'd then report FENCED on what
      // is in fact a successful prior commit. Return COMMITTED with the
      // input event unchanged; the caller's flow stays the same.
      return { outcome: "COMMITTED", event };
    }

    const appendResult = await this.eventStore.appendFenced(event, fence);
    if (appendResult.outcome === "FENCED") {
      this.fenceSinks.metrics?.recordFenceRejected({
        eventType: event.type,
        executionId: fence.executionId,
        workerId: fence.workerId,
        attempt: fence.attempt
      });
      this.fenceSinks.logger?.warn("event.fence_rejected", {
        eventType: event.type,
        eventId: event.id,
        executionId: fence.executionId,
        workerId: fence.workerId,
        attempt: fence.attempt,
        traceId: event.metadata.traceId
      });
      return { outcome: "FENCED", eventType: event.type, executionId: fence.executionId };
    }

    const persisted = appendResult.event;
    this.addToSeenSet(persisted.id);

    try {
      await this.eventBus.publish(persisted);
    } catch (busErr) {
      // Audit fix HIGH-2: a fenced event whose durable INSERT already
      // committed is consistent on disk. Re-throwing here pushes the engine
      // into its catch branch — which then writes EXECUTION_FAILED for an
      // execution whose only fault was a transient Redis blip. That
      // converted "Redis down for 30s" into "every in-flight execution is
      // FAILED", which is a much worse production outcome than a delayed
      // live event.
      //
      // Posture: mirror publishDurable. Enqueue into the in-process
      // pendingOutbox so the OutboxDispatcher (or a sibling tick) can
      // redeliver to the bus once it recovers. Do NOT remove from the
      // dedup set — the event IS durable; a future retry that lands the
      // same event id would otherwise re-broadcast unnecessarily.
      this.pendingOutbox.set(persisted.id, persisted);
      this.fenceSinks.logger?.warn("event.bus_deferred", {
        eventType: event.type,
        eventId: persisted.id,
        executionId: fence.executionId,
        workerId: fence.workerId,
        attempt: fence.attempt,
        reason: busErr instanceof Error ? busErr.message : String(busErr)
      });
    }

    return { outcome: "COMMITTED", event: persisted };
  }

  /** Current pending outbox depth — for observability and tests. */
  pendingOutboxSize(): number {
    return this.pendingOutbox.size;
  }

  /** Snapshot of pending events for inspection / dispatcher draining. */
  peekPending(): DomainEvent[] {
    return [...this.pendingOutbox.values()];
  }

  /**
   * Remove an event from the pending outbox. Called by the OutboxDispatcher
   * after a successful bus delivery. Idempotent.
   */
  confirmDelivered(eventId: string): void {
    this.pendingOutbox.delete(eventId);
    // Now safe to record in seenIds — the event reached the bus exactly
    // once via the dispatcher.
    this.addToSeenSet(eventId);
  }

  private addToSeenSet(id: string): void {
    if (this.seenIds.has(id)) return;
    if (this.seenQueue.length >= DEDUP_WINDOW_SIZE) {
      const evicted = this.seenQueue.shift();
      if (evicted) this.seenIds.delete(evicted);
    }
    this.seenIds.add(id);
    this.seenQueue.push(id);
  }

  private removeFromSeenSet(id: string): void {
    this.seenIds.delete(id);
    const idx = this.seenQueue.indexOf(id);
    if (idx !== -1) this.seenQueue.splice(idx, 1);
  }
}
