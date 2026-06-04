import { describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../src/domain/ports.js";
import type { Agent, Execution } from "../src/domain/model.js";
import {
  CachingModelProvider,
  InMemoryResponseCache,
  buildCacheKey,
  isCacheable
} from "../src/providers/responseCache.js";

function makeInput(opts: {
  prompt?: string;
  temperature?: number;
  goal?: string;
  onToken?: (t: string, c: number) => void;
}): Parameters<ModelProvider["complete"]>[0] {
  const agent = {
    id: "agent-1",
    goal: opts.goal ?? "do the thing",
    model: { provider: "groq", model: "llama-3.3-70b-versatile", temperature: opts.temperature ?? 0 }
  } as unknown as Agent;
  const execution = { id: "exec-1" } as unknown as Execution;
  return {
    agent,
    execution,
    prompt: opts.prompt ?? "what is 2+2?",
    context: [],
    onToken: opts.onToken
  };
}

function makeInner(text = "four"): { provider: ModelProvider; calls: () => number } {
  let calls = 0;
  const provider: ModelProvider = {
    async complete(input) {
      calls += 1;
      input.onToken?.(text, 1.0);
      return {
        output: { result: text },
        tokenUsage: { prompt: 10, completion: 5, total: 15 }
      };
    }
  };
  return { provider, calls: () => calls };
}

describe("InMemoryResponseCache", () => {
  it("returns undefined after TTL expiry", async () => {
    let now = 0;
    const cache = new InMemoryResponseCache(10, () => now);
    await cache.set("k", { output: { result: "x" }, tokenUsage: { prompt: 1, completion: 1, total: 2 } }, 1000);
    now = 999;
    expect(await cache.get("k")).toBeDefined();
    now = 1001;
    expect(await cache.get("k")).toBeUndefined();
  });

  it("evicts the least-recently-used entry past capacity", async () => {
    const cache = new InMemoryResponseCache(2);
    const v = { output: {}, tokenUsage: { prompt: 0, completion: 0, total: 0 } };
    await cache.set("a", v, 10_000);
    await cache.set("b", v, 10_000);
    await cache.get("a"); // touch a → b is now LRU
    await cache.set("c", v, 10_000); // evicts b
    expect(await cache.get("a")).toBeDefined();
    expect(await cache.get("c")).toBeDefined();
    expect(await cache.get("b")).toBeUndefined();
    expect(cache.size()).toBe(2);
  });
});

describe("cache key + cacheability", () => {
  it("only caches deterministic (temperature=0) requests", () => {
    expect(isCacheable(makeInput({ temperature: 0 }))).toBe(true);
    expect(isCacheable(makeInput({ temperature: 0.7 }))).toBe(false);
  });

  it("identical deterministic requests hash to the same key", () => {
    expect(buildCacheKey(makeInput({ prompt: "p" }))).toBe(buildCacheKey(makeInput({ prompt: "p" })));
  });

  it("different prompts hash to different keys", () => {
    expect(buildCacheKey(makeInput({ prompt: "a" }))).not.toBe(buildCacheKey(makeInput({ prompt: "b" })));
  });
});

describe("CachingModelProvider", () => {
  it("serves a second identical deterministic call from cache (zero upstream calls)", async () => {
    const inner = makeInner();
    const events: string[] = [];
    const caching = new CachingModelProvider(inner.provider, {
      onResult: (e) => events.push(e)
    });

    const first = await caching.complete(makeInput({ prompt: "q" }));
    const second = await caching.complete(makeInput({ prompt: "q" }));

    expect(inner.calls()).toBe(1);
    expect(second.output).toEqual(first.output);
    expect(second.tokenUsage).toEqual(first.tokenUsage);
    expect(events).toEqual(["miss", "hit"]);
  });

  it("replays cached text through onToken on a hit so SSE still streams", async () => {
    const inner = makeInner("the answer");
    const caching = new CachingModelProvider(inner.provider);
    await caching.complete(makeInput({ prompt: "q" }));

    const tokens: string[] = [];
    await caching.complete(makeInput({ prompt: "q", onToken: (t) => tokens.push(t) }));
    expect(tokens).toEqual(["the answer"]);
    expect(inner.calls()).toBe(1);
  });

  it("bypasses the cache for non-deterministic requests", async () => {
    const inner = makeInner();
    const events: string[] = [];
    const caching = new CachingModelProvider(inner.provider, { onResult: (e) => events.push(e) });
    await caching.complete(makeInput({ prompt: "q", temperature: 0.9 }));
    await caching.complete(makeInput({ prompt: "q", temperature: 0.9 }));
    expect(inner.calls()).toBe(2);
    expect(events).toEqual(["skip", "skip"]);
  });

  it("falls through to the provider when the cache store throws", async () => {
    const inner = makeInner();
    const brokenStore = {
      get: vi.fn().mockRejectedValue(new Error("redis down")),
      set: vi.fn().mockRejectedValue(new Error("redis down"))
    };
    const caching = new CachingModelProvider(inner.provider, { store: brokenStore });
    const result = await caching.complete(makeInput({ prompt: "q" }));
    expect(result.output).toEqual({ result: "four" });
    expect(inner.calls()).toBe(1);
  });

  it("does not serve a stale entry after TTL expiry", async () => {
    let now = 0;
    const store = new InMemoryResponseCache(100, () => now);
    const inner = makeInner();
    const caching = new CachingModelProvider(inner.provider, { store, ttlMs: 1000 });
    await caching.complete(makeInput({ prompt: "q" }));
    now = 2000;
    await caching.complete(makeInput({ prompt: "q" }));
    expect(inner.calls()).toBe(2);
  });
});
