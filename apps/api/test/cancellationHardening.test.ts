import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeAbortSignals,
  createAbortError,
  emitTokenIfLive,
  isAbortError,
  normalizeAbortReason,
  sleep
} from "../src/providers/retry.js";
import { ClaudeProvider } from "../src/providers/claudeProvider.js";
import { ExecutionEngine } from "../src/runtime/executionEngine.js";
import { SystemClock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { InMemoryEventBus } from "../src/infrastructure/events/inMemoryEventBus.js";
import { PersistedEventPublisher } from "../src/infrastructure/events/persistedEventPublisher.js";
import {
  InMemoryEventStore,
  InMemoryExecutionRepository
} from "../src/infrastructure/persistence/inMemoryStores.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import { DeterministicModelProvider } from "../src/runtime/mockModelProvider.js";
import type { DomainEvent } from "../src/domain/events.js";
import type { Agent, Execution, MemoryRecord } from "../src/domain/model.js";
import type { MemoryRepository } from "../src/domain/ports.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * Pins behaviour introduced by the cancellation hardening pass:
 *
 *   1. normalizeAbortReason always returns an Error that classifies as
 *      AbortError, regardless of what arbitrary value `signal.reason` holds.
 *   2. sleep() removes its abort listener on BOTH paths (timer resolves and
 *      abort fires) with no leak.
 *   3. composeAbortSignals fires its inner controller at most once even when
 *      multiple parent signals abort, and the first reason wins.
 *   4. emitTokenIfLive refuses to dispatch the consumer callback once the
 *      signal is aborted, closing the zombie-token window.
 *   5. ExecutionEngine fences a SECOND time immediately before memory.add so
 *      a worker whose lease was revoked between the first gate and the
 *      durable write cluster cannot pollute the memory store.
 *
 * Tests intentionally avoid network or timing dependencies — fake signals,
 * fake validators, fake memory repo. No simulation harness.
 */

// ─── 1. normalizeAbortReason ─────────────────────────────────────────────────

describe("normalizeAbortReason", () => {
  it("returns Error untouched when reason is already an Error", () => {
    const original = new Error("boom");
    expect(normalizeAbortReason(original)).toBe(original);
  });

  it("preserves DOMException as Error (it already extends Error in Node 18+)", () => {
    const dom = new DOMException("aborted by user", "AbortError");
    const out = normalizeAbortReason(dom);
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe("AbortError");
  });

  it("wraps a string reason as an AbortError preserving the message", () => {
    const out = normalizeAbortReason("user clicked stop");
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe("AbortError");
    expect(out.message).toBe("user clicked stop");
    expect(isAbortError(out)).toBe(true);
  });

  it("produces a default AbortError for undefined reason", () => {
    const out = normalizeAbortReason(undefined);
    expect(out).toBeInstanceOf(Error);
    expect(isAbortError(out)).toBe(true);
  });

  it("produces a default AbortError for null reason", () => {
    const out = normalizeAbortReason(null);
    expect(out).toBeInstanceOf(Error);
    expect(isAbortError(out)).toBe(true);
  });

  it("serialises arbitrary plain-object reasons into the message", () => {
    const out = normalizeAbortReason({ code: 42, why: "lease lost" });
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe("AbortError");
    expect(out.message).toContain("lease lost");
  });

  it("classifies the normalised error as an AbortError downstream", () => {
    // Whatever shape goes in, isAbortError() — the system-wide classifier —
    // must say yes. Otherwise the engine's catch-branch will treat
    // cancellation as a real failure.
    for (const reason of ["x", undefined, null, { a: 1 }, createAbortError()]) {
      expect(isAbortError(normalizeAbortReason(reason))).toBe(true);
    }
  });
});

// ─── 2. sleep() listener cleanup ────────────────────────────────────────────

describe("sleep listener cleanup", () => {
  /**
   * Tiny fake AbortSignal that counts add/remove so we can prove the
   * listener inventory returns to zero on both code paths.
   */
  type Listener = (ev: { target: unknown }) => void;
  function makeCountingSignal() {
    const listeners = new Set<Listener>();
    let addCount = 0;
    let removeCount = 0;
    const state = { aborted: false, reason: undefined as unknown };
    const target = {
      get aborted() {
        return state.aborted;
      },
      get reason() {
        return state.reason;
      },
      onabort: null,
      throwIfAborted() {
        if (state.aborted) throw normalizeAbortReason(state.reason);
      },
      addEventListener(_type: string, listener: Listener) {
        addCount++;
        listeners.add(listener);
      },
      removeEventListener(_type: string, listener: Listener) {
        removeCount++;
        listeners.delete(listener);
      },
      dispatchEvent() {
        return true;
      }
    } as unknown as AbortSignal;
    return {
      signal: target,
      stats: () => ({ add: addCount, remove: removeCount, attached: listeners.size }),
      fireAbort(reason?: unknown) {
        state.aborted = true;
        state.reason = reason;
        for (const l of [...listeners]) {
          // `once: true` is implemented by the real DOM; our shim removes
          // explicitly so the count remains accurate.
          listeners.delete(l);
          removeCount++;
          l({ target });
        }
      }
    };
  }

  it("removes the abort listener on the timer-fires path", async () => {
    const { signal, stats } = makeCountingSignal();
    await sleep(1, signal);
    const s = stats();
    expect(s.add).toBe(1);
    expect(s.remove).toBe(1);
    expect(s.attached).toBe(0);
  });

  it("removes the abort listener on the abort-fires path", async () => {
    const { signal, stats, fireAbort } = makeCountingSignal();
    const pending = sleep(60_000, signal);
    // Abort immediately so the timer never fires.
    fireAbort("operator stop");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const s = stats();
    expect(s.add).toBe(1);
    expect(s.remove).toBe(1);
    expect(s.attached).toBe(0);
  });

  it("rejects with a normalized Error even when reason is a raw string", async () => {
    const { signal, fireAbort } = makeCountingSignal();
    const pending = sleep(60_000, signal);
    fireAbort("just stop");
    try {
      await pending;
      throw new Error("sleep did not reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("AbortError");
      expect((err as Error).message).toBe("just stop");
    }
  });
});

// ─── 3. composeAbortSignals double-abort resilience ─────────────────────────

describe("composeAbortSignals", () => {
  it("aborts the composed signal exactly once when multiple parents abort", () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal, cleanup } = composeAbortSignals(a.signal, b.signal);

    let abortEvents = 0;
    signal.addEventListener("abort", () => {
      abortEvents++;
    });

    a.abort(new Error("first"));
    b.abort(new Error("second"));

    expect(signal.aborted).toBe(true);
    // First abort wins — the guard prevents the second from re-firing.
    expect(abortEvents).toBe(1);
    expect((signal.reason as Error)?.message).toBe("first");

    cleanup();
  });

  it("cleanup is safe to call multiple times", () => {
    const a = new AbortController();
    const b = new AbortController();
    const { cleanup } = composeAbortSignals(a.signal, b.signal);
    cleanup();
    expect(() => cleanup()).not.toThrow();
  });

  it("short-circuits when one parent is already aborted with a non-Error reason", () => {
    const a = new AbortController();
    a.abort("string reason");
    const b = new AbortController();
    const { signal } = composeAbortSignals(a.signal, b.signal);
    expect(signal.aborted).toBe(true);
    // Reason normalised into an Error rather than the raw string.
    expect(signal.reason).toBeInstanceOf(Error);
    expect((signal.reason as Error).name).toBe("AbortError");
    expect((signal.reason as Error).message).toBe("string reason");
  });

  it("returns the only signal verbatim with a no-op cleanup", () => {
    const a = new AbortController();
    const { signal, cleanup } = composeAbortSignals(undefined, a.signal, undefined);
    expect(signal).toBe(a.signal);
    expect(() => cleanup()).not.toThrow();
  });
});

