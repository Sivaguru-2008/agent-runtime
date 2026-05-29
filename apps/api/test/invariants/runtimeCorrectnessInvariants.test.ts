import { describe, it, expect, vi } from "vitest";
import { assertRuntimeInvariant, InvariantViolation, INVARIANT_REGISTRY } from "../../src/runtime/invariants.js";
import { ExecutionEngine } from "../../src/runtime/executionEngine.js";
import { OutboxDispatcher } from "../../src/infrastructure/events/outboxDispatcher.js";
import { DedupingToolExecutor } from "../../src/runtime/toolDedupExecutor.js";
import { EventFactory } from "../../src/infrastructure/events/eventFactory.js";
import { SystemClock } from "../../src/shared/clock.js";
import type { Execution, Agent } from "../../src/domain/model.js";

describe("Runtime Correctness Invariant Layer Tests", () => {
  describe("Centralized Invariant Registry", () => {
    it("asserts a truthy condition successfully without throwing", () => {
      expect(() => assertRuntimeInvariant("S1", true, "Should pass")).not.toThrow();
    });

    it("asserts a falsy condition by throwing an InvariantViolation with correct metadata", () => {
      let threw = false;
      try {
        assertRuntimeInvariant("S1", false, "Test assertion failed");
      } catch (err) {
        threw = true;
        expect(err).toBeInstanceOf(InvariantViolation);
        const invErr = err as InvariantViolation;
        expect(invErr.invariant).toBe("S1");
        expect(invErr.message).toContain("Test assertion failed");
        expect(INVARIANT_REGISTRY.S1.category).toBe("safety");
      }
      expect(threw).toBe(true);
    });
  });

  describe("P2: Tenant Isolation Safeguard", () => {
    it("executionEngine.execute throws an invariant violation if tenantId is missing or empty", async () => {
      const clock = new SystemClock();
      const eventFactory = new EventFactory(clock, "test");
      const mockPublisher = { publish: vi.fn(), publishFenced: vi.fn() } as any;
      const mockExecutions = { save: vi.fn(), saveFenced: vi.fn() } as any;
      const mockMemory = { search: vi.fn() } as any;
      const mockModelProvider = { complete: vi.fn() } as any;
      const mockTools = { execute: vi.fn() } as any;

      const engine = new ExecutionEngine(
        eventFactory,
        mockPublisher,
        mockExecutions,
        mockMemory,
        mockModelProvider,
        mockTools,
        clock
      );

      const invalidExecution: Execution = {
        id: "exec-1",
        agentId: "agent-1",
        status: "QUEUED",
        input: {},
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tenantId: "" // Missing tenant ID!
      };

      const agent: Agent = {
        id: "agent-1",
        tenantId: "",
        name: "Test Agent",
        goal: "Test goals",
        state: "RUNNING",
        runtimeStatus: "BUSY",
        model: { provider: "mock", model: "test" },
        tools: [],
        memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 1 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await expect(
        engine.execute({
          agent,
          execution: invalidExecution,
          task: {}
        })
      ).rejects.toThrow(/\[invariant:P2\]/);
    });
  });

  describe("S2: Fenced Tool Execution Guard", () => {
    it("executionEngine throws an invariant violation if fenced execution doesn't wrap tools in DedupingToolExecutor", async () => {
      const clock = new SystemClock();
      const eventFactory = new EventFactory(clock, "test");
      const mockPublisher = {
        publish: vi.fn(),
        publishFenced: vi.fn(() => Promise.resolve({ outcome: "COMMITTED" })),
        publishDurable: vi.fn()
      } as any;
      const mockExecutions = {
        save: vi.fn(),
        saveFenced: vi.fn(() => Promise.resolve("COMMITTED")),
        commitTransition: vi.fn(() => Promise.resolve("COMMITTED")),
        commitTerminal: vi.fn(() => Promise.resolve("COMMITTED")),
        // execute() runs partial-commit detection before the tool loop; a fresh
        // execution is trivially consistent. Without this stub the engine throws
        // a TypeError before reaching the S2 fenced-tool guard under test.
        detectPartialCommit: vi.fn(() => Promise.resolve({ isConsistent: true, actualStatus: "QUEUED" }))
      } as any;
      const mockMemory = {
        search: vi.fn(() => Promise.resolve([]))
      } as any;
      const mockModelProvider = {
        complete: vi.fn(() => Promise.resolve({ tokenUsage: { prompt: 0, completion: 0, total: 0 }, output: {} }))
      } as any;
      
      // Plain mockToolExecutor (not DedupingToolExecutor)
      const mockTools = { execute: vi.fn() } as any;

      const engine = new ExecutionEngine(
        eventFactory,
        mockPublisher,
        mockExecutions,
        mockMemory,
        mockModelProvider,
        mockTools,
        clock,
        { workerId: "worker-1" }
      );

      const execution: Execution = {
        id: "exec-1",
        agentId: "agent-1",
        status: "QUEUED",
        input: {},
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tenantId: "tenant-1"
      };

      const agent: Agent = {
        id: "agent-1",
        tenantId: "tenant-1",
        name: "Test Agent",
        goal: "Test goals",
        state: "RUNNING",
        runtimeStatus: "BUSY",
        model: { provider: "mock", model: "test" },
        tools: [{ name: "t1", enabled: true }],
        memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 1 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // When execution is fenced (fence is defined), it must throw S2 violation
      await expect(
        engine.execute({
          agent,
          execution,
          task: {},
          fence: { executionId: "exec-1", workerId: "worker-1", attempt: 1 }
        })
      ).rejects.toThrow(/\[invariant:S2\]/);
    });
  });

  describe("O1: Outbox FIFO Order Monotonicity", () => {
    it("outbox dispatcher tickMemory throws if pending in-memory events are out of sequence order", async () => {
      const mockPublisher = {
        peekPending: () => [
          { aggregateType: "EXECUTION", aggregateId: "exec-1", sequence: 2, id: "ev-2", type: "TOOL_CALLED" },
          { aggregateType: "EXECUTION", aggregateId: "exec-1", sequence: 1, id: "ev-1", type: "EXECUTION_STARTED" } // Sequence dropped from 2 to 1!
        ]
      } as any;

      const mockBus = { publish: vi.fn() } as any;
      const dispatcher = new OutboxDispatcher(mockPublisher, mockBus);

      await expect(dispatcher.tick()).rejects.toThrow(/\[invariant:O1\]/);
    });

    it("outbox dispatcher tickMemory passes if sequence order is strictly monotonic", async () => {
      const mockPublisher = {
        peekPending: () => [
          { aggregateType: "EXECUTION", aggregateId: "exec-1", sequence: 1, id: "ev-1", type: "EXECUTION_STARTED" },
          { aggregateType: "EXECUTION", aggregateId: "exec-1", sequence: 2, id: "ev-2", type: "TOOL_CALLED" }
        ],
        confirmDelivered: vi.fn()
      } as any;

      const mockBus = { publish: vi.fn() } as any;
      const dispatcher = new OutboxDispatcher(mockPublisher, mockBus);

      const count = await dispatcher.tick();
      expect(count).toBe(2);
    });
  });
});
