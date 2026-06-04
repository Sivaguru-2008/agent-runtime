import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { deterministicStorage } from "../src/runtime/executionEngine.js";
import { createLogger, trueClockTimestamp } from "../src/infrastructure/logger.js";
import { trueDateNow } from "../src/shared/trueClock.js";

/**
 * Regression: a log line emitted inside an execution step's async context used
 * to crash the process. Pino timestamps every line with Date.now(), which
 * executionEngine patches to throw InvariantViolation(S_UNSAFE_REPLAY) inside a
 * step. The uncaughtException handler then logged the error, tripped the guard
 * AGAIN, and the secondary throw killed the process — masking the real cause.
 *
 * The fix routes log timestamps through the genuine (pre-patch) Date.now via
 * shared/trueClock. These tests assert the guard is still armed for step code,
 * but logging is immune.
 */
const config = { LOG_LEVEL: "silent", NODE_ENV: "test" } as never;

function withinStep<T>(fn: () => T): T {
  return deterministicStorage.run(
    {
      executionId: "exec-guard-test",
      stepType: "MODEL_GENERATION",
      clock: { now: () => 0 } as never,
      random: () => 0,
      allowUntracked: false
    },
    fn
  );
}

describe("determinism guard vs. logging", () => {
  it("still throws for raw Date.now() inside a step (guard is armed)", () => {
    withinStep(() => {
      expect(() => Date.now()).toThrow(/S_UNSAFE_REPLAY|Untracked Nondeterminism/);
    });
  });

  it("does NOT throw when the logger emits a line inside a step context", () => {
    const logger = createLogger(config);
    withinStep(() => {
      expect(() => logger.info({ foo: "bar" }, "inside a step")).not.toThrow();
      // The fatal path is the one that crashed the process — exercise it too.
      expect(() => logger.fatal({ err: new Error("boom") }, "uncaught")).not.toThrow();
    });
  });

  it("does NOT throw when Fastify's own logger (app.log) emits inside a step", async () => {
    // Recurrence guard: createLogger was fixed, but app.ts builds Fastify with an
    // INLINE logger config, so Fastify makes its OWN pino. If that config omits
    // `timestamp: trueClockTimestamp`, app.log falls back to pino's default
    // epochTime → patched Date.now → crash when processLifecycle's
    // uncaughtException handler logs a fatal raised inside a step. Mirror app.ts's
    // config faithfully and exercise the fatal path inside a step context.
    const app = Fastify({
      logger: {
        level: "silent",
        base: { service: "agent-runtime-api", environment: "test" },
        timestamp: trueClockTimestamp
      }
    });
    try {
      withinStep(() => {
        expect(() => app.log.info({ foo: "bar" }, "inside a step")).not.toThrow();
        expect(() => app.log.fatal({ err: new Error("boom") }, "uncaught")).not.toThrow();
      });
    } finally {
      await app.close();
    }
  });

  it("trueDateNow returns a real timestamp even inside a step", () => {
    withinStep(() => {
      const t = trueDateNow();
      expect(typeof t).toBe("number");
      expect(t).toBeGreaterThan(0);
    });
  });
});
