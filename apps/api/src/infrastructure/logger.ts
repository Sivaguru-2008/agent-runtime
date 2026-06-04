import pino from "pino";
import type { AppConfig } from "../shared/config.js";
import { getActiveSpanContext } from "./telemetry/tracing.js";
import { trueDateNow } from "../shared/trueClock.js";

/**
 * Pino `timestamp` function that reads the REAL clock. Pino's default
 * `epochTime` calls the global `Date.now`, which executionEngine patches to
 * throw `S_UNSAFE_REPLAY` inside an execution step. A log emitted in a step's
 * async context — including the uncaughtException fatal handler — would
 * otherwise crash the whole process (masking the real error). Log timestamps
 * are observability, never replayable state, so reading the genuine clock here
 * is correct, not a determinism leak.
 *
 * Exported so EVERY pino instance uses it — including the one Fastify builds
 * from an inline logger config in app.ts. createLogger covers the container
 * logger; without sharing this, Fastify's own `app.log` keeps the default
 * epochTime and crashes the backend on the first fatal raised inside a step.
 */
export const trueClockTimestamp = () => `,"time":${trueDateNow()}`;

export function createLogger(config: AppConfig) {
  return pino({
    level: config.LOG_LEVEL,
    timestamp: trueClockTimestamp,
    base: {
      service: "agent-runtime-api",
      environment: config.NODE_ENV
    },
    mixin() {
      const spanCtx = getActiveSpanContext();
      if (spanCtx) {
        return {
          traceId: spanCtx.traceId,
          spanId: spanCtx.spanId
        };
      }
      return {};
    }
  });
}
