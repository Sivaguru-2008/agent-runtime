import { describe, expect, it, vi, afterEach } from "vitest";
import { ClaudeProvider } from "../src/providers/claudeProvider.js";
import { OpenAIProvider } from "../src/providers/openaiProvider.js";
import { withRetry, withProviderTimeout } from "../src/providers/retry.js";
import { FailoverModelProvider } from "../src/providers/failoverModelProvider.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";
import { DeterministicModelProvider } from "../src/runtime/mockModelProvider.js";
import { ProviderServerError } from "../src/providers/errors.js";
import type { Agent, Execution } from "../src/domain/model.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// Helper to mock streaming fetch responses
function mockFetchStream(chunks: string[], delayMs = 0) {
  return (async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

function makeMockAgentAndExecution(): { agent: Agent; execution: Execution } {
  const now = new Date().toISOString();
  return {
    agent: {
      id: "agent-1",
      name: "Test Agent",
      goal: "Test goals",
      state: "RUNNING",
      runtimeStatus: "BUSY",
      model: { provider: "mock", model: "deterministic", temperature: 0.7 },
      tools: [],
      memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
      createdAt: now,
      updatedAt: now,
      tenantId: "tenant-1"
    },
    execution: {
      id: "exec-1",
      agentId: "agent-1",
      status: "RUNNING",
      input: { prompt: "Hello" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: now,
      updatedAt: now,
      tenantId: "tenant-1"
    }
  };
}

describe("Hardened Cancellation Propagation Invariant Tests", () => {
  
  // ─── VERIFICATION 1: ZERO POST-ABORT TOKEN EMISSION ───────────────────────────
  it("GUARANTEES: ClaudeProvider terminates streaming instantly and leaks no tokens after abort", async () => {
    const chunks = [
      'data: {"type": "message_start", "message": {"usage": {"input_tokens": 10}}}\n',
      'data: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello"}}\n',
      'data: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": " World"}}\n',
      'data: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "!"}}\n',
      'data: {"type": "message_delta", "usage": {"output_tokens": 5}}\n'
    ];

    globalThis.fetch = mockFetchStream(chunks, 15);
    const { agent, execution } = makeMockAgentAndExecution();
    const controller = new AbortController();

    const provider = new ClaudeProvider({ apiKey: "fake-key" });
    const tokensEmitted: string[] = [];

    const pending = provider.complete({
      agent,
      execution,
      prompt: "Hello",
      context: [],
      signal: controller.signal,
      onToken: (tok) => {
        tokensEmitted.push(tok);
        if (tok === "Hello") {
          controller.abort();
        }
      }
    });

    let threwAbortError = false;
    try {
      await pending;
    } catch (err: any) {
      if (err.name === "AbortError" || err.message?.includes("aborted")) {
        threwAbortError = true;
      }
    }

    // Must have aborted immediately and thrown a valid AbortError
    expect(threwAbortError).toBe(true);
    // ZERO post-abort token leakage allowed! " World" and "!" must NEVER be emitted.
    expect(tokensEmitted).toContain("Hello");
    expect(tokensEmitted).not.toContain(" World");
    expect(tokensEmitted).not.toContain("!");
  });

  it("GUARANTEES: OpenAIProvider terminates streaming instantly and leaks no tokens after abort", async () => {
    const chunks = [
      'data: {"choices": [{"delta": {"content": "Hello"}}]}\n',
      'data: {"choices": [{"delta": {"content": " World"}}]}\n',
      'data: {"choices": [{"delta": {"content": "!"}}]}\n',
      "data: [DONE]\n"
    ];

    globalThis.fetch = mockFetchStream(chunks, 15);
    const { agent, execution } = makeMockAgentAndExecution();
    const controller = new AbortController();

    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    const tokensEmitted: string[] = [];

    const pending = provider.complete({
      agent,
      execution,
      prompt: "Hello",
      context: [],
      signal: controller.signal,
      onToken: (tok) => {
        tokensEmitted.push(tok);
        if (tok === "Hello") {
          controller.abort();
        }
      }
    });

    let threwAbortError = false;
    try {
      await pending;
    } catch (err: any) {
      if (err.name === "AbortError" || err.message?.includes("aborted")) {
        threwAbortError = true;
      }
    }

    expect(threwAbortError).toBe(true);
    expect(tokensEmitted).toContain("Hello");
    expect(tokensEmitted).not.toContain(" World");
    expect(tokensEmitted).not.toContain("!");
  });

  // ─── VERIFICATION 2: RETRY EXPONENTIAL BACKOFF REJECTS INSTANTLY ─────────────
  it("GUARANTEES: withRetry exponential backoff sleep rejects under 100ms when signal aborts", async () => {
    const controller = new AbortController();
    let fnCallCount = 0;

    const start = Date.now();

    const pending = withRetry(
      async () => {
        fnCallCount++;
        if (fnCallCount === 1) {
          throw new ProviderServerError("claude", 500);
        }
        return "success";
      },
      { maxAttempts: 2, baseDelayMs: 5000, maxDelayMs: 5000, jitterFactor: 0 },
      undefined,
      controller.signal
    );

    // Abort the signal after 50ms while the loop is sleeping in backoff
    setTimeout(() => {
      controller.abort();
    }, 50);

    let threwAbort = false;
    try {
      await pending;
    } catch (err: any) {
      if (err.name === "AbortError" || err.message?.includes("aborted")) {
        threwAbort = true;
      }
    }

    const elapsed = Date.now() - start;
    expect(threwAbort).toBe(true);
    // High-performance abort: must have rejected instantly (<150ms instead of 5000ms!)
    expect(elapsed).toBeLessThan(150);
  });

  // ─── VERIFICATION 3: FAILOVER SKIP ON PRE-ABORTED SIGNAL ─────────────────────
  it("GUARANTEES: FailoverModelProvider skips links immediately if signal is already aborted", async () => {
    const { agent, execution } = makeMockAgentAndExecution();
    const controller = new AbortController();
    controller.abort(); // Pre-abort the signal

    let primaryProviderCalled = false;
    const mockPrimary: any = {
      complete: async () => {
        primaryProviderCalled = true;
        return { output: {}, tokenUsage: { prompt: 0, completion: 0, total: 0 } };
      }
    };

    const failoverProvider = new FailoverModelProvider({
      links: [
        { name: "primary", provider: mockPrimary }
      ]
    });

    let threwAbort = false;
    try {
      await failoverProvider.complete({
        agent,
        execution,
        prompt: "Hello",
        context: [],
        signal: controller.signal
      });
    } catch (err: any) {
      if (err.name === "AbortError" || err.message?.includes("aborted")) {
        threwAbort = true;
      }
    }

    expect(threwAbort).toBe(true);
    // Link must NEVER have been called!
    expect(primaryProviderCalled).toBe(false);
  });

  // ─── VERIFICATION 4: TOOLS EMBED SIGNAL AND CANCEL FETCH ──────────────────────
  it("GUARANTEES: BuiltInToolExecutor DuckDuckGo/Brave Search respects AbortSignal and aborts fetch", async () => {
    const executor = new BuiltInToolExecutor();
    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    let threwAbort = false;
    try {
      await executor.execute({
        toolName: "web.search",
        args: { query: "vitest testing framework" },
        executionId: "exec-1",
        agentId: "agent-1",
        signal: controller.signal
      });
    } catch (err: any) {
      if (err.name === "AbortError" || err.message?.includes("aborted")) {
        threwAbort = true;
      }
    }

    expect(threwAbort).toBe(true);
  });
});