// ─── 4. emitTokenIfLive zombie suppression ──────────────────────────────────

describe("emitTokenIfLive", () => {
  it("invokes the consumer when the signal is live", () => {
    const seen: Array<[string, number]> = [];
    emitTokenIfLive(undefined, (tok, c) => seen.push([tok, c]), "alpha", 1.0);
    expect(seen).toEqual([["alpha", 1.0]]);
  });

  it("does NOT invoke the consumer when the signal is aborted", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const seen: string[] = [];
    expect(() =>
      emitTokenIfLive(ctrl.signal, (tok) => seen.push(tok), "alpha", 1.0)
    ).toThrow();
    expect(seen).toEqual([]);
  });

  it("throws a normalized AbortError even when reason is a raw string", () => {
    const ctrl = new AbortController();
    ctrl.abort("operator");
    try {
      emitTokenIfLive(ctrl.signal, () => undefined, "x", 1.0);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("AbortError");
      expect((err as Error).message).toBe("operator");
    }
  });
});

// ─── 5. End-to-end zombie-token + releaseLock in ClaudeProvider ─────────────

describe("ClaudeProvider stream cancellation", () => {
  function mockFetchStream(chunks: string[], delayMs = 0) {
    return (async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of chunks) {
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        }
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
  }

  function makeAgentExec(): { agent: Agent; execution: Execution } {
    const now = new Date().toISOString();
    return {
      agent: {
        id: "a",
        name: "n",
        goal: "g",
        state: "RUNNING",
        runtimeStatus: "BUSY",
        model: { provider: "mock", model: "x", temperature: 0 },
        tools: [],
        memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
        createdAt: now,
        updatedAt: now,
        tenantId: "t"
      },
      execution: {
        id: "e",
        agentId: "a",
        status: "RUNNING",
        input: { prompt: "x" },
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        startedAt: now,
        updatedAt: now,
        tenantId: "t"
      }
    };
  }

  it("emits no token after the consumer aborts the signal mid-stream", async () => {
    const chunks = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"A"}}\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"B"}}\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"C"}}\n'
    ];
    globalThis.fetch = mockFetchStream(chunks, 5);
    const { agent, execution } = makeAgentExec();
    const ctrl = new AbortController();
    const provider = new ClaudeProvider({ apiKey: "k" });
    const emitted: string[] = [];

    await provider
      .complete({
        agent,
        execution,
        prompt: "x",
        context: [],
        signal: ctrl.signal,
        onToken: (tok) => {
          emitted.push(tok);
          if (tok === "A") ctrl.abort();
        }
      })
      .catch(() => undefined);

    expect(emitted).toEqual(["A"]);
  });

  it("releases the stream reader lock even when abort interrupts the loop", async () => {
    const chunks = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"A"}}\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"B"}}\n'
    ];

    // Wrap the mock so we can observe releaseLock().
    let releaseCount = 0;
    const baseFetch = mockFetchStream(chunks, 5);
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const res = await (baseFetch as typeof fetch)(...args);
      const original = res.body!;
      // Decorate the body so getReader() returns a reader whose releaseLock
      // we can count without changing read semantics.
      const decorated = new Proxy(original, {
        get(target, prop, receiver) {
          if (prop === "getReader") {
            return (...rargs: Parameters<ReadableStream["getReader"]>) => {
              const reader = (target.getReader as Function).apply(target, rargs);
              const origRelease = reader.releaseLock.bind(reader);
              reader.releaseLock = () => {
                releaseCount++;
                origRelease();
              };
              return reader;
            };
          }
          return Reflect.get(target, prop, receiver);
        }
      });
      return new Response(decorated as unknown as ReadableStream<Uint8Array>, {
        status: res.status,
        headers: res.headers
      });
    }) as typeof fetch;

    const { agent, execution } = makeAgentExec();
    const ctrl = new AbortController();
    const provider = new ClaudeProvider({ apiKey: "k" });
    await provider
      .complete({
        agent,
        execution,
        prompt: "x",
        context: [],
        signal: ctrl.signal,
        onToken: (tok) => {
          if (tok === "A") ctrl.abort();
        }
      })
      .catch(() => undefined);

    expect(releaseCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── 6. ExecutionEngine: fencing before memory.add ──────────────────────────

class SpyMemoryRepository implements MemoryRepository {
  readonly added: MemoryRecord[] = [];
  async add(record: MemoryRecord): Promise<void> {
    this.added.push(record);
  }
  // Test-double: this suite does not exercise fenced writes; the engine
  // only routes through addFenced when a fence is passed in ExecuteTaskInput
  // which these cancellation tests never do. Surface as a hard error so any
  // future use is loud rather than silently bypassing the fence check.
  async addFenced(): Promise<never> {
    throw new Error("SpyMemoryRepository.addFenced is not implemented for this suite");
  }
  async search(): Promise<MemoryRecord[]> {
    return [];
  }
  async listByAgent(): Promise<MemoryRecord[]> {
    return [];
  }
}

function buildSuccessHarness() {
  const clock = new SystemClock();
  const eventStore = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const publisher = new PersistedEventPublisher(eventStore, bus);
  const eventFactory = new EventFactory(clock, "hardening-test");
  const memory = new SpyMemoryRepository();
  const executions = new InMemoryExecutionRepository(undefined, memory);

  const observed: DomainEvent[] = [];
  bus.subscribe((ev) => {
    observed.push(ev);
  });

  const engine = new ExecutionEngine(
    eventFactory,
    publisher,
    executions,
    memory,
    new DeterministicModelProvider(),
    new BuiltInToolExecutor(),
    clock,
    { workerId: "worker-stale" }
  );

  return { engine, executions, memory, observed };
}

function makeAgentExecution(): { agent: Agent; execution: Execution } {
  const now = new Date().toISOString();
  return {
    agent: {
      id: "agent-hardening",
      name: "hardening",
      goal: "complete the task",
      state: "RUNNING",
      runtimeStatus: "BUSY",
      model: { provider: "mock", model: "deterministic-runtime-v1", temperature: 0 },
      tools: [{ name: "runtime.inspect", enabled: false }],
      memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
      createdAt: now,
      updatedAt: now,
      tenantId: "tenant-hardening"
    },
    execution: {
      id: "exec-hardening",
      agentId: "agent-hardening",
      status: "QUEUED",
      input: { prompt: "go" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: now,
      updatedAt: now,
      tenantId: "tenant-hardening"
    }
  };
}

describe("ExecutionEngine pre-durable-write fencing", () => {
  it("calls validateLease at least twice in the success path (first gate + pre-memory.add gate)", async () => {
    const { engine } = buildSuccessHarness();
    const { agent, execution } = makeAgentExecution();
    const calls: string[] = [];
    await engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: "worker-stale",
      validateLease: async (id) => {
        calls.push(id);
        return true;
      }
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((id) => id === execution.id)).toBe(true);
  });

  it("does NOT call memory.add when the second fencing gate fails", async () => {
    const { engine, memory, observed, executions } = buildSuccessHarness();
    const { agent, execution } = makeAgentExecution();

    let callIndex = 0;
    const result = await engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: "worker-stale",
      // First gate (pre-memory.add #1) passes; second gate (pre-memory.add
      // #2) fails — simulating a lease revocation in the millisecond window
      // between the two checks. The catch handler will then validate a
      // third time (returns false) and emit EXECUTION_FENCE_REJECTED.
      validateLease: async () => {
        callIndex++;
        return callIndex < 2;
      }
    });

    // Surrender contract: input execution returned unchanged, no memory
    // write, no FAILED state, fence-rejected event published.
    expect(result).toEqual(execution);
    expect(memory.added).toHaveLength(0);

    const persisted = await executions.getById(execution.id);
    expect(persisted?.status).not.toBe("FAILED");
    expect(persisted?.status).not.toBe("COMPLETED");

    const rejected = observed.filter((e) => e.type === "EXECUTION_FENCE_REJECTED");
    expect(rejected.length).toBeGreaterThanOrEqual(1);

    const completed = observed.filter((e) => e.type === "EXECUTION_COMPLETED");
    expect(completed).toHaveLength(0);
  });

  it("writes memory.add exactly once when both fencing gates pass", async () => {
    const { engine, memory } = buildSuccessHarness();
    const { agent, execution } = makeAgentExecution();
    await engine.execute({
      agent,
      execution,
      task: execution.input,
      workerId: "worker-stale",
      validateLease: async () => true
    });
    expect(memory.added).toHaveLength(1);
    expect(memory.added[0]!.executionId).toBe(execution.id);
    expect(memory.added[0]!.tenantId).toBe("tenant-hardening");
  });
});
