import type { DomainEvent } from "../../domain/events.js";
import type { EventBus, EventHandler } from "../../domain/ports.js";
import type {
  StreamConsumeOptions,
  StreamEventBus,
  StreamMessage
} from "../../domain/clusterPorts.js";

interface PendingEntry {
  streamId: string;
  event: DomainEvent;
  consumer: string;
  deliveredAt: number;
}

export class InMemoryStreamEventBus implements StreamEventBus, EventBus {
  private readonly handlers = new Set<EventHandler>();
  private readonly entries: StreamMessage[] = [];
  private readonly groupCursors = new Map<string, number>();
  private readonly groupPending = new Map<string, Map<string, PendingEntry>>();
  private readonly waiters: Array<() => void> = [];
  private sequence = 0;
  private closed = false;

  async publish(event: DomainEvent): Promise<void> {
    await this.publishToStream(event);
  }

  async publishToStream(event: DomainEvent): Promise<string> {
    this.sequence += 1;
    const streamId = `${Date.now()}-${this.sequence}`;
    this.entries.push({ streamId, event });
    await Promise.all([...this.handlers].map((handler) => handler(event)));
    for (const waiter of this.waiters.splice(0)) waiter();
    return streamId;
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async ensureGroup(group: string): Promise<void> {
    if (!this.groupCursors.has(group)) this.groupCursors.set(group, this.entries.length);
    if (!this.groupPending.has(group)) this.groupPending.set(group, new Map());
  }

  consume(options: StreamConsumeOptions): AsyncIterable<StreamMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamMessage> {
        return {
          async next(): Promise<IteratorResult<StreamMessage>> {
            while (!self.closed) {
              const cursor = self.groupCursors.get(options.group) ?? 0;
              if (cursor < self.entries.length) {
                const message = self.entries[cursor];
                self.groupCursors.set(options.group, cursor + 1);
                const pending = self.groupPending.get(options.group) ?? new Map();
                pending.set(message.streamId, {
                  streamId: message.streamId,
                  event: message.event,
                  consumer: options.consumer,
                  deliveredAt: Date.now()
                });
                self.groupPending.set(options.group, pending);
                return { value: message, done: false };
              }
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, options.blockMs ?? 1000);
                self.waiters.push(() => {
                  clearTimeout(timer);
                  resolve();
                });
              });
            }
            return { value: undefined, done: true };
          },
          async return(): Promise<IteratorResult<StreamMessage>> {
            return { value: undefined, done: true };
          }
        };
      }
    };
  }

  async ack(group: string, streamId: string): Promise<void> {
    const pending = this.groupPending.get(group);
    pending?.delete(streamId);
  }

  async pending(group: string): Promise<number> {
    return this.groupPending.get(group)?.size ?? 0;
  }

  async replay(fromId: string, limit: number): Promise<StreamMessage[]> {
    const start = fromId === "-" ? 0 : this.entries.findIndex((entry) => entry.streamId >= fromId);
    const slice = start < 0 ? [] : this.entries.slice(start, start + limit);
    return slice.map((entry) => ({ streamId: entry.streamId, event: entry.event }));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}
