import { Redis } from "ioredis";
import type { DomainEvent } from "../../domain/events.js";
import type { EventBus, EventHandler } from "../../domain/ports.js";
import type {
  StreamConsumeOptions,
  StreamEventBus,
  StreamMessage
} from "../../domain/clusterPorts.js";
import { createRedisClient } from "../reliability/redisClient.js";

const DEFAULT_STREAM = "agent-runtime.events";
const EPHEMERAL_CHANNEL = "agent-runtime.events.ephemeral";

export interface RedisStreamsConfig {
  url: string;
  stream?: string;
  maxLen?: number;
}

function isHighPriority(type: string): boolean {
  return (
    type === "EXECUTION_STARTED" ||
    type === "EXECUTION_COMPLETED" ||
    type === "EXECUTION_FAILED" ||
    type === "COGNITION_STARTED" ||
    type === "COGNITION_COMPLETED" ||
    type === "COGNITION_FAILED" ||
    type === "COGNITION_HANDOFF" ||
    type === "COGNITION_NODE_STARTED" ||
    type === "COGNITION_NODE_COMPLETED" ||
    type === "COGNITION_NODE_FAILED" ||
    type === "FAILURE_SIGNAL_RAISED" ||
    type === "REPLAY_SESSION_CREATED" ||
    type === "REPLAY_SNAPSHOT_WRITTEN" ||
    type === "REPLAY_BRANCH_CREATED" ||
    type === "REPLAY_DIVERGENCE_DETECTED" ||
    type === "SYSTEM_ERROR_RAISED"
  );
}

export class RedisStreamsEventBus implements StreamEventBus, EventBus {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly consumers: Redis[] = [];
  private readonly handlers = new Set<EventHandler>();
  private readonly stream: string;
  private readonly maxLen: number;
  private readonly url: string;
  private readonly busId: string;
  private closed = false;

  // Local write buffer for adaptive pipelined writes
  private writeBuffer: DomainEvent[] = [];
  private readonly flushTimer: NodeJS.Timeout | null = null;

