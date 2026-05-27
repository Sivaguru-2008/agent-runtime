import type { DomainEvent } from "../../domain/events.js";
import type { EventBus, EventHandler } from "../../domain/ports.js";

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Set<EventHandler>();

  async publish(event: DomainEvent): Promise<void> {
    await Promise.all([...this.handlers].map((handler) => handler(event)));
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
