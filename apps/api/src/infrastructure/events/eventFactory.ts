import { createHash } from "node:crypto";
import type { Clock } from "../../shared/clock.js";
import { toIso } from "../../shared/clock.js";
import { createId, isValidUuid, generateDeterministicUuid } from "../../shared/id.js";
import type { DomainEvent, DomainEventType, EventMetadata } from "../../domain/events.js";

export interface EventContext {
  traceId?: string;
  correlationId?: string;
  causationId?: string;
  tenantId?: string;
  /**
   * Override the auto-derived idempotency key. Use this when the caller needs
   * a completely deterministic key regardless of traceId (e.g., scheduled
   * background events that fire once per interval).
   */
  idempotencyKey?: string;
}

export class EventFactory {
  constructor(private readonly clock: Clock, private readonly source = "api") {}

  create<TPayload extends Record<string, unknown>>(input: {
    type: DomainEventType;
    aggregateId: string;
    aggregateType: DomainEvent["aggregateType"];
    payload: TPayload;
    context?: EventContext;
  }): DomainEvent<TPayload> {
    const traceId = input.context?.traceId ?? createId();
    const causationId = input.context?.causationId;

    const originalAggregateId = input.aggregateId;
    const mappedAggregateId = isValidUuid(originalAggregateId)
      ? originalAggregateId
      : generateDeterministicUuid(originalAggregateId);

    /**
     * Idempotency key derivation:
     *   key = sha256(type:aggregateId:traceId:causationId)
     *
     * This is deterministic for the same logical business operation. If the
     * caller retries publish() with a freshly-constructed event (new event.id)
     * but the same business context, the EventStore recognises the duplicate
     * and returns the originally-persisted sequence number without inserting.
     *
     * causationId is included so that two distinct effects of the same cause
     * (same traceId but different causationId) produce different keys and are
     * NOT deduplicated.
     */
    const idempotencyKey =
      input.context?.idempotencyKey ??
      createHash("sha256")
        .update(`${input.type}:${input.aggregateId}:${traceId}:${causationId ?? ""}`)
        .digest("base64url");

    const metadata: EventMetadata = {
      traceId,
      correlationId: input.context?.correlationId ?? traceId,
      causationId,
      tenantId: input.context?.tenantId,
      schemaVersion: 1,
      source: this.source,
      idempotencyKey
    };

    return {
      id: createId(),
      type: input.type,
      aggregateId: input.aggregateId,
      aggregateType: input.aggregateType,
      version: 1,
      timestamp: toIso(this.clock.now()),
      payload: input.payload,
      metadata: {
        ...metadata,
        originalAggregateId: originalAggregateId !== mappedAggregateId ? originalAggregateId : undefined
      }
    };
  }
}
