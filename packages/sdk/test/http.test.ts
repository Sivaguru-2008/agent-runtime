import { describe, it, expect, vi } from "vitest";
import { HttpClient, parseRetryAfter } from "../src/http.js";
import { resolveConfig } from "../src/config.js";
import { jsonResponse, mockFetch } from "./helpers.js";
import {
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
  TimeoutError,
  NetworkError
} from "../src/errors.js";

function client(fetchImpl: ReturnType<typeof mockFetch>["fetch"], overrides = {}) {
  return new HttpClient(
    resolveConfig({
      baseUrl: "https://api.test",
      apiKey: "sk_test",
      fetch: fetchImpl,
      retry: { maxRetries: 2, baseDelayMs: 0, jitter: 0 },
      ...overrides
    })
  );
}

describe("parseRetryAfter", () => {
  it("parses a delta-seconds value", () => {
    expect(parseRetryAfter("5")).toBe(5000);
  });
  it("parses an HTTP-date value", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10_000);
  });
  it("returns undefined for missing/garbage", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("HttpClient.request", () => {
  it("sends the api key as X-Api-Key by default", async () => {
    const { fetch, calls } = mockFetch([jsonResponse({ ok: true })]);
    await client(fetch).request({ method: "GET", path: "/health" });
    expect(calls[0]!.headers["x-api-key"]).toBe("sk_test");
    expect(calls[0]!.url).toBe("https://api.test/health");
  });

  it("sends Bearer auth when configured", async () => {
    const { fetch, calls } = mockFetch([jsonResponse({ ok: true })]);
    await client(fetch, { authScheme: "bearer" }).request({ method: "GET", path: "/x" });
    expect(calls[0]!.headers["authorization"]).toBe("Bearer sk_test");
  });

  it("serialises a JSON body and sets content-type", async () => {
    const { fetch, calls } = mockFetch([jsonResponse({ id: "e1" }, { status: 202 })]);
    await client(fetch).request({ method: "POST", path: "/x", body: { a: 1 } });
    expect(calls[0]!.body).toEqual({ a: 1 });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
  });

  it("appends query params", async () => {
    const { fetch, calls } = mockFetch([jsonResponse({})]);
    await client(fetch).request({ method: "GET", path: "/x", query: { afterSequence: 7, skip: undefined } });
    expect(calls[0]!.url).toBe("https://api.test/x?afterSequence=7");
  });

  it("throws a typed error for a 4xx", async () => {
    const { fetch } = mockFetch([jsonResponse({ error: "VALIDATION_ERROR", message: "bad" }, { status: 400 })]);
    await expect(client(fetch).request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("retries a 503 on a safe method and honours Retry-After", async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({ error: "QUEUE_SATURATED" }, { status: 503, headers: { "retry-after": "0" } }),
      jsonResponse({ ok: true })
    ]);
    const result = await client(fetch).request<{ ok: boolean }>({ method: "GET", path: "/x" });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("retries a 429", async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({ error: "QUOTA_EXCEEDED" }, { status: 429, headers: { "retry-after": "0" } }),
      jsonResponse({ ok: true })
    ]);
    await client(fetch).request({ method: "GET", path: "/x" });
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a POST without an idempotency key, even on 503", async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({ error: "QUEUE_SATURATED" }, { status: 503, headers: { "retry-after": "0" } })
    ]);
    await expect(
      client(fetch).request({ method: "POST", path: "/x", body: {} })
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it("DOES retry a POST when allowRetry is set", async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({ error: "QUEUE_SATURATED" }, { status: 503, headers: { "retry-after": "0" } }),
      jsonResponse({ id: "e1" }, { status: 202 })
    ]);
    await client(fetch).request({ method: "POST", path: "/x", body: {}, allowRetry: true });
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries", async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({}, { status: 503, headers: { "retry-after": "0" } }),
      jsonResponse({}, { status: 503, headers: { "retry-after": "0" } }),
      jsonResponse({}, { status: 503, headers: { "retry-after": "0" } })
    ]);
    await expect(client(fetch).request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(
      ServiceUnavailableError
    );
    expect(calls).toHaveLength(3); // 1 + 2 retries
  });

  it("wraps a network failure as NetworkError and retries it", async () => {
    const { fetch, calls } = mockFetch([new TypeError("fetch failed"), jsonResponse({ ok: true })]);
    await client(fetch).request({ method: "GET", path: "/x" });
    expect(calls).toHaveLength(2);
  });

  it("surfaces a persistent network failure as NetworkError", async () => {
    const { fetch } = mockFetch([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed")
    ]);
    await expect(client(fetch).request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(NetworkError);
  });

  it("raises TimeoutError when the request exceeds timeoutMs", async () => {
    const slowFetch = vi.fn((_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal!.reason ?? new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
    const c = new HttpClient(
      resolveConfig({ baseUrl: "https://api.test", fetch: slowFetch, timeoutMs: 10, retry: { maxRetries: 0 } })
    );
    await expect(c.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(TimeoutError);
  });

  it("returns the raw Response when raw:true", async () => {
    const { fetch } = mockFetch([jsonResponse({ ok: true })]);
    const res = await client(fetch).request<Response>({ method: "GET", path: "/x", raw: true });
    expect(res).toBeInstanceOf(Response);
  });
});
