import { describe, it, expect, vi } from "vitest";
import { computeDelayMs, resolveRetryOptions, withRetry, DEFAULT_RETRY } from "../src/retry.js";
import { RateLimitError, ValidationError, ServiceUnavailableError } from "../src/errors.js";

describe("computeDelayMs", () => {
  const opts = resolveRetryOptions({ baseDelayMs: 100, maxDelayMs: 5000, jitter: 0 });

  it("uses exponential backoff with no jitter", () => {
    const err = new ServiceUnavailableError("x");
    expect(computeDelayMs(0, err, opts)).toBe(100);
    expect(computeDelayMs(1, err, opts)).toBe(200);
    expect(computeDelayMs(2, err, opts)).toBe(400);
  });

  it("caps at maxDelayMs", () => {
    const err = new ServiceUnavailableError("x");
    expect(computeDelayMs(10, err, opts)).toBe(5000);
  });

  it("prefers server Retry-After over backoff", () => {
    const err = new RateLimitError("x", { retryAfterMs: 1234 });
    expect(computeDelayMs(0, err, opts)).toBe(1234);
  });

  it("caps Retry-After at maxDelayMs", () => {
    const err = new RateLimitError("x", { retryAfterMs: 999_999 });
    expect(computeDelayMs(0, err, opts)).toBe(5000);
  });

  it("applies jitter within bounds", () => {
    const jittered = resolveRetryOptions({ baseDelayMs: 100, jitter: 0.5 });
    const err = new ServiceUnavailableError("x");
    // random()=1 -> factor 1.5
    expect(computeDelayMs(0, err, jittered, () => 1)).toBe(150);
    // random()=0 -> factor 0.5
    expect(computeDelayMs(0, err, jittered, () => 0)).toBe(50);
  });
});

describe("withRetry", () => {
  const fast = resolveRetryOptions({ maxRetries: 3, baseDelayMs: 0, jitter: 0 });

  it("returns on first success", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, fast)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors then succeeds", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new ServiceUnavailableError("down");
      return "recovered";
    });
    expect(await withRetry(fn, fast)).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn(async () => {
      throw new ValidationError("bad");
    });
    await expect(withRetry(fn, fast)).rejects.toBeInstanceOf(ValidationError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const fn = vi.fn(async () => {
      throw new ServiceUnavailableError("still down");
    });
    await expect(withRetry(fn, fast)).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("invokes onRetry with attempt metadata", async () => {
    const onRetry = vi.fn();
    const opts = resolveRetryOptions({ maxRetries: 2, baseDelayMs: 0, jitter: 0, onRetry });
    let n = 0;
    await withRetry(async () => {
      n += 1;
      if (n < 2) throw new ServiceUnavailableError("x");
      return "ok";
    }, opts);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1, maxRetries: 2 });
  });

  it("rethrows non-AgentRuntimeError immediately", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("programming bug");
    });
    await expect(withRetry(fn, fast)).rejects.toBeInstanceOf(TypeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("DEFAULT_RETRY", () => {
  it("has conservative production defaults", () => {
    expect(DEFAULT_RETRY.maxRetries).toBe(3);
    expect(DEFAULT_RETRY.jitter).toBeGreaterThan(0);
  });
});
