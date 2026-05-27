import pino from "pino";
import type { AppConfig } from "../shared/config.js";
import { getActiveSpanContext } from "./telemetry/tracing.js";

export function createLogger(config: AppConfig) {
  return pino({
    level: config.LOG_LEVEL,
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
