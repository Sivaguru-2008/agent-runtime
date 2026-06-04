/**
 * processLifecycle.test.ts — verifies the crash-diagnostics policy.
 *
 * The decisive guarantee under test: an `unhandledRejection` is NON-FATAL. It
 * is logged with a full snapshot but does NOT trigger the fatal path, so a
 * stray async rejection can never tear down the HTTP listener — the root cause
 * of "API starts then ERR_CONNECTION_REFUSED".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  installProcessLifecycle,
  serializeError,
  __resetProcessLifecycleForTests
} from "../src/infrastructure/reliability/processLifecycle.js";

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn()
  };
}

describe("serializeError", () => {
  it("serializes a standard Error with stack and code", () => {
    const err = Object.assign(new Error("boom"), { code: "EBOOM" });
    const out = serializeError(err);
    expect(out.name).toBe("Error");
    expect(out.message).toBe("boom");
    expect(out.code).toBe("EBOOM");
    expect(out.stack).toContain("boom");
  });

  it("expands an AggregateError's inner errors (the OTLP ECONNREFUSED shape)", () => {
    const agg = new AggregateError(
      [new Error("connect ECONNREFUSED ::1:4318"), new Error("connect ECONNREFUSED 127.0.0.1:4318")],
      "all connections failed"
    );
    const out = serializeError(agg);
    expect(out.aggregate).toEqual([
      "connect ECONNREFUSED ::1:4318",
      "connect ECONNREFUSED 127.0.0.1:4318"
    ]);
  });

  it("handles non-Error throws (strings / objects)", () => {
    expect(serializeError("plain string").message).toBe("plain string");
    expect(serializeError({ weird: true }).message).toContain("weird");
  });
});

describe("installProcessLifecycle", () => {
  // Capture the handlers we add so we can invoke + remove them without relying
  // on real process events (and without leaving listeners that pollute other
  // suites).
  let addedUnhandled: Array<(...a: unknown[]) => void> = [];
  let beforeUnhandled = 0;
  let beforeUncaught = 0;

  beforeEach(() => {
    __resetProcessLifecycleForTests();
    beforeUnhandled = process.listeners("unhandledRejection").length;
    beforeUncaught = process.listeners("uncaughtException").length;
    addedUnhandled = [];
  });

  afterEach(() => {
    // Remove only the listeners this test added so a non-fatal uncaughtException
    // handler can never swallow a real error in a later suite.
    const currentUnhandled = process.listeners("unhandledRejection");
    for (const l of currentUnhandled.slice(beforeUnhandled)) {
      process.removeListener("unhandledRejection", l as (...a: unknown[]) => void);
    }
    const currentUncaught = process.listeners("uncaughtException");
    for (const l of currentUncaught.slice(beforeUncaught)) {
      process.removeListener("uncaughtException", l as (...a: unknown[]) => void);
    }
    __resetProcessLifecycleForTests();
  });

  it("treats unhandledRejection as NON-FATAL: logs error, never calls onFatal", () => {
    const logger = fakeLogger();
    const onFatal = vi.fn();

    installProcessLifecycle({
      logger,
      runtimeId: "test-rt",
      role: "api",
      onFatal
    });

    const handlers = process.listeners("unhandledRejection");
    const handler = handlers[handlers.length - 1] as (reason: unknown, p: unknown) => void;
    handler(new Error("stray rejection"), Promise.resolve());

    expect(onFatal).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [snapshot, msg] = logger.error.mock.calls[0]!;
    expect(msg).toContain("kept alive");
    expect((snapshot as Record<string, unknown>).event).toBe("unhandledRejection");
    expect((snapshot as Record<string, unknown>).runtimeId).toBe("test-rt");
    expect((snapshot as { memory?: unknown }).memory).toBeDefined();
  });

  it("is idempotent — a second install is a no-op that warns", () => {
    const logger = fakeLogger();
    installProcessLifecycle({ logger, runtimeId: "rt", role: "api", onFatal: vi.fn() });
    const afterFirst = process.listeners("unhandledRejection").length;

    const logger2 = fakeLogger();
    installProcessLifecycle({ logger: logger2, runtimeId: "rt2", role: "api", onFatal: vi.fn() });

    expect(logger2.warn).toHaveBeenCalledTimes(1);
    // No new unhandledRejection handler added by the second call.
    expect(process.listeners("unhandledRejection").length).toBe(afterFirst);
  });

  it("escalates to onFatal when fatalOnUnhandledRejection is explicitly enabled", () => {
    const logger = fakeLogger();
    const onFatal = vi.fn();
    installProcessLifecycle({
      logger,
      runtimeId: "rt",
      role: "api",
      onFatal,
      fatalOnUnhandledRejection: true,
      // Push the hard-exit fallback far out so its unref'd timer can never fire
      // during the test run (onFatal here is a no-op spy that does not exit).
      fatalExitDelayMs: 600_000
    });
    const handlers = process.listeners("unhandledRejection");
    const handler = handlers[handlers.length - 1] as (reason: unknown, p: unknown) => void;
    handler(new Error("boom"), Promise.resolve());
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it("treats uncaughtException as NON-FATAL when fatalOnUncaughtException is false (development policy)", () => {
    const logger = fakeLogger();
    const onFatal = vi.fn();

    installProcessLifecycle({
      logger,
      runtimeId: "dev-rt",
      role: "api",
      onFatal,
      fatalOnUncaughtException: false
    });

    const handlers = process.listeners("uncaughtException");
    const handler = handlers[handlers.length - 1] as (err: unknown, origin: unknown) => void;
    handler(new Error("stray throw from a background timer"), "uncaughtException");

    // The decisive guarantee: a stray synchronous throw must NOT drain + exit in
    // development, because `tsx watch` would never restart the crashed child and
    // the backend would go permanently offline. onFatal owns process.exit, so it
    // must not run; the failure is still logged at fatal level for visibility.
    expect(onFatal).not.toHaveBeenCalled();
    expect(logger.fatal).toHaveBeenCalledTimes(1);
    const [snapshot, msg] = logger.fatal.mock.calls[0]!;
    expect(msg).toContain("kept alive");
    expect((snapshot as Record<string, unknown>).event).toBe("uncaughtException");
    expect((snapshot as Record<string, unknown>).runtimeId).toBe("dev-rt");
    expect((snapshot as { memory?: unknown }).memory).toBeDefined();
  });

  it("treats uncaughtException as FATAL by default (production policy)", () => {
    const logger = fakeLogger();
    const onFatal = vi.fn();

    installProcessLifecycle({
      logger,
      runtimeId: "prod-rt",
      role: "api",
      onFatal,
      // Push the hard-exit fallback far out so its unref'd timer cannot fire
      // during the test (onFatal here is a no-op spy that does not exit).
      fatalExitDelayMs: 600_000
    });

    const handlers = process.listeners("uncaughtException");
    const handler = handlers[handlers.length - 1] as (err: unknown, origin: unknown) => void;
    handler(new Error("boom"), "uncaughtException");

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith("uncaughtException", expect.any(Error));
  });
});
