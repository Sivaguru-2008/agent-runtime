import { Redis } from "ioredis";
import type { DomainEvent } from "../../domain/events.js";
import type { EventBus, EventHandler } from "../../domain/ports.js";
import { createRedisClient } from "../reliability/redisClient.js";

const CHANNEL = "agent-runtime.events";

export class RedisEventBus implements EventBus {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers = new Set<EventHandler>();

  constructor(redisUrl: string) {
    // Pub/Sub clients must NOT have maxRetriesPerRequest set — ioredis throws
    // when SUBSCRIBE is issued on a connection with that limit. The factory
    // sets a default; override back to null on the subscriber to stay
    // compatible with subscribe()/psubscribe() semantics.
    this.publisher = createRedisClient(redisUrl, { name: "event-bus-pub" });
    this.subscriber = createRedisClient(redisUrl, {
      name: "event-bus-sub",
      overrides: { maxRetriesPerRequest: null }
    });
    void this.subscriber.subscribe(CHANNEL);
    this.subscriber.on("message", (_channel: string, message: string) => {
      const event = JSON.parse(message) as DomainEvent;
      void Promise.all([...this.handlers].map((handler) => handler(event)));
    });
  }

  async publish(event: DomainEvent): Promise<void> {
    await this.publisher.publish(CHANNEL, JSON.stringify(event));
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }
}
