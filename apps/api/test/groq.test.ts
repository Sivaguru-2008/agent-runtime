import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GroqProvider, GroqUnavailableError } from "../src/providers/GroqProvider.js";
import { LiveEventBroadcaster } from "../src/events/live-broadcaster.js";
import { LiveExecutionEngine } from "../src/runtime/execution-engine.js";
import type { LiveEvent } from "../src/telemetry/live-events.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Mock Groq's OpenAI-compatible streaming endpoint. Each item becomes one
 * `data: {json}` SSE frame; a trailing `data: [DONE]` sentinel is appended.
 */
function mockGroqStream(frames: Array<Record<string, unknown>>): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

const STREAM_FRAMES = [
  { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
  { choices: [{ delta: { content: ", " }, finish_reason: null }] },
  { choices: [{ delta: { content: "world!" }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 4, completion_tokens: 3 } }
];

describe("GroqProvider", () => {
  it("streams parsed chunks from the chat/completions endpoint", async () => {
    globalThis.fetch = mockGroqStream(STREAM_FRAMES);

    const provider = new GroqProvider({ apiKey: "k", baseUrl: "http://example.test/v1", model: "llama-3.3-70b-versatile" });
    const collected: string[] = [];
    let finalChunk: any;
    for await (const chunk of provider.runPrompt({ prompt: "hi" })) {
      collected.push(chunk.token);
      if (chunk.done && chunk.evalCount !== undefined) finalChunk = chunk;
    }

    expect(collected.join("")).toBe("Hello, world!");
    expect(finalChunk?.evalCount).toBe(3);
    expect(finalChunk?.promptEvalCount).toBe(4);
  });

  it("aggregates text + usage via the LLMProvider chat() surface", async () => {
    globalThis.fetch = mockGroqStream(STREAM_FRAMES);
    const provider = new GroqProvider({ apiKey: "k", baseUrl: "http://example.test/v1" });
    const res = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toBe("Hello, world!");
    expect(res.usage.prompt).toBe(4);
    expect(res.usage.completion).toBe(3);
    expect(res.usage.total).toBe(7);
    expect(res.model).toBe("llama-3.3-70b-versatile");
  });

  it("listModels falls back to the supported list when /models is unreachable", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const provider = new GroqProvider({ apiKey: "k" });
    const models = await provider.listModels();
    expect(models).toContain("llama-3.3-70b-versatile");
    expect(models).toContain("qwen-qwq-32b");
  });

  it("health reports offline with an error when the probe fails", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const provider = new GroqProvider({ apiKey: "k" });
    const health = await provider.health();
    expect(health.provider).toBe("groq");
    expect(health.online).toBe(false);
    expect(health.error).toBeDefined();
  });

  it("throws GroqUnavailableError when fetch rejects", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const provider = new GroqProvider({ apiKey: "k", baseUrl: "http://nowhere.test/v1", model: "llama-3.3-70b-versatile" });
    await expect(async () => {
      for await (const _ of provider.runPrompt({ prompt: "hi" })) {
        // no-op
      }
    }).rejects.toBeInstanceOf(GroqUnavailableError);
  });
});

describe("LiveExecutionEngine", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("emits the full event sequence and aggregates metrics", async () => {
    globalThis.fetch = mockGroqStream([
      { choices: [{ delta: { content: "A" }, finish_reason: null }] },
      { choices: [{ delta: { content: "B" }, finish_reason: null }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2 } }
    ]);

    const broadcaster = new LiveEventBroadcaster();
    const events: LiveEvent[] = [];
    broadcaster.subscribe((event) => events.push(event));

    const provider = new GroqProvider({ apiKey: "k", baseUrl: "http://example.test/v1", model: "llama-3.3-70b-versatile" });
    const engine = new LiveExecutionEngine(provider, broadcaster);

    const record = await engine.runPrompt({ prompt: "go" });

    expect(record.state).toBe("COMPLETED");
    expect(record.output).toBe("AB");
    expect(record.completionTokens).toBe(2);
    expect(record.promptTokens).toBe(2);
    expect(record.totalTokens).toBe(4);

    const types = events.map((e) => e.type);
    expect(types).toContain("PROMPT_RECEIVED");
    expect(types).toContain("MODEL_START");
    expect(types.filter((t) => t === "TOKEN_STREAM")).toHaveLength(2);
    expect(types).toContain("MODEL_COMPLETE");

    const metrics = engine.metrics();
    expect(metrics.executions.completed).toBe(1);
    expect(metrics.tokens.total).toBe(4);
  });

  it("emits MODEL_ERROR when Groq is unavailable", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const broadcaster = new LiveEventBroadcaster();
    const events: LiveEvent[] = [];
    broadcaster.subscribe((event) => events.push(event));

    const provider = new GroqProvider({ apiKey: "k", baseUrl: "http://nowhere.test/v1", model: "llama-3.3-70b-versatile" });
    const engine = new LiveExecutionEngine(provider, broadcaster);

    const record = await engine.runPrompt({ prompt: "go" });
    expect(record.state).toBe("FAILED");
    expect(record.error?.code).toBe("GROQ_UNAVAILABLE");

    const errorEvent = events.find((e) => e.type === "MODEL_ERROR");
    expect(errorEvent).toBeDefined();
  });
});
