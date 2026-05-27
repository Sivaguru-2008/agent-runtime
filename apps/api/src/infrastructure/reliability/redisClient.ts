/**
 * Centralised Redis client factory with production-grade reconnect / backoff.
 *
 * Why this exists:
 *   The platform constructs Redis clients in several places (event bus,
 *   streams bus, job queue, security cache, rate limiter). Each `new Redis()`
 *   call without explicit options inherits ioredis defaults:
 *     - retryStrategy() retries forever with no upper bound
 *     - reconnectOnError() never reconnects on READONLY (failover)
 *     - No connect timeout — a wedged DNS lookup blocks startup
 *     - No error listener — `error` becomes an unhandledRejection
 *   This factory replaces those defaults with policies aligned to a strict,
 *   distributed runtime: bounded exponential backoff, READONLY-triggered
 *   reconnect (so a replica promotion is recovered automatically), explicit
 *   connect/command timeouts, and a default error logger so connection
 *   blips show up in the structured log stream instead of stdout.
 *
 * Backward compatibility:
 *   The function returns a plain `Redis` so callers continue using the
 *   ioredis API surface. Callers that need a different option (e.g.
 *   enableOfflineQueue=false for the security cache) pass `overrides`.
 */

import { Redis, type RedisOptions } from "ioredis";
import { currentRegionTag } from "./regionAwareness.js";
import { isChaosEnabled, wrapRedisWithChaos } from "../chaos/index.js";

export interface RedisClientOptions {
  /** Logical name — used in structured log lines so operators can identify the client. */
  name: string;
  /** Optional ioredis overrides. Merged on top of the hardened defaults. */
  overrides?: RedisOptions;
  /** Optional structured logger sink — receives { name, err } on connection errors. */
  onError?: (name: string, err: Error) => void;
}

/**
 * Bounded exponential backoff. Caps at 5s so a flapping Redis does not
 * inflate latency beyond the request budget while still giving a slow
 * recovering instance room to come back online.
 */
function defaultRetryStrategy(times: number): number {
  // 50ms, 100, 200, 400, ..., capped at 5_000ms.
  return Math.min(5_000, 50 * Math.pow(2, Math.min(times, 7)));
}

/**
 * Reconnect when Redis returns READONLY — the canonical signal of a primary
 * failover. Without this, every client pinned to the demoted primary will
 * return errors until the connection is torn down by another path.
 */
function defaultReconnectOnError(err: Error): boolean {
  return err.message.startsWith("READONLY");
}

export function createRedisClient(url: string, opts: RedisClientOptions): Redis {
  const base: RedisOptions = {
    connectTimeout: 5_000,
    retryStrategy: defaultRetryStrategy,
    reconnectOnError: defaultReconnectOnError,
    // Cap per-command retries so a wedged Redis surfaces as an error to the
    // caller rather than blocking indefinitely. The bounded retryStrategy
    // above handles connection-level retries.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // Surface client identity in MONITOR output so operators can correlate.
    // The region tag is appended so multi-region deployments can attribute
    // writes/reads to the originating region from server-side MONITOR.
    name: `agent-runtime:${opts.name}:${currentRegionTag()}`,
    ...opts.overrides
  };

  const client = new Redis(url, base);
  client.on("error", (err: Error) => {
    if (opts.onError) {
      opts.onError(opts.name, err);
    } else {
      // Final safety net: never let a Redis `error` event become an
      // unhandledRejection. Operators who want richer reporting pass onError.
      // eslint-disable-next-line no-console
      console.error(`[redis:${opts.name}] connection error: ${err.message}`);
    }
  });
  // Chaos: opt-in, dev/test only. wrapRedisWithChaos is an identity function
  // unless CHAOS_ENABLED=true AND NODE_ENV ∉ {production,staging}. The proxy
  // intercepts data commands and publish() to inject the faults configured on
  // chaosController(); lifecycle methods (on/quit/disconnect/connect) are NOT
  // proxied so event-emitter semantics and reconnect behaviour are unchanged.
  return isChaosEnabled() ? wrapRedisWithChaos(client) : client;
}
