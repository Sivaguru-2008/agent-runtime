import { describe, it, expect, vi, afterEach } from "vitest";
import { Redis } from "ioredis";
import { PersistedEventPublisher } from "../src/infrastructure/events/persistedEventPublisher.js";
import { InMemoryStreamEventBus } from "../src/infrastructure/events/inMemoryStreamEventBus.js";
import { RedisStreamsEventBus } from "../src/infrastructure/events/redisStreamsEventBus.js";
import type { DomainEvent } from "../src/domain/events.js";
import type { EventStore } from "../src/domain/ports.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe("Distributed Event Bus Hardening", () => {
  describe("PersistedEventPublisher (Selective Persistence)", () => {
    const mockStore: EventStore = {
      append: vi.fn().mockImplementation(async (event: DomainEvent) => ({
        ...event,
        sequence: 42
      })),
      appendFenced: vi.fn().mockImplementation(async (event: DomainEvent) => ({
        outcome: "COMMITTED",
        event: { ...event, sequence: 42 }
      })),
      listByAggregate: vi.fn(),
      listByExecution: vi.fn(),
      listRecent: vi.fn(),
      listAfterSequence: vi.fn(),
      lastForExecution: vi.fn()
    };

    afterEach(() => {
      vi.clearAllMocks();
    });

    it("should write HIGH PRIORITY events to the EventStore durably", async () => {
      const bus = new InMemoryStreamEventBus();
      const publisher = new PersistedEventPublisher(mockStore, bus);

      const highPriorityEvent: DomainEvent = {
        id: "ev-1",
        type: "COGNITION_STARTED",
        aggregateId: "exec-123",
        aggregateType: "EXECUTION",
        version: 1,
        timestamp: new Date().toISOString(),
        payload: { cognitionId: "cog-1" },
        metadata: { traceId: "t-1", correlationId: "c-1", schemaVersion: 1, source: "test", idempotencyKey: "i-1" }
      };

      const result = await publisher.publish(highPriorityEvent);

      // Verify it was written to EventStore and sequence was assigned
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      expect(mockStore.append).toHaveBeenCalledWith(highPriorityEvent);
      expect(result.sequence).toBe(42);
    });

    it("should bypass the EventStore for LOW PRIORITY events (Selective Persistence)", async () => {
      const bus = new InMemoryStreamEventBus();
      const publisher = new PersistedEventPublisher(mockStore, bus);

      const lowPriorityEvent: DomainEvent = {
        id: "ev-2",
        type: "COGNITION_NODE_STREAMING",
        aggregateId: "exec-123",
        aggregateType: "EXECUTION",
        version: 1,
        timestamp: new Date().toISOString(),
        payload: { nodeId: "node-1", chunk: "hello" },
        metadata: { traceId: "t-2", correlationId: "c-2", schemaVersion: 1, source: "test", idempotencyKey: "i-2" }
      };

      const result = await publisher.publish(lowPriorityEvent);

      // Verify it bypassed EventStore completely, but still assigned sequence 0
      expect(mockStore.append).not.toHaveBeenCalled();
      expect(result.sequence).toBe(0);
    });
  });

  // Dynamic Integration tests for RedisStreamsEventBus (skipped if Redis is offline)
  describe("RedisStreamsEventBus (Priority Routing & Pipelining)", () => {
    let isRedisAvailable = false;
    let testBus: RedisStreamsEventBus | null = null;

    it("check if Redis is available on localhost", async () => {
      const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 0, connectTimeout: 1000 });
      try {
        await redis.ping();
        isRedisAvailable = true;
      } catch {
        isRedisAvailable = false;
      } finally {
        redis.disconnect();
      }
    });

    it("should route high-priority to stream and pubsub, and low-priority to pubsub only", async () => {
      if (!isRedisAvailable) {
        console.log("Redis is not available. Skipping RedisStreamsEventBus integration tests.");
        return;
      }

      const streamName = `test-stream-${Date.now()}`;
      testBus = new RedisStreamsEventBus({ url: REDIS_URL, stream: streamName, maxLen: 1000 });

      const receivedEvents: DomainEvent[] = [];
      testBus.subscribe((ev) => {
        receivedEvents.push(ev);
      });

      const highPriorityEvent: DomainEvent = {
        id: `ev-hp-${Date.now()}`,
        type: "COGNITION_STARTED",
        aggregateId: "exec-123",
        aggregateType: "EXECUTION",
        version: 1,
        timestamp: new Date().toISOString(),
        payload: { cognitionId: "cog-1" },
        metadata: { traceId: "t-1", correlationId: "c-1", schemaVersion: 1, source: "test", idempotencyKey: "i-1" }
      };

      const lowPriorityEvent: DomainEvent = {
        id: `ev-lp-${Date.now()}`,
        type: "COGNITION_NODE_STREAMING",
        aggregateId: "exec-123",
        aggregateType: "EXECUTION",
        version: 1,
        timestamp: new Date().toISOString(),
        payload: { nodeId: "node-1", chunk: "test-token" },
        metadata: { traceId: "t-2", correlationId: "c-2", schemaVersion: 1, source: "test", idempotencyKey: "i-2" }
      };

      // Publish high and low priority events
      await testBus.publish(highPriorityEvent);
      await testBus.publish(lowPriorityEvent);

      // Give a tiny window for Pub/Sub processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Both should have triggered the handlers on this node
      expect(receivedEvents.map(e => e.id)).toContain(highPriorityEvent.id);
      expect(receivedEvents.map(e => e.id)).toContain(lowPriorityEvent.id);

      // Verify that high priority event is present in the stream
      const streamMessages = await testBus.replay("-", 100);
      const streamEventIds = streamMessages.map((m) => m.event.id);

      expect(streamEventIds).toContain(highPriorityEvent.id);
      // Low priority token chunk event MUST NOT be stored in the Redis Stream!
      expect(streamEventIds).not.toContain(lowPriorityEvent.id);

      await testBus.close();
      testBus = null;
    });

    it("should pipeline low-priority buffer writes correctly", async () => {
      if (!isRedisAvailable) return;

      const streamName = `test-stream-pipeline-${Date.now()}`;
      testBus = new RedisStreamsEventBus({ url: REDIS_URL, stream: streamName, maxLen: 1000 });

      // Publish 25 low priority events sequentially
      for (let i = 0; i < 25; i++) {
        const ev: DomainEvent = {
          id: `ev-lp-pipe-${i}-${Date.now()}`,
          type: "COGNITION_NODE_STREAMING",
          aggregateId: "exec-123",
          aggregateType: "EXECUTION",
          version: 1,
          timestamp: new Date().toISOString(),
          payload: { nodeId: "node-1", chunk: `t-${i}` },
          metadata: { traceId: "t-1", correlationId: "c-1", schemaVersion: 1, source: "test", idempotencyKey: `i-${i}` }
        };
        await testBus.publish(ev);
      }

      // Replay stream messages
      const streamMessages = await testBus.replay("-", 100);
      expect(streamMessages.length).toBe(0); // Bypasses stream completely

      await testBus.close();
      testBus = null;
    });
  });
});
