import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OllamaProvider, OllamaUnavailableError } from "../src/providers/ollama.js";
import { LiveEventBroadcaster } from "../src/events/live-broadcaster.js";
import { LiveExecutionEngine } from "../src/runtime/execution-engine.js";
import type { LiveEvent } from "../src/telemetry/live-events.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockOllamaStream(chunks: Array<Record<string, unknown>>): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        }
        controller.close();
      }
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }) as unknown as typeof fetch;
}

describe("OllamaProvider", () => {
  it("streams parsed chunks from the /api/generate endpoint", async () => {
    globalThis.fetch = mockOllamaStream([
      { response: "Hello", done: false },
      { response: ", ", done: false },
      { response: "world!", done: false },
      { response: "", done: true, prompt_eval_count: 4, eval_count: 3, total_duration: 1_000_000 }
    ]);

    const provider = new OllamaProvider({ baseUrl: "http://example.test", model: "llama3" });
    const collected: string[] = [];
    let finalChunk: any;
    for await (const chunk of provider.runPrompt({ prompt: "hi" })) {
      collected.push(chunk.token);
      if (chunk.done) finalChunk = chunk;
    }

    expect(collected.join("")).toBe("Hello, world!");
    expect(finalChunk?.evalCount).toBe(3);
    expect(finalChunk?.promptEvalCount).toBe(4);
  });

  it("throws OllamaUnavailableError when fetch rejects", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const provider = new OllamaProvider({ baseUrl: "http://nowhere.test", model: "llama3" });
    await expect(async () => {
      for await (const _ of provider.runPrompt({ prompt: "hi" })) {
        // no-op
      }
    }).rejects.toBeInstanceOf(OllamaUnavailableError);
  });
});

describe("LiveExecutionEngine", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("emits the full event sequence and aggregates metrics", async () => {
    globalThis.fetch = mockOllamaStream([
      { response: "A", done: false },
      { response: "B", done: false },
      { response: "", done: true, prompt_eval_count: 2, eval_count: 2, total_duration: 2_000_000 }
    ]);

    const broadcaster = new LiveEventBroadcaster();
    const events: LiveEvent[] = [];
    broadcaster.subscribe((event) => events.push(event));

    const provider = new OllamaProvider({ baseUrl: "http://example.test", model: "llama3" });
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

  it("emits MODEL_ERROR when Ollama is unavailable", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const broadcaster = new LiveEventBroadcaster();
    const events: LiveEvent[] = [];
    broadcaster.subscribe((event) => events.push(event));

    const provider = new OllamaProvider({ baseUrl: "http://nowhere.test", model: "llama3" });
    const engine = new LiveExecutionEngine(provider, broadcaster);

    const record = await engine.runPrompt({ prompt: "go" });
    expect(record.state).toBe("FAILED");
    expect(record.error?.code).toBe("OLLAMA_UNAVAILABLE");

    const errorEvent = events.find((e) => e.type === "MODEL_ERROR");
    expect(errorEvent).toBeDefined();
  });
});