  constructor(config: RedisStreamsConfig) {
    this.url = config.url;
    // Publisher carries XADD/XREAD writes — hardened retry policy is fine.
    this.publisher = createRedisClient(config.url, { name: "stream-bus-pub" });
    this.stream = config.stream ?? DEFAULT_STREAM;
    this.maxLen = config.maxLen ?? 50_000;
    this.busId = Math.random().toString(36).slice(2) + "-" + Date.now();

    // Subscriber issues SUBSCRIBE; ioredis forbids maxRetriesPerRequest in
    // that mode, so clear it from the hardened defaults.
    this.subscriber = createRedisClient(config.url, {
      name: "stream-bus-sub",
      overrides: { maxRetriesPerRequest: null }
    });
    void this.subscriber.subscribe(EPHEMERAL_CHANNEL);
    this.subscriber.on("message", (channel: string, message: string) => {
      if (this.closed || channel !== EPHEMERAL_CHANNEL) return;
      try {
        const { sender, event } = JSON.parse(message) as { sender: string; event: DomainEvent };
        // Trigger handlers only if the message originated from a different bus instance
        if (sender !== this.busId) {
          void Promise.all([...this.handlers].map((handler) => handler(event)));
        }
      } catch {
        // ignore malformed messages
      }
    });

    // Start background interval for pipelined batch flushing
    this.flushTimer = setInterval(() => void this.flush(), 10);
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  async publish(event: DomainEvent): Promise<void> {
    await this.publishToStream(event);
  }

  async publishToStream(event: DomainEvent): Promise<string> {
    if (this.closed) return "0-0";

    // 1. Trigger local handlers synchronously immediately for zero-lag responsiveness
    void Promise.all([...this.handlers].map((handler) => handler(event)));

    // 2. Broadcast immediately over the ephemeral Pub/Sub channel
    await this.publisher.publish(
      EPHEMERAL_CHANNEL,
      JSON.stringify({ sender: this.busId, event })
    );

    // 3. Selective Persistence: Write to durable Stream ONLY if it is high priority
    if (isHighPriority(event.type)) {
      this.writeBuffer.push(event);
      if (this.writeBuffer.length >= 30) {
        void this.flush();
      }
    }

    return event.id ?? "0-0";
  }

  private async flush(): Promise<void> {
    if (this.writeBuffer.length === 0) return;

    const batch = this.writeBuffer.splice(0);
    const pipeline = this.publisher.pipeline();

    for (const event of batch) {
      pipeline.xadd(
        this.stream,
        "MAXLEN",
        "~",
        String(this.maxLen),
        "*",
        "event",
        JSON.stringify(event)
      );
    }

    try {
      await pipeline.exec();
    } catch (err) {
      console.error("Redis Stream pipelined flush failed, recovering events:", err);
      // Recover failed writes back to the buffer to avoid data loss
      this.writeBuffer.unshift(...batch);
    }
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async ensureGroup(group: string): Promise<void> {
    try {
      await this.publisher.xgroup("CREATE", this.stream, group, "$", "MKSTREAM");
    } catch (error) {
      if (!isBusyGroupError(error)) throw error;
    }
  }

  consume(options: StreamConsumeOptions): AsyncIterable<StreamMessage> {
    // XREADGROUP with BLOCK ms requires a connection where ioredis does not
    // mid-flight time the command out. Disable per-command retries; the
    // outer loop already handles reconnect via retryStrategy.
    const consumer = createRedisClient(this.url, {
      name: `stream-bus-consumer:${options.consumer}`,
      overrides: { maxRetriesPerRequest: null }
    });
    this.consumers.push(consumer);
    const stream = this.stream;
    const blockMs = options.blockMs ?? 5_000;
    const count = options.count ?? 16;
    const closedRef = () => this.closed;

    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamMessage> {
        const buffer: StreamMessage[] = [];
        return {
          async next(): Promise<IteratorResult<StreamMessage>> {
            while (!closedRef()) {
              if (buffer.length) {
                return { value: buffer.shift() as StreamMessage, done: false };
              }
              const response = (await consumer.xreadgroup(
                "GROUP",
                options.group,
                options.consumer,
                "COUNT",
                count,
                "BLOCK",
                blockMs,
                "STREAMS",
                stream,
                ">"
              )) as Array<[string, Array<[string, string[]]>]> | null;

              if (!response) continue;
              for (const [, entries] of response) {
                for (const [streamId, fields] of entries) {
                  const payload = readField(fields, "event");
                  if (!payload) continue;
                  try {
                    const event = JSON.parse(payload) as DomainEvent;
                    buffer.push({ streamId, event });
                  } catch {
                    // ignore malformed entries
                  }
                }
              }
            }
            await consumer.quit().catch(() => undefined);
            return { value: undefined, done: true };
          },
          async return(): Promise<IteratorResult<StreamMessage>> {
            await consumer.quit().catch(() => undefined);
            return { value: undefined, done: true };
          }
        };
      }
    };
  }

  async ack(group: string, streamId: string): Promise<void> {
    await this.publisher.xack(this.stream, group, streamId);
  }

  async pending(group: string): Promise<number> {
    const summary = (await this.publisher.xpending(this.stream, group)) as [number, ...unknown[]] | null;
    if (!summary) return 0;
    return Number(summary[0] ?? 0);
  }

  async replay(fromId: string, limit: number): Promise<StreamMessage[]> {
    const response = (await this.publisher.xrange(this.stream, fromId, "+", "COUNT", limit)) as Array<[string, string[]]>;
    const messages: StreamMessage[] = [];
    for (const [streamId, fields] of response) {
      const payload = readField(fields, "event");
      if (!payload) continue;
      try {
        const event = JSON.parse(payload) as DomainEvent;
        messages.push({ streamId, event });
      } catch {
        continue;
      }
    }
    return messages;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    // Flush remaining writes
    await this.flush();
    this.publisher.disconnect();
    this.subscriber.disconnect();
    await Promise.all(this.consumers.map((consumer) => consumer.quit().catch(() => undefined)));
  }
}

function readField(fields: string[], name: string): string | undefined {
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === name) return fields[i + 1];
  }
  return undefined;
}

function isBusyGroupError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const message = (error as { message?: string }).message ?? "";
  return message.includes("BUSYGROUP");
}
